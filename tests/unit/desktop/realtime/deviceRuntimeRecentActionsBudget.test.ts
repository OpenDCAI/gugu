import { expect, test } from 'vitest'
import { setImmediate } from 'node:timers/promises'
import { hostname } from 'node:os'
import { createDeviceRuntimeHostLoop, type DeviceRuntimeIdentityClient } from '@gugu/core'
import type { AgentStatusReading } from '@gugu/core/shared/agentStatus'
import { awaitPending } from '../../../support/awaitFact'
import { createTestLocalAgent, isolatedGuguEnv, pollOnlyRuntimeIdentityClient, presenceRow } from '../../../support/deviceRuntimeHarness'

async function fixture(beforeReport?: (args: Record<string, unknown>) => Promise<void>) {
  const env = await isolatedGuguEnv('gugu-presence-budget-')
  await createTestLocalAgent(env, { gugu_user_id: 'agent-1' }, { cache: { acp_engine_id: 'claude' }, status: 'active' })
  await createTestLocalAgent(env, { gugu_user_id: 'agent-2' }, { cache: { acp_engine_id: 'claude' }, status: 'active' })
  const client = pollOnlyRuntimeIdentityClient([], 'presence budget')
  const original = client.rpc.bind(client)
  const waiters = new Set<() => void>()
  const changed = () => { for (const done of [...waiters]) done() }
  const when = async (label: string, predicate: () => boolean) => {
    if (predicate()) return
    await awaitPending(label, new Promise<void>((resolve) => {
      const done = () => { if (predicate()) { waiters.delete(done); resolve() } }
      waiters.add(done)
    }))
  }
  let reads = 0, snapshots = 0
  const state: { at: number; recent: { actions: string[]; lastActionAt: string | null }; secondRecent: { actions: string[]; lastActionAt: string | null } | null; status: AgentStatusReading | null; secondStatus: AgentStatusReading | null } = { at: 0, recent: { actions: [], lastActionAt: null }, secondRecent: null, status: null, secondStatus: null }
  const reports: Array<{ at: number; args: Record<string, unknown> }> = []
  client.rpc = async (name: string, args: Record<string, unknown>) => {
    if (name === 'set_agent_runtime_state') await beforeReport?.(args)
    const result = await original(name, args)
    if (name === 'get_agent_presence_batch') { snapshots += 1; changed() }
    if (name === 'set_agent_runtime_state') { reports.push({ at: state.at, args }); changed() }
    return result
  }
  let notify: (() => void) | undefined
  const never = 24 * 60 * 60 * 1000
  const host = createDeviceRuntimeHostLoop({
    env, nowMs: () => state.at,
    intervalMs: never, superviseIntervalMs: never, heartbeatIntervalMs: never, activityReconcileIntervalMs: never,
    subscribeCommandWake: () => () => undefined,
    machineIdentifier: () => 'presence-budget-machine',
    capabilities: { terminals: [], runtimes: [] },
    authProvider: { getAuth: async () => ({ accessToken: 'token', userId: 'user-1' }) },
    makeIdentityClient: () => client as unknown as DeviceRuntimeIdentityClient,
    runtimeBridge: {
      create: async () => {}, injectAgentInbox: async () => 'accepted' as const, stop: async () => {},
      agentStatus: (id) => id === 'agent-1' ? state.status : state.secondStatus,
      recentActionsForAgent: async (id) => { reads += 1; changed(); return id === 'agent-1' ? state.recent : state.secondRecent },
      onAgentStatusChanged: (listener) => { notify = () => listener('agent-1'); return () => { notify = undefined } },
    },
  })
  const publish = async () => {
    const before = reads
    notify?.()
    await when('recent snapshot collected', () => reads > before)
    // The snapshot hook is the final I/O before the pure publication decision.
    await setImmediate()
  }
  host.start()
  await when('cloud presence reconciled', () => snapshots > 0)
  await setImmediate()
  return { state, reports, when, publish, client, reconciled: () => snapshots, tick: () => host.tickOnce(), notify: () => notify?.(), close: () => host.stop() }
}

test('stopping a host with agents marks its cloud device row offline once', async () => {
  const { state, client, tick, close } = await fixture()
  try {
    state.at = 1
    await tick()
    const deviceId = client.upserts.at(-1)?.row.device_id
    expect(deviceId).toBeTypeOf('string')
    await close()
    expect(client.offlineUpdates).toEqual([{ deviceId, value: expect.objectContaining({ status: 'offline' }) }])
  } finally { await close() }
})

test('reconciliation does not publish a new recent action before the next thirty-second interval', async () => {
  const { state, reports, publish, client, when, notify, reconciled, close } = await fixture()
  try {
    state.at = 30_000
    state.status = { status: 'working', detail: 'running', running: true, background: null }
    state.recent = { actions: ['Read'], lastActionAt: new Date(state.at).toISOString() }
    await publish()
    await when('running state published', () => reports.some(({ args }) => args.p_agent_status === 'working'))
    client.presence.set('agent-1', presenceRow('agent-1', {
      activity_status: 'running', agent_status: 'working', agent_status_detail: 'running',
      runtime_kind: 'gugu', runtime_label: hostname(),
      recent_actions: state.recent.actions, last_action_at: state.recent.lastActionAt,
    }))
    state.at = 24 * 60 * 60 * 1000
    const beforeReconcile = reconciled()
    notify()
    await when('cloud presence reconciled again', () => reconciled() > beforeReconcile)
    await setImmediate()
    const reportsAfterReconcile = reports.length
    state.at += 29_999
    state.recent = { actions: ['Edit'], lastActionAt: new Date(state.at).toISOString() }
    await publish()
    expect(reports).toHaveLength(reportsAfterReconcile)
    state.at += 1
    await publish()
    await when('post-reconcile trailing action published', () => {
      const actions = reports.at(-1)?.args.p_recent_actions
      return Array.isArray(actions) && actions[0] === 'Edit'
    })
    expect(reports).toHaveLength(reportsAfterReconcile + 1)
    expect(reports.at(-1)?.args.p_recent_actions).toEqual(['Edit'])
  } finally { await close() }
})

test('keeps status edges immediate while recent-only writes are bounded per agent and trailing', async () => {
  const { state, reports, when, publish, close } = await fixture()
  try {
    state.at = 30_000
    state.recent = { actions: ['Read'], lastActionAt: '2026-11-02T00:00:00Z' }
    state.status = { status: 'working', detail: 'running', running: true, background: null }
    await publish()
    await when('first action published', () => reports.some(({ args }) => Array.isArray(args.p_recent_actions) && args.p_recent_actions[0] === 'Read'))
    await setImmediate()

    state.at = 31_000
    state.recent = { actions: ['Edit'], lastActionAt: '2026-11-02T00:00:01Z' }
    state.status = { status: 'needs_user', detail: 'approval', running: true, background: null }
    await publish()
    await when('approval reading published', () => reports.some(({ args }) => args.p_agent_status_detail === 'approval'))
    await setImmediate()
    const approval = reports.find(({ args }) => args.p_agent_status_detail === 'approval')!
    expect(approval.at).toBe(31_000)
    expect(approval.args.p_recent_actions).toEqual(['Edit'])
    expect(approval.args.p_last_action_at).toBe('2026-11-02T00:00:01Z')

    state.at = 40_000
    state.secondRecent = { actions: ['Read second agent'], lastActionAt: '2026-11-02T00:00:10Z' }
    await publish()
    await when('second agent has its own interval', () => reports.some(({ args }) => args.p_agent_user_id === 'agent-2' && args.p_recent_actions !== null))
    await setImmediate()

    state.at = 60_999
    state.recent = { actions: ['Bash'], lastActionAt: '2026-11-02T00:00:29Z' }
    await publish()
    expect(reports.filter(({ args }) => args.p_agent_user_id === 'agent-1' && args.p_recent_actions !== null)).toHaveLength(2)

    state.at = 61_000
    await publish()
    await when('latest trailing action published', () => reports.some(({ args }) => Array.isArray(args.p_recent_actions) && args.p_recent_actions[0] === 'Bash'))
    const actionReports = reports.filter(({ args }) => args.p_agent_user_id === 'agent-1' && args.p_recent_actions !== null)
    expect(actionReports.map(({ at }) => at)).toEqual([30_000, 31_000, 61_000])
    expect(actionReports.at(-1)?.args.p_last_action_at).toBe('2026-11-02T00:00:29Z')
  } finally { await close() }
})

test('publishes a short turn only at start and end, including the final action on idle', async () => {
  const { state, reports, publish, close } = await fixture()
  try {
    const before = reports.length
    state.at = 30_000
    state.status = { status: 'working', detail: 'running', running: true, background: null }
    await publish()
    for (let i = 0; i < 30; i += 1) {
      state.at = 30_000 + i * 200
      state.recent = { actions: [`tool_${i}`], lastActionAt: new Date(state.at).toISOString() }
      await publish()
    }
    state.at = 39_000
    state.status = { status: 'idle', detail: 'plain', running: false, background: null }
    await publish()
    const turn = reports.slice(before)
    expect(turn).toHaveLength(2)
    expect(turn.map(({ args }) => args.p_agent_status)).toEqual(['working', 'idle'])
    expect(turn[1]!.args.p_recent_actions).toEqual(['tool_29'])
    expect(turn[1]!.args.p_last_action_at).toBe(new Date(35_800).toISOString())
    state.at = 70_000
    await publish()
    expect(reports.slice(before)).toHaveLength(2)
  } finally { await close() }
})

test('reads the final actions for each status edge after another agent report completes', async () => {
  let block = false
  let release!: () => void
  let started!: () => void
  const writing = new Promise<void>((resolve) => { started = resolve })
  const held = new Promise<void>((resolve) => { release = resolve })
  const { state, reports, when, publish, notify, close } = await fixture(async (args) => {
    if (block && args.p_agent_user_id === 'agent-1') {
      block = false
      started()
      await held
    }
  })
  try {
    state.at = 30_000
    state.status = state.secondStatus = { status: 'working', detail: 'running', running: true, background: null }
    state.recent = state.secondRecent = { actions: ['tool_149'], lastActionAt: new Date(state.at).toISOString() }
    await publish()
    await when('both running reports complete', () => reports.filter(({ args }) => args.p_agent_status === 'working').length === 2)
    await setImmediate()
    state.at = 60_000
    state.recent = { actions: ['first agent tool'], lastActionAt: new Date(state.at).toISOString() }
    block = true
    notify()
    await writing
    state.secondRecent = { actions: ['tool_150'], lastActionAt: new Date(state.at + 1).toISOString() }
    state.secondStatus = { status: 'idle', detail: 'plain', running: false, background: null }
    notify()
    release()
    await when('second agent idle report completes', () => reports.some(({ args }) => args.p_agent_user_id === 'agent-2' && args.p_agent_status === 'idle'))
    const idle = reports.find(({ args }) => args.p_agent_user_id === 'agent-2' && args.p_agent_status === 'idle')!
    expect(idle.args.p_recent_actions).toEqual(['tool_150'])
    expect(idle.args.p_last_action_at).toBe(new Date(60_001).toISOString())
  } finally { release(); await close() }
})

test('trailing publication follows the actions actually carried by the previous idle write', async () => {
  const { state, reports, publish, close } = await fixture()
  try {
    state.at = 30_000
    state.status = { status: 'idle', detail: 'plain', running: false, background: null }
    state.recent = { actions: ['tool_149'], lastActionAt: new Date(state.at).toISOString() }
    await publish()
    const before = reports.length
    state.recent = { actions: ['tool_150'], lastActionAt: new Date(30_001).toISOString() }
    state.at = 59_999
    await publish()
    expect(reports).toHaveLength(before)
    state.at = 60_000
    await publish()
    expect(reports).toHaveLength(before + 1)
    expect(reports.at(-1)!.args.p_recent_actions).toEqual(['tool_150'])
    expect(reports.at(-1)!.args.p_last_action_at).toBe(new Date(30_001).toISOString())
  } finally { await close() }
})
