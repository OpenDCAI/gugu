import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { openPhoneAgentStore } from './phone-agent-store.mjs'
import { receivePhoneArtifact, phoneFileTools, phoneInboxAttachmentRow, registerArtifact } from './phone-agent-files.mjs'

const ownerId = '68a158dd-1832-4671-ac02-ebde330d3d7a'
const agent = { agentUserId: '558fcc98-9d61-4054-8a18-900d969b1849', sessionId: '13226587-813a-4e58-a023-dc419aeab890' }
const chatId = 'a540c592-971b-4bcf-89c3-944484a14640'
const proof = { permissions: ['READ_MEDIA_IMAGES'], mediaRefs: [{ kind: 'image', id: '10', version: 'v1' }] }
const bytes = Buffer.from('phone media bytes must not become model text')
const chunk = { phone_file_chunk: { offset: 0, total_size: bytes.length, version: 'v1', name: 'image.jpg', mime_type: 'image/jpeg', data_base64: bytes.toString('base64'), eof: true } }
const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } })

test('inbox attachment metadata retains the authoritative message reference without image bytes, URLs or unregistered paths', () => {
  const row = { id: '4f6dac4f-a3f2-48da-9876-d3a4567d8b64', contentType: 'attachment', content: '[附件] calendar.png (image/png)\n[URL] https://files.invalid/storage/v1/object/public/chat-media/calendar.png\n[Size] 42\n[Kind] image\n[Caption]\n请把这个图片转发给我', fileItemId: null, fileVersion: null, fileBlobId: null }
  const prepared = phoneInboxAttachmentRow(row)
  assert.match(prepared.content, /message_download_file/)
  assert.match(prepared.content, new RegExp(`msg:${row.id}`))
  assert.match(prepared.content, /calendar\.png/)
  assert.match(prepared.content, /请把这个图片转发给我/)
  assert.equal(prepared.content.includes('https://'), false)
  assert.equal(prepared.content.startsWith('[附件]'), false)
  assert.equal(row.content.startsWith('[附件]'), true)
  const gone = phoneInboxAttachmentRow({ ...row, content: '[附件] deleted.png (image/png)\n[Size] 42\n[Kind] image' })
  assert.match(gone.content, /"available":false/)
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gugu-phone-file-'))
  const store = await openPhoneAgentStore(root, ownerId)
  const job = { id: 'd6857196-44c1-49c0-b265-e18de6ea3f51', usedGroups: ['photos'], permissionRequirements: [proof] }
  const artifact = await receivePhoneArtifact({ first: { ...chunk, pictures: [{ mimeType: 'image/jpeg', data: 'private-thumbnail-bytes' }] }, args: { id: '10' }, read: async () => { throw new Error('one chunk is complete') }, agent, job, signal: new AbortController().signal, store, root, group: 'photos' })
  const requests = []
  const cloud = {
    rpc: async (_schema, name) => name === 'list_member_ids' ? [{ user_id: agent.agentUserId }, { user_id: ownerId }] : [{ kind: 'dm', group_prompt: null }],
    attachmentEndpoint: async () => ({ supabaseUrl: 'https://files.invalid', anonKey: 'public', token: 'private-token', fetch: async (url, options) => {
      requests.push([String(url), options])
      if (String(url).endsWith('/attachments/upload')) return json({ staging_key: 'staged', url: 'https://storage.invalid/put', fields: {}, max_bytes: 1024 })
      if (String(url).includes('/put')) return new Response('', { status: 200 })
      if (String(url).endsWith('/attachments/commit')) return json({ message: { id: JSON.parse(options.body).message_id } })
      throw new Error('unexpected endpoint')
    } }),
  }
  return { root, store, job, artifact, cloud, requests, async close() { await rm(root, { recursive: true }) } }
}

test('native chunks become an owner-scoped complete artifact and private permission proof never reaches Pi text', async () => {
  const fx = await fixture()
  try {
    assert.equal(JSON.stringify(fx.artifact).includes(bytes.toString('base64')), false)
    assert.equal(JSON.stringify(fx.artifact.data).includes('READ_MEDIA_IMAGES'), false)
    assert.deepEqual(fx.artifact.content.map((block) => block.type), ['text'])
    assert.equal(JSON.stringify(fx.artifact).includes('private-thumbnail-bytes'), false)
    const stored = fx.store.state.artifacts[fx.artifact.data.artifact_id]
    assert.deepEqual(stored.permissionRequirements, [proof])
    assert.deepEqual(stored.groups, ['photos'])
    assert.equal(stored.agentUserId, agent.agentUserId)
  } finally { await fx.close() }
})

test('file sending uses core attachment upload/commit with the agent sender, stable message id and real bytes', async () => {
  const fx = await fixture()
  const checked = []
  try {
    const tool = phoneFileTools({ agent, job: fx.job, cloud: fx.cloud, store: fx.store, env: { GUGU_HOME: fx.root }, authorize: async (groups, artifact) => { checked.push([groups, artifact.permissionRequirements]) }, emit: () => undefined }).find((item) => item.name === 'message_send_file')
    const args = { chat_id: chatId, file_path: fx.artifact.data.file_path, to_user_ids: [`user:${ownerId}`] }
    const sent = await tool.execute('first', args)
    await tool.execute('retry', args)
    assert.equal(fx.requests.filter(([url]) => url.endsWith('/commit')).length, 1)
    const permit = JSON.parse(fx.requests.find(([url]) => url.endsWith('/upload'))[1].body)
    assert.deepEqual({ size_bytes: permit.size_bytes, as: permit.as, chat_id: permit.chat_id }, { size_bytes: bytes.length, as: agent.agentUserId, chat_id: chatId })
    assert.match(permit.request_id, /^[0-9a-f-]{36}$/i)
    const upload = fx.requests.find(([url]) => url.includes('/put'))[1].body.get('file')
    assert.deepEqual(Buffer.from(await upload.arrayBuffer()), bytes)
    const commit = JSON.parse(fx.requests.find(([url]) => url.endsWith('/commit'))[1].body)
    assert.equal(commit.sender_user_id, agent.agentUserId)
    assert.equal(sent.details.message_id, `msg:${commit.message_id}`)
    assert.equal(checked.length >= 2, true)
    assert.deepEqual(checked[0][1], [proof])
  } finally { await fx.close() }
})

test('unregistered paths, changed bytes and permission revocation before commit cannot send a file', async () => {
  const fx = await fixture()
  try {
    let checks = 0
    const tools = phoneFileTools({ agent, job: fx.job, cloud: fx.cloud, store: fx.store, env: { GUGU_HOME: fx.root }, authorize: async () => { if (++checks > 1) throw Object.assign(new Error('photo permission revoked'), { code: 'os_permission' }) }, emit: () => undefined })
    const send = tools.find((item) => item.name === 'message_send_file')
    await assert.rejects(send.execute('unknown', { chat_id: chatId, file_path: '/etc/hosts' }), /登记/)
    await assert.rejects(send.execute('revoked', { chat_id: chatId, file_path: fx.artifact.data.file_path }), /permission revoked/)
    assert.equal(fx.requests.some(([url]) => url.endsWith('/commit')), false)
    await writeFile(fx.artifact.data.file_path, Buffer.alloc(bytes.length, 0))
    await assert.rejects(send.execute('modified', { chat_id: chatId, file_path: fx.artifact.data.file_path }), /内容已变化/)
  } finally { await fx.close() }
})

test('attachment download ignores an untrusted body URL and requires message ACL before requesting any object bytes', async () => {
  const fx = await fixture()
  try {
    fx.cloud.rpc = async (_schema, name) => { assert.equal(name, 'can_read_message'); return true }
    fx.cloud.chat = { from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { id: '4f6dac4f-a3f2-48da-9876-d3a4567d8b64', content_type: 'attachment', content: '[附件] secret.txt (text/plain)\n[URL] http://127.0.0.1/secret\n[Size] 42\n[Kind] file' }, error: null }) }) }) }) }
    const endpoint = await fx.cloud.attachmentEndpoint()
    fx.cloud.attachmentEndpoint = async () => ({ ...endpoint, fetch: async (url, init) => { fx.requests.push([String(url), init]); return json({ status: 'gone', sha256: null }) } })
    const tool = phoneFileTools({ agent, job: fx.job, cloud: fx.cloud, store: fx.store, env: {}, authorize: async () => undefined, emit: () => undefined }).find((item) => item.name === 'message_download_file')
    await assert.rejects(tool.execute('unsafe', { source_message_id: 'msg:4f6dac4f-a3f2-48da-9876-d3a4567d8b64' }), /已删除或不可见/)
    assert.deepEqual(fx.requests.map(([url]) => url), ['https://files.invalid/functions/v1/attachments/file-resolve'])
    assert.deepEqual(JSON.parse(fx.requests[0][1].body), { ref: { message_id: '4f6dac4f-a3f2-48da-9876-d3a4567d8b64' }, as: agent.agentUserId })
  } finally { await fx.close() }
})

test('the message authority downloads the verified original even when its body contains a local-network URL', async () => {
  const fx = await fixture()
  const id = '4f6dac4f-a3f2-48da-9876-d3a4567d8b64'
  try {
    fx.cloud.rpc = async (_schema, name) => { assert.equal(name, 'can_read_message'); return true }
    fx.cloud.chat = { from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { id, content_type: 'attachment', content: '[附件] private.bin (application/octet-stream)\n[URL] http://127.0.0.1/secret\n[Size] 42\n[Kind] file' }, error: null }) }) }) }) }
    const endpoint = await fx.cloud.attachmentEndpoint()
    const revision = { status: 'ready', source: 'managed-object', file_name: 'private.bin', content_type: 'application/octet-stream', size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    fx.cloud.attachmentEndpoint = async () => ({ ...endpoint, fetch: async (url, init) => {
      fx.requests.push([String(url), init])
      if (String(url).endsWith('/file-resolve')) { assert.deepEqual(JSON.parse(init.body), { ref: { message_id: id }, as: agent.agentUserId }); return json(revision) }
      if (String(url).endsWith('/file-download')) { assert.equal(JSON.parse(init.body).as, agent.agentUserId); return json({ ...revision, download_id: 'download', url: 'https://storage.invalid/original' }) }
      assert.equal(String(url), 'https://storage.invalid/original'); assert.equal(init?.headers?.Authorization, undefined); return new Response(bytes)
    } })
    const tool = phoneFileTools({ agent, job: fx.job, cloud: fx.cloud, store: fx.store, env: {}, authorize: async () => undefined, emit: () => undefined }).find(item => item.name === 'message_download_file')
    const original = (await tool.execute('original', { source_message_id: `msg:${id}` })).details
    assert.deepEqual(await readFile(original.file_path), bytes)
    assert.equal(original.sha256, revision.sha256)
    assert.deepEqual(fx.requests.map(([url]) => url), ['https://files.invalid/functions/v1/attachments/file-resolve', 'https://files.invalid/functions/v1/attachments/file-download', 'https://storage.invalid/original', 'https://files.invalid/functions/v1/attachments/file-resolve'])
    assert.equal(JSON.stringify(original).includes('127.0.0.1'), false)
  } finally { await fx.close() }
})

test('task text reads only its registered intact artifact, with explicit Unicode pagination and permission proof', async () => {
  const fx = await fixture()
  try {
    const text = '手机😀任务附件\n第二行内容'
    const bytes = Buffer.from(text)
    const path = join(fx.root, 'task-upload.txt')
    await writeFile(path, bytes)
    const registered = await registerArtifact({ store: fx.store, agent, groups: ['photos'], file: { file_path: path, name: 'task-upload.txt', mime_type: 'text/plain', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), permissionRequirements: [proof] } })
    const checked = []
    const read = phoneFileTools({ agent, job: fx.job, cloud: fx.cloud, store: fx.store, env: {}, authorize: async (groups, file) => { checked.push([groups, file.permissionRequirements]) }, emit: () => undefined }).find((tool) => tool.name === 'phone_file_read')
    const first = (await read.execute('first', { file_path: registered.file_path, limit: 4 })).details
    const next = (await read.execute('next', { file_path: registered.file_path, offset: first.next_offset, limit: 32768 })).details
    assert.equal(first.text, '手机😀任')
    assert.equal(first.eof, false)
    assert.equal(first.text + next.text, text)
    assert.equal(next.eof, true)
    assert.equal(next.total_chars, Array.from(text).length)
    assert.ok(checked.length >= 4)
    assert.deepEqual(checked[0][1], [proof])
    assert.deepEqual(fx.job.permissionRequirements, [proof])
    const list = phoneFileTools({ agent, job: fx.job, cloud: fx.cloud, store: fx.store, env: {}, authorize: async () => undefined, emit: () => undefined }).find((tool) => tool.name === 'phone_file_list')
    const directory = registered.file_path.slice(0, registered.file_path.lastIndexOf('/'))
    const listing = (await list.execute('registered-folder', { folder_path: directory })).details
    assert.ok(listing.files.some((entry) => entry.file_path === registered.file_path))
    assert.equal((await list.execute('unregistered-folder', { folder_path: '/etc' })).details.files.length, 0)
    await assert.rejects(read.execute('arbitrary', { file_path: '/etc/hosts' }), { code: 'not_granted' })
    await assert.rejects(read.execute('binary', { file_path: fx.artifact.data.file_path }), { code: 'unsupported' })
    await writeFile(path, Buffer.alloc(bytes.length, 65))
    await assert.rejects(read.execute('changed', { file_path: registered.file_path }), { code: 'file_changed' })
  } finally { await fx.close() }
})

test('text permission revoked during a file read prevents returning the private page', async () => {
  const fx = await fixture()
  try {
    const path = join(fx.root, 'private.txt')
    const bytes = Buffer.from('private-text-must-not-be-delivered')
    await writeFile(path, bytes)
    const registered = await registerArtifact({ store: fx.store, agent, groups: ['photos'], file: { file_path: path, name: 'private.txt', mime_type: 'text/plain', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), permissionRequirements: [proof] } })
    let checks = 0
    const read = phoneFileTools({ agent, job: fx.job, cloud: fx.cloud, store: fx.store, env: {}, authorize: async () => { if (++checks > 1) throw Object.assign(new Error('photo permission revoked during read'), { code: 'os_permission' }) }, emit: () => undefined }).find((tool) => tool.name === 'phone_file_read')
    await assert.rejects(read.execute('revoked', { file_path: registered.file_path }), { code: 'os_permission' })
    assert.equal(checks, 2)
  } finally { await fx.close() }
})
