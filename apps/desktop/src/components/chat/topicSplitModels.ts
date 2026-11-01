// @@@5856 话题分栏的纯函数 —— 单独一个文件是 react-refresh 的要求(一个文件只导出组件),
// 也让引文的取法能被单独判真假。
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { isServerMessage } from '@gugu/core/shared/ui/messageState'

/** 引用条的文本:与主线同形(一行引文 + 省略)。引用的是话题里的一句话,所以它留在分栏自己的输入框上。 */
export function quotePrefixOf(message: Pick<MessageItem, 'content'>): string {
  const firstLine = (message.content ?? '').split('\n')[0] ?? ''
  return `> ${firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine}`
}

/**
 * 顶栏那颗「开话题」的来源:这条线上**最新一条真能当来源**的消息,没有就返回 null(按钮不画)。
 *
 * 判据与服务端一一对应,❌ 不许只在这边挡:
 * - `seq >= 0` 且没有 `local_send_state` —— 乐观行服务端还不存在;发失败的红气泡会一直挂在末尾,
 *   直接取末尾等于这颗按钮**每次都开不出来**,而 create_topic 只会说「来源消息不是这条线上的活消息」。
 * - 非悄悄话、未撤回 —— 话题名截自来源正文且对全线可见,拿这两种当来源就是把不该看见的那句话
 *   重新贴到所有人眼前(20260919001500 / 20260919003000 两条迁移硬拒)。
 * ❗判据到此为止,**与服务端逐条对齐**:系统消息与附件服务端是收的(只是名字回落成「话题」),
 * 所以这里也收。客户端比服务端严的后果是这颗按钮在「最近全是附件」的线上**整颗消失、不给任何解释**
 * (刚建好、只有一条入群系统消息的新群就是这种线),而用户只剩右键那一条路 —— 那是自找的缺陷。
 */
export type TopicSourceCandidate =
  Pick<MessageItem, 'id' | 'seq' | 'local_send_state' | 'is_whisper' | 'retracted_at' | 'content_type'>

/**
 * 「这条消息开得出话题吗」—— 顶栏那颗按钮与右键菜单**共用这一个判据**。
 *
 * @@@5856 找茬第八轮:原先两处各写一份 —— 顶栏挡了乐观行,右键只挡了悄悄话与撤回,
 * 于是在「发送中 / 未送达」的红气泡上右键还能点「开话题」,点完服务端必拒
 * (`Source message … is not a live message`),界面只给一句帮不上忙的 toast。
 * 两份判据就是允许它们漂开;收成一份之后,漏的那一半不可能只在一边补上。
 */
export function canSourceTopic(message: TopicSourceCandidate): boolean {
  // 乐观行服务端还不存在;发失败的红气泡会一直挂着,拿它当来源是必拒。
  if (!isServerMessage(message)) return false
  // 话题名截自来源正文且对全线可见 ⇒ 悄悄话与撤回不许当来源
  // (20260919001500 / 20260919003000 两条迁移硬拒)。
  if (message.is_whisper || message.retracted_at) return false
  return true
}

/**
 * @@@5856 话题分栏的宽度。owner 2026-09-19 实测后拿掉了头栏那颗「全宽打开」键,
 * 原话是「不应该有这个按钮,你只要保证分割线可分割就行了」——
 * 所以「想看大一点」这件事从一颗按钮换成了这条分割线,它必须真的能拖。
 *
 * 地板 280:再窄一条消息就折成竖条。天花板由容器算(见 maxTopicSplitWidthForAvailableWidth):
 * 左边主聊天区要留得下自己的最小宽度,❌ 不许把分栏拖到把主线挤没。
 */
const TOPIC_SPLIT_WIDTH_STORAGE_KEY = 'gugu.topicSplitPane.width'
export const TOPIC_SPLIT_DEFAULT_WIDTH = 340
export const TOPIC_SPLIT_MIN_WIDTH = 280
export const TOPIC_SPLIT_MAX_WIDTH = 720
/**
 * 拖到头时左边主聊天区仍要留住的理想宽度 = 380。
 *
 * ⚠️ 这里原先写的是 **740**,那是「中栏 380 + 右栏 360」的**和**,
 * 不是中栏的保留额。后果是在 1280 宽的窗口上(聊天区实宽约 980):
 *   上限 = min(720, max(280, 980-740=240)) = 280 = 下限 ⇒ **这条分割线一格都拖不动**,
 *   而且它连 data-dragging 都照常翻成 true,看起来像在拖、实际数字纹丝不动。
 * owner 2026-09-19 实测:「这条线也拖不动啊」。
 */
export const TOPIC_SPLIT_HOST_MIN_WIDTH = 380

export function clampTopicSplitWidth(width: number): number {
  if (!Number.isFinite(width)) return TOPIC_SPLIT_DEFAULT_WIDTH
  return Math.min(TOPIC_SPLIT_MAX_WIDTH, Math.max(TOPIC_SPLIT_MIN_WIDTH, Math.round(width)))
}

export function maxTopicSplitWidthForAvailableWidth(availableWidth: number): number {
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) return TOPIC_SPLIT_MAX_WIDTH
  const remaining = Math.floor(availableWidth - TOPIC_SPLIT_HOST_MIN_WIDTH)
  return Math.min(TOPIC_SPLIT_MAX_WIDTH, Math.max(TOPIC_SPLIT_MIN_WIDTH, remaining))
}

export function readStoredTopicSplitWidth(storage: Storage = window.localStorage): number {
  const value = Number(storage.getItem(TOPIC_SPLIT_WIDTH_STORAGE_KEY))
  if (!Number.isFinite(value) || value <= 0) return TOPIC_SPLIT_DEFAULT_WIDTH
  return clampTopicSplitWidth(value)
}

export function writeStoredTopicSplitWidth(width: number, storage: Storage = window.localStorage): void {
  storage.setItem(TOPIC_SPLIT_WIDTH_STORAGE_KEY, String(clampTopicSplitWidth(width)))
}
