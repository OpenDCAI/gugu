// @vitest-environment jsdom
// #7350 关闭住在这台电脑上的咕咕:撤定时任务 →(勾了)删它开过的会话 → 删它 → 停它的会话 → 清它的家 → 回到「认识咕咕」。
import { afterEach, describe, expect, it, vi } from 'vitest'

const mine = vi.hoisted(() => ({ isMyAssistant: vi.fn(() => false) }))
vi.mock('../../../../apps/desktop/src/lib/myAssistant', () => mine)

const {
  AssistantCloseError,
  closeIfMyAssistant,
  closeLocalAssistant,
  planLocalClose,
} = await import('../../../../apps/desktop/src/lib/assistantClose')
const { UI_EVENTS } = await import('../../../../apps/desktop/src/lib/uiEvents')

const GUGU = 'agent-gugu'
const session = (conversationId: string, extra: Record<string, unknown> = {}) =>
  ({ conversationId, projectId: 'p1', title: conversationId, agent: null, parentConversationId: null, spawnedByConversationId: null, ...extra }) as never

const sessions = [
  session('s-gugu', { agent: { userId: GUGU } }),
  session('s-child', { agent: { userId: 'agent-child' }, spawnedByConversationId: 's-gugu' }),
  session('s-grandchild', { parentConversationId: 's-child' }),
  session('s-other', { agent: { userId: 'agent-other' } }),
]
const automations = [
  { id: 'a-gugu', agentSessionId: 's-gugu' },
  { id: 'a-child', agentSessionId: 's-child' },
  { id: 'a-other', agentSessionId: 's-other' },
  { id: 'a-none' },
]

function rig(overrides: Record<string, unknown> = {}) {
  const calls: string[] = []
  const deps = {
    listSessions: vi.fn(async () => sessions),
    listAutomations: vi.fn(async () => automations),
    deleteAutomation: vi.fn(async (id: string) => void calls.push(`schedule:${id}`)),
    removeAgent: vi.fn(async (id: string) => void calls.push(`agent:${id}`)),
    archiveSession: vi.fn(async (_projectId: string, id: string) => void calls.push(`archive:${id}`)),
    wipeHome: vi.fn(async () => void calls.push('wipe')),
    resetLocalState: vi.fn(() => void calls.push('reset')),
    ...overrides,
  }
  return { calls, deps }
}

afterEach(() => vi.clearAllMocks())

describe('close the assistant that lives on this computer (#7350)', () => {
  it('cloud cleanup unavailable or the target changed: refuse before deleting any schedule, session or identity', async () => {
    const { calls, deps } = rig({ check: async () => { throw new Error('cloud cleanup is not available') } })
    await expect(closeLocalAssistant({ assistantId: GUGU, deleteStarted: true }, await planLocalClose(GUGU, deps), deps)).rejects.toMatchObject({ step: 'check' })
    expect(calls).toEqual([])
  })
  it('knows its own session and every session it started (child, grandchild), nothing else', async () => {
    const plan = await planLocalClose(GUGU, rig().deps)
    expect(plan.own.map((s) => s.conversationId)).toEqual(['s-gugu'])
    expect(plan.started.map((s) => s.conversationId).sort()).toEqual(['s-child', 's-grandchild'])
  })

  it('box unticked: its schedules go first, then it, its session, its home; started tasks are archived with identities kept', async () => {
    const { calls, deps } = rig()
    await closeLocalAssistant({ assistantId: GUGU, deleteStarted: false }, await planLocalClose(GUGU, deps), deps)
    expect(calls).toEqual(['schedule:a-gugu', 'schedule:a-child', 'archive:s-child', 'archive:s-grandchild', `agent:${GUGU}`, 'archive:s-gugu', 'wipe', 'reset'])
  })

  it('box ticked: the started sessions (and their schedules) go too, before it does; a session without an identity is only put away', async () => {
    const { calls, deps } = rig()
    await closeLocalAssistant({ assistantId: GUGU, deleteStarted: true }, await planLocalClose(GUGU, deps), deps)
    expect(calls.slice(0, 2).sort()).toEqual(['schedule:a-child', 'schedule:a-gugu'])
    expect(calls).not.toContain('schedule:a-other')
    expect(calls).toContain('agent:agent-child')
    expect(calls).not.toContain('agent:agent-other')
    expect(calls.indexOf('archive:s-grandchild')).toBeLessThan(calls.indexOf(`agent:${GUGU}`))
    expect(calls.indexOf('archive:s-child')).toBeLessThan(calls.indexOf(`agent:${GUGU}`))
    expect(calls.slice(-4)).toEqual([`agent:${GUGU}`, 'archive:s-gugu', 'wipe', 'reset'])
  })

  it('a schedule that is just starting stops everything before anything is deleted (say "wait a moment")', async () => {
    const { calls, deps } = rig({ deleteAutomation: vi.fn(async () => { throw new Error('automation_runs_active') }) })
    const error = await closeLocalAssistant({ assistantId: GUGU, deleteStarted: true }, await planLocalClose(GUGU, deps), deps).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AssistantCloseError)
    expect(error).toMatchObject({ step: 'schedules', kind: 'schedule-starting' })
    expect(calls).toEqual([])
  })

  it('deleting it fails: it is still here, so its session keeps running, its home stays and nothing is reset', async () => {
    const { calls, deps } = rig({ removeAgent: vi.fn(async () => { throw new Error('rpc down') }) })
    const error = await closeLocalAssistant({ assistantId: GUGU, deleteStarted: false }, await planLocalClose(GUGU, deps), deps).catch((e: unknown) => e)
    expect(error).toMatchObject({ step: 'identity', kind: 'failed' })
    expect(calls).toEqual(['schedule:a-gugu', 'schedule:a-child', 'archive:s-child', 'archive:s-grandchild'])
  })

  it('it is deleted but its home could not be cleared: say so, and still reset this computer back to "meet Gugu"', async () => {
    const { calls, deps } = rig({ wipeHome: vi.fn(async () => { throw new Error('EBUSY') }) })
    const error = await closeLocalAssistant({ assistantId: GUGU, deleteStarted: false }, await planLocalClose(GUGU, deps), deps).catch((e: unknown) => e)
    expect(error).toMatchObject({ step: 'home', kind: 'failed' })
    expect(calls).toEqual(['schedule:a-gugu', 'schedule:a-child', 'archive:s-child', 'archive:s-grandchild', `agent:${GUGU}`, 'archive:s-gugu', 'reset'])
  })

  it('deleting it from contacts / agent settings opens this close instead of the generic delete, only when it really is the assistant', () => {
    const heard = vi.fn()
    window.addEventListener(UI_EVENTS.closeAssistant, heard)
    try {
      mine.isMyAssistant.mockReturnValueOnce(false)
      expect(closeIfMyAssistant('owner-1', 'agent-other')).toBe(false)
      expect(heard).not.toHaveBeenCalled()
      mine.isMyAssistant.mockReturnValueOnce(true)
      expect(closeIfMyAssistant('owner-1', GUGU)).toBe(true)
      expect(heard).toHaveBeenCalledTimes(1)
      expect(mine.isMyAssistant).toHaveBeenLastCalledWith('owner-1', GUGU)
    } finally {
      window.removeEventListener(UI_EVENTS.closeAssistant, heard)
    }
  })
})
