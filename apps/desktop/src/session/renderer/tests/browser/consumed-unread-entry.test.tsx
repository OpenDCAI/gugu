import { createElement, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { MessageList, type ChatListRowItem, type MessageListRowProps } from '@/components/chat/MessageList'
import { useConversationScrollMemory } from '@/components/chat/useConversationScrollMemory'
import { useFollowingTail, useTailPinning } from '@/components/chat/useFollowingTail'
import { useUnreadLocatorNavigation } from '@/hooks/useUnreadLocatorNavigation'
import { ChatHistoryWindow } from '@/store/chatHistoryWindow'
import type { UnreadLocatorCommit } from '@/lib/chatUnreadLocatorWindow'
import type { FlowListHandle } from '@/lib/flowList'
import { useChatUnreadStreamNavigation } from '@/lib/chatUnreadStreamNavigation'
import { getUnreadLocatorWindow } from '@/lib/chatUnreadLocatorMessages'
import { chat, createReactHarness, message, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/i18n/registerMessagingCatalog'
import '@/styles/tokens.css'

vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }))
vi.mock('@/hooks/useAgentHarnessIdentity', () => ({ useAgentHarnessIdentity: () => 'codex' }))
vi.mock('@/lib/chatUnreadLocatorMessages', () => ({ getUnreadLocatorWindow: vi.fn() }))
vi.mock('@/lib/chatMemberReadState', () => ({ markStreamRead: vi.fn(async () => {}), markMemberRead: vi.fn(), markMemberUnread: vi.fn() }))

let harness: ReturnType<typeof createReactHarness> | undefined
let slotHarness: ReturnType<typeof createReactHarness> | undefined
let frame = 0
afterEach(() => { cancelAnimationFrame(frame); harness?.cleanup(); slotHarness?.cleanup(); slotHarness = undefined })

const noop = () => {}
const snapshotEpoch = () => 0
const rowsBetween = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => message({
  id: `m${from + i}`, seq: from + i, chat_id: 'long-chat', sender_user_id: 'sender',
  created_at: '2026-10-24T08:00:00Z', content: `Message ${from + i}. ${'A long conversation. '.repeat(i % 5 + 1)}`,
}))
async function renderConversation(width: number) {
  const target = 310
  await page.viewport(width, 760)
  harness = createReactHarness()
  const history = new ChatHistoryWindow('reader')
  history.reset('long-chat', rowsBetween(301, 340))
  const commit: UnreadLocatorCommit = { rows: rowsBetween(Math.max(1, target - 59), Math.min(340, target + 60)), readSeq: 340, reachedTail: target + 60 >= 340 }
  const loadMessageAnchor = vi.fn(async (_id: string, known?: UnreadLocatorCommit) => {
    const result = known ?? commit
    await history.restoreAnchor(async () => ({ messages: result.rows, hasNewer: !result.reachedTail }))
  })
  vi.mocked(getUnreadLocatorWindow).mockResolvedValue({
    anchorRows: commit.rows.filter((row) => row.seq <= target), forwardRows: commit.rows.filter((row) => row.seq > target),
    reachedTail: commit.reachedTail, tailSeq: 340,
  })
  const confirmed = vi.fn(), rejected = vi.fn()
  const returnToLatest = async () => { await history.load('latest', async () => rowsBetween(301, 340)) }
  const setFollowingTail = (following: boolean | undefined) => { if (following !== undefined) history.setFollowingTail(following) }
  let slot: HTMLElement | null = null
  const subscribers = new Set<() => void>()
  const registerSlot = (element: HTMLDivElement | null) => { slot = element; subscribers.forEach((listener) => listener()) }
  const surfaceRoot = () => slot ?? harness!.container
  const scroller = () => surfaceRoot().querySelector<HTMLElement>('[data-testid="chat-message-list"]')!
  function Slot() { return <div ref={registerSlot} /> }
  function Host() {
    const chatsRef = useRef([chat({ id: 'long-chat', unread_count: 31, last_read_seq: 309, next_message_seq: 341, unread_locator: { stream_id: 'main:long-chat', stream_kind: 'main', thread_root_id: null,
      message_id: `m${target}`, message_seq: target, unread_count: 341 - target, cursor_seq: target - 1, version: 1, is_marked_unread: false } })])
    const activeChatIdRef = useRef<string | null>('long-chat'), cancelChatOpenRef = useRef(noop)
    // The account's primary observer stays alive when a desktop portal closes. Its snapshot epoch does not change.
    const navigation = useChatUnreadStreamNavigation({ user: { id: 'reader' }, chatsRef, activeChatIdRef, cancelChatOpenRef,
      getMessageSnapshotEpoch: snapshotEpoch, isChatOpen: () => true, threadRootOf: () => null,
      setActiveChatId: noop, setActiveThreadRootId: noop, setLoadingThread: noop, setThreadMessages: noop,
      loadChats: async () => { chatsRef.current = [chat({ id: 'long-chat', unread_locator: null })] } })
    const { beginChatOpen, finishChatOpen } = navigation
    useEffect(() => {
      beginChatOpen('long-chat'); finishChatOpen('long-chat')
      chatsRef.current = [chat({ id: 'long-chat', unread_locator: null })]
    }, [beginChatOpen, finishChatOpen])
    const element = useSyncExternalStore((listener) => { subscribers.add(listener); return () => { subscribers.delete(listener) } }, () => slot)
    const conversation = <Conversation navigation={navigation} />
    return element ? createPortal(conversation, element) : null
  }
  function Conversation({ navigation }: { navigation: ReturnType<typeof useChatUnreadStreamNavigation> }) {
    const entry = navigation.entryFor('long-chat')
    const window = useSyncExternalStore(history.subscribe, history.getSnapshot)
    const messages = window.messages
    const rows: ChatListRowItem[] = messages.map((message) => ({ type: 'message', message }))
    const listRef = useRef<FlowListHandle | null>(null), isAtBottomRef = useRef(true)
    const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const [flashMessageId, setFlashMessageId] = useState<string | null>(null)
    const memory = useConversationScrollMemory({ chatId: 'long-chat', viewportKey: `consumed-unread-${width}`, activationKey: 'long-chat',
      enabled: true, discardSaved: !!entry, messageIds: messages.map((row) => row.id), isAtBottomRef, setFollowingTail: history.setFollowingTail, loadMessageAnchor })
    const resetKey = `long-chat#${window.viewVersion}`
    const input = { activeChatId: 'long-chat', navigationTarget: true, rows, scrollerRef: memory.scrollerRef, listRef,
      loadingAnchor: window.loading === 'anchor', setFollowingTail: (following: boolean) => { isAtBottomRef.current = following; history.setFollowingTail(following) },
      setFlashMessageId, flashTimerRef, hasMoreOlder: window.hasOlder, loadingOlder: false, loadOlderMessages: vi.fn(async () => {}),
      loadMessageAnchor, revealMessage: memory.revealMessage }
    const pending = useUnreadLocatorNavigation(input)
    const { onAtBottomChange } = useFollowingTail({ resetKey, unreadNavigationPending: pending, hasNewer: window.hasNewer,
      loading: !!window.loading, isPreservingPosition: memory.isPreservingPosition, isAtBottomRef, setFollowingTail })
    const { pinToBottom, onTotalListHeightChanged } = useTailPinning({ resetKey, messages, enabled: !pending, messageWindow: window, scrollerEl: memory.scrollerEl, scrollerRef: memory.scrollerRef,
      listRef, isAtBottomRef, isPreservingPosition: memory.isPreservingPosition, prepareForSavedPosition: memory.prepareForSavedPosition,
      forgetSavedPosition: memory.forgetSavedPosition, returnToLatest, onError: rejected })
    const jump = () => {
      void navigation.jumpToUnreadEntry('long-chat', memory.scrollerRef.current).then(() => confirmed(`m${target}`), rejected)
    }
    const rowProps: MessageListRowProps = { rows, messages, isFiltering: false, mobile: width < 720, memberReadSeqs: {}, memberProfiles: {}, isAgentChat: false,
      isGroupChat: true, onReaction: noop, onQuote: noop, onForward: noop, onDelete: noop, onVisible: noop, selectMode: false,
      selectedIds: new Set(), onToggleSelect: noop, onEnterSelectMode: noop, flashMessageId, highlight: undefined, threeParty: undefined,
      onShowReadReceipt: undefined, onOpenMemberProfile: undefined, onOpenTopic: undefined, topicAnchors: undefined, onOpenTopicAnchor: undefined,
      agentFloodNoticeMessageId: undefined, onAgentFloodUndone: undefined, onOpenFile: undefined, onOpenLocalFileLink: undefined, onMentionMember: undefined }
    return <><button onClick={pinToBottom}>Return to latest</button><div data-window-head={messages[0]?.id} style={{ height: 560, width: '100%', display: 'flex', flexDirection: 'column' }}>
      <MessageList rows={rows} rowProps={rowProps} resetKey={resetKey} listRef={listRef} scrollerRef={memory.setScrollerRef}
        initialTopMostItemIndex={memory.openLocation()} followTail={!pending && !window.hasNewer} onAtBottomChange={onAtBottomChange}
        onTotalListHeightChanged={onTotalListHeightChanged}
        unreadAbove={entry ? { messageId: entry.locator.message_id, messageSeq: entry.locator.message_seq, label: 'Jump to first unread', onJump: jump } : null} />
    </div></>
  }
  slotHarness = createReactHarness()
  await slotHarness.render(<Slot />)
  await renderWithAppProviders(harness, createElement(Host))
  await until('the long conversation has completed its initial tail layout', () => scroller()?.querySelectorAll('[data-msg-id]').length === 40)
  await page.getByRole('button', { name: 'Jump to first unread' }).click()
  await until('unread navigation confirms the visible row or reports its failure', () => confirmed.mock.calls.length > 0 || rejected.mock.calls.length > 0)
  expect(confirmed).toHaveBeenCalledWith(`m${target}`)
  expect(rejected).not.toHaveBeenCalled()
  return { scroller, history,
    closeSlot: () => slotHarness!.render(null), reopenSlot: () => slotHarness!.render(<Slot />) }
}

describe('consumed first-unread entry', () => {
  it.each([1100, 390])('restores reading after consuming unread navigation and reopening its slot while the account observer survives at width %i', async (width) => {
    const view = await renderConversation(width)
    await page.getByRole('button', { name: 'Return to latest' }).click()
    await until('the latest window has filled its rows and reached its actual bottom', () => {
      const surface = view.scroller()
      return !view.history.getSnapshot().hasNewer && surface.querySelectorAll('[data-msg-id]').length === view.history.getSnapshot().messages.length
        && surface.scrollHeight - surface.scrollTop - surface.clientHeight <= 1
    })
    const visible = () => {
      const surface = view.scroller(), bounds = surface.getBoundingClientRect()
      const row = Array.from(surface.querySelectorAll<HTMLElement>('[data-msg-id]')).find((row) => {
        const rect = row.getBoundingClientRect(); return rect.bottom > bounds.top && rect.top < bounds.bottom
      })!
      return { id: row.dataset.msgId, top: row.getBoundingClientRect().top - bounds.top }
    }
    const surface = view.scroller()
    const scrolled = new Promise<void>((resolve) => surface.addEventListener('scroll', () => resolve(), { once: true }))
    surface.scrollTop = surface.scrollHeight - surface.clientHeight - 500
    await scrolled
    await until('the real scroll event withdraws tail following', () => !view.history.isFollowingTail())
    const before = visible()
    await view.closeSlot()
    await until('the other root has removed the conversation slot', () => !view.scroller())
    const restored: ReturnType<typeof visible>[] = []
    const sample = () => {
      if (view.scroller()) restored.push(visible())
      frame = requestAnimationFrame(sample)
    }
    frame = requestAnimationFrame(sample)
    await view.reopenSlot()
    await until('twelve restored viewport frames are recorded', () => restored.length >= 12)
    cancelAnimationFrame(frame)
    expect(restored.every((row) => row.id === before.id && Math.abs(row.top - before.top) <= 1), JSON.stringify({ before, restored })).toBe(true)
  })
})
