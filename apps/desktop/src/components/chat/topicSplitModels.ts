// @@@5856 话题分栏的纯函数 —— 单独一个文件是 react-refresh 的要求(一个文件只导出组件),
// 也让引文的取法能被单独判真假。
import type { MessageItem } from '@gugu/core/shared/types/chat'

/** 引用条的文本:与主线同形(一行引文 + 省略)。引用的是话题里的一句话,所以它留在分栏自己的输入框上。 */
export function quotePrefixOf(message: Pick<MessageItem, 'content'>): string {
  const firstLine = (message.content ?? '').split('\n')[0] ?? ''
  return `> ${firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine}`
}

/** Source eligibility matches server privacy rules; outbox waits for local sources. */
export type TopicSourceCandidate =
  Pick<MessageItem, 'id' | 'seq' | 'local_send_state' | 'is_whisper' | 'retracted_at' | 'content_type'>

export function canSourceTopic(message: TopicSourceCandidate): boolean {
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
