import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type RefObject } from 'react'
import { subscribeActiveChatWillChange } from '../../store/activeChatTransition'
import { rendererLogger } from '../../lib/log'
import { restoreLanding } from '../../lib/listLanding'
import type { ListLanding } from '../../lib/flowList'
import { currentAuthSessionSignal } from '../../lib/authSessionLoss'

const log = rendererLogger('conversation-scroll')

export type ConversationViewportPosition =
  | { atBottom: true }
  | { atBottom: false; messageId: string; offset: number }

// The same account's blocks remount; keep their existing anchors for that auth lifetime.
const positionsBySession = new WeakMap<AbortSignal, Map<string, ConversationViewportPosition>>()

export interface ViewportRowGeometry {
  id: string
  top: number
  bottom: number
}

export function isConversationViewportAtBottom(
  viewport: { scrollHeight: number; scrollTop: number; clientHeight: number },
  threshold: number,
): boolean {
  return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= threshold
}

export function selectConversationViewportAnchor(
  viewport: { top: number; bottom: number },
  rows: ReadonlyArray<ViewportRowGeometry>,
): { messageId: string; offset: number } | null {
  const row = rows.find((candidate) => candidate.bottom > viewport.top && candidate.top < viewport.bottom)
  return row ? { messageId: row.id, offset: row.top - viewport.top } : null
}

export function resolveConversationRestoreLocation(
  position: ConversationViewportPosition,
  messageIds: ReadonlyArray<string>,
): { index: number; offset: number } | null {
  if (position.atBottom) return null
  const dataIndex = messageIds.indexOf(position.messageId)
  if (dataIndex < 0) return null
  return { index: dataIndex, offset: -position.offset }
}

interface UseConversationScrollMemoryOptions {
  chatId: string | null
  // Conversation-scoped on purpose: an openNonce remount reopens at LAST (#461), it does not replay the saved anchor.
  activationKey: string
  enabled: boolean
  messageIds: ReadonlyArray<string>
  isAtBottomRef: RefObject<boolean>
  setFollowingTail: (following: boolean) => void
  loadMessageAnchor?: (messageId: string) => Promise<void>
  discardSaved?: boolean // @@@6530 因为有新消息才点开的这一次停在最新处,不回上次读到一半的位置(微信同款)
}

const RESTORE_TIMEOUT_MS = 5_000
const RESTORE_STABLE_FRAMES = 3
const RESTORE_OFFSET_TOLERANCE = 1
const AT_BOTTOM_THRESHOLD = 80
// A revealed message lands this far down the viewport (its top edge), so it reads as "here", not glued to the top.
const REVEAL_VIEWPORT_FRACTION = 0.35

export function useConversationScrollMemory({
  chatId,
  activationKey,
  enabled,
  messageIds,
  isAtBottomRef,
  setFollowingTail,
  loadMessageAnchor,
  discardSaved,
}: UseConversationScrollMemoryOptions): {
  scrollerEl: HTMLElement | null
  scrollerRef: RefObject<HTMLElement | null>
  setScrollerRef: (value: HTMLElement | Window | null) => void
  hasSavedOffBottomPosition: () => boolean
  prepareForSavedPosition: () => boolean
  isPreservingPosition: () => boolean
  forgetSavedPosition: () => void
  openLocation: () => ListLanding | null
  revealMessage: (messageId: string) => Promise<void>
} {
  const session = currentAuthSessionSignal()
  const positions = useMemo(() => positionsBySession.get(session) ?? new Map<string, ConversationViewportPosition>(), [session])
  positionsBySession.set(session, positions)
  const scrollerOwnerRef = useRef<{
    chatId: string
    element: HTMLElement
    captureEnabled: boolean
  } | null>(null)
  const completedActivationRef = useRef<string | null>(null)
  const restoringActivationRef = useRef<string | null>(null)
  const restoreDeadlineRef = useRef<{ activationKey: string; expiresAt: number } | null>(null)
  const lastActivationRef = useRef<string | null>(null)
  const requestedAnchorRef = useRef<string | null>(null)
  // @@@scroller-out-of-closures — 滚动容器元素**只**以 state 的身份出现在依赖数组与返回值里;闭包一律读
  // scrollerRef.current。React 每一轮渲染的闭包共用一个作用域,而被 useCallback 记住的旧闭包会把整条旧作用域
  // 链留在内存里(换一次会话就多两环);闭包若捕获 scrollerEl,每一环都钉住那一轮的旧容器 —— 连同它底下
  // 整页已卸载的消息行。mac1 2026-09-25:每切一次会话多留 ~905 个脱离文档的节点,97% 经由这里。
  const [scrollerEl, setScrollerEl] = useState<HTMLElement | null>(null)
  const scrollerRef = useRef<HTMLElement | null>(null)
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  // revealMessage: a message someone asked to see (#1708 来源消息). It travels the restore path below, and this
  // settles with it: resolved when the row has settled in place, rejected when it cannot be loaded or never settles.
  const revealRef = useRef<{ chatId: string; messageId: string; resolve: () => void; reject: (error: Error) => void } | null>(null)
  const [revealRequest, setRevealRequest] = useState(0)
  const settleReveal = useCallback((messageId: string, error?: Error) => {
    const reveal = revealRef.current
    if (!reveal || reveal.messageId !== messageId) return
    revealRef.current = null
    if (error) reveal.reject(error)
    else reveal.resolve()
  }, [])

  if (lastActivationRef.current !== activationKey) {
    lastActivationRef.current = activationKey
    if (discardSaved && chatId) positions.delete(chatId)
    completedActivationRef.current = null
    restoreDeadlineRef.current = null
    requestedAnchorRef.current = null
    if (revealRef.current) {
      revealRef.current.reject(new Error('The conversation changed before the message was shown'))
      revealRef.current = null
    }
  }

  const capturePosition = useCallback((owner: NonNullable<typeof scrollerOwnerRef.current>) => {
    if (!owner.captureEnabled) {
      positions.delete(owner.chatId)
      return
    }
    if (owner.element.scrollHeight <= 0) return
    if (isConversationViewportAtBottom(owner.element, AT_BOTTOM_THRESHOLD)) {
      positions.set(owner.chatId, { atBottom: true })
      return
    }

    const viewportRect = owner.element.getBoundingClientRect()
    const elements = Array.from(owner.element.querySelectorAll<HTMLElement>('[data-msg-id]'))
    const retained = elements.filter((row) => row.getAttribute('aria-posinset') !== '1')
    const rows = (retained.some((row) => row.getBoundingClientRect().bottom > viewportRect.top && row.getBoundingClientRect().top < viewportRect.bottom) ? retained : elements)
      .flatMap((row) => row.dataset.msgId
        ? [{ id: row.dataset.msgId, top: row.getBoundingClientRect().top, bottom: row.getBoundingClientRect().bottom }]
        : [])
    const anchor = selectConversationViewportAnchor(viewportRect, rows)
    if (!anchor) return
    positions.set(owner.chatId, { atBottom: false, ...anchor })
  }, [positions])

  useEffect(() => subscribeActiveChatWillChange((previousChatId) => {
    const owner = scrollerOwnerRef.current
    if (owner?.chatId === previousChatId) { capturePosition(owner); scrollerOwnerRef.current = null }
  }), [capturePosition])

  const setScrollerRef = useCallback((value: HTMLElement | Window | null) => {
    const element = value instanceof HTMLElement ? value : null
    if (!element && scrollerOwnerRef.current) capturePosition(scrollerOwnerRef.current)
    scrollerOwnerRef.current = element && chatId
      ? { chatId, element, captureEnabled: enabled }
      : null
    scrollerRef.current = element
    setScrollerEl(element)
  }, [chatId, enabled, capturePosition])

  const hasSavedOffBottomPosition = useCallback(() => {
    if (!chatId) return false
    const position = positions.get(chatId)
    return !!position && !position.atBottom
  }, [chatId, positions])

  const isPreservingPosition = useCallback(() => (
    completedActivationRef.current !== activationKey && hasSavedOffBottomPosition()
  ), [activationKey, hasSavedOffBottomPosition])

  const openLocation = useCallback(() => {
    const position = chatId && enabled && completedActivationRef.current !== activationKey ? positions.get(chatId) : undefined
    return restoreLanding(position && !position.atBottom ? position : null, messageIds)
  }, [activationKey, chatId, enabled, messageIds, positions])

  const prepareForSavedPosition = useCallback(() => {
    if (!hasSavedOffBottomPosition()) return false
    isAtBottomRef.current = false
    setFollowingTail(false)
    return true
  }, [hasSavedOffBottomPosition, isAtBottomRef, setFollowingTail])

  const forgetSavedPosition = useCallback(() => {
    if (chatId) positions.delete(chatId)
    completedActivationRef.current = activationKey
    restoringActivationRef.current = null
    restoreDeadlineRef.current = null
  }, [activationKey, chatId, positions])

  // Show one message of this conversation, loaded or not: it becomes the position to restore, so a window
  // loaded around it (loadMessageAnchor) remounts the list landing on it, and the settle loop holds it there
  // against whatever else moves the list meanwhile. A one-shot scroll does not survive that remount.
  const revealMessage = useCallback((messageId: string) => new Promise<void>((resolve, reject) => {
    if (!chatId || !enabled) {
      reject(new Error('The conversation cannot show a message now'))
      return
    }
    revealRef.current?.reject(new Error('Superseded by another message to show'))
    revealRef.current = { chatId, messageId, resolve, reject }
    const height = scrollerRef.current?.clientHeight ?? 0
    positions.set(chatId, { atBottom: false, messageId, offset: Math.round(height * REVEAL_VIEWPORT_FRACTION) })
    completedActivationRef.current = null
    restoreDeadlineRef.current = null
    requestedAnchorRef.current = null
    isAtBottomRef.current = false
    setFollowingTail(false)
    setRevealRequest((n) => n + 1)
  }), [chatId, enabled, isAtBottomRef, setFollowingTail, positions])

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!chatId || !enabled || !scroller || completedActivationRef.current === activationKey) return
    const position = positions.get(chatId)
    if (!position || position.atBottom) return
    const deadline = restoreDeadlineRef.current?.activationKey === activationKey
      ? restoreDeadlineRef.current
      : { activationKey, expiresAt: performance.now() + RESTORE_TIMEOUT_MS }
    restoreDeadlineRef.current = deadline
    const abandon = (reason: string) => {
      console.error(`[conversation-scroll] saved message anchor ${reason}`, { chatId, messageId: position.messageId })
      settleReveal(position.messageId, new Error(`The message ${reason}`))
      positions.delete(chatId)
      if (restoreDeadlineRef.current?.activationKey === activationKey) restoreDeadlineRef.current = null
      rerender() // 列表可能正按 openLocation() === null 藏着等锚点;放弃了就重算一次,露出最新处
    }
    const location = resolveConversationRestoreLocation(position, messageIds)
    if (!location) {
      if (loadMessageAnchor && requestedAnchorRef.current !== activationKey) {
        requestedAnchorRef.current = activationKey
        void loadMessageAnchor(position.messageId).catch((error: unknown) => {
          if (lastActivationRef.current !== activationKey) return
          log.error({ chatId, messageId: position.messageId, error }, 'loading saved message anchor failed')
          settleReveal(position.messageId, error instanceof Error ? error : new Error(String(error)))
          forgetSavedPosition()
          rerender() // the list is hidden while it waits for the anchor (openLocation() === null): show it again
        })
      }
      const timeout = window.setTimeout(() => abandon('is not in the loaded window'), Math.max(0, deadline.expiresAt - performance.now()))
      return () => window.clearTimeout(timeout)
    }

    restoringActivationRef.current = activationKey
    isAtBottomRef.current = false
    setFollowingTail(false)

    let frame = 0
    let stableFrames = 0
    const settle = (now: number) => {
      if (restoringActivationRef.current !== activationKey) return
      // @@@6595 列表挂载时在第一次绘制之前就落在这一行(openLocation;锚点后载进来时整列表重挂),这里只核对偏移。
      const row = Array.from(scroller.querySelectorAll<HTMLElement>('[data-msg-id]'))
        .find((candidate) => candidate.dataset.msgId === position.messageId)
      if (row) {
        const actualOffset = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top
        const delta = actualOffset - position.offset
        if (Math.abs(delta) <= RESTORE_OFFSET_TOLERANCE) {
          stableFrames += 1
          if (stableFrames >= RESTORE_STABLE_FRAMES) {
            completedActivationRef.current = activationKey
            restoringActivationRef.current = null
            restoreDeadlineRef.current = null
            isAtBottomRef.current = false
            setFollowingTail(false)
            settleReveal(position.messageId)
            return
          }
        } else {
          stableFrames = 0
          scroller.scrollTop += delta
        }
      }

      if (now >= deadline.expiresAt) {
        restoringActivationRef.current = null
        abandon('did not settle')
        return
      }
      frame = requestAnimationFrame(settle)
    }
    frame = requestAnimationFrame(settle)
    return () => {
      cancelAnimationFrame(frame)
      if (restoringActivationRef.current === activationKey) restoringActivationRef.current = null
    }
  }, [
    activationKey,
    chatId,
    enabled,
    isAtBottomRef,
    messageIds,
    scrollerEl,
    setFollowingTail,
    loadMessageAnchor,
    forgetSavedPosition,
    settleReveal,
    revealRequest,
    positions,
  ])

  return { scrollerEl, scrollerRef, setScrollerRef, hasSavedOffBottomPosition, prepareForSavedPosition, isPreservingPosition, forgetSavedPosition, openLocation, revealMessage }
}
