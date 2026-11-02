// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { useRoomAuthorityRevision } from '../../../../apps/desktop/src/hooks/useRoomAuthorityRevision'
import { readMemberRosterRevision, type AccountRevisionEvent, type AccountRevisionListener } from '../../../../apps/desktop/src/lib/accountRevisionCoordinator'

let harness: ReturnType<typeof createReactHarness>
let authority: number
let listeners: Map<AccountRevisionEvent, AccountRevisionListener>
let loadGroupCollab: ReturnType<typeof vi.fn<() => Promise<void>>>

beforeEach(() => {
  vi.useFakeTimers()
  harness = createReactHarness()
  listeners = new Map()
  loadGroupCollab = vi.fn(async () => undefined)
})
afterEach(() => { harness.cleanup(); vi.useRealTimers() })

async function mount() {
  const subscribeAccountRevision = (event: AccountRevisionEvent, listener: AccountRevisionListener) => {
    listeners.set(event, listener)
    return () => { listeners.delete(event) }
  }
  function Fixture() {
    authority = useRoomAuthorityRevision({
      chatId: 'group', sourceChatId: 'source', isRoom: true, userId: 'viewer',
      loadGroupCollab, subscribeAccountRevision,
    })
    return null
  }
  await harness.render(<Fixture />)
}

async function deliver(payload: Record<string, unknown>, event: AccountRevisionEvent = 'chat_members_changed') {
  await act(async () => {
    await listeners.get(event)!([{ revision: '1', event, payload }])
    await vi.advanceTimersByTimeAsync(300)
  })
}

describe('member revision collaboration request budget', () => {
  it.each(['viewer', 'peer'])('does not reload collaboration or authority for %s own state', async userId => {
    await mount()
    await deliver({ chat_id: 'group', user_id: userId, kind: 'own', tombstone: false })
    expect(loadGroupCollab).not.toHaveBeenCalled()
    expect(authority).toBe(0)
  })

  it('still refreshes the viewer authority for a roster change', async () => {
    await mount()
    await deliver({ chat_id: 'group', user_id: 'viewer', kind: 'roster', tombstone: false })
    expect(loadGroupCollab).toHaveBeenCalledTimes(1)
    expect(authority).toBe(1)
  })

  it('preserves legacy membership revisions without kind', async () => {
    await mount()
    await deliver({ chat_id: 'group', user_id: 'peer', tombstone: false })
    expect(loadGroupCollab).toHaveBeenCalledTimes(1)
    expect(authority).toBe(0)
  })

  it('rejects an unknown membership kind', () => {
    expect(() => readMemberRosterRevision({ chat_id: 'group', user_id: 'peer', kind: 'bogus', tombstone: false }))
      .toThrow(/unknown kind/)
  })

  it('retains source-group authority changes for topics', async () => {
    await mount()
    await deliver({ chat_id: 'source', user_id: 'viewer', kind: 'roster', tombstone: false })
    expect(loadGroupCollab).toHaveBeenCalledTimes(1)
    expect(authority).toBe(1)
  })

  it('does not filter group collaboration events', async () => {
    await mount()
    await deliver({ chat_id: 'group', user_id: 'viewer' }, 'group_collab_changed')
    expect(loadGroupCollab).toHaveBeenCalledTimes(1)
    expect(authority).toBe(1)
  })
})
