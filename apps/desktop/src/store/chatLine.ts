import { useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { useChatStore, type ChatContextValue } from './chatContext'

// #7199 聊天面「吃一个会话 id」。
//
// store 里只有一条活的线(activeChatId):消息窗口、实时、未读导航、话题视图都跟着它走。对话页之外还有一处要画整套聊天面 ——
// 「助理」App 里和个人助理的那条私聊,owner:「这是这个 App 的核心，不能跳去私聊」。两处从来不同时摆在人眼前,
// 所以不复制那套机器,而是:
//   · 每块聊天面包一层 ChatLineScope,只认自己那条。线在别处时它看到的是线离开前自己那一帧(冻住),
//     ❌ 跟着线换成别的会话 —— 换了就是一次真切换:右栏收起、话题分栏关掉、群协作重拉,回来时什么都没了;
//   · 摆在人眼前的那块借线(useChatLineClaim),离开时还给对话页原来选中的那条;
//   · 对话页选中的是哪条 = useChatSelection:有人借着线时是借之前那条,否则就是线本身。

/** 跟着线走的那几格:线不在这条上时,用离开前自己那一帧(没有过 = 还在读)。 */
const LINE_FIELDS = [
  'messages', 'loadingMessages', 'messagesError', 'hasMoreOlder', 'loadingOlder', 'messageWindow', 'unreadNavigationPending', 'unreadEntry',
  'memberReadSeqs', 'activeThreadRootId', 'threadMessages', 'loadingThread', 'threadScope',
] as const satisfies readonly (keyof ChatContextValue)[]

type LineFields = Pick<ChatContextValue, (typeof LINE_FIELDS)[number]>

const NOT_YET_READ: LineFields = {
  messages: [], loadingMessages: true, messagesError: null, hasMoreOlder: false, loadingOlder: false, messageWindow: undefined,
  unreadNavigationPending: false, unreadEntry: null, memberReadSeqs: {},
  activeThreadRootId: null, threadMessages: [], loadingThread: false,
  threadScope: { rootId: null, isOpen: false, messages: [], loading: false },
}

const idle = () => {}
const idleAsync = async () => {}

/**
 * 线不在 `chatId` 上时这块面看到的 store:会话列表、草稿、身份这些照常是活的;跟着线走的几格是 `frozen` 那一帧;
 * 发消息按 `chatId` 发(❌ 落到线所在的那条);其余跟着线走的动作一律不做 —— 这块面此刻要么藏着,要么正把线借回来。
 */
export function offLineChatValue(
  store: ChatContextValue,
  chatId: string | null,
  frozen: ChatContextValue | null,
  sendHere: ChatContextValue['sendMessage'],
): ChatContextValue {
  const line = frozen && frozen.activeChatId === chatId ? frozen : NOT_YET_READ
  return {
    ...store,
    ...(Object.fromEntries(LINE_FIELDS.map((key) => [key, line[key]])) as LineFields),
    activeChatId: chatId,
    activeChat: store.chats.find((chat) => chat.id === chatId) ?? frozen?.activeChat ?? null,
    sendMessage: sendHere,
    toggleReaction: idleAsync, clearMessages: idleAsync, loadOlderMessages: idleAsync, loadNewerMessages: idleAsync,
    loadMessageAnchor: idleAsync, returnToLatestMessages: idleAsync, jumpToUnreadEntry: idleAsync,
    openThread: idle, markMessageVisible: idle, setFollowingTail: idle, removeMessage: idle,
  }
}

// ── 谁借着线 ───────────────────────────────────────────────────────────────────

type LineClaim = { chatId: string; returnTo: string | null }

let claim: LineClaim | null = null
const claimListeners = new Set<() => void>()

function setClaim(next: LineClaim | null): void {
  claim = next
  for (const listener of [...claimListeners]) listener()
}

function subscribeClaim(listener: () => void): () => void {
  claimListeners.add(listener)
  return () => { claimListeners.delete(listener) }
}

/** 对话页选中的是哪条:线被借着 = 借之前那条;线在别的地方(借着的时候被人换走)= 线本身。 */
export function chatSelectionOf(lineChatId: string | null, held: LineClaim | null): string | null {
  return held && lineChatId === held.chatId ? held.returnTo : lineChatId
}

export function useChatSelection(lineChatId: string | null): string | null {
  const held = useSyncExternalStore(subscribeClaim, () => claim)
  return chatSelectionOf(lineChatId, held)
}

/**
 * 摆在人眼前的这块面把线借到 `chatId` 上;`active` 变 false / 卸载时还回去(线还在它这儿才还 ——
 * 别处已经开了另一条,比如点了一条通知,那一条就是对话页现在选中的)。
 * 用 layout effect:还线要赶在画出来之前,对话页 ❌ 先闪一帧借来的那条。
 */
export function useChatLineClaim(chatId: string | null, active: boolean): void {
  const { activeChatId, setActiveChatId } = useChatStore('activeChatId', 'setActiveChatId')
  const lineRef = useRef(activeChatId)
  lineRef.current = activeChatId
  const engaged = active && chatId !== null
  useLayoutEffect(() => {
    if (!engaged || !chatId) return
    setClaim({ chatId, returnTo: lineRef.current })
    setActiveChatId(chatId)
    return () => {
      const held = claim
      setClaim(null)
      if (held && lineRef.current === held.chatId) setActiveChatId(held.returnTo)
    }
  }, [engaged, chatId, setActiveChatId])
  // 借着的时候线被别处换走、这块面还摆在眼前(没跟着换页):换去的那条记成对话页的选中,线要回来。
  useLayoutEffect(() => {
    if (!engaged || !chatId || activeChatId === chatId || claim?.chatId !== chatId) return
    setClaim({ chatId, returnTo: activeChatId })
    setActiveChatId(chatId)
  }, [engaged, chatId, activeChatId, setActiveChatId])
}
