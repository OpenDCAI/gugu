// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTeam, AgentTeamMember } from '../../../../apps/desktop/src/components/BuildAgentWizard'
import type { TeamProvisionDeps, TeamProvisionResult } from '../../../../apps/desktop/src/lib/teamProvisionSaga'
import type { AgentProvision } from '@gugu/core/shared/types/agentProvision'
const listDevices = vi.fn()
const createAgentOnDevice = vi.fn()
const archiveChat = vi.fn()
const setAgentListenMode = vi.fn()
const provisionTeam = vi.fn()
const resumeTeam = vi.fn()
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({
  chatService: {
    listDevices: (...a: unknown[]) => listDevices(...a),
    createAgentOnDevice: (...a: unknown[]) => createAgentOnDevice(...a),
    archiveChat: (...a: unknown[]) => archiveChat(...a),
    setAgentListenMode: (...a: unknown[]) => setAgentListenMode(...a),
  },
}))
vi.mock('../../../../apps/desktop/src/lib/teamProvisionSaga', () => ({
  provisionTeam: (...a: unknown[]) => provisionTeam(...a),
  resumeTeam: (...a: unknown[]) => resumeTeam(...a),
}))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  getCurrentAuthUserId: async () => 'owner-1',
  identityDb: {},
}))
import { createAgentTeam, resetAgentTeamCreationCoordinatorForTests } from '../../../../apps/desktop/src/lib/createAgentTeam'
const GROUP_ID = '11111111-1111-4111-8111-111111111111'
// @@@2470 这些夹具**有意**把 tempId 建模成稳定的 blueprint 槽位 key —— 产品侧同款
function memberWithTempIdAsSlotKey(
  over: Partial<AgentTeamMember> & Pick<AgentTeamMember, 'tempId' | 'displayName' | 'engineId'>,
): AgentTeamMember {
  return { role: 'member', description: '', avatarUrl: null, ...over, avatarSeed: over.avatarSeed ?? over.tempId }
}
function team(over: Partial<AgentTeam> = {}): AgentTeam {
  return {
    userDescription: '想要一个多空辩论桌',
    teamName: '多空辩论桌',
    groupPrompt: '章程:先给论点再给反证',
    members: [
      memberWithTempIdAsSlotKey({ tempId: 'm-long', displayName: '多头站', engineId: 'codex', description: '看多方', specialFocus: '只做多方论证' }),
      memberWithTempIdAsSlotKey({ tempId: 'm-risk', displayName: '风控', engineId: 'claude-code', description: '风险边界' }),
    ],
    ...over,
  }
}
const ONLINE_CLOUD_AND_LOCAL = [
  { device_id: 'cloud:worker-1', is_online: true },
  { device_id: 'dev-local-1', is_online: true },
]
type ConsumedMemberFields = Pick<AgentProvision, 'id' | 'member_key' | 'phase' | 'agent_user_id'>
type ConsumedResultFields = Pick<TeamProvisionResult, 'operationId' | 'group' | 'allCompleted'>
function sagaCompleted() {
  const members: ConsumedMemberFields[] = [
    { id: 'p1', member_key: 'm-long', phase: 'completed', agent_user_id: 'agent-long' },
    { id: 'p2', member_key: 'm-risk', phase: 'completed', agent_user_id: 'agent-risk' },
  ]
  const consumed: ConsumedResultFields = { operationId: 'op-1', group: { id: GROUP_ID }, allCompleted: true }
  return {
    ...consumed,
    operation: { id: 'op-1', kind: 'team', phase: 'completed', group_chat_id: GROUP_ID },
    members,
    outcomes: [],
  }
}
beforeEach(() => {
  resetAgentTeamCreationCoordinatorForTests()
  window.localStorage.clear()   // no stray resume record → first-create path
  listDevices.mockResolvedValue(ONLINE_CLOUD_AND_LOCAL)
  provisionTeam.mockImplementation(async (_deviceId: string, _input: unknown, deps?: TeamProvisionDeps) => {
    await deps?.onOperationCreated?.('op-1')
    await deps?.onOperationStarted?.('op-1')
    return sagaCompleted()
  })
  createAgentOnDevice.mockResolvedValue({ agent: { id: 'legacy-agent' }, chatId: 'legacy-dm' })
  archiveChat.mockResolvedValue(undefined)
  setAgentListenMode.mockResolvedValue(undefined)
})
afterEach(() => {
  resetAgentTeamCreationCoordinatorForTests()
  window.localStorage.clear()
  vi.useRealTimers()
  vi.clearAllMocks()
})
describe('#2260 boundary C — createAgentTeam is a THIN adapter over provisionTeam', () => {
  it('hands the whole creation to provisionTeam on an online LOCAL device and returns the saga-built group', async () => {
    const res = await createAgentTeam(team(), { onProgress: vi.fn() })
    expect(provisionTeam).toHaveBeenCalledTimes(1)
    const [deviceId, input] = provisionTeam.mock.calls[0]
    expect(deviceId).toBe('dev-local-1')            // the online LOCAL device, never the online cloud one
    expect(input.teamName).toBe('多空辩论桌')
    expect(input.groupPrompt).toBe('章程:先给论点再给反证')
    expect(typeof input.groupChatId).toBe('string')  // caller mints it; finalize_agent_team builds THAT group
    expect(input.groupChatId.length).toBeGreaterThan(0)
    expect(res.chatId).toBe(GROUP_ID)
    expect(res.agentIds).toEqual(['agent-long', 'agent-risk'])
  })
  it('the legacy serial path is GONE: no per-member createAgentOnDevice, no manual group / archive / listen-mode', async () => {
    await createAgentTeam(team(), {})
    expect(createAgentOnDevice).not.toHaveBeenCalled()
    expect(archiveChat).not.toHaveBeenCalled()
    expect(setAgentListenMode).not.toHaveBeenCalled()
  })
  it('no fixed sleeps: completes with timers frozen (bounded concurrency is the DB claim, not a wall-clock guess)', async () => {
    vi.useFakeTimers()
    await expect(createAgentTeam(team(), {})).resolves.toMatchObject({ chatId: GROUP_ID })
  }, 2000)
  it('translates the preview verbatim: tempId → member_key, engine → agent_type, persona → special_focus, active', async () => {
    const preview = team()
    preview.members[0].avatarUrl = '/assets/agent-avatars/avatar-01.png'
    await createAgentTeam(preview, {})
    expect(provisionTeam, 'the saga must be the thing that receives the translated intent').toHaveBeenCalledTimes(1)
    const input = provisionTeam.mock.calls[0][1]
    expect(input.members).toHaveLength(2)
    const first = input.members[0].member
    expect(first.memberKey).toBe('m-long')          // stable per-member identity = the wizard's tempId (bijection)
    expect(first.displayName).toBe('多头站')
    expect(first.agentType).toBe('codex')
    expect(first.specialFocus).toBe('只做多方论证')
    expect(first.listenMode).toBe('active')
    expect(first.avatar, 'the explicitly assigned canonical identity must reach the provision blueprint').toBe('/assets/agent-avatars/avatar-01.png')
    expect(first.inheritMemory).toBe(false)
    expect(first.historyImportRequired).toBe(false)
    expect(input.members[1].member.memberKey).toBe('m-risk')
    expect(input.members[1].member.avatar, 'no explicit avatar stays empty; the caller must not synthesize a fallback').toBeUndefined()
    expect(input.members[1].member.specialFocus).toBe('风险边界')
  })
  it('an absent group charter becomes an empty string (a present JSON string), not undefined', async () => {
    await createAgentTeam(team({ groupPrompt: undefined }), {})
    expect(provisionTeam, 'no saga call means there is no charter to inspect').toHaveBeenCalledTimes(1)
    expect(provisionTeam.mock.calls[0][1].groupPrompt).toBe('')
  })
  it('passes onProgress THROUGH (the wizard owns the progress UI) and ends at ratio 1', async () => {
    const onProgress = vi.fn()
    await createAgentTeam(team(), { onProgress })
    expect(onProgress).toHaveBeenCalled()
    const ratios = onProgress.mock.calls.map((c) => c[0].ratio)
    expect(ratios.every((r) => r >= 0 && r <= 1)).toBe(true)
    expect(ratios[ratios.length - 1]).toBe(1)
    const progress = onProgress.mock.calls.map((call) => call[0])
    expect(progress.map((entry) => entry.code)).toEqual([
      'checking-device',
      'provisioning',
      'provisioning',
      'ready',
    ])
    expect(progress.filter((entry) => entry.code === 'provisioning'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ provisioningCount: 2 }),
      ]))
  })
  it('exposes the cancel handle only after the durable operation start succeeds', async () => {
    const onProgress = vi.fn()
    provisionTeam.mockImplementationOnce(async (_deviceId: string, _input: unknown, deps?: TeamProvisionDeps) => {
      await deps?.onOperationCreated?.('op-1')
      expect(onProgress.mock.calls.some(([progress]) => progress.operationId === 'op-1')).toBe(false)
      await deps?.onOperationStarted?.('op-1')
      expect(onProgress.mock.calls.some(([progress]) => progress.operationId === 'op-1')).toBe(true)
      return sagaCompleted()
    })
    await createAgentTeam(team({ starterPrompt: 'Start here' }), { onProgress })
  })
  it('fail loud: no online device at all', async () => {
    listDevices.mockResolvedValue([{ device_id: 'dev-1', is_online: false }])
    await expect(createAgentTeam(team(), {})).rejects.toThrow(/在线设备/)
    expect(provisionTeam).not.toHaveBeenCalled()
  })
  it('fail loud: only a CLOUD device is online (members need a local engine)', async () => {
    listDevices.mockResolvedValue([{ device_id: 'cloud:worker-1', is_online: true }])
    await expect(createAgentTeam(team(), {})).rejects.toThrow(/云设备/)
    expect(provisionTeam).not.toHaveBeenCalled()
  })
  it('fail loud: a cloud-marked member never enters a group (#1761) — rejected before any saga work', async () => {
    const t = team({ members: [memberWithTempIdAsSlotKey({ tempId: 'm-cloud', displayName: '云员', engineId: 'gugu-cloud', description: 'x' })] })
    await expect(createAgentTeam(t, {})).rejects.toThrow(/云 agent/)
    expect(provisionTeam).not.toHaveBeenCalled()
  })
  it('fail loud: an empty team is rejected before touching devices or the saga', async () => {
    await expect(createAgentTeam(team({ members: [] }), {})).rejects.toThrow(/至少/)
    expect(listDevices).not.toHaveBeenCalled()
    expect(provisionTeam).not.toHaveBeenCalled()
  })
  it('fail loud: not every member completed → no half-built handoff, and the failed member is named', async () => {
    provisionTeam.mockResolvedValue({
      ...sagaCompleted(),
      operation: { id: 'op-1', kind: 'team', phase: 'failed', group_chat_id: null },
      members: [
        { id: 'p1', member_key: 'm-long', phase: 'completed', agent_user_id: 'agent-long' },
        { id: 'p2', member_key: 'm-risk', phase: 'failed', agent_user_id: null },
      ],
      group: undefined,
      allCompleted: false,
    })
    await expect(createAgentTeam(team(), {})).rejects.toThrow(/m-risk/)
  })
  it('defense-in-depth: allCompleted but no group row → never silently substitute the client-minted id', async () => {
    provisionTeam.mockResolvedValue({ ...sagaCompleted(), group: undefined })
    await expect(createAgentTeam(team(), {})).rejects.toThrow(/群/)
  })
})
// @@@2470 夹具不变量：本文件的成员构造器把 tempId 当槽位 key，显式钉住，
describe('fixture invariant: memberWithTempIdAsSlotKey', () => {
  it('avatarSeed 恒等于 tempId（除非调用方显式覆盖）', () => {
    const m = memberWithTempIdAsSlotKey({ tempId: 'slot-1', displayName: 'X', engineId: 'codex' })
    expect(m.avatarSeed).toBe('slot-1')
    expect(m.avatarSeed).toBe(m.tempId)
    const overridden = memberWithTempIdAsSlotKey({ tempId: 'slot-2', displayName: 'Y', engineId: 'codex', avatarSeed: 'explicit' })
    expect(overridden.avatarSeed).toBe('explicit')
  })
})
