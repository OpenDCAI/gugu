// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { sidebarChatSignals } from '../../../../apps/desktop/src/lib/sidebarChatsBridge'
import { topicsReadOnOpen, useMarkProjectTopicsReadOnOpen } from '../../../../apps/desktop/src/hooks/useMarkProjectTopicsReadOnOpen'
import { chat, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import { openImRepository, replaceChatRows, type AccountImRepository } from '../../../../apps/desktop/src/lib/imRepository'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { chatOnScreen } from '../../../../apps/desktop/src/lib/onScreenChat'

const write = vi.hoisted(() => vi.fn<(deps: { chats: readonly ChatItem[]; refresh: () => Promise<void>; preserveManualUnread?: boolean; canMarkRead?: (chatId: string) => boolean }) => Promise<{ failedChats: number }>>().mockResolvedValue({ failedChats: 0 }))
const host = vi.hoisted(() => ({
  listener: null as null | ((active: boolean) => void),
  subscribeAppActive: undefined as undefined | ((listener: (active: boolean) => void) => () => void),
}))
vi.mock('../../../../apps/desktop/src/lib/chatUnreadLocator', () => ({ markChatsReadAndRefresh: write }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: {
  get subscribeAppActive() { return host.subscribeAppActive },
} }))

const GROUP = 'group-1'

function topic(id: string, unread: number, addressed: number, patch: Partial<ChatItem> = {}): ChatItem {
  return chat({
    id, kind: 'topic', source_chat_id: GROUP, unread_count: unread, next_message_seq: unread + 1,
    unread_locator: { stream_id: id, stream_kind: 'main', thread_root_id: null, message_id: `${id}-m1`, message_seq: 1,
      unread_count: unread, addressed_count: addressed, cursor_seq: 0, version: 1, is_marked_unread: false },
    ...patch,
  })
}

// The owner's case (#1057): the group's main stream is read; two topics opened from it still mention you (17 + 2).
const CHATS: ChatItem[] = [
  chat({ id: GROUP, kind: 'group', unread_count: 0 }),
  topic('topic-17', 30, 17),
  topic('topic-2', 2, 2),
  topic('topic-quiet', 5, 0),
  topic('topic-manual', 1, 1, { is_marked_unread: true }),
  topic('topic-other-group', 3, 3, { source_chat_id: 'group-2' }),
]

describe('topicsReadOnOpen', () => {
  it('picks the topics of this group that still mention you, and leaves a manual mark alone', () => {
    expect(topicsReadOnOpen(CHATS, GROUP).map((c) => c.id)).toEqual(['topic-17', 'topic-2'])
  })

  it('reading them leaves the project row with nothing but what you marked yourself', () => {
    const before = sidebarChatSignals(CHATS, new Set([GROUP])).groupUnread.get(GROUP)
    const cleared = new Set(topicsReadOnOpen(CHATS, GROUP).map((c) => c.id))
    const after = sidebarChatSignals(CHATS.map((c) => (cleared.has(c.id) ? { ...c, unread_count: 0, unread_locator: null } : c)), new Set([GROUP])).groupUnread.get(GROUP)
    expect(before).toBe(17 + 2 + 1)
    expect(after).toBe(1)
  })
})

let harness: ReturnType<typeof createReactHarness>
describe('project-slot lifecycle', () => {
  let repository: AccountImRepository
  let target: HTMLDivElement
  let entries: ReadonlyMap<string, HTMLElement>
  let callback: IntersectionObserverCallback
  const groups = new Set([GROUP])
  let finishRefresh: () => void
  let refreshChats: ReturnType<typeof vi.fn<() => Promise<void>>>
  let getImRepository: () => Promise<AccountImRepository>
  let accountId: string
  function SlotProbe() { useMarkProjectTopicsReadOnOpen(entries, groups); return null }
  const render = (chats: ChatItem[], chatsRead = true) => renderWithAppProviders(harness, <SlotProbe />, {
    auth: { id: accountId },
    chat: { chats, chatsRead, refreshChats, getImRepository },
  })
  const intersect = (isIntersecting: boolean) => act(async () => callback([
    { target, isIntersecting, intersectionRatio: isIntersecting ? 1 : 0, time: 0,
      boundingClientRect: new DOMRect(0, 0, 300, 300), intersectionRect: new DOMRect(0, 0, 300, 300), rootBounds: null },
  ], {} as IntersectionObserver))
  const visible = (value: 'visible' | 'hidden') => act(async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(value)
    document.dispatchEvent(new Event('visibilitychange'))
  })
  beforeEach(async () => {
    harness = createReactHarness()
    write.mockClear()
    accountId = 'user-1'
    host.listener = null
    host.subscribeAppActive = undefined
    repository = await openImRepository('user-1', { adapter: createMemoryLocalSyncDb() })
    getImRepository = async () => repository
    const pending = new Promise<void>((resolve) => { finishRefresh = resolve })
    refreshChats = vi.fn(() => pending)
    target = document.createElement('div')
    document.body.append(target)
    entries = new Map([[`chat:${GROUP}`, target]])
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    vi.stubGlobal('IntersectionObserver', class {
      constructor(cb: IntersectionObserverCallback) { callback = cb }
      observe() {}
      disconnect() {}
    })
  })
  afterEach(() => { harness.cleanup(); target.remove(); repository.close(); vi.unstubAllGlobals() })

  it('waits for this opening’s authoritative refresh even when cached rows are already displayable', async () => {
    await render([CHATS[0]])
    await intersect(true)
    expect(write).not.toHaveBeenCalled()
    await act(async () => { await replaceChatRows(repository, CHATS); finishRefresh() })
    await render(CHATS)
    expect(write).toHaveBeenCalledTimes(1)
    expect(refreshChats).toHaveBeenCalledWith({ acceptEmpty: true, throwOnError: true })
    expect(chatOnScreen(), 'a foreground project slot needs no primary-chat reporter').toBeNull()
    expect(write.mock.calls[0][0].chats.map(c => c.id)).toEqual(['topic-17', 'topic-2'])
    expect(write.mock.calls[0][0].preserveManualUnread).toBe(true)
  })

  it('keeps a visible opening pending when its list arrives in the background, then reads on return', async () => {
    await render([CHATS[0]], false)
    await intersect(true)
    await visible('hidden')
    await act(async () => { await replaceChatRows(repository, CHATS); finishRefresh() })
    await render(CHATS)
    expect(write).not.toHaveBeenCalled()
    await visible('visible')
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('uses host active state even if the document still says visible', async () => {
    host.subscribeAppActive = (listener) => {
      host.listener = listener; listener(true)
      return () => { host.listener = null }
    }
    await render(CHATS)
    await intersect(true)
    await act(async () => { host.listener?.(false) })
    await act(async () => { await replaceChatRows(repository, CHATS); finishRefresh() })
    expect(document.visibilityState).toBe('visible')
    expect(write).not.toHaveBeenCalled()
    await act(async () => { host.listener?.(true) })
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('reads once per opening and keeps later messages until the slot is hidden and reopened', async () => {
    await render(CHATS)
    expect(refreshChats).not.toHaveBeenCalled()
    await intersect(true)
    await act(async () => { await replaceChatRows(repository, CHATS); finishRefresh() })
    expect(write).toHaveBeenCalledTimes(1)
    const later = [topic('topic-17', 40, 25)]
    await act(async () => { await replaceChatRows(repository, later) })
    await render(later)
    expect(write).toHaveBeenCalledTimes(1)
    await intersect(false)
    await intersect(true)
    expect(write).toHaveBeenCalledTimes(2)
    expect(write.mock.calls[1][0].chats[0].next_message_seq).toBe(41)
  })

  it('keeps the completed snapshot watermark while waiting in the background', async () => {
    await render(CHATS)
    await intersect(true)
    await visible('hidden')
    await act(async () => { await replaceChatRows(repository, CHATS); finishRefresh() })
    await act(async () => { await replaceChatRows(repository, [topic('topic-17', 50, 40)]) })
    await render([topic('topic-17', 50, 40)])
    await visible('visible')
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0][0].chats[0].next_message_seq).toBe(31)
  })

  it('preserves a manual unread mark synchronized after the pending snapshot was captured', async () => {
    const captured = topic('topic-17', 30, 17, { member_updated_at: '2026-10-30T00:00:01Z' })
    await render([captured])
    await intersect(true)
    await visible('hidden')
    await act(async () => { await replaceChatRows(repository, [captured]); finishRefresh() })
    await act(async () => { await replaceChatRows(repository, [{ ...captured, is_marked_unread: true, member_updated_at: '2026-10-30T00:00:02Z' }]) })
    await visible('visible')
    expect(write).not.toHaveBeenCalled()
  })

  it('does not overwrite a newer read-state intent even if its manual mark has since been cleared', async () => {
    const captured = topic('topic-17', 30, 17, { member_updated_at: '2026-10-30T00:00:01Z' })
    await render([captured])
    await intersect(true)
    await visible('hidden')
    await act(async () => { await replaceChatRows(repository, [captured]); finishRefresh() })
    await act(async () => { await replaceChatRows(repository, [{ ...captured, member_updated_at: '2026-10-30T00:00:03Z' }]) })
    await visible('visible')
    expect(write).not.toHaveBeenCalled()
  })

  it('rechecks current manual intent while the unread-locator request is pending', async () => {
    await render(CHATS)
    await intersect(true)
    await act(async () => { await replaceChatRows(repository, CHATS); finishRefresh() })
    const pendingWrite = write.mock.calls[0][0]
    expect(pendingWrite.canMarkRead?.('topic-17')).toBe(true)
    await act(async () => { await replaceChatRows(repository, [topic('topic-17', 30, 17, { is_marked_unread: true })]) })
    expect(pendingWrite.canMarkRead?.('topic-17')).toBe(false)
  })

  it('does not treat a refreshed action callback as another opening', async () => {
    await render(CHATS)
    await intersect(true)
    await act(async () => { await replaceChatRows(repository, CHATS); finishRefresh() })
    expect(write).toHaveBeenCalledTimes(1)
    await act(async () => { await replaceChatRows(repository, [topic('topic-17', 50, 40)]) })
    // Notification preferences can change the store's refresh callback without closing the slot.
    refreshChats = vi.fn(async () => {})
    await render([topic('topic-17', 50, 40)])
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('discards the previous account’s late result when the account changes in an open slot', async () => {
    await render(CHATS)
    await intersect(true)
    const finishPrevious = finishRefresh
    const nextRepository = await openImRepository('user-2', { adapter: createMemoryLocalSyncDb() })
    let finishNext!: () => void
    const nextPending = new Promise<void>((resolve) => { finishNext = resolve })
    accountId = 'user-2'
    getImRepository = async () => nextRepository
    refreshChats = vi.fn(() => nextPending)
    await render([])
    await act(async () => { await replaceChatRows(repository, CHATS); finishPrevious() })
    expect(write).not.toHaveBeenCalled()
    await act(async () => { await replaceChatRows(nextRepository, [topic('other-account-topic', 2, 2)]); finishNext() })
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0][0].chats.map(c => c.id)).toEqual(['other-account-topic'])
    nextRepository.close()
  })

  it('does not consume a closed slot when its authoritative refresh finishes late', async () => {
    await render(CHATS)
    await intersect(true)
    await intersect(false)
    await act(async () => { await replaceChatRows(repository, CHATS); finishRefresh() })
    expect(write).not.toHaveBeenCalled()
    await intersect(true)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('consumes an authoritative empty result without swallowing a later new topic', async () => {
    await render([CHATS[0]])
    await intersect(true)
    await act(async () => { await replaceChatRows(repository, [CHATS[0]]); finishRefresh() })
    await act(async () => { await replaceChatRows(repository, CHATS) })
    await render(CHATS)
    expect(refreshChats).toHaveBeenCalledTimes(1)
    expect(write).not.toHaveBeenCalled()
    await intersect(false)
    await intersect(true)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('leaves a failed authoritative read alone until the next opening', async () => {
    refreshChats.mockRejectedValueOnce(new Error('refresh failed'))
    await render(CHATS)
    await intersect(true)
    expect(write).not.toHaveBeenCalled()
    await render(CHATS)
    expect(refreshChats).toHaveBeenCalledTimes(1)
    await intersect(false)
    await intersect(true)
    await act(async () => { await replaceChatRows(repository, CHATS); finishRefresh() })
    expect(write).toHaveBeenCalledTimes(1)
  })
})
