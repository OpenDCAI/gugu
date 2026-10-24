import { createElement, useRef, useState, useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { MessageList, type ChatListRowItem, type MessageListRowProps } from '@/components/chat/MessageList'
import { useConversationScrollMemory } from '@/components/chat/useConversationScrollMemory'
import { useFollowingTail, useTailPinning } from '@/components/chat/useFollowingTail'
import { useUnreadLocatorNavigation } from '@/hooks/useUnreadLocatorNavigation'
import { ChatHistoryWindow } from '@/store/chatHistoryWindow'
import type { UnreadLocatorCommit } from '@/lib/chatUnreadLocatorWindow'
import type { FlowListHandle } from '@/lib/flowList'
import type { UnreadMessageRevealRequest } from '@/lib/chatUnreadLocator'
import { UI_EVENTS } from '@/lib/uiEvents'
import { createReactHarness, message, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/i18n/registerMessagingCatalog'
import '@/styles/tokens.css'

vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }))
vi.mock('@/hooks/useAgentHarnessIdentity', () => ({ useAgentHarnessIdentity: () => 'codex' }))

let harness: ReturnType<typeof createReactHarness> | undefined
let frame = 0
afterEach(() => { cancelAnimationFrame(frame); harness?.cleanup() })

const noop = () => {}
const rowsBetween = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => message({
  id: `m${from + i}`, seq: from + i, chat_id: 'long-chat', sender_user_id: 'sender',
  created_at: '2026-10-24T08:00:00Z', content: `Message ${from + i}. ${'A long conversation. '.repeat(i % 5 + 1)}`,
}))
type Reading = { windowHead: string; visible: boolean; targetVisible: boolean; targetTop: number | null; first: string | undefined; last: string | undefined }

async function renderConversation(target: number, width: number) {
  await page.viewport(width, 760)
  harness = createReactHarness()
  const history = new ChatHistoryWindow('reader')
  history.reset('long-chat', rowsBetween(301, 340))
  const commit: UnreadLocatorCommit = { rows: rowsBetween(Math.max(1, target - 59), Math.min(340, target + 60)), readSeq: 340, reachedTail: target + 60 >= 340 }
  const loadMessageAnchor = vi.fn(async (_id: string, known?: UnreadLocatorCommit) => {
    const result = known ?? commit
    await history.restoreAnchor(async () => ({ messages: result.rows, hasNewer: !result.reachedTail }))
  })
  const confirmed = vi.fn(), rejected = vi.fn()
  const readings: Reading[] = []
  let clicked = false
  const setFollowingTail = (following: boolean | undefined) => { if (following !== undefined) history.setFollowingTail(following) }
  const scroller = () => harness!.container.querySelector<HTMLElement>('[data-testid="chat-message-list"]')!
  function Conversation() {
    const window = useSyncExternalStore(history.subscribe, history.getSnapshot)
    const messages = window.messages
    const rows: ChatListRowItem[] = messages.map((message) => ({ type: 'message', message }))
    const listRef = useRef<FlowListHandle | null>(null), isAtBottomRef = useRef(true)
    const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const [flashMessageId, setFlashMessageId] = useState<string | null>(null)
    const memory = useConversationScrollMemory({ chatId: 'long-chat', viewportKey: `unread-${target}-${width}`, activationKey: 'long-chat',
      enabled: true, messageIds: messages.map((row) => row.id), isAtBottomRef, setFollowingTail: history.setFollowingTail, loadMessageAnchor })
    const resetKey = `long-chat#${window.viewVersion}`
    const input = { activeChatId: 'long-chat', navigationTarget: true, rows, scrollerRef: memory.scrollerRef, listRef,
      loadingAnchor: window.loading === 'anchor', setFollowingTail: (following: boolean) => { isAtBottomRef.current = following; history.setFollowingTail(following) },
      setFlashMessageId, flashTimerRef, hasMoreOlder: window.hasOlder, loadingOlder: false, loadOlderMessages: vi.fn(async () => {}),
      loadMessageAnchor, revealMessage: memory.revealMessage }
    const pending = useUnreadLocatorNavigation(input)
    const { onAtBottomChange } = useFollowingTail({ resetKey, unreadNavigationPending: pending, hasNewer: window.hasNewer,
      loading: !!window.loading, isPreservingPosition: memory.isPreservingPosition, isAtBottomRef, setFollowingTail })
    useTailPinning({ resetKey, messages, enabled: !pending, messageWindow: window, scrollerEl: memory.scrollerEl, scrollerRef: memory.scrollerRef,
      listRef, isAtBottomRef, isPreservingPosition: memory.isPreservingPosition, prepareForSavedPosition: memory.prepareForSavedPosition,
      forgetSavedPosition: memory.forgetSavedPosition, returnToLatest: vi.fn(async () => {}), onError: rejected })
    const jump = () => {
      clicked = true
      const request: UnreadMessageRevealRequest = { token: `jump-${target}`, chatId: 'long-chat', streamId: 'main:long-chat', streamKind: 'main',
        threadRootId: null, messageId: `m${target}`, messageSeq: target, commit, confirm: confirmed, reject: rejected, isCurrent: () => true }
      globalThis.window.dispatchEvent(new CustomEvent(UI_EVENTS.openUnreadMessage, { detail: request }))
    }
    const rowProps: MessageListRowProps = { rows, messages, isFiltering: false, mobile: width < 720, memberReadSeqs: {}, memberProfiles: {}, isAgentChat: false,
      isGroupChat: true, onReaction: noop, onQuote: noop, onForward: noop, onDelete: noop, onVisible: noop, selectMode: false,
      selectedIds: new Set(), onToggleSelect: noop, onEnterSelectMode: noop, flashMessageId, highlight: undefined, threeParty: undefined,
      onShowReadReceipt: undefined, onOpenMemberProfile: undefined, onOpenTopic: undefined, topicAnchors: undefined, onOpenTopicAnchor: undefined,
      agentFloodNoticeMessageId: undefined, onAgentFloodUndone: undefined, onOpenFile: undefined, onOpenLocalFileLink: undefined, onMentionMember: undefined }
    return <div data-window-head={messages[0]?.id} style={{ height: 560, width: '100%', display: 'flex', flexDirection: 'column' }}>
      <MessageList rows={rows} rowProps={rowProps} resetKey={resetKey} listRef={listRef} scrollerRef={memory.setScrollerRef}
        initialTopMostItemIndex={memory.openLocation()} followTail={!pending && !window.hasNewer} onAtBottomChange={onAtBottomChange}
        unreadAbove={{ messageId: `m${target}`, messageSeq: target, label: 'Jump to first unread', onJump: jump }} />
    </div>
  }
  await renderWithAppProviders(harness, createElement(Conversation))
  await until('the long conversation has completed its initial tail layout', () => scroller()?.querySelectorAll('[data-msg-id]').length === 40)
  const sample = () => {
    if (!clicked) { frame = requestAnimationFrame(sample); return }
    const surface = scroller(), bounds = surface.getBoundingClientRect()
    const visible = Array.from(surface.querySelectorAll<HTMLElement>('[data-msg-id]')).filter((row) => {
      const rect = row.getBoundingClientRect(); return rect.bottom > bounds.top && rect.top < bounds.bottom
    })
    const targetRow = surface.querySelector<HTMLElement>(`[data-msg-id="m${target}"]`)
    const targetRect = targetRow?.getBoundingClientRect()
    readings.push({ windowHead: harness!.container.querySelector<HTMLElement>('[data-window-head]')!.dataset.windowHead!,
      visible: getComputedStyle(surface).visibility !== 'hidden', targetVisible: !!targetRect && targetRect.bottom > bounds.top && targetRect.top < bounds.bottom,
      targetTop: targetRect ? targetRect.top - bounds.top : null, first: visible[0]?.dataset.msgId, last: visible.at(-1)?.dataset.msgId })
    frame = requestAnimationFrame(sample)
  }
  frame = requestAnimationFrame(sample)
  await page.getByRole('button', { name: 'Jump to first unread' }).click()
  await until('twelve animation frames after navigation are recorded', () => readings.length >= 12)
  cancelAnimationFrame(frame)
  await until('unread navigation confirms the visible row or reports its failure', () => confirmed.mock.calls.length > 0 || rejected.mock.calls.length > 0)
  return { readings, confirmed, rejected, loadMessageAnchor, scroller }
}

describe('first unread navigation paints its final landing', () => {
  it.each([1100, 390])('opens a message outside the loaded tail without painting an intermediate window at width %i', async (width) => {
    const view = await renderConversation(120, width)
    const targetWindow = view.readings.filter((reading) => reading.windowHead === 'm61' && reading.visible)
    expect(targetWindow.length, JSON.stringify(view.readings)).toBeGreaterThan(0)
    expect(targetWindow.every((reading) => reading.targetVisible), JSON.stringify(targetWindow)).toBe(true)
    const tops = targetWindow.map((reading) => reading.targetTop!)
    expect(Math.max(...tops) - Math.min(...tops), JSON.stringify(targetWindow)).toBeLessThanOrEqual(1)
    expect(view.confirmed).toHaveBeenCalledWith('m120')
    expect(view.rejected).not.toHaveBeenCalled()
    expect(view.loadMessageAnchor).toHaveBeenCalledOnce()
  })

  it('positions an already loaded unread row without replacing its window', async () => {
    const view = await renderConversation(310, 1100)
    expect(view.readings.at(-1)?.targetVisible).toBe(true)
    expect(view.loadMessageAnchor).not.toHaveBeenCalled()
    expect(view.confirmed).toHaveBeenCalledWith('m310')
    expect(view.rejected).not.toHaveBeenCalled()
  })
})
