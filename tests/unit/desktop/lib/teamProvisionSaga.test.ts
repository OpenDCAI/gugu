// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMemoryContentInput, AgentProvision } from '@gugu/core/shared/types/agentProvision'
const rpc = vi.fn()
const from = vi.fn()
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  identityDb: { rpc: (...a: unknown[]) => rpc(...a), from: (...a: unknown[]) => from(...a) },
  getCurrentAuthUserId: async () => 'owner-1',
}))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({
  chatService: { waitForDeviceCommand: vi.fn(), getDeviceCommand: vi.fn(), listDevices: vi.fn() },
}))
import {
  provisionTeam,
  resumeTeam,
  cancelTeamProvision,
  type TeamMemberProvisionInput,
} from '../../../../apps/desktop/src/lib/teamProvisionSaga'
import {
  buildTeamBlueprint,
  getProvision,
  listOperationMembers,
  type ProvisionResumeRecord,
} from '../../../../apps/desktop/src/lib/agentProvision'
const OP = 'op-1'
const LIMIT = 2
interface Fake {
  id: string
  member_key: string
  phase: AgentProvision['phase']
  cmd: string | null
  history_import_required: boolean
  history_thread_root_id: string | null
  owner_user_id?: string
  operation_id?: string
  created_at?: string
}
let fakeMembers: Fake[]
let fakeOpPhase: string
let cmdTerminal: Record<string, 'done' | 'error'> // keyed by command id
let removedFakeAgents: Set<string>
const ONLINE = { ensureDeviceOnline: async () => {} }
const digestFn = async (p: unknown) => `fp:${JSON.stringify(p).length}`
function toRow(m: Fake): AgentProvision {
  return {
    id: m.id, owner_user_id: m.owner_user_id ?? 'owner-1', operation_id: m.operation_id ?? OP, member_key: m.member_key, device_id: 'dev-1',
    display_name: m.member_key, agent_type: 'codex', project_path: null, avatar: null, special_focus: null,
    inherit_memory: true, memory_sources: null, history_import_required: m.history_import_required,
    history_payload_hash: null, history_thread_root_id: m.history_thread_root_id,
    payload_hash: 'h',
    agent_user_id: m.phase === 'queued' || removedFakeAgents.has(`a-${m.id}`) ? null : `a-${m.id}`,
    provisioned_agent_user_id: m.phase === 'queued' ? null : `a-${m.id}`,
    dm_chat_id: m.phase === 'queued' ? null : `dm-${m.id}`, create_command_id: m.cmd, phase: m.phase,
    template_client_message_id: null, error: m.phase === 'failed' ? 'agent_create_command_error' : null,
    created_at: m.created_at ?? 't0', updated_at: 't0',
  }
}
function installStatefulRpc() {
  rpc.mockImplementation((name: string, params: Record<string, unknown>) => {
    if (name === 'start_agent_provision_operation') return Promise.resolve({ data: { id: OP, phase: fakeOpPhase } })
    if (name === 'claim_provision_slots') {
      const retryIds: string[] = (params.p_retry_provision_ids as string[] | null) ?? []
      const hasRetry = retryIds.length > 0
      if (fakeOpPhase !== 'provisioning_members' && !(fakeOpPhase === 'failed' && hasRetry)) return Promise.resolve({ data: [] })
      const inflight = fakeMembers.filter((m) => m.phase === 'preparing' || m.phase === 'awaiting_terminal').length
      let budget = Math.max(0, LIMIT - inflight)
      const picked: Fake[] = []
      for (const m of fakeMembers) { // (1) retry-selected failed → preparing
        if (budget <= 0) break
        if (m.phase === 'failed' && retryIds.includes(m.id)) { m.phase = 'preparing'; picked.push(m); budget -= 1 }
      }
      for (const m of fakeMembers) { // (2) fill remaining budget with queued first-creates
        if (budget <= 0) break
        if (m.phase === 'queued') { m.phase = 'preparing'; picked.push(m); budget -= 1 }
      }
      if (hasRetry && fakeOpPhase === 'failed' && picked.some((m) => retryIds.includes(m.id))) fakeOpPhase = 'provisioning_members'
      return Promise.resolve({ data: picked.map(toRow) })
    }
    if (name === 'prepare_agent_provision') {
      const m = fakeMembers.find((x) => x.id === params.p_provision_id)!
      if (m.phase === 'awaiting_terminal' || m.phase === 'ready' || m.phase === 'completed') return Promise.resolve({ data: toRow(m) })
      if (m.phase !== 'preparing') {
        return Promise.resolve({
          data: null,
          error: { message: `prepare: provision ${m.id} is not a slot-granted preparing row (phase=${m.phase}); claim_provision_slots must grant capacity first` },
        })
      }
      m.cmd = `c-${m.id}-${(m.cmd ?? '').length}` // new command id on (re)prepare
      m.phase = 'awaiting_terminal'
      return Promise.resolve({ data: toRow(m) })
    }
    if (name === 'settle_agent_provision_terminal') {
      const m = fakeMembers.find((x) => x.id === params.p_provision_id)!
      if ((cmdTerminal[m.cmd as string] ?? 'done') === 'done') m.phase = 'ready'
      else { m.phase = 'failed'; fakeOpPhase = 'failed' }
      return Promise.resolve({ data: toRow(m) })
    }
    if (name === 'complete_agent_provision') {
      const m = fakeMembers.find((x) => x.id === params.p_provision_id)!
      m.phase = 'completed'
      return Promise.resolve({ data: [{ message_id: `msg-${m.id}`, client_message_id: `k-${m.id}`, already: false }] })
    }
    if (name === 'finalize_agent_team') { fakeOpPhase = 'completed'; return Promise.resolve({ data: { id: 'group-1' } }) }
    if (name === 'cancel_agent_provision_operation') {
      fakeOpPhase = 'cleaning_up'
      fakeMembers.forEach((m) => { m.phase = 'cancelling' })
      return Promise.resolve({ data: null })
    }
    if (name === 'set_agent_desired_status') return Promise.resolve({ data: null })
    if (name === 'remove_owned_agent') {
      const removed = String(params.p_agent_user_id)
      removedFakeAgents.add(removed)
      return Promise.resolve({ data: null })
    }
    if (name === 'settle_provision_cancellation') {
      fakeMembers.forEach((m) => {
        if (m.phase !== 'cancelling') return
        const boundAgent = m.phase === 'cancelling' && m.cmd !== null ? `a-${m.id}` : null
        if (!boundAgent || removedFakeAgents.has(boundAgent)) m.phase = 'cancelled'
      })
      if (fakeMembers.every((m) => m.phase === 'cancelled')) fakeOpPhase = 'cancelled'
      return Promise.resolve({ data: { id: OP, phase: fakeOpPhase } })
    }
    return Promise.resolve({ data: null, error: null })
  })
  from.mockImplementation((table: string) => {
    const source: Array<Record<string, unknown>> = table === 'agent_provisions'
      ? fakeMembers.map(toRow) as unknown as Array<Record<string, unknown>>
      : table === 'agent_provision_operations'
        ? [{ id: OP, owner_user_id: 'owner-1', kind: 'team', phase: fakeOpPhase, created_at: 't0' }]
        : (() => { throw new Error(`stateful provision fake does not model table ${table}`) })()
    const predicates: Array<(row: Record<string, unknown>) => boolean> = [
      (row) => row.owner_user_id === 'owner-1',
    ]
    const orders: Array<{ column: string; ascending: boolean }> = []
    const evaluate = () => source
      .filter((row) => predicates.every((predicate) => predicate(row)))
      .sort((a, b) => {
        for (const order of orders) {
          const left = String(a[order.column] ?? '')
          const right = String(b[order.column] ?? '')
          const compared = left.localeCompare(right)
          if (compared !== 0) return order.ascending ? compared : -compared
        }
        return 0
      })
    const chain: Record<string, unknown> = {}
    chain.select = (columns: string) => {
      if (columns !== '*') throw new Error(`stateful provision fake only models select('*'), received ${columns}`)
      return chain
    }
    chain.eq = (column: string, value: unknown) => {
      predicates.push((row) => row[column] === value)
      return chain
    }
    chain.in = (column: string, values: unknown[]) => {
      predicates.push((row) => values.includes(row[column]))
      return chain
    }
    chain.order = (column: string, options?: { ascending?: boolean }) => {
      orders.push({ column, ascending: options?.ascending !== false })
      return chain
    }
    chain.maybeSingle = () => {
      const rows = evaluate()
      return Promise.resolve(rows.length > 1
        ? { data: null, error: { message: `maybeSingle matched ${rows.length} rows` } }
        : { data: rows[0] ?? null, error: null })
    }
    ;(chain as { then: unknown }).then = (
      resolve: (value: { data: Array<Record<string, unknown>>; error: null }) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve({ data: evaluate(), error: null as null }).then(resolve, reject)
    return chain
  })
}
function memberInputs(keys: string[], overs: Partial<TeamMemberProvisionInput['member']> = {}): TeamMemberProvisionInput[] {
  return keys.map((k) => ({ member: { memberKey: k, displayName: k, agentType: 'codex', inheritMemory: true, historyImportRequired: false, listenMode: 'passive', ...overs } }))
}
const teamInput = (keys: string[]) => ({ groupChatId: 'g'.padEnd(36, '0'), teamName: 'T', groupPrompt: 'c', concurrencyLimit: LIMIT, members: memberInputs(keys) })
let idSeq = 0
const deps = () => ({
  waitForCommandTerminal: vi.fn(async () => 'done' as const),
  computeSourceDigest: digestFn,
  newId: () => (idSeq === 0 ? (idSeq++, OP) : `${['m1', 'm2', 'm3', 'm4'][idSeq++ - 1]}`),
  getOwnerUserId: async () => 'owner-1',
  ...ONLINE,
})
beforeEach(() => { idSeq = 0; cmdTerminal = {}; fakeOpPhase = 'provisioning_members'; removedFakeAgents = new Set() })
afterEach(() => vi.clearAllMocks())
describe('#2260 teamProvisionSaga', () => {
  it('limit enforcement: drives 4 members across claim batches (no upfront create-all), finalizes once', async () => {
    fakeMembers = ['m1', 'm2', 'm3', 'm4'].map((k) => ({ id: k, member_key: k, phase: 'queued', cmd: null, history_import_required: false, history_thread_root_id: null }))
    installStatefulRpc()
    const resumeStore = { remember: vi.fn(), forget: vi.fn(), list: vi.fn(() => []) }
    const res = await provisionTeam('dev-1', teamInput(['m1', 'm2', 'm3', 'm4']), { ...deps(), resumeStore })
    expect(res.allCompleted).toBe(true)
    expect(res.members.map((m) => m.phase)).toEqual(['completed', 'completed', 'completed', 'completed'])
    expect(res.group?.id).toBe('group-1')
    expect(rpc.mock.calls.filter((c) => c[0] === 'finalize_agent_team')).toHaveLength(1)
    expect(rpc.mock.calls.filter((c) => c[0] === 'claim_provision_slots').length).toBeGreaterThanOrEqual(2)
    expect(resumeStore.remember, 'the complete intent is durable before the first RPC').toHaveBeenCalledTimes(1)
    expect(resumeStore.forget, 'DB completion alone cannot erase a renderer handoff identity').not.toHaveBeenCalled()
  })
  it('partial failure: a failed member blocks finalize (no group) unless retried', async () => {
    fakeMembers = ['m1', 'm2'].map((k) => ({ id: k, member_key: k, phase: 'queued', cmd: null, history_import_required: false, history_thread_root_id: null }))
    installStatefulRpc()
    const d = deps()
    d.waitForCommandTerminal = vi.fn(async (cmdId: string) => (cmdId.startsWith('c-m2') ? 'error' : 'done')) as never
    cmdTerminal['c-m2-0'] = 'error'
    const res = await provisionTeam('dev-1', teamInput(['m1', 'm2']), d)
    expect(res.allCompleted).toBe(false)
    expect(res.group).toBeUndefined()
    expect(res.members.find((m) => m.member_key === 'm2')!.phase).toBe('failed')
    expect(rpc.mock.calls.some((c) => c[0] === 'finalize_agent_team')).toBe(false)
  })
  it('same-member retry: retryFailedMembers re-drives the failed member (same id) → all completed, finalize once', async () => {
    fakeMembers = ['m1', 'm2'].map((k) => ({ id: k, member_key: k, phase: 'queued', cmd: null, history_import_required: false, history_thread_root_id: null }))
    installStatefulRpc()
    cmdTerminal['c-m2-0'] = 'error' // first attempt fails; retry (new command) succeeds (default 'done')
    const d = { ...deps(), retryFailedMembers: true }
    const res = await provisionTeam('dev-1', teamInput(['m1', 'm2']), d)
    expect(res.allCompleted).toBe(true)
    expect(res.members.every((m) => m.phase === 'completed')).toBe(true)
    const m2Prepares = rpc.mock.calls.filter((c) => c[0] === 'prepare_agent_provision' && (c[1] as { p_provision_id: string }).p_provision_id === 'm2')
    expect(m2Prepares.length).toBe(2)
    const retrySelections = rpc.mock.calls.filter((c) => c[0] === 'claim_provision_slots'
      && Array.isArray((c[1] as { p_retry_provision_ids?: unknown }).p_retry_provision_ids)
      && ((c[1] as { p_retry_provision_ids: string[] }).p_retry_provision_ids).includes('m2'))
    expect(retrySelections.length).toBeGreaterThanOrEqual(1)
    const firstRetryClaimIdx = rpc.mock.calls.findIndex((c) => c[0] === 'claim_provision_slots'
      && Array.isArray((c[1] as { p_retry_provision_ids?: unknown }).p_retry_provision_ids)
      && ((c[1] as { p_retry_provision_ids: string[] }).p_retry_provision_ids).includes('m2'))
    const lastM2PrepareIdx = rpc.mock.calls.map((c, i) => ({ c, i }))
      .filter(({ c }) => c[0] === 'prepare_agent_provision' && (c[1] as { p_provision_id: string }).p_provision_id === 'm2')
      .map(({ i }) => i).pop()!
    expect(lastM2PrepareIdx).toBeGreaterThan(firstRetryClaimIdx)
    expect(rpc.mock.calls.filter((c) => c[0] === 'finalize_agent_team')).toHaveLength(1)
  })
  it('response-loss / reload: resumeTeam replays start (idempotent) and completes; one start call', async () => {
    fakeMembers = ['m1', 'm2'].map((k) => ({ id: k, member_key: k, phase: 'queued', cmd: null, history_import_required: false, history_thread_root_id: null }))
    installStatefulRpc()
    const blueprint = buildTeamBlueprint({ groupChatId: 'g'.padEnd(36, '0'), teamName: 'T', groupPrompt: 'c', concurrencyLimit: LIMIT, members: [
      { memberKey: 'm1', displayName: 'm1', agentType: 'codex', inheritMemory: true, historyImportRequired: false, listenMode: 'passive', provisionId: 'm1' },
      { memberKey: 'm2', displayName: 'm2', agentType: 'codex', inheritMemory: true, historyImportRequired: false, listenMode: 'passive', provisionId: 'm2' },
    ] })
    const record: ProvisionResumeRecord = { version: 2, ownerUserId: 'owner-1', operationId: OP, deviceId: 'dev-1', blueprint, members: [{ provisionId: 'm1', memberKey: 'm1' }, { provisionId: 'm2', memberKey: 'm2' }] }
    const res = await resumeTeam(record, { ...ONLINE, waitForCommandTerminal: vi.fn(async () => 'done' as const), computeSourceDigest: digestFn })
    expect(res.allCompleted).toBe(true)
    expect(rpc.mock.calls.filter((c) => c[0] === 'start_agent_provision_operation')).toHaveLength(1)
  })
  it('resume fails loud with the bound device id before reading sources when the device is gone or stale', async () => {
    fakeMembers = ['m1'].map((k) => ({ id: k, member_key: k, phase: 'queued', cmd: null, history_import_required: false, history_thread_root_id: null }))
    installStatefulRpc()
    const record: ProvisionResumeRecord = {
      version: 2,
      ownerUserId: 'owner-1',
      operationId: OP,
      deviceId: 'dev-reinstalled-old',
      blueprint: buildTeamBlueprint({
        groupChatId: 'g'.padEnd(36, '0'),
        teamName: 'T',
        groupPrompt: 'c',
        concurrencyLimit: LIMIT,
        members: [{ memberKey: 'm1', displayName: 'm1', agentType: 'codex', inheritMemory: true, historyImportRequired: false, listenMode: 'passive', provisionId: 'm1' }],
      }),
      members: [{ provisionId: 'm1', memberKey: 'm1' }],
    }
    const readMemory = vi.fn(async () => ({ 'claude-code': 'should-not-read' } as AgentMemoryContentInput))
    await expect(resumeTeam(record, {
      ...deps(),
      ensureDeviceOnline: vi.fn(async () => { throw new Error('device row missing') }),
      readMemory,
    })).rejects.toThrow('device dev-reinstalled-old')
    await expect(resumeTeam(record, {
      ...deps(),
      ensureDeviceOnline: vi.fn(async () => { throw new Error('device row missing') }),
      readMemory,
    })).rejects.toThrow(/recreate the team or cancel the operation/)
    expect(readMemory).not.toHaveBeenCalled()
    expect(rpc.mock.calls.filter((c) => c[0] === 'start_agent_provision_operation')).toHaveLength(0)
  })
  it('drive rechecks the binding after the fresh preflight and before starting the operation', async () => {
    fakeMembers = ['m1'].map((k) => ({ id: k, member_key: k, phase: 'queued', cmd: null, history_import_required: false, history_thread_root_id: null }))
    installStatefulRpc()
    const ensureDeviceOnline = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('device became stale'))
    const resumeStore = { remember: vi.fn(), forget: vi.fn(), list: vi.fn(() => []) }
    await expect(provisionTeam('dev-reinstalled-old', teamInput(['m1']), { ...deps(), ensureDeviceOnline, resumeStore }))
      .rejects.toThrow(/team provision operation is bound to device dev-reinstalled-old.*recreate the team or cancel the operation/)
    expect(ensureDeviceOnline).toHaveBeenCalledTimes(2)
    expect(rpc.mock.calls.filter((c) => c[0] === 'start_agent_provision_operation')).toHaveLength(1)
  })
  it('a start replay that returns cleaning_up is cancellation-only and rejects before claim or prepare', async () => {
    fakeMembers = ['m1', 'm2'].map((k) => ({ id: k, member_key: k, phase: 'queued', cmd: null, history_import_required: false, history_thread_root_id: null }))
    fakeOpPhase = 'cleaning_up'
    installStatefulRpc()
    const blueprint = buildTeamBlueprint({ groupChatId: 'g'.padEnd(36, '0'), teamName: 'T', groupPrompt: 'c', concurrencyLimit: LIMIT, members: [
      { memberKey: 'm1', displayName: 'm1', agentType: 'codex', inheritMemory: true, historyImportRequired: false, listenMode: 'passive', provisionId: 'm1' },
      { memberKey: 'm2', displayName: 'm2', agentType: 'codex', inheritMemory: true, historyImportRequired: false, listenMode: 'passive', provisionId: 'm2' },
    ] })
    const record: ProvisionResumeRecord = { version: 2, ownerUserId: 'owner-1', operationId: OP, deviceId: 'dev-1', blueprint, members: [{ provisionId: 'm1', memberKey: 'm1' }, { provisionId: 'm2', memberKey: 'm2' }] }
    await expect(resumeTeam(record, { ...ONLINE, waitForCommandTerminal: vi.fn(async () => 'done' as const), computeSourceDigest: digestFn }))
      .rejects.toThrow(/cleaning_up|cancell|取消/i)
    expect(rpc.mock.calls.filter((c) => c[0] === 'claim_provision_slots')).toHaveLength(0)
    expect(rpc.mock.calls.filter((c) => c[0] === 'prepare_agent_provision')).toHaveLength(0)
    expect(rpc.mock.calls.filter((c) => c[0] === 'finalize_agent_team')).toHaveLength(0)
  })
  it('cancel during active work goes through the governed cancel RPC', async () => {
    fakeMembers = ['m1'].map((k) => ({ id: k, member_key: k, phase: 'preparing', cmd: 'c-m1-0', history_import_required: false, history_thread_root_id: null }))
    installStatefulRpc()
    const res = await cancelTeamProvision(OP)
    expect(rpc.mock.calls.filter((c) => c[0] === 'cancel_agent_provision_operation')).toHaveLength(1)
    expect(rpc.mock.calls.filter((c) => c[0] === 'remove_owned_agent')).toHaveLength(1)
    expect(rpc.mock.calls.filter((c) => c[0] === 'settle_provision_cancellation')).toHaveLength(1)
    expect(fakeMembers[0].phase).toBe('cancelled')
    expect(res.fullyCancelled).toBe(true)
    expect(res.cleanupErrors).toEqual([])
  })
})
describe('#2260 stateful DB fake — reads honor exact ids, operation scope, and owner RLS', () => {
  it('getProvision returns the requested row and returns null for a missing id', async () => {
    fakeMembers = ['m1', 'm2'].map((k) => ({ id: k, member_key: k, phase: 'queued' as const, cmd: null, history_import_required: false, history_thread_root_id: null }))
    installStatefulRpc()

    await expect(getProvision('m2')).resolves.toMatchObject({ id: 'm2' })
    await expect(getProvision('missing')).resolves.toBeNull()
  })

  it('listOperationMembers excludes cross-operation and cross-owner rows and preserves created order', async () => {
    fakeMembers = [
      { id: 'later', member_key: 'later', phase: 'queued', cmd: null, history_import_required: false, history_thread_root_id: null, created_at: 't2' },
      { id: 'other-op', member_key: 'other-op', phase: 'queued', cmd: null, history_import_required: false, history_thread_root_id: null, operation_id: 'op-other', created_at: 't0' },
      { id: 'other-owner', member_key: 'other-owner', phase: 'queued', cmd: null, history_import_required: false, history_thread_root_id: null, owner_user_id: 'owner-2', created_at: 't0' },
      { id: 'earlier', member_key: 'earlier', phase: 'queued', cmd: null, history_import_required: false, history_thread_root_id: null, created_at: 't1' },
    ]
    installStatefulRpc()

    const rows = await listOperationMembers(OP)
    expect(rows.map((row) => row.id)).toEqual(['earlier', 'later'])
  })
})
describe('#2260 teamProvisionSaga fresh-review fixes (fail-first)', () => {
  const emptyFrom = () => {
    from.mockImplementation(() => {
      const c: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'order']) c[m] = () => c
      ;(c as { then: unknown }).then = (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r)
      return c
    })
  }
  it('P1.2 a rejected member (thrown prepare RPC) fails loud — not swallowed as allCompleted=false', async () => {
    let claims = 0
    rpc.mockImplementation((name: string) => {
      if (name === 'start_agent_provision_operation') return Promise.resolve({ data: { id: OP, phase: 'provisioning_members' } })
      if (name === 'claim_provision_slots') { claims += 1; return Promise.resolve({ data: claims === 1 ? [toRow({ id: 'm1', member_key: 'm1', phase: 'preparing', cmd: null, history_import_required: false, history_thread_root_id: null })] : [] }) }
      if (name === 'prepare_agent_provision') return Promise.resolve({ data: null, error: { message: 'prepare boom' } })
      return Promise.resolve({ data: null, error: null })
    })
    emptyFrom()
    await expect(provisionTeam('dev-1', teamInput(['m1']), deps())).rejects.toThrow(/prepare boom|threw during drive/)
  })
  it('P1.3 resumeTeam fails loud on owner mismatch BEFORE any local source read', async () => {
    emptyFrom()
    const readMemory = vi.fn(async () => ({ 'claude-code': 'PREV-ACCOUNT' }))
    const bp = buildTeamBlueprint({ groupChatId: 'g'.padEnd(36, '0'), teamName: 'T', groupPrompt: 'c', concurrencyLimit: 2, members: [{ memberKey: 'm1', displayName: 'm1', agentType: 'codex', inheritMemory: true, historyImportRequired: false, listenMode: 'passive', memorySources: ['claude-code'], provisionId: 'p1' }] })
    const rec: ProvisionResumeRecord = { version: 2, ownerUserId: 'other-owner', operationId: OP, deviceId: 'd', blueprint: bp, members: [{ provisionId: 'p1', memberKey: 'm1', memorySourceRef: { sources: ['claude-code'], clientDigest: 'x' } }] }
    await expect(resumeTeam(rec, { readMemory, computeSourceDigest: digestFn })).rejects.toThrow(/owner/)
    expect(readMemory).not.toHaveBeenCalled()
  })
  it('P1.5 provisionTeam fails loud when a member gives memoryContent without memory_sources (no silent drop)', async () => {
    installStatefulRpc()
    const input = { groupChatId: 'g'.padEnd(36, '0'), teamName: 'T', groupPrompt: 'c', concurrencyLimit: LIMIT, members: [{ member: { memberKey: 'm1', displayName: 'm1', agentType: 'codex', inheritMemory: true, historyImportRequired: false, listenMode: 'passive' as const }, memoryContent: { 'claude-code': 'X' } }] }
    await expect(provisionTeam('dev-1', input, deps())).rejects.toThrow(/memory/)
  })
})
describe('#2260 round-2 fresh-review fixes — F1 team recovery drives durable non-terminal members (fail-first)', () => {
  const bpFor = (keys: string[]) => buildTeamBlueprint({
    groupChatId: 'g'.padEnd(36, '0'), teamName: 'T', groupPrompt: 'c', concurrencyLimit: LIMIT,
    members: keys.map((k) => ({ memberKey: k, displayName: k, agentType: 'codex', inheritMemory: true, historyImportRequired: false, listenMode: 'passive' as const, provisionId: k })),
  })
  const recFor = (keys: string[]): ProvisionResumeRecord => ({
    version: 2, ownerUserId: 'owner-1', operationId: OP, deviceId: 'dev-1', blueprint: bpFor(keys),
    members: keys.map((k) => ({ provisionId: k, memberKey: k })),
  })

  it('resume with members already in awaiting_terminal + ready (claim returns none) re-drives them to completed + finalizes once', async () => {
    fakeMembers = [
      { id: 'm1', member_key: 'm1', phase: 'awaiting_terminal', cmd: 'c-m1-0', history_import_required: false, history_thread_root_id: null },
      { id: 'm2', member_key: 'm2', phase: 'ready', cmd: 'c-m2-0', history_import_required: false, history_thread_root_id: null },
    ]
    installStatefulRpc()
    const res = await resumeTeam(recFor(['m1', 'm2']), { ...ONLINE, waitForCommandTerminal: vi.fn(async () => 'done' as const), computeSourceDigest: digestFn, getOwnerUserId: async () => 'owner-1' })
    expect(res.allCompleted).toBe(true)
    expect(res.members.every((m) => m.phase === 'completed')).toBe(true)
    expect(rpc.mock.calls.filter((c) => c[0] === 'finalize_agent_team')).toHaveLength(1)
  })

  it('resume with a member stuck in preparing (crash mid-first-prepare) re-drives it to completed', async () => {
    fakeMembers = [{ id: 'm1', member_key: 'm1', phase: 'preparing', cmd: null, history_import_required: false, history_thread_root_id: null }]
    installStatefulRpc()
    const res = await resumeTeam(recFor(['m1']), { ...ONLINE, waitForCommandTerminal: vi.fn(async () => 'done' as const), computeSourceDigest: digestFn, getOwnerUserId: async () => 'owner-1' })
    expect(res.allCompleted).toBe(true)
    expect(res.members[0].phase).toBe('completed')
  })
})
describe('#2260 round-6 fail-first — team cancel-only precheck and bounded retry accounting', () => {
  const bpFor = (keys: string[]) => buildTeamBlueprint({
    groupChatId: 'g'.padEnd(36, '0'), teamName: 'T', groupPrompt: 'c', concurrencyLimit: LIMIT,
    members: keys.map((k) => ({ memberKey: k, displayName: k, agentType: 'codex', inheritMemory: true, historyImportRequired: false, listenMode: 'passive' as const, provisionId: k })),
  })
  const recFor = (keys: string[]): ProvisionResumeRecord => ({
    version: 2, ownerUserId: 'owner-1', operationId: OP, deviceId: 'dev-1', blueprint: bpFor(keys),
    members: keys.map((k) => ({ provisionId: k, memberKey: k })),
  })
  it('P1-1 a governed-removed member fails the whole drive BEFORE any claim RPC or run', async () => {
    fakeMembers = [
      { id: 'm1', member_key: 'm1', phase: 'failed', cmd: 'c-m1-0', history_import_required: false, history_thread_root_id: null },
      { id: 'm2', member_key: 'm2', phase: 'queued', cmd: null, history_import_required: false, history_thread_root_id: null },
    ]
    installStatefulRpc()
    const origFrom = from.getMockImplementation()!
    from.mockImplementation((table: string) => {
      const chain = origFrom(table) as Record<string, unknown>
      if (table === 'agent_provisions') {
        const rows = fakeMembers.map(toRow).map((r) => r.id === 'm1'
          ? ({ ...r, agent_user_id: null, provisioned_agent_user_id: 'a-m1' })
          : r)
        ;(chain as { then: unknown }).then = (res: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(res)
      }
      return chain
    })
    await expect(resumeTeam(recFor(['m1', 'm2']), { ...ONLINE, waitForCommandTerminal: vi.fn(async () => 'done' as const), computeSourceDigest: digestFn, getOwnerUserId: async () => 'owner-1', retryFailedMembers: true }))
      .rejects.toThrow(/governed-removed|cancel|reclaimed/i)
    expect(rpc.mock.calls.filter((c) => c[0] === 'claim_provision_slots')).toHaveLength(0)
    expect(rpc.mock.calls.filter((c) => c[0] === 'prepare_agent_provision')).toHaveLength(0)
  })
  it('P1-5 over-budget failed members stay eligible and finish in later iterations of the SAME drive (no starvation, no double-drive)', async () => {
    fakeMembers = ['m1', 'm2', 'm3'].map((k) => ({ id: k, member_key: k, phase: 'failed' as const, cmd: `c-${k}-0`, history_import_required: false, history_thread_root_id: null }))
    installStatefulRpc()
    cmdTerminal = {}
    const res = await resumeTeam(recFor(['m1', 'm2', 'm3']), { ...ONLINE, waitForCommandTerminal: vi.fn(async () => 'done' as const), computeSourceDigest: digestFn, getOwnerUserId: async () => 'owner-1', retryFailedMembers: true })
    expect(res.members.map((m) => m.phase)).toEqual(['completed', 'completed', 'completed'])
    expect(res.allCompleted).toBe(true)
    for (const id of ['m1', 'm2', 'm3']) {
      const prepares = rpc.mock.calls.filter((c) => c[0] === 'prepare_agent_provision' && (c[1] as { p_provision_id: string }).p_provision_id === id)
      expect(prepares, `${id} prepared exactly once`).toHaveLength(1)
    }
  })
})
