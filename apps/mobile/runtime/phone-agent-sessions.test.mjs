import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { openPhoneAgentStore } from './phone-agent-store.mjs'
import { registerArtifact } from './phone-agent-files.mjs'
import { createPhoneAssistantWork } from './phone-assistant-work.mjs'
import { createPhoneSessionTools } from './phone-agent-sessions.mjs'
import { buildSessionDirectEnvelope } from '../../../packages/core/src/local/agent/deliveryEnvelope.ts'

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
  const queued = new Map()
  agent.assistantWork = {assistant_id:receiver.agentUserId}
  const cloud = { attachmentEndpoint: async () => endpoint, identity: {rpc:async(name,args)=>{
    if(name==='assistant_work_history')return {data:{work:{work_id:args.p_work_id,assistant_user_id:receiver.agentUserId,
      coordinator_session_id:receiver.sessionId,coordinator_device_id:'this-phone',executors:[{session_id:agent.sessionId,device_id:'this-phone'}]},events:[]},error:null}
    if(name==='assistant_work_commit'){
      for(const event of args.p_events){
        if(queued.has(event.message_id))assert.deepEqual(queued.get(event.message_id),event)
        queued.set(event.message_id,event)
      }
      return {data:{work_id:args.p_work_id,event_ids:args.p_events.map(e=>e.message_id),outcome:'completed',terminal_version:'1'},error:null}
    }
    throw new Error(`Unexpected work RPC: ${name}`)
  }} }
  const work = createPhoneAssistantWork({ownerId:store.state.ownerId,deviceId:'this-phone',instanceId:randomUUID(),cloud,store,isReady:()=>true,invoke:async()=>{throw new Error('Report must not be directly delivered')},kick:()=>{}})
  const tools = createPhoneSessionTools({ agent, job, store, cloud, work, deviceId: 'this-phone', requester: {},
    authorize: async (_groups, file) => { if (!permission) throw new Error('permission revoked'); if (file) assert.deepEqual(file.permissionRequirements, [{ permissions: ['READ_MEDIA_IMAGES'] }]) },
    invoke: async (_method, [_caller, action]) => {
      delivered.push(action)
      return { recipients: [{ to: `session:${receiver.sessionId}`, status: 'delivered' }] }
    }, emit: () => undefined,
  })
  return { agent, job, store, artifact, receiver, bytes, requests, delivered, queued, send: tools.find(tool => tool.name === 'session_message'), revoke: () => { permission = false }, failSecond: () => { failSecond = true }, close: () => rm(root, { recursive: true, force: true }) }
}

function dispatch(fx,purpose) {
  const work_id=randomUUID()
  fx.job.prompt=buildSessionDirectEnvelope({senderSessionId:fx.receiver.sessionId,senderTitle:'Assistant',messageId:fx.job.id,at:'2026-10-27T06:00:00Z',
    content:`Please reply\n<gugu_work>\n${JSON.stringify({work_id,coordinator:`session:${fx.receiver.sessionId}`,assistant_id:fx.receiver.agentUserId,purpose,report:'Return the result'})}\n</gugu_work>`})
  return work_id
}

test('an inquiry completes on its first real ordinary reply through the existing work queue',async()=>{
  const fx=await fixture()
  try {
    const work_id=dispatch(fx,'reply')
    delete fx.agent.assistantWork // Reusing an independently created task still has its host-bound dispatch.
    const args={to:[`session:${fx.receiver.sessionId}`],text:'收到，测试正文'}
    await fx.send.execute('ordinary-reply',args)
    await fx.send.execute('ordinary-reply',args)
    assert.equal(fx.delivered.length,0)
    assert.equal(fx.queued.size,1)
    assert.equal([...fx.queued.values()][0].kind,'completed')
    assert.equal([...fx.queued.values()][0].content,'收到，测试正文')
    assert.equal(fx.requests.length,0)
    assert.ok(work_id)
  } finally {await fx.close()}
})

test('an assignment asks for status before sending, accepts progress and loses no original reply',async()=>{
  const fx=await fixture()
  try {
    const work_id=dispatch(fx,'task'),args={to:[`session:${fx.receiver.sessionId}`],text:'收到，开始做'}
    await assert.rejects(fx.send.execute('missing-status',args),/work_result.*progress/)
    assert.equal(fx.delivered.length,0);assert.equal(fx.queued.size,0)
    const corrected={...args,work_result:{work_id,status:'progress'}}
    await fx.send.execute('corrected-status',corrected)
    await fx.send.execute('corrected-status',corrected)
    assert.equal(fx.queued.size,1)
    assert.deepEqual([...fx.queued.values()].map(row=>[row.kind,row.content]),[['progress','收到，开始做']])
    assert.equal(fx.delivered.length,0)
  } finally {await fx.close()}
})

test('phone session_message uploads original bytes and queues scoped work references; retries reuse the same event', async () => {
  const fx = await fixture()
  try {
    const work = { work_id: randomUUID(), status: 'completed' }
    const args = { to: [`session:${fx.receiver.sessionId}`], text: 'complete original', files: [{ file_path: fx.artifact.file_path }], work_result: work }
    const first = await fx.send.execute('call-one', args); const second = await fx.send.execute('call-one', args)
    assert.equal(first.details.status,'accepted'); assert.deepEqual(second.details,first.details)
    assert.equal(fx.requests.filter(([url]) => url.endsWith('/session-commit')).length, 1)
    assert.deepEqual(Buffer.from(await fx.requests.find(([url]) => url === 'https://objects.invalid/upload')[1].body.arrayBuffer()), fx.bytes)
    const commit = JSON.parse(fx.requests.find(([url]) => url.endsWith('/session-commit'))[1].body)
    assert.deepEqual(commit.recipient_user_ids, [fx.receiver.agentUserId])
    assert.equal(fx.queued.size,1)
    assert.equal([...fx.queued.values()][0].attachment_refs[0].attachment_id,commit.attachment_id)
    assert.equal([...fx.queued.values()][0].kind,'completed')
    assert.equal(JSON.stringify([...fx.queued.values()]).includes(fx.bytes.toString('base64')), false)
    fx.revoke()
    await assert.rejects(fx.send.execute('call-one', args), /permission revoked/)
    assert.equal(fx.delivered.length, 0)
    assert.equal(fx.queued.size,1)
  } finally { await fx.close() }
})

test('the active phone session tool exposes and validates correlated results before delivery', async () => {
  const fx = await fixture()
  try {
    assert.ok(fx.send.parameters.properties.work_result)
    await assert.rejects(fx.send.execute('invalid-report', { to: [`session:${fx.receiver.sessionId}`], text: 'result', work_result: { work_id: randomUUID(), status: 'idle' } }))
    assert.equal(fx.delivered.length, 0)
    assert.equal(fx.requests.length, 0)
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
