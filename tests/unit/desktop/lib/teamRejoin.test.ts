// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BuildAgentWizard, type AgentTeam, type AgentTeamMember } from '../../../../apps/desktop/src/components/BuildAgentWizard'
import { createNode, createReactHarness } from '../../../support/testHarness'
vi.mock('../../../../apps/desktop/src/components/Avatar', () => ({ Avatar: () => null }))
const listDevices = vi.fn()
const provisionTeam = vi.fn()
const resumeTeam = vi.fn()
const cancelProvisionOperation = vi.fn()
const settleProvisionCancellation = vi.fn()
const listOperationMembers = vi.fn()
const getProvisionOperation = vi.fn()
const getCurrentAuthUserId = vi.fn()
let cancelUnconverged = false
let operationPhase: string | null = 'provisioning_members'
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({
  chatService: { listDevices: (...a: unknown[]) => listDevices(...a) },
}))
vi.mock('../../../../apps/desktop/src/lib/teamProvisionSaga', async (orig) => ({
  ...(await orig() as object),
  provisionTeam: (...a: unknown[]) => provisionTeam(...a),
  resumeTeam: (...a: unknown[]) => resumeTeam(...a),
}))
vi.mock('../../../../apps/desktop/src/lib/agentProvision', async (orig) => ({
  ...(await orig() as object),
  cancelProvisionOperation: (...a: unknown[]) => cancelProvisionOperation(...a),
  settleProvisionCancellation: (...a: unknown[]) => settleProvisionCancellation(...a),
  listOperationMembers: (...a: unknown[]) => listOperationMembers(...a),
  getProvisionOperation: (...a: unknown[]) => getProvisionOperation(...a),
}))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  getCurrentAuthUserId: (...a: unknown[]) => getCurrentAuthUserId(...a),
  identityDb: {},
}))
import * as createAgentTeamModule from '../../../../apps/desktop/src/lib/createAgentTeam'
import { cancelTeamProvision } from '../../../../apps/desktop/src/lib/teamProvisionSaga'
import { starterContinuationStore } from '../../../../apps/desktop/src/lib/starterContinuation'
const { createAgentTeam } = createAgentTeamModule
const coordinatorApi = createAgentTeamModule as typeof createAgentTeamModule & {
  hydrateAgentTeamForReentry?: (team: AgentTeam) => Promise<{
    team: AgentTeam
    cancellationOperationId?: string
  }>
  resetAgentTeamCreationCoordinatorForTests?: () => void
  completeAgentTeamCreationHandoff?: (
    team: AgentTeam,
    result: {
      chatId: string
      operationId: string
      assertHandoffCurrent?: () => void
      finishHandoff?: (succeeded: boolean) => void
    },
    deps: {
      setDraft: (chatId: string, value: string) => void
      clearLandedStarter: (operationId: string) => Promise<void>
      close: () => void
      navigateToChat: (chatId: string) => void
    },
  ) => Promise<void>
  cancelAgentTeamCreation?: (operationId: string) => Promise<{
    fullyCancelled: boolean
    completedNoop: boolean
    cleanupErrors: string[]
  }>
}
const OWNER = 'owner-1'
const GROUP = '11111111-1111-4111-8111-111111111111'
const RESUME_KEY = `gugu:agent-provision:pending:${OWNER}`
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
// @@@2470 这些夹具**有意**把 tempId 建模成稳定的 blueprint 槽位 key —— 产品侧同款
function memberWithTempIdAsSlotKey(
  over: Partial<AgentTeamMember> & Pick<AgentTeamMember, 'tempId' | 'displayName' | 'engineId'>,
): AgentTeamMember {
  return { role: 'member', description: '', avatarUrl: null, ...over, avatarSeed: over.avatarSeed ?? over.tempId }
}
function team(over: Partial<AgentTeam> = {}): AgentTeam {
  return {
    userDescription: 'x',
    teamName: '多空辩论桌',
    groupPrompt: '章程',
    members: [
      memberWithTempIdAsSlotKey({ tempId: 'preset-debate-long-77', displayName: '多头站', engineId: 'codex', description: '看多方' }),
      memberWithTempIdAsSlotKey({ tempId: 'preset-debate-risk-78', displayName: '风控', engineId: 'claude-code', description: '风险边界' }),
    ],
    ...over,
  }
}
function storedRecord(teamName = '多空辩论桌') {
  return {
    version: 2,
    ownerUserId: OWNER,
    operationId: 'op-stored',
    deviceId: 'dev-local-1',
    blueprint: {
      kind: 'team',
      group_chat_id: GROUP,
      team_name: teamName,
      group_prompt: '章程',
      concurrency_limit: 2,   // buildTeamBlueprint always writes it — a real stored record carries it
      members: [
        { provision_id: 'pv-1', member_key: 'preset-debate-long-1', display_name: '多头站', agent_type: 'codex', special_focus: '看多方', inherit_memory: false, history_import_required: false, listen_mode: 'active' },
        { provision_id: 'pv-2', member_key: 'preset-debate-risk-2', display_name: '风控', agent_type: 'claude-code', special_focus: '风险边界', inherit_memory: false, history_import_required: false, listen_mode: 'active' },
      ],
    },
    members: [
      { provisionId: 'pv-1', memberKey: 'preset-debate-long-1' },
      { provisionId: 'pv-2', memberKey: 'preset-debate-risk-2' },
    ],
  }
}
function completedResult(operationId: string) {
  return {
    operationId,
    operation: { id: operationId, kind: 'team', phase: 'completed', group_chat_id: GROUP },
    members: [
      { id: 'pv-1', member_key: 'preset-debate-long-1', phase: 'completed', agent_user_id: 'agent-1' },
      { id: 'pv-2', member_key: 'preset-debate-risk-2', phase: 'completed', agent_user_id: 'agent-2' },
    ],
    outcomes: [],
    group: { id: GROUP },
    allCompleted: true,
  }
}
beforeEach(() => {
  coordinatorApi.resetAgentTeamCreationCoordinatorForTests?.()
  window.localStorage.clear()
  listDevices.mockResolvedValue([{ device_id: 'dev-local-1', is_online: true }])
  cancelUnconverged = false
  operationPhase = 'provisioning_members'
  cancelProvisionOperation.mockImplementation(async () => {
    if (operationPhase === 'completed' || operationPhase === 'cancelled') return
    operationPhase = 'cleaning_up'
  })
  listOperationMembers.mockResolvedValue([])
  settleProvisionCancellation.mockImplementation(async (id: string) => {
    operationPhase = cancelUnconverged ? 'cleaning_up' : 'cancelled'
    return { id, phase: operationPhase }
  })
  getProvisionOperation.mockImplementation(async (id: string) => operationPhase == null ? null : ({ id, phase: operationPhase }))
  getCurrentAuthUserId.mockResolvedValue(OWNER)
  provisionTeam.mockImplementation(async () => completedResult('op-fresh'))
  resumeTeam.mockImplementation(async (record: { operationId: string }) => completedResult(record.operationId))
})
afterEach(() => { coordinatorApi.resetAgentTeamCreationCoordinatorForTests?.(); window.localStorage.clear(); vi.clearAllMocks() })
describe('#2260 boundary E2a — re-entry rejoins the SAME operation, never forks a second team', () => {
  it('an unrelated stale team operation cannot block opening this team', async () => {
    window.localStorage.setItem(RESUME_KEY, JSON.stringify([
      { ...storedRecord('旧团队'), operationId: 'op-unrelated' },
    ]))
    getProvisionOperation.mockImplementation(async (id: string) => {
      if (id === 'op-unrelated') throw new Error('Unexpected failure, please check server logs for more information')
      return { id, phase: operationPhase }
    })
    const hydrated = await coordinatorApi.hydrateAgentTeamForReentry!(team())
    expect(hydrated.team.teamName).toBe('多空辩论桌')
    expect(getProvisionOperation).not.toHaveBeenCalled()
  })
  it('a resumable record for this team is rejoined: resumeTeam runs, provisionTeam is never called', async () => {
    window.localStorage.setItem(RESUME_KEY, JSON.stringify([storedRecord()]))
    const res = await createAgentTeam(team(), {})
    expect(resumeTeam).toHaveBeenCalledTimes(1)
    expect(provisionTeam, 'a second operation must NEVER be started while one is resumable').not.toHaveBeenCalled()
    expect(res.operationId, 'the SAME durable operation, not a fresh id').toBe('op-stored')
  })
  it('a failed durable operation retries failed members only after the user explicitly creates again', async () => {
    window.localStorage.setItem(RESUME_KEY, JSON.stringify([storedRecord()]))
    operationPhase = 'failed'
    resumeTeam.mockImplementationOnce(async (record: { operationId: string }, options?: { retryFailedMembers?: boolean }) => {
      if (options?.retryFailedMembers !== true) throw new Error('failed-member retry flag missing')
      return completedResult(record.operationId)
    })
    const res = await createAgentTeam(team(), {})
    expect(resumeTeam).toHaveBeenCalledTimes(1)
    expect(resumeTeam.mock.calls[0][1]).toMatchObject({ retryFailedMembers: true })
    expect(provisionTeam, 'retry stays on the same durable operation').not.toHaveBeenCalled()
    expect(res.operationId).toBe('op-stored')
  })
  it('a completed operation whose success handoff was interrupted replays the same group, then forgets only after handoff commit', async () => {
    window.localStorage.setItem(RESUME_KEY, JSON.stringify([storedRecord()]))
    operationPhase = 'completed'
    const result = await createAgentTeam(team(), {})
    expect(result.operationId).toBe('op-stored')
    expect(result.chatId).toBe(GROUP)
    expect(resumeTeam).toHaveBeenCalledTimes(1)
    expect(provisionTeam, 'DB completion before renderer handoff must not mint a replacement operation').not.toHaveBeenCalled()
    expect(window.localStorage.getItem(RESUME_KEY), 'completed is not handoff-committed yet').not.toBeNull()
    const close = vi.fn()
    const navigateToChat = vi.fn()
    await coordinatorApi.completeAgentTeamCreationHandoff!(team(), result, {
      setDraft: vi.fn(),
      clearLandedStarter: vi.fn(),
      close,
      navigateToChat,
    })
    expect(close).toHaveBeenCalledTimes(1)
    expect(navigateToChat).toHaveBeenCalledWith(GROUP)
    expect(window.localStorage.getItem(RESUME_KEY), 'the successful user-visible handoff owns terminal cleanup').toBeNull()
  })
  it('a still-provisioning rejoin does not turn ordinary recovery into an explicit failed retry', async () => {
    window.localStorage.setItem(RESUME_KEY, JSON.stringify([storedRecord()]))
    operationPhase = 'provisioning_members'
    await createAgentTeam(team(), {})
    expect(resumeTeam.mock.calls[0][1]?.retryFailedMembers).not.toBe(true)
  })
  it('a cleaning_up operation hydrates an explicit cancellation recovery handle instead of a create path', async () => {
    window.localStorage.setItem(RESUME_KEY, JSON.stringify([storedRecord()]))
    starterContinuationStore.remember({ version: 1, ownerUserId: OWNER, operationId: 'op-stored', starter: 'keep while cancelling' })
    operationPhase = 'cleaning_up'
    const hydrated = await coordinatorApi.hydrateAgentTeamForReentry!(team({ starterPrompt: 'PRESET DEFAULT' }))
    expect(hydrated.team.starterPrompt).toBe('keep while cancelling')
    expect(hydrated.cancellationOperationId).toBe('op-stored')
    expect(resumeTeam).not.toHaveBeenCalled()
    expect(provisionTeam).not.toHaveBeenCalled()
    expect(cancelProvisionOperation, 'opening recovery is not an automatic cancel').not.toHaveBeenCalled()
  })
  it('cleaning_up recovery wins over a changed preview fingerprint so the user can still finish cancelling', async () => {
    window.localStorage.setItem(RESUME_KEY, JSON.stringify([storedRecord()]))
    operationPhase = 'cleaning_up'
    const changedPreview = team({ groupPrompt: 'a newly edited charter' })
    const hydrated = await coordinatorApi.hydrateAgentTeamForReentry!(changedPreview)
    expect(hydrated.cancellationOperationId).toBe('op-stored')
    expect(hydrated.team.groupPrompt).toBe('a newly edited charter')
    expect(resumeTeam).not.toHaveBeenCalled()
    expect(provisionTeam).not.toHaveBeenCalled()
    expect(cancelProvisionOperation).not.toHaveBeenCalled()
  })
  it('a direct create call refuses cleaning_up without resuming, cancelling, or forking', async () => {
    window.localStorage.setItem(RESUME_KEY, JSON.stringify([storedRecord()]))
    operationPhase = 'cleaning_up'
    await expect(createAgentTeam(team(), {})).rejects.toThrow(/取消|cleaning_up|继续取消/)
    expect(resumeTeam).not.toHaveBeenCalled()
    expect(provisionTeam).not.toHaveBeenCalled()
    expect(cancelProvisionOperation).not.toHaveBeenCalled()
  })
  it('rejoin replays the STORED member_keys — the freshly minted tempIds cannot fork member identity', async () => {
    window.localStorage.setItem(RESUME_KEY, JSON.stringify([storedRecord()]))
    await createAgentTeam(team(), {})   // fresh tempIds are …-77 / …-78
    const [record] = resumeTeam.mock.calls[0]
    expect(record.members.map((m: { memberKey: string }) => m.memberKey)).toEqual(['preset-debate-long-1', 'preset-debate-risk-2'])
    expect(JSON.stringify(record)).not.toContain('-77')
  })
  it('the same explicit canonical avatar is part of the durable intent and rejoins the same operation', async () => {
    const record = storedRecord()
    ;(record.blueprint.members[0] as typeof record.blueprint.members[number] & { avatar?: string | null }).avatar = '/assets/agent-avatars/avatar-01.png'
    window.localStorage.setItem(RESUME_KEY, JSON.stringify([record]))
    const preview = team()
    preview.members[0].avatarUrl = '/assets/agent-avatars/avatar-01.png'
    const res = await createAgentTeam(preview, {})
    expect(res.operationId).toBe('op-stored')
    expect(resumeTeam).toHaveBeenCalledTimes(1)
    expect(provisionTeam).not.toHaveBeenCalled()
  })
  it('adding an explicit canonical avatar to a legacy avatar-less live intent is divergent and fail-loud', async () => {
    window.localStorage.setItem(RESUME_KEY, JSON.stringify([storedRecord()]))
    const preview = team()
    preview.members[0].avatarUrl = '/assets/agent-avatars/avatar-01.png'
    await expect(createAgentTeam(preview, {})).rejects.toThrow(/op-stored/)
    expect(resumeTeam).not.toHaveBeenCalled()
    expect(provisionTeam).not.toHaveBeenCalled()
  })
  it('a valid PRE-START record with no DB row replays the SAME ids instead of being swept and forked', async () => {
    const original = storedRecord()
    window.localStorage.setItem(RESUME_KEY, JSON.stringify([original]))
    operationPhase = null // legitimate pre-RPC/pre-ack window: the resume record exists before start creates the row
    const res = await createAgentTeam(team(), {})
    expect(resumeTeam).toHaveBeenCalledTimes(1)
    expect(provisionTeam, 'null is not terminal proof and must never fork fresh ids').not.toHaveBeenCalled()
    const [replayed] = resumeTeam.mock.calls[0]
    expect(replayed.operationId).toBe(original.operationId)
    expect(replayed.members).toEqual(original.members)
    expect(replayed.blueprint).toEqual(original.blueprint)
    expect(res.operationId).toBe('op-stored')
  })
  it('CONTROL: with no resumable record it starts a fresh operation', async () => {
    const res = await createAgentTeam(team(), {})
    expect(provisionTeam).toHaveBeenCalledTimes(1)
    expect(resumeTeam).not.toHaveBeenCalled()
    expect(res.operationId).toBe('op-fresh')
  })
  it('a record for a DIFFERENT team is not rejoined (re-entry must not hijack another operation)', async () => {
    window.localStorage.setItem(RESUME_KEY, JSON.stringify([storedRecord('旅行规划台')]))
    await createAgentTeam(team(), {})
    expect(resumeTeam).not.toHaveBeenCalled()
    expect(provisionTeam).toHaveBeenCalledTimes(1)
  })
  it('a live record under the SAME team name whose ROLE SET differs is REFUSED (not silently forked)', async () => {
    const rec = storedRecord()
    rec.blueprint.members = [rec.blueprint.members[0]]      // one member instead of two
    rec.members = [rec.members[0]]
    window.localStorage.setItem(RESUME_KEY, JSON.stringify([rec]))
    await expect(createAgentTeam(team(), {})).rejects.toThrow(/op-stored/)
    expect(resumeTeam).not.toHaveBeenCalled()
    expect(provisionTeam).not.toHaveBeenCalled()
  })
  it('rejoin re-remembers the (possibly re-edited) starter under the SAME operation, keeping its bound group', async () => {
    window.localStorage.setItem(RESUME_KEY, JSON.stringify([storedRecord()]))
    starterContinuationStore.remember({ version: 1, ownerUserId: OWNER, operationId: 'op-stored', starter: '旧文本' })
    starterContinuationStore.bindGroup(OWNER, 'op-stored', GROUP)
    await createAgentTeam(team({ starterPrompt: '  用户改过的开场任务\n' }), {})
    const rec = starterContinuationStore.find(OWNER, 'op-stored')
    expect(rec?.starter, 'verbatim re-edit, under the same operation').toBe('  用户改过的开场任务\n')
    expect(rec?.groupChatId, 'the already-bound group is not lost').toBe(GROUP)
    expect(starterContinuationStore.list(OWNER), 'no second pointer').toHaveLength(1)
  })
  it('a corrupt resume store fails loud rather than silently starting a second team', async () => {
    window.localStorage.setItem(RESUME_KEY, '{not json')
    await expect(createAgentTeam(team(), {})).rejects.toThrow(/corrupt/i)
    expect(provisionTeam, 'never fork a team on the back of an unreadable store').not.toHaveBeenCalled()
  })
})
describe('#2260 close/reopen — one in-process driver and one success handoff', () => {
  function pendingFirstDrive() {
    const pending = deferred<ReturnType<typeof completedResult>>()
    provisionTeam.mockImplementation(async (_deviceId: string, _input: unknown, deps?: {
      onOperationCreated?: (operationId: string) => void | Promise<void>
      onOperationStarted?: (operationId: string) => void | Promise<void>
    }) => {
      window.localStorage.setItem(RESUME_KEY, JSON.stringify([storedRecord()]))
      await deps?.onOperationCreated?.('op-stored')
      await deps?.onOperationStarted?.('op-stored')
      return pending.promise
    })
    resumeTeam.mockImplementation(async () => pending.promise)
    return pending
  }
  it('close then reopen before completion attaches to ONE promise/driver and grants exactly one handoff owner', async () => {
    const pending = pendingFirstDrive()
    const first = createAgentTeam(team({ starterPrompt: '  custom starter\n' }), {})
    await vi.waitFor(() => { expect(provisionTeam).toHaveBeenCalledTimes(1) })
    const second = createAgentTeam(team({ starterPrompt: '  custom starter\n' }), {})
    await Promise.resolve()
    expect(provisionTeam).toHaveBeenCalledTimes(1)
    expect(resumeTeam, 'reopen must subscribe, not launch a second renderer driver').not.toHaveBeenCalled()
    pending.resolve(completedResult('op-stored'))
    const firstResult = await first
    let secondSettled = false
    void second.then(() => { secondSettled = true })
    await Promise.resolve()
    expect(secondSettled, 'the observer waits for the owner to commit the handoff').toBe(false)
    firstResult.finishHandoff?.(true)
    const results = [firstResult, await second]
    expect(results.map((result) => result.operationId)).toEqual(['op-stored', 'op-stored'])
    expect(results.filter((result) => (result as typeof result & { handoffOwner?: boolean }).handoffOwner)).toHaveLength(1)
  })
  it('close/reopen retries a failed owner handoff in the visible subscriber without a false Done state', async () => {
    const pending = pendingFirstDrive()
    const firstClear = deferred<void>()
    const setDraft = vi.fn()
    const clearLandedStarter = vi.fn()
      .mockImplementationOnce(async () => { await firstClear.promise; throw new Error('pointer clear failed') })
      .mockResolvedValueOnce(undefined)
    const close = vi.fn()
    const navigateToChat = vi.fn()
    expect(coordinatorApi.completeAgentTeamCreationHandoff).toBeTypeOf('function')
    const onCreated = vi.fn((createdTeam: AgentTeam, result: { chatId: string; operationId: string }) => (
      coordinatorApi.completeAgentTeamCreationHandoff!(createdTeam, result, {
        setDraft,
        clearLandedStarter,
        close,
        navigateToChat,
      })
    ))
    const onCreate = (createdTeam: AgentTeam, onProgress?: Parameters<typeof createAgentTeam>[1]['onProgress']) => (
      createAgentTeam(createdTeam, { onProgress })
    )
    let harness = createReactHarness()
    try {
      await harness.render(createNode(BuildAgentWizard, {
        initialTeam: team({ starterPrompt: '  custom starter\n' }),
        onCreate,
        onCreated,
        onClose: vi.fn(),
      }))
      await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-testid="wizard-create"]')!.click() })
      await vi.waitFor(() => { expect(provisionTeam).toHaveBeenCalledTimes(1) })
      expect(document.body.querySelector('[aria-label="关闭向导"]')).toBeNull()
      harness.cleanup()
      harness = createReactHarness()
      await harness.render(createNode(BuildAgentWizard, {
        initialTeam: team({ starterPrompt: '  custom starter\n' }),
        onCreate,
        onCreated,
        onClose: vi.fn(),
      }))
      await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-testid="wizard-create"]')!.click() })
      await act(async () => {
        pending.resolve(completedResult('op-stored'))
        await pending.promise
        await Promise.resolve()
      })
      await vi.waitFor(() => { expect(onCreated).toHaveBeenCalledTimes(1) })
      expect(document.body.querySelector('[data-testid="wizard-creating-label"]')).not.toBeNull()
      expect(document.body.textContent).not.toContain('团队已创建')
      expect(setDraft).toHaveBeenCalledWith(GROUP, '  custom starter\n')
      expect(close).not.toHaveBeenCalled()
      expect(navigateToChat).not.toHaveBeenCalled()
      await act(async () => {
        firstClear.resolve()
        await firstClear.promise
        await Promise.resolve()
      })
      await vi.waitFor(() => { expect(onCreated).toHaveBeenCalledTimes(2) })
      await vi.waitFor(() => { expect(document.body.textContent).toContain('团队已创建') })
      expect(setDraft, 'retrying the same exact draft is idempotent').toHaveBeenCalledTimes(2)
      expect(clearLandedStarter).toHaveBeenCalledTimes(2)
      expect(clearLandedStarter).toHaveBeenNthCalledWith(1, 'op-stored')
      expect(clearLandedStarter).toHaveBeenNthCalledWith(2, 'op-stored')
      expect(close, 'only the committed handoff closes the sheet').toHaveBeenCalledTimes(1)
      expect(navigateToChat, 'only the committed handoff navigates').toHaveBeenCalledTimes(1)
      expect(navigateToChat).toHaveBeenCalledWith(GROUP)
      expect(provisionTeam).toHaveBeenCalledTimes(1)
      expect(resumeTeam).not.toHaveBeenCalled()
    } finally {
      harness.cleanup()
    }
  })
  it('completion while closed remains attachable; reopening after settle does not start/resume another driver', async () => {
    const pending = pendingFirstDrive()
    const first = createAgentTeam(team({ starterPrompt: 'kept while closed' }), {})
    await vi.waitFor(() => { expect(provisionTeam).toHaveBeenCalledTimes(1) })
    pending.resolve(completedResult('op-stored'))
    const firstResult = await first
    const reopenedPromise = createAgentTeam(team({ starterPrompt: 'kept while closed' }), {})
    let reopenedSettled = false
    void reopenedPromise.then(() => { reopenedSettled = true })
    await Promise.resolve()
    expect(reopenedSettled).toBe(false)
    firstResult.finishHandoff?.(true)
    const reopened = await reopenedPromise
    expect(provisionTeam).toHaveBeenCalledTimes(1)
    expect(resumeTeam).not.toHaveBeenCalled()
    expect((firstResult as typeof firstResult & { handoffOwner?: boolean }).handoffOwner).toBe(true)
    expect((reopened as typeof reopened & { handoffOwner?: boolean }).handoffOwner).toBe(false)
  })
  it('hydrates the durable custom starter verbatim before reopening the wizard', async () => {
    window.localStorage.setItem(RESUME_KEY, JSON.stringify([storedRecord()]))
    starterContinuationStore.remember({ version: 1, ownerUserId: OWNER, operationId: 'op-stored', starter: '  custom\ntext  ' })
    expect(coordinatorApi.hydrateAgentTeamForReentry).toBeTypeOf('function')
    const hydrated = await coordinatorApi.hydrateAgentTeamForReentry!(team({ starterPrompt: 'PRESET DEFAULT' }))
    expect(hydrated.team.starterPrompt).toBe('  custom\ntext  ')
  })
  it('an intentionally cleared starter survives attach as empty and never revives the prior/default text', async () => {
    const pending = pendingFirstDrive()
    const first = createAgentTeam(team({ starterPrompt: 'old custom' }), {})
    await vi.waitFor(() => { expect(provisionTeam).toHaveBeenCalledTimes(1) })
    const attached = createAgentTeam(team({ starterPrompt: '' }), {})
    await vi.waitFor(() => { expect(starterContinuationStore.find(OWNER, 'op-stored')?.starter).toBe('') })
    pending.resolve(completedResult('op-stored'))
    const firstResult = await first
    firstResult.finishHandoff?.(true)
    const attachedResult = await attached
    expect((attachedResult as typeof attachedResult & { starterPrompt?: string }).starterPrompt).toBe('')
  })
  it('two rejected overlapping edits roll memory back to the last DURABLE starter, never to an optimistic failed edit', async () => {
    const pending = pendingFirstDrive()
    const first = createAgentTeam(team({ starterPrompt: 'durable A' }), {})
    void first.catch(() => undefined)
    await vi.waitFor(() => { expect(starterContinuationStore.find(OWNER, 'op-stored')?.starter).toBe('durable A') })
    let ownerReads = 0
    getCurrentAuthUserId.mockImplementation(async () => {
      ownerReads += 1
      if (ownerReads > 2) throw new Error(`starter write ${ownerReads - 2} failed`)
      return OWNER
    })
    const editB = createAgentTeam(team({ starterPrompt: 'optimistic B' }), {})
    const editC = createAgentTeam(team({ starterPrompt: 'optimistic C' }), {})
    await expect(editB).rejects.toThrow(/starter write 1 failed/)
    await expect(editC).rejects.toThrow(/starter write 2 failed/)
    getCurrentAuthUserId.mockResolvedValue(OWNER)
    pending.resolve(completedResult('op-stored'))
    const result = await first
    expect(result.starterPrompt, 'handoff must expose the last successfully durable revision').toBe('durable A')
    expect(starterContinuationStore.find(OWNER, 'op-stored')?.starter).toBe('durable A')
    coordinatorApi.resetAgentTeamCreationCoordinatorForTests?.()
    getCurrentAuthUserId.mockResolvedValue(OWNER)
    const recovered = await coordinatorApi.hydrateAgentTeamForReentry!(team({ starterPrompt: 'PRESET DEFAULT' }))
    expect(recovered.team.starterPrompt, 'crash recovery and in-memory handoff agree').toBe('durable A')
  })
  it('a fully-cancelled operation fences and drains a blocked starter write before the terminal clear', async () => {
    const pending = pendingFirstDrive()
    const first = createAgentTeam(team({ starterPrompt: 'durable A' }), {})
    void first.catch(() => undefined)
    await vi.waitFor(() => { expect(starterContinuationStore.find(OWNER, 'op-stored')?.starter).toBe('durable A') })
    const blockedWrite = deferred<string>()
    let ownerReads = 0
    getCurrentAuthUserId.mockImplementation(async () => {
      ownerReads += 1
      if (ownerReads === 2) return blockedWrite.promise
      return OWNER
    })
    const lateEdit = createAgentTeam(team({ starterPrompt: 'late B' }), {})
    void lateEdit.catch(() => undefined)
    await vi.waitFor(() => { expect(ownerReads).toBeGreaterThanOrEqual(2) })
    expect(coordinatorApi.cancelAgentTeamCreation).toBeTypeOf('function')
    const cancelling = coordinatorApi.cancelAgentTeamCreation!('op-stored')
    const early = await Promise.race([
      cancelling.then(() => 'resolved' as const),
      new Promise<'pending'>((resolve) => { setTimeout(() => resolve('pending'), 30) }),
    ])
    expect(early, 'cancel must wait for the registered write before its final clear').toBe('pending')
    blockedWrite.resolve(OWNER)
    const cancelled = await cancelling
    expect(cancelled.fullyCancelled).toBe(true)
    await expect(lateEdit).rejects.toThrow(/cancel/i)
    expect(starterContinuationStore.find(OWNER, 'op-stored'), 'a late write cannot resurrect the cancelled pointer').toBeUndefined()
    pending.resolve(completedResult('op-stored'))
    await expect(first, 'the cancelled drive cannot surface a success handoff').rejects.toThrow(/cancel/i)
  })
  it('completed cancel is a true no-op: it lifts the fence and preserves the success handoff', async () => {
    const pending = pendingFirstDrive()
    const first = createAgentTeam(team({ starterPrompt: 'durable A' }), {})
    await vi.waitFor(() => { expect(provisionTeam).toHaveBeenCalledTimes(1) })
    operationPhase = 'completed'
    const cancelled = await coordinatorApi.cancelAgentTeamCreation!('op-stored')
    expect(cancelled.completedNoop).toBe(true)
    pending.resolve(completedResult('op-stored'))
    const result = await first
    expect(result.handoffOwner).toBe(true)
    expect(result.starterPrompt).toBe('durable A')
  })
  it('completed no-op while an exposed owner is clearing the pointer preserves that SAME lease and one navigation', async () => {
    const pending = pendingFirstDrive()
    const first = createAgentTeam(team({ starterPrompt: 'durable A' }), {})
    await vi.waitFor(() => { expect(provisionTeam).toHaveBeenCalledTimes(1) })
    pending.resolve(completedResult('op-stored'))
    const owner = await first
    expect(owner.handoffOwner).toBe(true)
    const pointerClear = deferred<void>()
    const cancelDecision = deferred<{ id: string; phase: string }>()
    const close = vi.fn()
    const navigateToChat = vi.fn()
    const handoff = coordinatorApi.completeAgentTeamCreationHandoff!(team({ starterPrompt: 'durable A' }), owner, {
      setDraft: vi.fn(),
      clearLandedStarter: async () => pointerClear.promise,
      close,
      navigateToChat,
    })
    void handoff.catch(() => undefined)
    const observer = createAgentTeam(team({ starterPrompt: undefined }), {})
    let observerSettled = false
    void observer.then(() => { observerSettled = true })
    operationPhase = 'completed'
    getProvisionOperation.mockImplementationOnce(async () => cancelDecision.promise)
    const cancelling = coordinatorApi.cancelAgentTeamCreation!('op-stored')
    pointerClear.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(close, 'the handoff waits for the DB cancel decision').not.toHaveBeenCalled()
    expect(observerSettled, 'the observer cannot steal a temporarily fenced lease').toBe(false)
    cancelDecision.resolve({ id: 'op-stored', phase: 'completed' })
    const cancelled = await cancelling
    expect(cancelled.completedNoop).toBe(true)
    await handoff
    const observed = await observer
    expect(observed.handoffOwner).toBe(false)
    expect(close).toHaveBeenCalledTimes(1)
    expect(navigateToChat).toHaveBeenCalledTimes(1)
  })
  it('a rejected cancel while an exposed owner is clearing the pointer also preserves the same lease', async () => {
    const pending = pendingFirstDrive()
    const first = createAgentTeam(team({ starterPrompt: 'durable A' }), {})
    await vi.waitFor(() => { expect(provisionTeam).toHaveBeenCalledTimes(1) })
    pending.resolve(completedResult('op-stored'))
    const owner = await first
    const pointerClear = deferred<void>()
    const cancelDecision = deferred<never>()
    const close = vi.fn()
    const navigateToChat = vi.fn()
    const handoff = coordinatorApi.completeAgentTeamCreationHandoff!(team({ starterPrompt: 'durable A' }), owner, {
      setDraft: vi.fn(),
      clearLandedStarter: async () => pointerClear.promise,
      close,
      navigateToChat,
    })
    void handoff.catch(() => undefined)
    const observer = createAgentTeam(team({ starterPrompt: undefined }), {})
    let observerSettled = false
    void observer.then(() => { observerSettled = true })
    getProvisionOperation.mockImplementationOnce(async () => cancelDecision.promise)
    const cancelling = coordinatorApi.cancelAgentTeamCreation!('op-stored')
    void cancelling.catch(() => undefined)
    pointerClear.resolve()
    await Promise.resolve()
    expect(close, 'temporary cancel failure is decided before handoff continues').not.toHaveBeenCalled()
    expect(observerSettled).toBe(false)
    cancelDecision.reject(new Error('cancel DB unavailable'))
    await expect(cancelling).rejects.toThrow(/cancel DB unavailable/)
    await handoff
    const observed = await observer
    expect(observed.handoffOwner).toBe(false)
    expect(close).toHaveBeenCalledTimes(1)
    expect(navigateToChat).toHaveBeenCalledTimes(1)
  })
  it('a same-starter observer during exposed pointer cleanup never enqueues a late terminal rewrite', async () => {
    const pending = pendingFirstDrive()
    const first = createAgentTeam(team({ starterPrompt: 'durable A' }), {})
    await vi.waitFor(() => { expect(provisionTeam).toHaveBeenCalledTimes(1) })
    pending.resolve(completedResult('op-stored'))
    const owner = await first
    const pointerClear = deferred<void>()
    const duplicateWrite = deferred<string>()
    let ownerReads = 0
    getCurrentAuthUserId.mockImplementation(async () => {
      ownerReads += 1
      if (ownerReads === 2) return duplicateWrite.promise
      return OWNER
    })
    const close = vi.fn()
    const handoff = coordinatorApi.completeAgentTeamCreationHandoff!(team({ starterPrompt: 'durable A' }), owner, {
      setDraft: vi.fn(),
      clearLandedStarter: async (operationId) => {
        await pointerClear.promise
        starterContinuationStore.clear(OWNER, operationId, 'draft-landed')
      },
      close,
      navigateToChat: vi.fn(),
    })
    const observer = createAgentTeam(team({ starterPrompt: 'durable A' }), {})
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    pointerClear.resolve()
    await handoff
    duplicateWrite.resolve(OWNER)
    const observed = await observer
    expect(observed.handoffOwner).toBe(false)
    expect(close).toHaveBeenCalledTimes(1)
    expect(starterContinuationStore.find(OWNER, 'op-stored'), 'no redundant same-value write may revive the cleared pointer').toBeUndefined()
  })
  it('a starter write racing finalization is durably bound to the completed group before handoff', async () => {
    const pending = pendingFirstDrive()
    const first = createAgentTeam(team({ starterPrompt: undefined }), {})
    await vi.waitFor(() => { expect(provisionTeam).toHaveBeenCalledTimes(1) })
    const blockedWrite = deferred<string>()
    let ownerReads = 0
    getCurrentAuthUserId.mockImplementation(async () => {
      ownerReads += 1
      if (ownerReads === 2) return blockedWrite.promise
      return OWNER
    })
    const edited = createAgentTeam(team({ starterPrompt: 'late first starter' }), {})
    await vi.waitFor(() => { expect(ownerReads).toBeGreaterThanOrEqual(2) })
    pending.resolve(completedResult('op-stored'))
    blockedWrite.resolve(OWNER)
    const firstResult = await first
    expect(firstResult.starterPrompt).toBe('late first starter')
    expect(starterContinuationStore.find(OWNER, 'op-stored')).toMatchObject({
      starter: 'late first starter',
      groupChatId: GROUP,
    })
    firstResult.finishHandoff?.(false)
    const editedResult = await edited
    expect(editedResult.handoffOwner).toBe(true)
  })
  it('a first starter attached after completion is persisted and bound to the retained group', async () => {
    const pending = pendingFirstDrive()
    const first = createAgentTeam(team({ starterPrompt: undefined }), {})
    await vi.waitFor(() => { expect(provisionTeam).toHaveBeenCalledTimes(1) })
    pending.resolve(completedResult('op-stored'))
    const firstResult = await first
    expect(firstResult.handoffOwner).toBe(true)
    const edited = createAgentTeam(team({ starterPrompt: 'post-completion starter' }), {})
    firstResult.finishHandoff?.(false)
    await vi.waitFor(() => {
      expect(starterContinuationStore.find(OWNER, 'op-stored')).toMatchObject({
        starter: 'post-completion starter',
        groupChatId: GROUP,
      })
    })
    const editedResult = await edited
    expect(editedResult.starterPrompt).toBe('post-completion starter')
  })
  it('a later edit invalidates the exposed handoff lease before old close/navigation, then takes over with the new draft', async () => {
    const pending = pendingFirstDrive()
    const first = createAgentTeam(team({ starterPrompt: 'starter A' }), {})
    await vi.waitFor(() => { expect(provisionTeam).toHaveBeenCalledTimes(1) })
    pending.resolve(completedResult('op-stored'))
    const firstResult = await first
    expect(firstResult.handoffOwner).toBe(true)
    const oldClear = deferred<void>()
    const drafts: string[] = []
    const close = vi.fn()
    const navigateToChat = vi.fn()
    const oldHandoff = coordinatorApi.completeAgentTeamCreationHandoff!(
      team({ starterPrompt: 'starter A' }),
      firstResult,
      {
        setDraft: (_chatId, value) => { drafts.push(value) },
        clearLandedStarter: async () => oldClear.promise,
        close,
        navigateToChat,
      },
    )
    await vi.waitFor(() => { expect(drafts).toEqual(['starter A']) })
    const newer = createAgentTeam(team({ starterPrompt: 'starter B' }), {})
    await Promise.resolve()
    expect(starterContinuationStore.find(OWNER, 'op-stored')?.starter, 'new persistence waits for old lease release').toBe('starter A')
    oldClear.resolve()
    await expect(oldHandoff).rejects.toThrow(/stale|handoff|superseded/i)
    expect(close, 'the stale owner cannot close the wizard').not.toHaveBeenCalled()
    expect(navigateToChat, 'the stale owner cannot navigate with the old draft').not.toHaveBeenCalled()
    const takeover = await newer
    expect(takeover.handoffOwner).toBe(true)
    await coordinatorApi.completeAgentTeamCreationHandoff!(
      team({ starterPrompt: 'starter B' }),
      takeover,
      {
        setDraft: (_chatId, value) => { drafts.push(value) },
        clearLandedStarter: async (operationId) => {
          starterContinuationStore.clear(OWNER, operationId, 'draft-landed')
        },
        close,
        navigateToChat,
      },
    )
    expect(drafts).toEqual(['starter A', 'starter B'])
    expect(close).toHaveBeenCalledTimes(1)
    expect(navigateToChat).toHaveBeenCalledTimes(1)
    expect(starterContinuationStore.find(OWNER, 'op-stored')).toBeUndefined()
  })
  it('an unconverged real cancel invalidates every success ticket but retains durable cleanup records', async () => {
    const pending = pendingFirstDrive()
    window.localStorage.setItem(RESUME_KEY, JSON.stringify([storedRecord()]))
    starterContinuationStore.remember({ version: 1, ownerUserId: OWNER, operationId: 'op-stored', starter: 'keep for cleanup' })
    const first = createAgentTeam(team({ starterPrompt: 'keep for cleanup' }), {})
    void first.catch(() => undefined)
    await vi.waitFor(() => { expect(resumeTeam).toHaveBeenCalledTimes(1) })
    const observer = createAgentTeam(team({ starterPrompt: 'keep for cleanup' }), {})
    void observer.catch(() => undefined)
    cancelUnconverged = true
    const cancelled = await coordinatorApi.cancelAgentTeamCreation!('op-stored')
    expect(cancelled.completedNoop).toBe(false)
    expect(cancelled.fullyCancelled).toBe(false)
    expect(window.localStorage.getItem(RESUME_KEY), 'cleaning_up stays resumable').not.toBeNull()
    expect(starterContinuationStore.find(OWNER, 'op-stored')?.starter).toBe('keep for cleanup')
    pending.resolve(completedResult('op-stored'))
    await expect(first, 'no cancelled attempt may later claim success').rejects.toThrow(/cancel/i)
    await expect(observer).rejects.toThrow(/cancel/i)
  })
})
describe('#2260 boundary E2a — cancel is terminal: it leaves nothing rejoinable behind', () => {
  it('a fully cancelled operation forgets its resume record and clears its starter pointer', async () => {
    window.localStorage.setItem(RESUME_KEY, JSON.stringify([storedRecord()]))
    starterContinuationStore.remember({ version: 1, ownerUserId: OWNER, operationId: 'op-stored', starter: '开场任务' })
    await cancelTeamProvision('op-stored', {
      stopAgentRuntime: async () => {},
      removeOwnedAgent: async () => {},
    })
    expect(window.localStorage.getItem(RESUME_KEY), 'no resumable record survives a converged cancel').toBeNull()
    expect(starterContinuationStore.find(OWNER, 'op-stored'), 'the starter pointer is cleared as cancelled').toBeUndefined()
  })
  it('an UNCONVERGED cancel keeps both (still recoverable — compensation must be able to continue)', async () => {
    window.localStorage.setItem(RESUME_KEY, JSON.stringify([storedRecord()]))
    starterContinuationStore.remember({ version: 1, ownerUserId: OWNER, operationId: 'op-stored', starter: '开场任务' })
    cancelUnconverged = true
    const res = await cancelTeamProvision('op-stored', {
      stopAgentRuntime: async () => {},
      removeOwnedAgent: async () => {},
    })
    expect(res.fullyCancelled).toBe(false)
    expect(window.localStorage.getItem(RESUME_KEY), 'kept: the operation is still cleaning_up').not.toBeNull()
    expect(starterContinuationStore.find(OWNER, 'op-stored')?.starter).toBe('开场任务')
  })
  it('a lingering record whose operation is cancelled is dropped, and a FRESH team is created', async () => {
    window.localStorage.setItem(RESUME_KEY, JSON.stringify([storedRecord()]))
    operationPhase = 'cancelled'
    const res = await createAgentTeam(team(), {})
    expect(resumeTeam, 'never resume a terminal operation').not.toHaveBeenCalled()
    expect(provisionTeam).toHaveBeenCalledTimes(1)
    expect(res.operationId).toBe('op-fresh')
    expect(window.localStorage.getItem(RESUME_KEY), 'the dead record is dropped, not left to trip the next create').toBeNull()
  })
})
describe('#2260 boundary E2a — exact semantic fingerprint: divergent intent must never be rejoined', () => {
  const seed = () => window.localStorage.setItem(RESUME_KEY, JSON.stringify([storedRecord()]))
  it.each([
    ['identical intent', (t: ReturnType<typeof team>) => t],
    ['member order changed', (t: ReturnType<typeof team>) => {
      t.members = [t.members[1], t.members[0]]
      return t
    }],
  ])('%s still rejoins the stored operation', async (_label, mutate) => {
    seed()
    const res = await createAgentTeam(mutate(team()), {})
    expect(res.operationId).toBe('op-stored')
    expect(provisionTeam).not.toHaveBeenCalled()
  })
  const zeroSideEffects = () => {
    expect(resumeTeam, 'must not rejoin a divergent intent').not.toHaveBeenCalled()
    expect(provisionTeam, 'must not fork a second live operation for the same team').not.toHaveBeenCalled()
  }
  it('ENGINE override on a live same-name operation → REFUSED, zero side effects', async () => {
    seed()
    const t = team()
    t.members[0] = { ...t.members[0], engineId: 'claude-code' }
    await expect(createAgentTeam(t, {})).rejects.toThrow(/op-stored/)
    zeroSideEffects()
  })
  it('the multi-match refusal also names every operation and both exits', async () => {
    const a = storedRecord()
    const b = { ...storedRecord(), operationId: 'op-stored-2' }
    window.localStorage.setItem(RESUME_KEY, JSON.stringify([a, b]))
    const err = await createAgentTeam(team(), {}).catch((e: Error) => e)
    const msg = (err as Error).message
    expect(msg).toContain('op-stored')
    expect(msg).toContain('op-stored-2')
    expect(msg).toMatch(/继续/)
    expect(msg).toMatch(/取消/)
  })
  it('the refusal never auto-cancels: the old operation and its record are left intact for the user to decide', async () => {
    seed()
    starterContinuationStore.remember({ version: 1, ownerUserId: OWNER, operationId: 'op-stored', starter: '开场任务' })
    const t = team({ groupPrompt: '章程改了' })
    await expect(createAgentTeam(t, {})).rejects.toThrow(/op-stored/)
    expect(window.localStorage.getItem(RESUME_KEY), 'the live record stays — cancelling is the user\'s call').not.toBeNull()
    expect(starterContinuationStore.find(OWNER, 'op-stored')?.starter).toBe('开场任务')
  })
  it('a CANCELLED divergent record is swept, and then the divergent intent CAN be created fresh', async () => {
    seed()
    operationPhase = 'cancelled'          // the old same-name operation is done with
    const t = team({ groupPrompt: '章程改了' })
    const res = await createAgentTeam(t, {})
    expect(res.operationId, 'stale records must not block a legitimate new team').toBe('op-fresh')
    expect(window.localStorage.getItem(RESUME_KEY), 'the dead record is swept').toBeNull()
  })
  it('generated ids are NOT identity: a record differing only in provision_id / member_key / group_chat_id rejoins', async () => {
    const rec = storedRecord()
    rec.blueprint.group_chat_id = '99999999-9999-4999-8999-999999999999'
    rec.blueprint.members[0].provision_id = 'pv-other'
    rec.blueprint.members[0].member_key = 'preset-debate-long-4242'
    rec.members[0] = { provisionId: 'pv-other', memberKey: 'preset-debate-long-4242' }
    window.localStorage.setItem(RESUME_KEY, JSON.stringify([rec]))
    const res = await createAgentTeam(team(), {})
    expect(res.operationId, 'ids are minted, not intent').toBe('op-stored')
  })
  it('TWO live records with the same intent → fail loud, never pick one arbitrarily', async () => {
    const a = storedRecord()
    const b = { ...storedRecord(), operationId: 'op-stored-2' }
    window.localStorage.setItem(RESUME_KEY, JSON.stringify([a, b]))
    await expect(createAgentTeam(team(), {})).rejects.toThrow(/多条|ambiguous|2/i)
    expect(resumeTeam, 'choosing for the user is not allowed').not.toHaveBeenCalled()
    expect(provisionTeam).not.toHaveBeenCalled()
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
