// @@@5856 「在来源线 S 上把话题 T 开成分栏」的请求 —— 从会话列表递到聊天区。
//
// 为什么不是一个 window 事件就完事,有两个原因:
// ① 主区此刻**可能根本没有聊天区**(一个会话都没选时那是空状态),事件发出去没人听,请求就丢了。
// ② 分栏状态是 subject-scoped 的(useTopicSurface:`splitState.forChatId === chatId` 才显示),
//    而列表点下去的那一刻聊天区显示的还是**上一条线**。当场 openSplit 会把分栏记在旧线名下,
//    切到来源线后它立刻变回不显示 —— 看起来就是「点了没反应」。
// 所以请求带上它属于哪条来源线,聊天区**只在自己正显示那条线时**才取走。
//
// ❌ 不做成「列表直接 setActiveChatId(话题)、再由聊天区改回来」:那等于先把话题当会话打开一帧,
// 而那一帧正好是 owner 不要的全宽形态(他的原话:「怎么还有把一个 topic 当做群的形式表达」)。
import { UI_EVENTS } from './uiEvents'

export type TopicSplitRequest = {
  chatId: string
  name: string
  sourceChatId: string
  /**
   * 开完之后把焦点交给**分栏自己**的输入框。
   * 用鼠标点进来的那条路一定要给:不给的话焦点留在左边来源线的 composer 上,
   * 顺手打字回车就发进了大群 —— 正是「消息隔离」要防的那个方向。
   */
  focusComposer?: boolean
  /** Activating a sidebar topic again closes its existing split. */
  toggle?: boolean
}

/** 过期阈值:点完话题却又去点了别处,这条请求就作废,❌ 不许日后回到那条线时突然自己弹出来。 */
const TOPIC_SPLIT_REQUEST_TTL_MS = 15_000

let pending: (TopicSplitRequest & { at: number }) | null = null

export function requestTopicSplit(request: TopicSplitRequest): void {
  pending = { ...request, at: Date.now() }
  window.dispatchEvent(new CustomEvent(UI_EVENTS.openTopicSplit))
}

/**
 * 取走属于 `currentChatId` 这条线的请求。不属于它的**留在盒子里**——
 * 聊天区正要切到那条线,下一帧它自己会来取。
 */
export function drainTopicSplitRequest(currentChatId: string | null): TopicSplitRequest | null {
  if (!pending) return null
  if (Date.now() - pending.at > TOPIC_SPLIT_REQUEST_TTL_MS) { pending = null; return null }
  if (!currentChatId || pending.sourceChatId !== currentChatId) return null
  const { chatId, name, sourceChatId, focusComposer, toggle } = pending
  pending = null
  return { chatId, name, sourceChatId, focusComposer, toggle }
}
