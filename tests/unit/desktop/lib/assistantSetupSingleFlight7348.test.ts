// #7348 这台电脑上同一时刻只推一次开通:开通页还在等它起来时,壳也会想接着推 —— 后来的一方接上正在推的那一次,❌ 同一单推两遍。
import { afterEach, describe, expect, it, vi } from 'vitest'

const provision = vi.hoisted(() => ({
  provisionSingleAgent: vi.fn(),
  resumeSingleAgent: vi.fn(),
  getProvisionOperation: vi.fn(async () => null as null | { phase: string }),
  assertResumeRecordOwner: vi.fn(async () => undefined),
  completedSingleProvisionSession: vi.fn((result: { agentUserId: string }) => ({ agentUserId: result.agentUserId })),
  forget: vi.fn(),
  createResumeStore: vi.fn(() => ({ list: () => [], forget: (...args: unknown[]) => provision.forget(...args) })),
}))
vi.mock('../../../../apps/desktop/src/lib/agentProvision', () => provision)
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ getCurrentAuthUserId: vi.fn(async () => 'owner') }))
const ipc = vi.hoisted(() => ({ invoke: vi.fn(async () => ({ workdir: '/home/assistant', home: '/home' })) }))
vi.mock('../../../../apps/desktop/src/platform/desktopIpc', () => ({ desktopIpc: () => ipc }))
vi.mock('../../../../apps/desktop/src/lib/assistantSetupPreparation', () => ({ prepareLocalAssistantSetup: async () => ({ workdir: '/home/assistant', home: '/home' }) }))
vi.mock('../../../../apps/desktop/src/lib/cloudComputerStore', () => ({ provisionCloudComputer: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/contacts', async () => {
  const { buildLookUrl, lookObjectPath } = await import('../../../../apps/desktop/src/components/agentAvatar/look')
  return { contactsService: { agentLookAvatarUrl: (look: import('../../../../apps/desktop/src/components/agentAvatar/look').AgentLook) =>
    buildLookUrl(`https://db.example/storage/v1/object/public/avatars/${lookObjectPath(look.color)}`, look.rest, look.wear) } }
})
const { DEFAULT_ASSISTANT_LOOK, parseAgentLook, wornOf } = await import('../../../../apps/desktop/src/components/agentAvatar/look')
const { provisionCloudComputer } = await import('../../../../apps/desktop/src/lib/cloudComputerStore')

const { setUpAssistantOnThisComputer, resumeLocalAssistant, setupStillStarting, AssistantSetupError, claimCloudAssistant } = await import('../../../../apps/desktop/src/lib/assistantSetup')

const draft = { name: 'Gugu', color: 0, rest: 'curious', owner: { preferredName: 'Neo', about: '' } } as const
const record = { operationId: 'op-1' } as never
const completed = (agentUserId: string) => ({ agentUserId, outcome: { member: { phase: 'completed' } } })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

describe('local assistant setup runs once at a time on this computer (#7348)', () => {
  it('uses the configured harness default when the official model provider is disabled', async () => {
    vi.stubEnv('GUGU_PLATFORM_MODELS_ENABLED', 'false')
    provision.provisionSingleAgent.mockResolvedValueOnce(completed('local-assistant'))
    await expect(setUpAssistantOnThisComputer(draft as never, 'device-1')).resolves.toEqual({ agentUserId: 'local-assistant' })
    expect(provision.provisionSingleAgent).toHaveBeenCalledWith(
      'device-1',
      expect.objectContaining({ agentType: 'claude-code' }),
      expect.objectContaining({ model: null, assistant: expect.objectContaining({ childHarness: 'claude' }) }),
    )
  })
  it('rejects another owner before reading the operation or dropping any recovery record', async () => {
    provision.assertResumeRecordOwner.mockRejectedValueOnce(new Error('wrong owner'))
    await expect(resumeLocalAssistant(record)).rejects.toThrow('wrong owner')
    expect(provision.getProvisionOperation).not.toHaveBeenCalled()
    expect(provision.forget).not.toHaveBeenCalled()
    expect(provision.resumeSingleAgent).not.toHaveBeenCalled()
  })
  it('forgets only a canonically cancelled setup and never resumes its reclaimed identity', async () => {
    provision.getProvisionOperation.mockResolvedValueOnce({ phase: 'cancelled' })
    await expect(resumeLocalAssistant({ operationId: 'cancelled-op', ownerUserId: 'owner' } as never)).rejects.toMatchObject({ kind: 'failed' })
    expect(provision.forget).toHaveBeenCalledWith('owner', 'cancelled-op')
    expect(provision.resumeSingleAgent).not.toHaveBeenCalled()
    expect(ipc.invoke).not.toHaveBeenCalled()
  })
  it('a resume while the setup is still waiting joins that setup instead of pushing the same order twice', async () => {
    const first = deferred<ReturnType<typeof completed>>()
    provision.provisionSingleAgent.mockReturnValueOnce(first.promise)
    const setUp = setUpAssistantOnThisComputer(draft as never, 'device-1')
    const resumed = resumeLocalAssistant(record)
    expect(resumed).toBe(setUp)
    first.resolve(completed('agent-1'))
    await expect(resumed).resolves.toEqual({ agentUserId: 'agent-1' })
    expect(provision.resumeSingleAgent).not.toHaveBeenCalled()
    expect(provision.provisionSingleAgent).toHaveBeenCalledWith(
      'device-1',
      expect.objectContaining({ agentType: 'claude-code' }),
      expect.objectContaining({ model: 'platform:glm-5.3-flash', assistant: expect.objectContaining({ childHarness: 'claude' }) }),
    )
  })

  it('once that attempt is over (here: gave up still starting), the next resume really pushes again', async () => {
    provision.provisionSingleAgent.mockResolvedValueOnce({ outcome: { member: { phase: 'awaiting_terminal' } } })
    await expect(setUpAssistantOnThisComputer(draft as never, 'device-1')).rejects.toMatchObject({ kind: 'still-starting' })
    provision.resumeSingleAgent.mockResolvedValueOnce(completed('agent-1'))
    await expect(resumeLocalAssistant(record)).resolves.toEqual({ agentUserId: 'agent-1' })
    expect(provision.resumeSingleAgent).toHaveBeenCalledTimes(1)
  })

  it('only "still starting" is worth pushing again later; a reclaimed order or a real failure is not', async () => {
    provision.provisionSingleAgent.mockResolvedValueOnce({ outcome: { member: { phase: 'awaiting_terminal' } } })
    const waiting = await setUpAssistantOnThisComputer(draft as never, 'device-1').catch((e: unknown) => e)
    expect(setupStillStarting(waiting)).toBe(true)
    provision.resumeSingleAgent.mockRejectedValueOnce(new Error('provision p-1 is governed-removed (agent a-1 reclaimed; evidence retained) — cancel/settle only'))
    const reclaimed = await resumeLocalAssistant(record).catch((e: unknown) => e)
    expect(setupStillStarting(reclaimed)).toBe(false)
    expect(setupStillStarting(new AssistantSetupError('failed', 'agent.create failed'))).toBe(false)
  })
})


describe('assistant setup appearance', () => {
  it('keeps the untouched default plain for both the draft and final identity', async () => {
    const plain = { ...draft, ...DEFAULT_ASSISTANT_LOOK }
    provision.provisionSingleAgent.mockResolvedValueOnce(completed('new-assistant'))
    await setUpAssistantOnThisComputer(plain, 'device-1')
    const avatar = provision.provisionSingleAgent.mock.calls[0][1].avatar
    const saved = parseAgentLook(avatar)!
    expect(saved).toEqual({ color: 0, rest: 'neutral' })
    expect(new URL(avatar).searchParams.has('wear')).toBe(false)
    expect(wornOf(saved)).toEqual([])
  })

  it('preserves all selected appearance fields when creating a local assistant', async () => {
    const selected = { ...draft, color: 9, rest: 'happy', wear: [{ id: 'set-puppy', cw: 0 }] } as const
    provision.provisionSingleAgent.mockResolvedValueOnce(completed('new-assistant'))
    await setUpAssistantOnThisComputer(selected, 'device-1')
    expect(parseAgentLook(provision.provisionSingleAgent.mock.calls[0][1].avatar)).toEqual({ color: 9, rest: 'happy', wear: [{ id: 'set-puppy', cw: 0 }] })
  })

  it('sends the same plain default to cloud setup', async () => {
    await claimCloudAssistant({ ...draft, ...DEFAULT_ASSISTANT_LOOK })
    expect(parseAgentLook(cloudAvatar())).toEqual(DEFAULT_ASSISTANT_LOOK)
  })
})

  it('preserves chosen accessories in cloud setup', async () => {
    const selected = { ...draft, color: 4, rest: 'shy', wear: [{ id: 'set-bear', cw: 0 }] } as const
    await claimCloudAssistant(selected)
    expect(parseAgentLook(cloudAvatar())).toEqual({ color: 4, rest: 'shy', wear: [{ id: 'set-bear', cw: 0 }] })
  })

function cloudAvatar(): string | null {
  const assistant = vi.mocked(provisionCloudComputer).mock.calls[0][0]?.assistant
  if (!assistant || !('avatar' in assistant)) throw new Error('expected a new cloud assistant setup')
  return assistant.avatar
}
