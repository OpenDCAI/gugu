import { beforeEach, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ release: vi.fn(), valid: true, own: { accountId: 'owner', queue: Promise.resolve(), valid: () => true } }))
vi.mock('@/lib/sessionInputOutboxBridge', () => ({ state: () => fixture.own, releaseQueuedSessionInput: (...args: unknown[]) => fixture.release(...args) }))
import { sendHeldInputNow } from '@/session/renderer/features/sessions/acp/send-held-input-now'

function replica<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return { current: () => value, onChange: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    onGone: () => () => {}, set(next: T) { value = next; for (const listener of listeners) listener() }, listeners }
}
function setup(legacy: boolean) {
  const operations: string[] = []
  const sessionState = replica({ lifecycle: 'working', queuedPrompts: legacy ? [{ id: 'old-hosted', clientMessageId: undefined as string | undefined }] : [] })
  const activeTurn = replica<null | { items: Array<{ kind: string; role: string; id: string; _meta?: { guguClientMessageId: string } }> }>(null)
  const session = { sessionState, activeTurn,
    changeQueuePromptOrder: vi.fn(async (ids: string[]) => { operations.push(`order:${ids.join(',')}`); return { success: true as const, data: undefined } }),
    cancelTurn: vi.fn(async () => { operations.push('cancel'); return { success: true as const, data: undefined } }),
  }
  const store = { session, runtimeSessionId: 'session', affordances: { isWorking: true },
    chatState: { transcript: { state: { committedTurns: [], activeTurnSnapshot: null } } } }
  return { session, store, operations }
}
beforeEach(() => { vi.clearAllMocks(); fixture.valid = true; fixture.own.valid = () => fixture.valid })

it('hands over the selected local ID before moving its hosted copy to the front and cancelling, preserving older items', async () => {
  const { session, store, operations } = setup(true)
  fixture.release.mockImplementation(async () => {
    operations.push('release')
    session.sessionState.set({ lifecycle: 'working', queuedPrompts: [{ id: 'old-hosted', clientMessageId: undefined }, { id: 'native-new', clientMessageId: 'client-new' }] })
    return { id: 'client-new' }
  })
  await sendHeldInputNow(store as never, 'client-new', false)
  expect(operations).toEqual(['release', 'order:native-new,old-hosted', 'cancel'])
  expect(session.sessionState.current().queuedPrompts.map(input => input.id)).toEqual(['old-hosted', 'native-new'])
  expect(session.sessionState.listeners.size + session.activeTurn.listeners.size).toBe(0)
})

it('never cancels the selected input when its native echo wins the race with the queue event', async () => {
  const { session, store } = setup(true)
  fixture.release.mockImplementation(async () => {
    session.activeTurn.set({ items: [{ kind: 'message', role: 'user', id: 'native-id', _meta: { guguClientMessageId: 'client-new' } }] })
    return { id: 'client-new' }
  })
  await sendHeldInputNow(store as never, 'client-new', false)
  expect(session.cancelTurn).not.toHaveBeenCalled()
  expect(session.changeQueuePromptOrder).not.toHaveBeenCalled()
})

it('does not wait for hosted identity when no legacy queue exists and preserves explicit steering', async () => {
  const { store, operations } = setup(false)
  fixture.release.mockImplementation(async () => { operations.push('release'); return { id: 'client-new' } })
  await sendHeldInputNow(store as never, 'client-new', false)
  expect(operations).toEqual(['cancel', 'release'])
  operations.length = 0
  await sendHeldInputNow(store as never, 'client-new', true)
  expect(operations).toEqual(['release'])
  expect(fixture.release.mock.calls.at(-1)?.[3]).toBe(true)
})

it('invalidates a late queue event on account change and removes its observers', async () => {
  const { session, store } = setup(true)
  fixture.release.mockImplementation(async () => {
    fixture.valid = false
    session.sessionState.set({ lifecycle: 'working', queuedPrompts: [{ id: 'native-new', clientMessageId: 'client-new' }] })
    return { id: 'client-new' }
  })
  await expect(sendHeldInputNow(store as never, 'client-new', false)).rejects.toThrow('account changed')
  expect(session.cancelTurn).not.toHaveBeenCalled()
  expect(session.changeQueuePromptOrder).not.toHaveBeenCalled()
  expect(session.sessionState.listeners.size + session.activeTurn.listeners.size).toBe(0)
})
