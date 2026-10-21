// @@@5856 「把来源线 S 的话题清单摊开给我看」的请求 —— 从会话列表递到聊天区。
//
// 侧边栏只摊开最近几条,剩下的那一行点下去❌ 不再就地展开(owner 2026-09-20:
// 「难道最合适的不是只展示最近几条吗,点击更多跳到群中的这里,然后这里加个搜索吗」)。
// 「这里」= 顶栏那颗 🕐 打开的「历史 → 话题」面板,它本来就是这条线全部话题的主场。
//
// 与 topicSplitRequest 同形,理由也同:点下去那一刻主区显示的还是**上一条线**,
// 当场开面板会开在旧线上;所以请求带着它属于哪条线,聊天区只在自己正显示那条线时才取走。
import { UI_EVENTS } from './uiEvents'

/** 过期阈值:点完又去点了别处,这条请求作废,❌ 不许日后回到那条线时面板自己弹出来。 */
const TOPICS_PANEL_REQUEST_TTL_MS = 15_000

let pending: { sourceChatId: string; at: number } | null = null

export function requestTopicsPanel(sourceChatId: string): void {
  pending = { sourceChatId, at: Date.now() }
  window.dispatchEvent(new CustomEvent(UI_EVENTS.openTopicsPanel))
}

/** 取走属于 `currentChatId` 的请求;不属于它的留在盒子里,等聊天区切过去自己来取。 */
export function drainTopicsPanelRequest(currentChatId: string | null): boolean {
  if (!pending) return false
  if (Date.now() - pending.at > TOPICS_PANEL_REQUEST_TTL_MS) { pending = null; return false }
  if (!currentChatId || pending.sourceChatId !== currentChatId) return false
  pending = null
  return true
}
