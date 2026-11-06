import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, mkdir, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openPhoneAgentStore, admitPhoneJob } from './phone-agent-store.mjs'
import { createPhoneConversationPublisher, recordPhonePersonalReply } from './phone-conversation-publications.mjs'

const owner = '68a158dd-1832-4671-ac02-ebde330d3d7a'
const agent = { agentUserId: '558fcc98-9d61-4054-8a18-900d969b1849', sessionId: 'b359ef15-f6da-4af0-9fac-8cd99b21877c', chatId: 'a540c592-971b-4bcf-89c3-944484a14640' }
const deviceId = 'test-phone'
const context = { agent, deviceId }
const receipt = args => ({ chat_id: args.p_chat_id, already: false, account_revision: '900719925474099312345' })
const input = (route = { kind: 'task', senderUserId: owner }) => ({ id: randomUUID(), agentUserId: agent.agentUserId, prompt: '真实个人输入', route })
const complete = (id, text = '给主人的回复') => ({ kind: 'complete', id, at: 1730000000123, content: [{ type: 'text', text }] })
const journal = store => readFile(join(store.directory, 'host.json'), 'utf8').then(JSON.parse)
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'gugu-phone-publication-'))
  try { await run(await openPhoneAgentStore(root, owner), root) }
  finally { await rm(root, { recursive: true, force: true }) }
}
function publisher(store, rpc, options = {}) {
  return createPhoneConversationPublisher({ store, cloud: { rpc }, isReady: () => true, authorize: async () => undefined, warn: () => undefined, ...options })
}

test('personal input and UUID outbox are atomic; duplicate admission retains the original message and timestamp', () => fixture(async store => {
  const original = input()
  const job = await admitPhoneJob(store, original, context)
  const saved = await journal(store)
  const message = saved.jobs[job.id].personalMessages.input
  assert.equal(message.text, original.prompt)
  assert.match(message.publicationId, /^[0-9a-f-]{36}$/)
  const entry = saved.conversationOutbox[message.publicationId]
  assert.equal(entry.occurredAt, job.createdAt)
  assert.equal(entry.sessionId, agent.sessionId)
  assert.notEqual(entry.id, job.id)
  await admitPhoneJob(store, { ...original, prompt: '重复回执不更换正文' }, context)
  assert.deepEqual((await journal(store)).conversationOutbox, saved.conversationOutbox)
  assert.deepEqual(job.personalMessages, saved.jobs[job.id].personalMessages)
}))

test('multiple visible replies in one job get separate durable UUIDs; stream fragments and provider aliases retain each UUID', () => fixture(async (store, root) => {
  const job = await admitPhoneJob(store, input(), context)
  job.status = 'running'
  assert.equal(recordPhonePersonalReply(store, job, agent, deviceId, { kind: 'delta', id: 'first', text: '片段' }), false)
  assert.equal(recordPhonePersonalReply(store, job, agent, deviceId, complete('first')), true)
  const first = job.personalMessages.first.publicationId
  recordPhonePersonalReply(store, job, agent, deviceId, complete('first', '同一消息最终落定'))
  recordPhonePersonalReply(store, job, agent, deviceId, { kind: 'committed', id: 'first', recordId: 'pi-original' })
  recordPhonePersonalReply(store, job, agent, deviceId, { kind: 'committed', id: 'first', recordId: 'pi-alias' })
  recordPhonePersonalReply(store, job, agent, deviceId, complete('second'))
  assert.notEqual(job.personalMessages.second.publicationId, first)
  assert.equal(Object.keys(store.state.conversationOutbox).length, 3)
  assert.deepEqual(job.personalMessages.first.aliases, ['pi-original', 'pi-alias'])
  await store.save()
  const cold = await openPhoneAgentStore(root, owner)
  assert.deepEqual(cold.state.conversationOutbox, store.state.conversationOutbox)
  assert.equal(cold.state.jobs[job.id].personalMessages.first.publicationId, first)
  assert.equal(recordPhonePersonalReply(cold, cold.state.jobs[job.id], agent, deviceId, complete('late')), false)
}))

test('legacy history, group work, session deliveries, status events and NO_REPLY never create personal publications', () => fixture(async (store, root) => {
  const legacy = await admitPhoneJob(store, input())
  for (const route of [{ kind: 'chat', chatId: randomUUID(), senderUserId: owner }, { kind: 'session-direct' }, { kind: 'task', senderUserId: randomUUID() }]) {
    const job = await admitPhoneJob(store, input(route), context)
    job.status = 'running'
    assert.equal(recordPhonePersonalReply(store, job, agent, deviceId, complete('background')), false)
  }
  legacy.status = 'done'
  await store.save()
  const cold = await openPhoneAgentStore(root, owner)
  assert.deepEqual(cold.state.conversationOutbox, {})
  const job = await admitPhoneJob(cold, input(), context)
  job.status = 'running'
  const before = structuredClone(cold.state.conversationOutbox)
  for (const event of [complete('empty', '  '), complete('silent', '[NO_REPLY]'), { kind: 'complete', id: 'tool', content: [{ type: 'toolCall', id: 't' }] }, { kind: 'committed', id: 'unknown', recordId: 'historical' }, { kind: 'phase', phase: 'model' }]) assert.equal(recordPhonePersonalReply(cold, job, agent, deviceId, event), false)
  assert.deepEqual(cold.state.conversationOutbox, before)
}))

test('failed real journal writes prevent publication; retry durably saves the original identity before RPC', () => fixture(async store => {
  const path = join(store.directory, 'host.json'), backup = `${path}.before`
  await rename(path, backup); await mkdir(path)
  const request = input()
  await assert.rejects(admitPhoneJob(store, request, context))
  const id = store.state.jobs[request.id].personalMessages.input.publicationId
  let calls = 0
  const pump = publisher(store, async (_schema, _name, args) => {
    calls++
    const saved = await journal(store)
    assert.equal(saved.jobs[request.id].personalMessages.input.publicationId, id)
    assert.equal(saved.conversationOutbox[id].id, args.p_message_id)
    return receipt(args)
  })
  try {
    await pump.kick(); assert.equal(calls, 0)
    await rm(path, { recursive: true }); await rename(backup, path)
    await admitPhoneJob(store, request, context)
    await pump.kick(); assert.equal(calls, 1)
    assert.equal((await journal(store)).conversationOutbox[id].status, 'published')
  } finally { await pump.close() }
}))

test('a lost server receipt survives restart and retries the identical payload without converting the revision to number', () => fixture(async (store, root) => {
  const job = await admitPhoneJob(store, input(), context)
  const requests = []
  const first = publisher(store, async (_schema, name, args) => {
    assert.equal(name, 'publish_native_conversation_message')
    requests.push(structuredClone(args))
    throw new Error('receipt lost after server commit')
  })
  await first.kick(); await first.close()
  const cold = await openPhoneAgentStore(root, owner)
  const retried = publisher(cold, async (schema, name, args) => {
    assert.equal(schema, 'chat'); assert.equal(name, 'publish_native_conversation_message')
    requests.push(structuredClone(args))
    assert.deepEqual(args, requests[0])
    return { ...receipt(args), already: true }
  })
  try {
    await retried.kick()
    assert.equal(requests.length, 2)
    const entry = (await journal(cold)).conversationOutbox[job.personalMessages.input.publicationId]
    assert.equal(entry.receipt.already, true)
    assert.equal(entry.receipt.account_revision, '900719925474099312345')
    assert.equal(Object.hasOwn(requests[0], 'text'), false)
  } finally { await retried.close() }
}))

test('authentication gating retains work and new admissions during a single flight are published in journal order', () => fixture(async store => {
  let ready = false, release, started
  const pending = new Promise(resolve => { release = resolve })
  const entered = new Promise(resolve => { started = resolve })
  const calls = []
  const pump = publisher(store, async (_schema, _name, args) => {
    calls.push(args.p_message_id)
    if (calls.length === 1) { started(); await pending }
    return receipt(args)
  }, { isReady: () => ready })
  try {
    const one = await admitPhoneJob(store, input(), context)
    await pump.kick(); assert.deepEqual(calls, [])
    ready = true
    const flight = pump.kick()
    await entered
    const two = await admitPhoneJob(store, input(), context)
    assert.equal(pump.kick(), flight)
    release(); await flight
    assert.deepEqual(calls, [one.personalMessages.input.publicationId, two.personalMessages.input.publicationId])
  } finally { release(); await pump.close() }
}))

test('missing backend and invalid receipts remain pending, then a successful kick confirms the same UUID', () => fixture(async store => {
  const job = await admitPhoneJob(store, input(), context)
  const id = job.personalMessages.input.publicationId
  let attempt = 0
  const pump = publisher(store, async (_schema, _name, args) => {
    assert.equal(args.p_message_id, id)
    attempt++
    if (attempt === 1) throw Object.assign(new Error('RPC not installed'), { code: 'PGRST202' })
    if (attempt === 2) return { ...receipt(args), account_revision: 1 }
    return receipt(args)
  })
  try {
    await pump.kick(); assert.equal(store.state.conversationOutbox[id].status, 'pending')
    await pump.kick(); assert.equal(store.state.conversationOutbox[id].status, 'pending')
    await pump.kick(); assert.equal(store.state.conversationOutbox[id].status, 'published')
  } finally { await pump.close() }
}))

test('reply authorization is rechecked before metadata publication and close prevents later sends', () => fixture(async store => {
  const job = await admitPhoneJob(store, input(), context)
  job.status = 'running'; job.usedGroups = ['contacts']
  recordPhonePersonalReply(store, job, agent, deviceId, complete('reply'))
  await store.save()
  let calls = 0, authorized = 0
  const pump = publisher(store, async (_schema, _name, args) => { calls++; return receipt(args) }, { authorize: async groups => { authorized++; assert.deepEqual(groups, ['contacts']); throw Object.assign(new Error('revoked'), { code: 'revoked' }) } })
  await pump.kick()
  assert.equal(calls, 1); assert.equal(authorized, 1)
  assert.equal(store.state.conversationOutbox[job.personalMessages.reply.publicationId].status, 'pending')
  await pump.close(); await pump.kick()
  assert.equal(calls, 1)
}))

test('a journal failure after the RPC receipt keeps the original publication pending for an idempotent retry', () => fixture(async store => {
  const job = await admitPhoneJob(store, input(), context)
  const id = job.personalMessages.input.publicationId
  const path = join(store.directory, 'host.json'), backup = `${path}.before-ack`
  const requests = []
  const pump = publisher(store, async (_schema, _name, args) => {
    requests.push(structuredClone(args))
    if (requests.length === 1) { await rename(path, backup); await mkdir(path) }
    return { ...receipt(args), already: requests.length > 1 }
  })
  try {
    await pump.kick()
    assert.equal(store.state.conversationOutbox[id].status, 'pending')
    await rm(path, { recursive: true }); await rename(backup, path)
    await pump.kick()
    assert.deepEqual(requests[0], requests[1])
    assert.equal((await journal(store)).conversationOutbox[id].receipt.already, true)
  } finally { await pump.close() }
}))

test('a transient publication failure schedules its own retry without waiting for a heartbeat', () => fixture(async store => {
  await admitPhoneJob(store, input(), context)
  let calls = 0
  const pump = publisher(store, async (_schema, _name, args) => { if (++calls === 1) throw new Error('offline'); return receipt(args) }, { retryMs: 5 })
  try {
    await pump.kick()
    const deadline = Date.now() + 5_000
    while (Object.values((await journal(store)).conversationOutbox)[0].status !== 'published') {
      assert.ok(Date.now() < deadline, 'publication retry did not complete')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(calls, 2)
  } finally { await pump.close() }
}))

test('a denied old reply cannot block later inputs, including admissions while that attempt is in flight', () => fixture(async store => {
  const job = await admitPhoneJob(store, input(), context)
  job.status = 'running'; job.usedGroups = ['contacts']
  recordPhonePersonalReply(store, job, agent, deviceId, complete('revoked-reply'))
  await store.save()
  const later = await admitPhoneJob(store, input(), context)
  const published = [], denied = []
  const pump = publisher(store, async (_schema, _name, args) => { published.push(args.p_message_id); return receipt(args) }, { authorize: async () => {
    denied.push(true)
    await admitPhoneJob(store, input(), context)
    void pump.kick()
    throw Object.assign(new Error('permission revoked'), { code: 'revoked' })
  } })
  try {
    await pump.kick()
    assert.equal(denied.length, 1)
    assert.ok(published.includes(later.personalMessages.input.publicationId))
    assert.equal(published.length, 3)
    assert.equal(store.state.conversationOutbox[job.personalMessages['revoked-reply'].publicationId].status, 'pending')
  } finally { await pump.close() }
}))
