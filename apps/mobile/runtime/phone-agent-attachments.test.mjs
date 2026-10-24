import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPhoneAttachmentApi } from './phone-agent-attachments.mjs'
import { registerArtifact } from './phone-agent-files.mjs'
import { openPhoneAgentStore } from './phone-agent-store.mjs'
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_FOLDER_FILES, REMOTE_WORKSPACE_CHUNK_BYTES } from '../../../packages/session-core/src/session-record/workspace-contract.ts'

const ownerId = '68a158dd-1832-4671-ac02-ebde330d3d7a'
const agent = { agentUserId: '558fcc98-9d61-4054-8a18-900d969b1849', sessionId: '13226587-813a-4e58-a023-dc419aeab890' }
const second = { agentUserId: '228fcc98-9d61-4054-8a18-900d969b1849', sessionId: '23226587-813a-4e58-a023-dc419aeab890' }
const input = { sessionId: agent.sessionId, uploadId: 'upload-0001' }
const content = Buffer.from('complete private task attachment')
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gugu-phone-attachment-'))
  let store = await openPhoneAgentStore(root, ownerId)
  store.state.agents[agent.agentUserId] = { ...agent }
  store.state.agents[second.agentUserId] = { ...second }
  await store.save()
  let allowed = true
  let registration = registerArtifact
  const options = () => ({ ownerId, store, findSession: (id) => Object.values(store.state.agents).find((item) => item.sessionId === id), verifyAgent: async () => { if (!allowed) throw Object.assign(new Error('owner binding revoked'), { code: 'not_authorized' }) }, registerArtifact: (args) => registration(args) })
  let api = createPhoneAttachmentApi(options())
  return {
    get store() { return store },
    options,
    setAllowed(value) { allowed = value },
    setRegister(value) { registration = value },
    async restart() { store = await openPhoneAgentStore(root, ownerId); api = createPhoneAttachmentApi(options()) },
    async call(method, args) { return (await api.invoke(`sessionCreate.${method}`, [args])).value },
    async write(extra = {}) { return this.call('writeAttachmentChunk', { ...input, segments: ['note.txt'], offset: 0, total: content.length, data: [...content], ...extra }) },
    async commit(extra = {}) { return this.call('commitAttachmentUpload', { ...input, kind: 'file', name: 'note.txt', ...extra }) },
    async discard(extra = {}) { return this.call('discardAttachmentUpload', { ...input, ...extra }) },
    async close() { await rm(root, { recursive: true, force: true }) },
  }
}
const okay = (result) => { assert.equal(result.success, true, JSON.stringify(result)); return result.data }
const rejected = (result, code) => { assert.equal(result.success, false, JSON.stringify(result)); if (code) assert.equal(result.error.type, code); return result.error }

test('real composer three-RPC contract accepts JSON and typed bytes, returning only a complete registered private path', async () => {
  const fx = await fixture()
  try {
    const split = 9
    okay(await fx.write({ data: new Uint8Array(content.subarray(0, split)) }))
    okay(await fx.write({ offset: split, data: { ...new Uint8Array(content.subarray(split)) } }))
    const file = okay(await fx.commit({ mimeType: 'text/plain', originalPath: '/outside/untrusted-secret.txt' }))
    assert.deepEqual(await readFile(file.storedPath), content)
    assert.equal(file.mentionPath, file.storedPath)
    assert.equal(file.originalPath, undefined)
    assert.equal(file.size, content.length)
    assert.equal(file.sha256, sha256(content))
    assert.equal(file.storedPath.startsWith(join(await realpath(fx.store.directory), 'task-attachments', agent.sessionId)), true)
    const artifact = Object.values(fx.store.state.artifacts)[0]
    assert.equal(artifact.ownerId, ownerId)
    assert.equal(artifact.sessionId, agent.sessionId)
    assert.equal(artifact.agentUserId, agent.agentUserId)
    assert.deepEqual(artifact.groups, [])
    assert.deepEqual(artifact.permissionRequirements, [])
    assert.equal((await stat(file.storedPath)).mode & 0o777, 0o600)
    assert.equal(Object.keys(fx.store.state.jobs).length, 0)
    assert.equal(Object.keys(fx.store.state.outbox).length, 0)
  } finally { await fx.close() }
})

test('concurrent duplicate chunks and commit retries are idempotent; changed retry bytes cannot replace committed content', async () => {
  const fx = await fixture()
  try {
    const writes = await Promise.all([fx.write(), fx.write()])
    writes.forEach(okay)
    const file = okay(await fx.commit())
    assert.deepEqual(okay(await fx.commit()), file)
    okay(await fx.write())
    rejected(await fx.write({ data: Array(content.length).fill(0) }), 'offset_mismatch')
    rejected(await fx.commit({ name: 'changed.txt' }), 'bad_request')
    assert.deepEqual(await readFile(file.storedPath), content)
    assert.equal(Object.keys(fx.store.state.artifacts).length, 1)
    assert.equal(Object.values(fx.store.state.attachmentUploads)[0].files[0].chunks.length, 1)
  } finally { await fx.close() }
})

test('owner, registered agent and session bindings are checked on every operation', async () => {
  const fx = await fixture()
  try {
    okay(await fx.write())
    rejected(await fx.commit({ sessionId: second.sessionId }), 'not_found')
    fx.setAllowed(false)
    rejected(await fx.commit(), 'not_authorized')
    assert.equal(Object.keys(fx.store.state.artifacts).length, 0)
    fx.setAllowed(true)
    fx.store.state.agents[agent.agentUserId].sessionId = second.sessionId
    rejected(await fx.commit(), 'not_found')
    assert.throws(() => createPhoneAttachmentApi({ ...fx.options(), ownerId: '88a158dd-1832-4671-ac02-ebde330d3d7a' }), /不属于/)
    assert.equal(await createPhoneAttachmentApi(fx.options()).invoke('sessionTimeline.sessionSend', []), null)
  } finally { await fx.close() }
})

test('invalid paths, sparse bytes, numeric overflows and oversized chunks are rejected before any artifact admission', async () => {
  const fx = await fixture()
  try {
    for (const segments of [['..', 'outside'], ['/outside'], ['folder', 'a/b'], ['folder', 'a\\b'], ['\0bad'], [], ['.']]) rejected(await fx.write({ segments }), 'bad_request')
    for (const offset of [-1, 0.1, NaN, Infinity]) rejected(await fx.write({ offset }), 'bad_request')
    for (const total of [-1, 1.1, NaN, Infinity]) rejected(await fx.write({ total }), 'bad_request')
    for (const data of [[-1], [256], [1.1], { 1: 2 }, { 0: 2, extra: 1 }, [undefined]]) rejected(await fx.write({ data }), 'bad_request')
    rejected(await fx.write({ total: MAX_ATTACHMENT_BYTES + 1 }), 'too_large')
    rejected(await fx.write({ total: REMOTE_WORKSPACE_CHUNK_BYTES + 1, data: new Uint8Array(REMOTE_WORKSPACE_CHUNK_BYTES + 1) }), 'too_large')
    rejected(await fx.write({ sessionId: '../session' }), 'bad_request')
    assert.equal(Object.keys(fx.store.state.artifacts).length, 0)
  } finally { await fx.close() }
})

test('incomplete or modified uploads never commit; cancelling removes partial bytes', async () => {
  const fx = await fixture()
  try {
    okay(await fx.write({ data: [...content.subarray(0, 5)] }))
    rejected(await fx.commit(), 'attachment_incomplete')
    rejected(await fx.write({ offset: 6, data: [...content.subarray(6)] }), 'offset_mismatch')
    const partial = join(fx.store.directory, 'task-attachments', agent.sessionId, '.incoming', input.uploadId, 'note.txt')
    await writeFile(partial, Buffer.alloc(5, 0))
    okay(await fx.write({ offset: 5, data: [...content.subarray(5)] }))
    rejected(await fx.commit(), 'invalid_attachment')
    assert.equal(Object.keys(fx.store.state.artifacts).length, 0)
    okay(await fx.discard())
    await assert.rejects(stat(partial), { code: 'ENOENT' })
    rejected(await fx.commit(), 'not_found')
    okay(await fx.write())
    const committed = okay(await fx.commit())
    okay(await fx.discard())
    assert.deepEqual(await readFile(committed.storedPath), content)
    assert.equal(Object.keys(fx.store.state.artifacts).length, 1)
  } finally { await fx.close() }
})

test('folder uploads check every complete file and register each file only after the full tree is verified', async () => {
  const fx = await fixture()
  try {
    const write = (segments, data) => fx.write({ segments, data: [...data], total: data.length })
    okay(await write(['folder', 'one.txt'], content))
    okay(await write(['folder', 'nested', 'two.txt'], Buffer.from('second')))
    rejected(await fx.commit({ kind: 'file', name: 'folder' }), 'bad_request')
    const folder = okay(await fx.commit({ kind: 'folder', name: 'folder' }))
    assert.equal(folder.mimeType, 'inode/directory')
    assert.equal(folder.size, content.length + 6)
    assert.deepEqual(await readFile(join(folder.storedPath, 'one.txt')), content)
    assert.equal(Object.keys(fx.store.state.artifacts).length, 2)
    assert.equal(Object.values(fx.store.state.artifacts).every((file) => file.file_path.startsWith(folder.storedPath) && file.sha256.length === 64), true)
  } finally { await fx.close() }
})

test('a failed artifact registration publishes no partial folder and a retry can finish the same upload', async () => {
  const fx = await fixture()
  try {
    okay(await fx.write({ segments: ['folder', 'one.txt'] }))
    okay(await fx.write({ segments: ['folder', 'two.txt'] }))
    let registered = 0
    fx.setRegister(async (args) => { const result = await registerArtifact(args); if (++registered === 2) throw new Error('disk save failed'); return result })
    rejected(await fx.commit({ kind: 'folder', name: 'folder' }), 'persist_failed')
    assert.equal(Object.keys(fx.store.state.artifacts).length, 0)
    assert.equal(Object.values(fx.store.state.attachmentUploads)[0].result, undefined)
    fx.setRegister(registerArtifact)
    const folder = okay(await fx.commit({ kind: 'folder', name: 'folder' }))
    assert.equal(Object.keys(fx.store.state.artifacts).length, 2)
    assert.deepEqual(await readFile(join(folder.storedPath, 'two.txt')), content)
  } finally { await fx.close() }
})

test('durable chunks resume after process restart, including bytes persisted before the receipt journal', async () => {
  const fx = await fixture()
  try {
    okay(await fx.write({ data: [...content.subarray(0, 5)] }))
    await fx.restart()
    okay(await fx.write({ offset: 5, data: [...content.subarray(5)] }))
    const entry = Object.values(fx.store.state.attachmentUploads)[0]
    entry.files[0].chunks.pop(); entry.files[0].received = 5
    await fx.store.save()
    await fx.restart()
    okay(await fx.write({ offset: 5, data: [...content.subarray(5)] }))
    const file = okay(await fx.commit())
    assert.deepEqual(await readFile(file.storedPath), content)
    await fx.restart()
    assert.deepEqual(okay(await fx.commit()), file)
  } finally { await fx.close() }
})

test('a process interrupted before the committing directory rename can retry without losing the upload', async () => {
  const fx = await fixture()
  try {
    okay(await fx.write())
    const entry = Object.values(fx.store.state.attachmentUploads)[0]
    entry.status = 'committing'
    await fx.store.save()
    await fx.restart()
    assert.deepEqual(await readFile(okay(await fx.commit()).storedPath), content)
  } finally { await fx.close() }
})

test('zero-byte files stay valid and folder size/file-count declarations are bounded before receiving bytes', async () => {
  const fx = await fixture()
  try {
    okay(await fx.write({ data: {}, total: 0 }))
    okay(await fx.write({ data: [], total: 0 }))
    const empty = okay(await fx.commit())
    assert.equal(empty.size, 0)
    assert.equal(empty.sha256, sha256(Buffer.alloc(0)))
    okay(await fx.write({ uploadId: 'upload-large', segments: ['folder', 'a'], total: MAX_ATTACHMENT_BYTES, data: [1] }))
    rejected(await fx.write({ uploadId: 'upload-large', segments: ['folder', 'b'], total: 1, data: [1] }), 'too_large')
    const entry = Object.values(fx.store.state.attachmentUploads).find((item) => item.uploadId === 'upload-large')
    entry.files = Array.from({ length: MAX_ATTACHMENT_FOLDER_FILES }, (_, index) => ({ segments: ['folder', String(index)], total: 0, received: 0, chunks: [] }))
    rejected(await fx.write({ uploadId: 'upload-large', segments: ['folder', 'extra'], total: 0, data: [] }), 'too_many_files')
  } finally { await fx.close() }
})


test('an existing symlink cannot turn an attachment chunk into an arbitrary file write', async () => {
  const fx = await fixture()
  try {
    const outside = join(fx.store.directory, 'outside.txt')
    await writeFile(outside, 'unchanged')
    const directory = join(fx.store.directory, 'task-attachments', agent.sessionId, '.incoming', input.uploadId)
    await mkdir(directory, { recursive: true })
    await symlink(outside, join(directory, 'note.txt'))
    rejected(await fx.write())
    assert.equal(await readFile(outside, 'utf8'), 'unchanged')
    assert.equal(Object.keys(fx.store.state.artifacts).length, 0)
  } finally { await fx.close() }
})
