import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createPhoneActionRuntime } from './phone-actions.mjs'

async function fixture(nativeOverride) {
  const ownerId = randomUUID()
  const agent = { agentUserId: randomUUID(), sessionId: randomUUID(), chatId: randomUUID() }
  const job = { id: randomUUID(), agentUserId: agent.agentUserId, route: { kind: 'chat', chatId: agent.chatId, sourceMessageId: randomUUID(), senderUserId: ownerId } }
  const state = { ownerId, agents: { [agent.agentUserId]: agent }, jobs: {}, outbox: {}, confirmations: {} }
  const store = { state, save: async () => {} }
  const writes = []
  let revoked = false
  const api = await createPhoneActionRuntime({ ownerId, store,
    cloud: { rpc: async (_schema, _name, args) => [{ id: args.p_message_id }] }, emit: () => {}, sendSession: async () => {}, getManifest: () => [],
    nativeCall: async (name, args, _signal, metadata) => {
      if (nativeOverride) return nativeOverride(name, args, _signal, metadata)
      if (name === 'permissions.check' || name === 'permissions.preflight') return revoked ? { ok: false, code: 'not_granted', message: '撤权' } : { ok: true }
      assert.equal(name, 'phone.native')
      writes.push({ args: structuredClone(args), metadata: structuredClone(metadata) })
      return { ok: true, data: { event_id: '42' }, permissionRequirements: { permissions: ['android.permission.WRITE_CALENDAR'], mediaRefs: [] } }
    },
  })
  const call = api.tools({ agent, job }).find((tool) => tool.name === 'phone_call')
  const args = { title: '会议', start: '2026-10-20T20:00:00+08:00', end: '2026-10-20T21:00:00+08:00' }
  return { ownerId, agent, job, state, writes, api, call, args, revoke: () => { revoked = true } }
}

test('models cannot manufacture approval and valid writes create a task settlement without sending a DM', async () => {
  const f = await fixture()
  const forged = await f.call.execute('forged', { name: 'calendar.events.create', args: { ...f.args, confirmed: true } })
  assert.equal(forged.details.code, 'invalid_args')
  assert.equal(f.writes.length, 0)
  assert.equal(Object.keys(f.state.outbox).length, 0)
  const requested = await f.call.execute('request', { name: 'calendar.events.create', args: f.args })
  assert.equal(requested.details.code, 'needs_confirmation')
  assert.equal(f.writes.length, 0)
  assert.deepEqual(f.state.outbox, {})
  const [question] = f.api.settlements(f.agent)
  assert.equal(question.state, 'pending')
  assert.equal(question.kind, 'permission')
  assert.deepEqual(question.options.map((option) => option.optionId), ['approve', 'cancel'])
})

test('DM messages and their sender metadata cannot approve an operation, including old owner confirmation text', async () => {
  const f = await fixture()
  await f.call.execute('request', { name: 'calendar.events.create', args: f.args })
  const pending = Object.values(f.state.confirmations)[0]
  const row = { id: randomUUID(), chatId: f.agent.chatId, senderUserId: f.ownerId, senderType: 'human', content: `确认 ${pending.code}` }
  assert.equal(f.api.confirmationForMessage(f.agent, { ...row, senderUserId: randomUUID() }), null)
  assert.equal(f.api.confirmationForMessage(f.agent, { ...row, senderType: 'agent' }), null)
  assert.equal(f.api.confirmationForMessage(f.agent, { ...row, content: '确认 deadbeef' }), null)
  assert.equal(f.api.confirmationForMessage(f.agent, row), null)
  await assert.rejects(f.api.runConfirmation(f.agent, { id: row.id, confirmationId: pending.id, confirmationDecision: 'approve', confirmationSource: { messageId: row.id, senderUserId: f.ownerId, chatId: f.agent.chatId } }), /确认来源/)
  assert.equal(f.writes.length, 0)
})

test('revocation between the question and approval prevents the write', async () => {
  const f = await fixture()
  await f.call.execute('request', { name: 'calendar.events.create', args: f.args })
  const pending = Object.values(f.state.confirmations)[0]
  let job
  await f.api.respond(f.agent, { itemId: pending.id, kind: 'permission', optionId: 'approve' }, { kind: 'native-ui', ownerId: f.ownerId }, async (admitted) => { job = admitted })
  f.revoke()
  await assert.rejects(f.api.runConfirmation(f.agent, job), /撤权/)
  assert.equal(f.writes.length, 0)
})

test('bad dates are rejected before asking for confirmation', async () => {
  const f = await fixture()
  const bad = await f.call.execute('bad', { name: 'calendar.events.create', args: { ...f.args, end: '2026-10-20T19:00:00+08:00' } })
  assert.equal(bad.details.code, 'invalid_args')
  assert.equal(f.writes.length, 0)
  assert.equal(Object.keys(f.state.outbox).length, 0)
})

test('the real action catalog renders local time and leaves confirmation authority with the host', async () => {
  const f = await fixture()
  const catalog = f.api.tools(f).find((tool) => tool.name === 'phone_actions')
  const all = (await catalog.execute('catalog', {})).details.actions
  assert.ok(all.length >= 21)
  const calendar = all.find((action) => action.name === 'calendar.events.list')
  assert.match(calendar.description, /UTC[+-]\d{2}:\d{2}/)
  assert.ok(calendar.input_schema.properties.date)
  for (const name of ['recordings.read', 'photos.read']) {
    const description = all.find((action) => action.name === name).description
    assert.match(description, /当前手机任务的 App 私有目录/)
    assert.doesNotMatch(description, /自动.*电脑|供你看/)
  }
  for (const action of all) assert.equal('confirmed' in action.input_schema.properties, false)
})

test('only a trusted native owner response claims a task approval; duplicates and mutated args cannot execute twice', async () => {
  const f = await fixture()
  await f.call.execute('request', { name: 'calendar.events.create', args: f.args })
  const pending = Object.values(f.state.confirmations)[0]
  const input = { conversationId: f.agent.sessionId, itemId: pending.id, kind: 'permission', optionId: 'approve', by: 'invented-owner-label' }
  const admitted = []
  const admit = async (job) => { admitted.push(job); f.state.jobs[job.id] = job }
  await assert.rejects(f.api.respond(f.agent, input, { kind: 'device-rpc', ownerId: f.ownerId }, admit), /不能代替主人/)
  await assert.rejects(f.api.respond(f.agent, input, { kind: 'native-ui', ownerId: randomUUID() }, admit), /不能代替主人/)
  await assert.rejects(f.api.respond(f.agent, { ...input, optionId: 'always_allow' }, { kind: 'native-ui', ownerId: f.ownerId }, admit), /选项无效/)
  assert.equal(admitted.length, 0)
  const answers = await Promise.all([f.api.respond(f.agent, input, { kind: 'native-ui', ownerId: f.ownerId }, admit), f.api.respond(f.agent, input, { kind: 'native-ui', ownerId: f.ownerId }, admit)])
  assert.deepEqual(answers.map((answer) => answer.accepted).sort(), [false, true])
  assert.equal(admitted.length, 1)
  assert.equal(answers.find((answer) => answer.accepted).settlement.resolvedBy, f.ownerId)
  f.args.title = '模型后来替换的参数'
  assert.equal((await f.api.runConfirmation(f.agent, admitted[0])).ok, true)
  assert.equal(f.writes[0].args.args.title, '会议')
  assert.equal(f.writes[0].metadata.approval.ownerId, f.ownerId)
  assert.equal(f.writes[0].metadata.approval.sourceMessageId, admitted[0].id)
  assert.equal((await f.api.runConfirmation(f.agent, admitted[0])).code, 'done')
  assert.equal(f.writes.length, 1)
})

test('expired and cross-session task confirmations cannot write; cancel is an actual one-time response', async () => {
  const f = await fixture()
  await f.call.execute('expire', { name: 'calendar.events.create', args: f.args })
  const pending = Object.values(f.state.confirmations)[0]
  const input = { itemId: pending.id, kind: 'permission', optionId: 'approve' }
  const source = { kind: 'native-ui', ownerId: f.ownerId }
  let admitted
  await assert.rejects(f.api.respond({ ...f.agent, sessionId: randomUUID() }, input, source, async () => {}), /不属于当前主人和任务/)
  pending.expiresAt = new Date(Date.now() - 1).toISOString()
  assert.equal((await f.api.respond(f.agent, input, source, async () => { throw new Error('must not admit') })).accepted, false)
  assert.equal(pending.status, 'expired')
  await f.call.execute('cancel', { name: 'calendar.events.create', args: f.args })
  const second = Object.values(f.state.confirmations).find((item) => item.id !== pending.id)
  assert.equal((await f.api.respond(f.agent, { ...input, itemId: second.id, optionId: 'cancel' }, source, async (job) => { admitted = job })).accepted, true)
  assert.equal((await f.api.runConfirmation(f.agent, admitted)).code, 'cancelled')
  assert.equal(f.writes.length, 0)
})

test('permission context rotation removes old private approval details and refuses stale answers', async () => {
  const f = await fixture()
  f.agent.contextEpoch = randomUUID()
  await f.call.execute('old-context', { name: 'calendar.events.create', args: { ...f.args, title: 'private-old-calendar-title' } })
  const pending = Object.values(f.state.confirmations)[0]
  assert.match(JSON.stringify(f.api.settlements(f.agent)), /private-old-calendar-title/)
  f.agent.contextEpoch = randomUUID()
  await f.api.resetContext(f.agent)
  assert.deepEqual(f.api.settlements(f.agent), [])
  await assert.rejects(f.api.respond(f.agent, { itemId: pending.id, kind: 'permission', optionId: 'approve' }, { kind: 'native-ui', ownerId: f.ownerId }, async () => { throw new Error('must not admit') }), /任务上下文/)
  assert.equal(f.writes.length, 0)
})

test('an old confirmation without provable context is invalidated rather than assigned to the new context', async () => {
  const f = await fixture()
  await f.call.execute('legacy', { name: 'calendar.events.create', args: f.args })
  const pending = Object.values(f.state.confirmations)[0]
  delete pending.contextEpoch
  f.agent.contextEpoch = randomUUID()
  const migrated = await createPhoneActionRuntime({ ownerId: f.ownerId, store: { state: f.state, save: async () => {} }, nativeCall: async () => { throw new Error('must not execute') }, sendSession: async () => {}, emit: () => {}, getManifest: () => [] })
  assert.equal(pending.status, 'cancelled')
  assert.equal(pending.contextEpoch, 'legacy-unscoped')
  assert.deepEqual(migrated.settlements(f.agent), [])
})

const permissionCases = [
  { name: 'location.current', group: 'location', args: {}, method: 'locationCurrent', permissions: ['android.permission.ACCESS_COARSE_LOCATION'], data: { latitude: 30, longitude: 120, fixed_at_ms: 1_700_000_000_000, cached: false } },
  { name: 'alarm.set', group: 'alarm', args: { hour: 8, minute: 30 }, method: 'alarmSet', permissions: [], data: {} },
  { name: 'health.sleep', group: 'health', args: {}, method: 'healthSleep', permissions: ['android.permission.health.READ_SLEEP'], data: { timezone: 'UTC', sessions: [] } },
  { name: 'recordings.list', group: 'recordings', args: {}, method: 'mediaList', permissions: ['android.permission.READ_MEDIA_AUDIO'], data: { items: [], next_before_id: null } },
  { name: 'photos.list', group: 'photos', args: {}, method: 'mediaList', permissions: ['android.permission.READ_MEDIA_IMAGES'], data: { items: [], next_before_id: null } },
  { name: 'dnd.set', group: 'notifications', args: { mode: 'priority' }, method: 'dndSet', permissions: ['@dnd_access'], data: { before: 'off', mode: 'priority' } },
]

async function approve(f, confirmationId) {
  let admitted
  const response = await f.api.respond(f.agent, { itemId: confirmationId, kind: 'permission', optionId: 'approve' },
    { kind: 'native-ui', ownerId: f.ownerId }, async (job) => { admitted = job })
  assert.equal(response.accepted, true)
  return admitted
}

for (const failure of ['timeout', 'execution_unknown', 'os_permission', 'invalid_args']) test(`a confirmed native ${failure} preserves whether its write outcome is known`, async () => {
  let calls = 0
  const f = await fixture(async (name) => {
    if (name === 'permissions.preflight' || name === 'permissions.check') return { ok: true }
    calls++
    if (failure === 'execution_unknown') throw Object.assign(new Error('native reply lost'), { code: failure })
    return { ok: false, code: failure, message: 'native execution did not confirm success' }
  })
  const asked = await f.call.execute('request', { name: 'calendar.events.create', args: f.args })
  const job = await approve(f, asked.details.confirmation_id)
  const outcome = await f.api.runConfirmation(f.agent, job)
  const pending = f.state.confirmations[asked.details.confirmation_id]
  const uncertain = ['timeout', 'execution_unknown'].includes(failure)
  assert.equal(outcome.code, uncertain ? 'execution_unknown' : failure)
  assert.equal(pending.status, uncertain ? 'interrupted' : 'failed')
  if (uncertain) assert.match(outcome.message, /结果尚未确认.*不能自动重复执行/)
  assert.equal((await f.api.runConfirmation(f.agent, job)).code, pending.status)
  assert.equal(calls, 1, 'late retry must not dispatch the same confirmed operation again')
})

test('lost native results keep the existing device-action wire codes and explicitly say the outcome is unknown', async () => {
  const f = await fixture(async (name) => {
    if (name === 'permissions.preflight') return { ok: true }
    throw Object.assign(new Error('native reply lost'), { code: 'execution_unknown' })
  })
  const result = await f.api.runDeviceAction('calendar.events.create', { ...f.args, confirmed: true }, { callId: randomUUID() })
  assert.equal(result.code, 'execution_failed')
  assert.match(result.message, /结果尚未确认/)
})

for (const action of permissionCases) test(`${action.name} preflights its grant and delivers only with the actual native proof`, async () => {
  const proof = { permissions: action.permissions, mediaRefs: [] }
  const calls = []
  const f = await fixture(async (name, args, _signal, metadata) => {
    calls.push({ name, args: structuredClone(args) })
    if (name === 'permissions.preflight') {
      assert.deepEqual(args, { groups: [action.group] })
      return { ok: true }
    }
    if (name === 'permissions.check') {
      assert.deepEqual(args.groups, [action.group])
      assert.deepEqual(args.requirements, [proof], 'delivery requires the native proof, including an alarm proof with no OS permissions')
      return { ok: true }
    }
    assert.equal(name, 'phone.native')
    assert.equal(args.method, action.method)
    assert.equal(metadata.actionName, action.name)
    return { ok: true, data: action.data, permissionRequirements: proof }
  })
  let executingJob = f.job
  const started = await f.call.execute('permission-case', { name: action.name, args: action.args })
  if (started.details.code === 'needs_confirmation') {
    assert.equal(calls.some((call) => call.name === 'phone.native'), false)
    executingJob = await approve(f, started.details.confirmation_id)
    assert.equal((await f.api.runConfirmation(f.agent, executingJob)).ok, true)
  } else assert.equal(started.details.ok, true)
  const nativeIndex = calls.findIndex((call) => call.name === 'phone.native')
  assert.ok(nativeIndex > 0)
  assert.ok(calls.slice(0, nativeIndex).every((call) => call.name === 'permissions.preflight'))
  assert.ok(calls.slice(nativeIndex + 1).some((call) => call.name === 'permissions.check'))
  assert.deepEqual(executingJob.permissionRequirements, [proof])
})

test('pending confirmation checks previous data proofs separately from the new action category', async () => {
  const oldProof = { permissions: ['android.permission.READ_SMS'], mediaRefs: [] }
  const newProof = { permissions: ['@dnd_access'], mediaRefs: [] }
  const checks = []
  const f = await fixture(async (name, args) => {
    if (name === 'permissions.preflight') { assert.deepEqual(args.groups, ['notifications']); return { ok: true } }
    if (name === 'permissions.check') {
      checks.push(structuredClone(args))
      if (args.groups[0] === 'sms') {
        assert.deepEqual(args.groups, ['sms'])
        assert.deepEqual(args.requirements, [oldProof])
      } else {
        assert.deepEqual(args.groups, ['notifications'])
        assert.deepEqual(args.requirements, [newProof])
      }
      return { ok: true }
    }
    assert.equal(name, 'phone.native')
    assert.equal(args.method, 'dndSet')
    return { ok: true, data: { before: 'off', mode: 'priority' }, permissionRequirements: newProof }
  })
  f.job.usedGroups = ['sms']; f.job.permissionRequirements = [oldProof]
  const asked = await f.call.execute('dnd-with-old-data', { name: 'dnd.set', args: { mode: 'priority' } })
  assert.equal(asked.details.code, 'needs_confirmation')
  const admitted = await approve(f, asked.details.confirmation_id)
  assert.equal((await f.api.runConfirmation(f.agent, admitted)).ok, true)
  assert.ok(checks.filter((check) => check.groups[0] === 'sms').length >= 2)
})

test('revoked categories fail preflight before asking or executing a native operation', async () => {
  for (const action of permissionCases) {
    const f = await fixture(async (name) => {
      assert.equal(name, 'permissions.preflight')
      return { ok: false, code: 'not_granted', message: '类别已断开' }
    })
    const outcome = await f.call.execute('revoked-category', { name: action.name, args: action.args })
    assert.equal(outcome.details.code, 'not_granted')
    assert.equal(Object.keys(f.state.confirmations).length, 0)
  }
})

test('grant-only preflight cannot bypass a native OS denial or revocation before delivery', async () => {
  for (const deniedAt of ['native', 'delivery']) {
    const stages = []
    const f = await fixture(async (name) => {
      stages.push(name)
      if (name === 'permissions.preflight') return { ok: true }
      if (name === 'permissions.check' || deniedAt === 'native') return { ok: false, code: 'os_permission', message: '系统已撤权' }
      assert.equal(name, 'phone.native')
      return { ok: true, data: { items: [{ name: 'must-not-leak' }] }, permissionRequirements: { permissions: ['android.permission.READ_MEDIA_IMAGES'], mediaRefs: [] } }
    })
    const outcome = await f.call.execute('revoked-os', { name: 'photos.list', args: {} })
    assert.equal(outcome.details.code, 'os_permission')
    assert.doesNotMatch(JSON.stringify(outcome), /must-not-leak/)
    assert.equal(stages.includes('permissions.check'), deniedAt === 'delivery')
  }
})
