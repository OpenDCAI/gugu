import { useMemo } from 'react'
import { buildMentionRender } from '../../lib/mentionRenderModel'
import { MENTION_MARKER_PREFIX } from '../../lib/mentionMdast'
import type { MemberProfileCardModel } from '../MemberProfileCard'
import type { MessageItem } from '@gugu/core/shared/types/chat'

// @@@2017 019f64ea 二审终版 — 从路由真源 to_user_ids 构建一条消息的渲染模型(单重显示,每对象恰好一个可见表达):
//   content → 注入本次 nonce marker 后的正文(交给 Markdown);mentionMarker → 本次 nonce(components.a 据此判 mention);
//   fallbackLabels → 高亮不到的路由对象的兜底徽标。背书唯一真源 = to_user_ids;正文无法伪造 backed(nonce 不可预知)。
//   reply 被回复者由引用条表达(excludeIds 排除);whisper/DM 各有自己的标签 → 仅群聊非 whisper 计算。
export interface MentionRender {
  /** 注入 nonce marker 后要渲染的正文;非群/whisper → undefined(调用方用原始 content)。 */
  content: string | undefined
  /** 本次渲染的 nonce marker;非群/whisper → undefined(不识别任何 mention marker)。 */
  mentionMarker: string | undefined
  /** 兜底徽标名单。 */
  fallbackLabels: string[]
}

export function useMentionRender(
  msg: Pick<MessageItem, 'to_user_ids' | 'is_whisper' | 'content' | 'reply_to_sender_user_id'>,
  isGroup: boolean,
  memberProfiles: Record<string, MemberProfileCardModel> | undefined,
): MentionRender {
  // 每个 Markdown 实例一枚 nonce marker:发消息者写正文时无从预知 → 无法伪造 data-mention;稳定于本次挂载 →
  // memo 友好,且令注入后内容唯一 → 天然绕开 Streamdown 按内容缓存导致的串味。
  const marker = useMemo(() => `${MENTION_MARKER_PREFIX}${crypto.randomUUID()}`, [])
  return useMemo(() => {
    if (!isGroup || msg.is_whisper) return { content: undefined, mentionMarker: undefined, fallbackLabels: [] }
    const model = buildMentionRender(msg.content ?? '', msg.to_user_ids, {
      nameOf: (id) => memberProfiles?.[id]?.displayName,
      excludeIds: msg.reply_to_sender_user_id ? [msg.reply_to_sender_user_id] : [],
      marker,
    })
    return { content: model.content, mentionMarker: marker, fallbackLabels: model.fallbackLabels }
  }, [isGroup, msg.is_whisper, msg.to_user_ids, msg.content, msg.reply_to_sender_user_id, memberProfiles, marker])
}
