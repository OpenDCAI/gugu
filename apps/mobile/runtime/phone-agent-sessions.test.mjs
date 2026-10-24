import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { openPhoneAgentStore } from './phone-agent-store.mjs'
import { registerArtifact } from './phone-agent-files.mjs'
import { createPhoneSessionTools } from './phone-agent-sessions.mjs'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'phone-session-files-'))
  const store = await openPhoneAgentStore(root, randomUUID())
  const agent = { agentUserId: randomUUID(), sessionId: randomUUID(), displayName: 'sender' }
  const receiver = { agentUserId: randomUUID(), sessionId: randomUUID() }
  store.state.agents = { [agent.agentUserId]: agent, [receiver.agentUserId]: receiver }
  const job = { id: randomUUID(), usedGroups: ['photos'] }
  const bytes = Buffer.from([0, 255, 128, 5, 0, 17])
  const path = join(root, 'original.bin'); await writeFile(path, bytes)
  const artifact = await registerArtifact({ store, agent, groups: ['photos'], file: {
    file_path: path, name: 'original.bin', size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), permissionRequirements: [{ permissions: ['READ_MEDIA_IMAGES'] }],
  } })
  const requests = []; const delivered = []; let permission = true; let failSecond = false; let commits = 0
  const endpoint = { supabaseUrl: 'https://files.invalid', anonKey: 'public', token: 'private', fetch: async (url, init) => {
    requests.push([String(url), init])
    if (String(url).endsWith('/upload')) return Response.json({ staging_key: `staging/${requests.length}`, url: 'https://objects.invalid/upload', fields: {}, method: 'PUT', max_bytes: 100 })
    if (String(url) === 'https://objects.invalid/upload') return new Response(null, { status: 204 })
    if (String(url).endsWith('/session-commit')) {
      const body = JSON.parse(init.body)
      if (failSecond && ++commits === 2) return Response.json({ error: 'denied', message: 'refused second file' }, { status: 403 })
      return Response.json({ attachment: { attachment_id: body.attachment_id, file_name: body.file_name, sha256: artifact.sha256, size_bytes: bytes.length, content_type: 'application/octet-stream' } })
    }
    if (String(url).endsWith('/session-revoke')) return Response.json({ ok: true })
    throw new Error('Unexpected HTTP route')
  } }
  const tools = createPhoneSessionTools({ agent, job, store, cloud: { attachmentEndpoint: async () => endpoint }, deviceId: 'this-phone', requester: {},
    authorize: async (_groups, file) => { if (!permission) throw new Error('permission revoked'); if (file) assert.deepEqual(file.permissionRequirements, [{ permissions: ['READ_MEDIA_IMAGES'] }]) },
    invoke: async (_method, [_caller, action]) => {
      delivered.push(action)
      return { recipients: [{ to: `session:${receiver.sessionId}`, status: 'delivered' }] }
    }, emit: () => undefined,
  })
  return { store, artifact, receiver, bytes, requests, delivered, send: tools.find(tool => tool.name === 'session_message'), revoke: () => { permission = false }, failSecond: () => { failSecond = true }, close: () => rm(root, { recursive: true, force: true }) }
}

test('phone session_message uploads original bytes and durably delivers scoped references; retries reuse the receipt', async () => {
  const fx = await fixture()
  try {
    const args = { to: [`session:${fx.receiver.sessionId}`], text: 'complete original', files: [{ file_path: fx.artifact.file_path }] }
    await fx.send.execute('call-one', args); await fx.send.execute('call-one', args)
    assert.equal(fx.requests.filter(([url]) => url.endsWith('/session-commit')).length, 1)
    assert.deepEqual(Buffer.from(await fx.requests.find(([url]) => url === 'https://objects.invalid/upload')[1].body.arrayBuffer()), fx.bytes)
    const commit = JSON.parse(fx.requests.find(([url]) => url.endsWith('/session-commit'))[1].body)
    assert.deepEqual(commit.recipient_user_ids, [fx.receiver.agentUserId])
    assert.equal(fx.delivered[0].attachments[0].attachment_id, commit.attachment_id)
    assert.equal(JSON.stringify(fx.delivered).includes(fx.bytes.toString('base64')), false)
    fx.revoke()
    await assert.rejects(fx.send.execute('call-one', args), /permission revoked/)
    assert.equal(fx.delivered.length, 2)
  } finally { await fx.close() }
})

test('phone attachment preparation validates every artifact and revokes only new references after a partial failure', async () => {
  const fx = await fixture()
  try {
    const args = { to: [`session:${fx.receiver.sessionId}`], text: 'two files', files: [{ file_path: fx.artifact.file_path }, { file_path: '/unregistered' }] }
    await assert.rejects(fx.send.execute('invalid', args), /登记/)
    assert.equal(fx.requests.length, 0)
    fx.failSecond(); args.files[1].file_path = fx.artifact.file_path
    await assert.rejects(fx.send.execute('partial', args), /refused second/)
    assert.equal(fx.delivered.length, 0)
    const revoked = JSON.parse(fx.requests.find(([url]) => url.endsWith('/session-revoke'))[1].body)
    const first = JSON.parse(fx.requests.find(([url]) => url.endsWith('/session-commit'))[1].body)
    assert.equal(revoked.attachment_id, first.attachment_id)
  } finally { await fx.close() }
})
