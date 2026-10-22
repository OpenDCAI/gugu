import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createPhoneSkillsRuntime, PHONE_SKILL_LIMITS, PHONE_SKILLS_SCHEMAS } from './phone-agent-skills.mjs'
import { openPhoneAgentStore } from './phone-agent-store.mjs'

const ownerId = '68a158dd-1832-4671-ac02-ebde330d3d7a'
const deviceId = `phone-22a953e8-e021-4789-9fc9-e41ecb37295b-${ownerId}`
const agentId = '558fcc98-9d61-4054-8a18-900d969b1849'
const sessionId = '23941602-1c88-46f0-a4d6-2bf4255ed242'
const skillId = '1a711613-a9a2-4608-b319-fbd7886cacb9'
const native = { kind: 'native-ui', ownerId }
const skill = (patch = {}) => ({ id: skillId, name: '日程检查', description: '用已授权的工具核对日程', instructions: '# 检查日程\n\n1. 实际调用手机日历。\n2. 不猜测未授权的数据。\n\n```text\n先查后答\n```\n', enabled: true, ...patch })

function fixture({ store = { state: { ownerId, agents: {}, jobs: {} }, save: async () => undefined }, isRunning = () => false, verifyAgent = async () => undefined } = {}) {
  store.state.agents[agentId] ??= { ownerId, deviceId, agentUserId: agentId, sessionId, contextEpoch: randomUUID(), status: 'idle', dataProof: { groups: ['calendar'], permissionRequirements: [{ permissions: ['calendarRead'], mediaRefs: [] }] } }
  const changes = []
  const verified = []
  const runtime = createPhoneSkillsRuntime({ ownerId, deviceId, store, isRunning,
    findSession: (id) => { const found = Object.values(store.state.agents).find((entry) => entry.sessionId === id); if (!found) throw new Error('session not found'); return found },
    verifyAgent: async (id) => { verified.push(id); await verifyAgent(id) },
    onChanged: (agent) => changes.push(agent.contextEpoch),
  })
  const call = async (method, input, source = native) => (await runtime.invoke(`sessionTimeline.phoneSkills${method}`, [input], randomUUID(), source)).value
  const get = (source = native, id = sessionId) => call('Get', { conversationId: id }, source)
  const set = (skills, expectedRevision = 0, source = native, id = sessionId) => call('Set', { conversationId: id, skills, expectedRevision }, source)
  const turn = (agent = store.state.agents[agentId]) => Object.fromEntries(runtime.forTurn(agent).tools.map((tool) => [tool.name, tool]))
  return { store, runtime, changes, verified, call, get, set, turn, agent: store.state.agents[agentId] }
}

test('Skill config is private and durable, Markdown is progressive, and changes preserve conversation history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-phone-skills-'))
  try {
    const f = fixture({ store: await openPhoneAgentStore(root, ownerId) })
    const before = f.agent.contextEpoch, proof = structuredClone(f.agent.dataProof)
    const record = { contextEpoch: before, path: 'retained.jsonl' }; f.agent.record = record
    assert.equal((await f.get()).revision, 0)
    const written = await f.set([skill(), skill({ id: randomUUID(), name: '禁用说明', instructions: '这段内容不进入模型', enabled: false })])
    assert.equal(written.revision, 1)
    assert.equal(f.agent.contextEpoch, before)
    assert.strictEqual(f.agent.record, record)
    assert.deepEqual(f.agent.dataProof, proof)
    const tools = f.turn()
    const listed = await tools.phone_skills_list.execute('list', {})
    assert.deepEqual(listed.details, { revision: 1, skills: [{ id: skillId, name: '日程检查', description: skill().description }] })
    assert.doesNotMatch(JSON.stringify(listed), /这段内容|instructions|先查后答/)
    const read = await tools.phone_skills_read.execute('read', { id: skillId })
    assert.equal(read.details.skill.instructions, skill().instructions)
    await assert.rejects(tools.phone_skills_read.execute('disabled', { id: written.skills[1].id }), { code: 'skill_not_found' })
    const epoch = f.agent.contextEpoch
    // Native may retry after its successful answer was lost; content is already exact.
    assert.deepEqual(await f.set(written.skills, 0), written)
    assert.equal(f.agent.contextEpoch, epoch)
    assert.equal(f.changes.length, 1)
    assert.equal((await stat(join(f.store.directory, 'host.json'))).mode & 0o777, 0o600)
    const cold = fixture({ store: await openPhoneAgentStore(root, ownerId) })
    assert.deepEqual(await cold.get(), written)
    assert.equal((await cold.turn().phone_skills_read.execute('after-restart', { id: skillId })).details.skill.instructions, skill().instructions)
    const otherOwner = await openPhoneAgentStore(root, randomUUID())
    assert.deepEqual(otherOwner.state.agents, {})
  } finally { await rm(root, { recursive: true }) }
})

test('only a trusted local owner can write; each read and write rechecks the real task binding', async () => {
  let moved = false
  const f = fixture({ verifyAgent: async () => { if (moved) throw Object.assign(new Error('identity moved'), { code: 'not_granted' }) } })
  assert.equal((await f.get({ kind: 'device-rpc' })).editable, false)
  await assert.rejects(f.set([skill()], 0, { kind: 'device-rpc' }), { code: 'not_granted' })
  await assert.rejects(f.set([skill()], 0, { ...native, ownerId: randomUUID() }), { code: 'not_granted' })
  await assert.rejects(f.call('Set', { conversationId: sessionId, expectedRevision: 0, skills: [skill()], source: 'native-ui' }), { code: 'invalid_args' })
  await f.set([skill()])
  const turn = f.turn()
  moved = true
  await assert.rejects(f.get(), { code: 'not_granted' })
  await assert.rejects(f.set([], 1), { code: 'not_granted' })
  await assert.rejects(turn.phone_skills_list.execute('read-moved', {}), { code: 'not_granted' })
  await assert.rejects(turn.phone_skills_read.execute('read-moved', { id: skillId }), { code: 'not_granted' })
  assert.ok(f.verified.every((id) => id === agentId))
  moved = false
  f.agent.ownerId = randomUUID()
  await assert.rejects(f.get(), { code: 'not_granted' })
})

test('running, queued and unresolved approvals prevent even no-op configuration writes', async () => {
  const cases = [
    (f) => { f.agent.status = 'working' },
    (f) => { f.agent.status = 'needs_user' },
    (f) => { f.store.state.jobs.one = { agentUserId: agentId, status: 'queued' } },
    (f) => { f.store.state.jobs.one = { agentUserId: agentId, status: 'running' } },
    ...['pending', 'approved', 'executing'].map((status) => (f) => { f.store.state.confirmations = { one: { agentUserId: agentId, status, expiresAt: new Date(Date.now() + 60_000).toISOString() } } }),
  ]
  for (const prepare of cases) {
    const f = fixture()
    await f.set([skill()])
    prepare(f)
    const before = structuredClone(f.agent)
    assert.deepEqual([(await f.get()).busy, (await f.get()).editable], [true, false])
    await assert.rejects(f.set([skill()], 1), { code: 'session_busy' })
    assert.deepEqual(f.agent, before)
  }
  const claimed = fixture({ isRunning: () => true })
  await assert.rejects(claimed.set([skill()]), { code: 'session_busy' })
})

test('disable/delete and another task cannot reveal old Skill bodies, including retained old tool closures', async () => {
  const f = fixture()
  await f.set([skill()])
  const oldTurn = f.turn()
  await f.set([skill({ enabled: false })], 1)
  await assert.rejects(oldTurn.phone_skills_read.execute('stale-read', { id: skillId }), { code: 'skill_context_changed' })
  assert.deepEqual((await f.turn().phone_skills_list.execute('disabled-list', {})).details.skills, [])
  await assert.rejects(f.turn().phone_skills_read.execute('disabled-read', { id: skillId }), { code: 'skill_not_found' })
  await f.set([], 2)
  assert.deepEqual((await f.get()).skills, [])
  const other = { ...f.agent, agentUserId: randomUUID(), sessionId: randomUUID(), skills: { revision: 1, updatedAt: new Date().toISOString(), items: [skill({ instructions: '另一个任务的私有说明' })] } }
  f.store.state.agents[other.agentUserId] = other
  assert.equal((await f.turn(other).phone_skills_read.execute('other', { id: skillId })).details.skill.instructions, '另一个任务的私有说明')
  await assert.rejects(f.turn().phone_skills_read.execute('own', { id: skillId }), { code: 'skill_not_found' })
})

test('strict bounded schema rejects malformed config, executable metadata, duplicate ids and aggregate overflow', async () => {
  const f = fixture()
  assert.equal(PHONE_SKILLS_SCHEMAS.set.additionalProperties, false)
  assert.equal(PHONE_SKILLS_SCHEMAS.response.properties.limits.properties.maxSkills.const, PHONE_SKILL_LIMITS.maxSkills)
  const invalid = [
    [skill({ id: '/private/task/SKILL.md' })], [skill({ id: skillId.toUpperCase() }), skill()],
    [skill({ name: '' })], [skill({ name: '日'.repeat(81) })], [skill({ description: null })],
    [skill({ description: 'd'.repeat(513) })], [skill({ instructions: '' })], [skill({ instructions: 'x'.repeat(16385) })],
    [skill({ instructions: '\0hidden' })], [skill({ instructions: '\ud800' })], [skill({ enabled: 'true' })],
    [skill({ path: '/private/SKILL.md' })], [skill({ url: 'https://example.invalid/skill' })], [skill({ script: 'execute()' })],
    Array.from({ length: 21 }, () => skill({ id: randomUUID() })),
    Array.from({ length: 4 }, () => skill({ id: randomUUID(), instructions: '字'.repeat(16384) })),
  ]
  for (const items of invalid) await assert.rejects(f.set(items), { code: 'invalid_args' })
  for (const expectedRevision of [-1, 0.5, '0', Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(f.set([skill()], expectedRevision), { code: 'invalid_args' })
  await assert.rejects(f.call('Set', { conversationId: sessionId, skills: [skill()] }), { code: 'invalid_args' })
  await assert.rejects(f.call('Get', { conversationId: sessionId, path: 'anything' }), { code: 'invalid_args' })
  assert.equal((await f.get()).revision, 0)
})

test('bad or old saved configs fail loudly rather than being dropped or silently repaired', async () => {
  const f = fixture()
  for (const saved of [null, [], {}, { skills: [] }, { revision: 0, updatedAt: null, items: [] },
    { revision: 1, updatedAt: 'not-a-time', items: [] },
    { revision: 1, updatedAt: new Date().toISOString(), items: [skill({ enabled: undefined })] },
    { revision: 1, updatedAt: new Date().toISOString(), items: [skill({ name: ' unnormalized ' })] }]) {
    f.agent.skills = saved
    const before = structuredClone(saved)
    await assert.rejects(f.get(), { code: 'skill_config_invalid' })
    await assert.rejects(f.set([], 0), { code: 'skill_config_invalid' })
    assert.throws(() => f.turn(), { code: 'skill_config_invalid' })
    assert.deepEqual(f.agent.skills, before)
  }
})

test('one compare-and-swap update wins; persistence failure restores the exact prior config and epoch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-phone-skill-atomic-'))
  try {
    const f = fixture({ store: await openPhoneAgentStore(root, ownerId) })
    const updates = await Promise.allSettled(['one', 'two'].map((instructions) => f.set([skill({ instructions })])))
    assert.equal(updates.filter((entry) => entry.status === 'fulfilled').length, 1)
    assert.equal(updates.find((entry) => entry.status === 'rejected').reason.code, 'conflict')
    const previous = structuredClone(f.agent)
    const path = join(f.store.directory, 'host.json'), backup = `${path}.before-failure`
    await rename(path, backup); await mkdir(path)
    await assert.rejects(f.set([skill({ instructions: 'not durable' })], 1), { code: 'skill_persist_failed' })
    assert.deepEqual(f.agent, previous)
    assert.equal(f.runtime.isEditing(agentId), false)
    assert.equal(f.changes.length, 1)
    await rm(path, { recursive: true }); await rename(backup, path)
    const disk = JSON.parse(await readFile(path, 'utf8'))
    assert.deepEqual(disk.agents[agentId], previous)
    const next = await f.set([skill({ instructions: 'durable retry' })], 1)
    assert.equal(next.revision, 2)
    const cold = fixture({ store: await openPhoneAgentStore(root, ownerId) })
    assert.deepEqual(await cold.get(), next)
  } finally { await rm(root, { recursive: true }) }
})
