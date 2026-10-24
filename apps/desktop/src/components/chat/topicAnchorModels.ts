// @@@5856 锚点那一行要显示什么 —— 纯函数,判官盯得住。
//
// owner 2026-09-19 看着实机问:「你不感觉这个像是个文字重复吗?这一段文字,是你故意的」。
// 是我做的:话题名默认**截自来源消息的开头**(spec:「建立是一步」的理由之一),而锚点就挂在那条消息底下 ⇒
// 同一句话在屏幕上连着出现两遍。名字本身没错,错的是**把它再念一遍**。
// 所以:名字还是自动截出来的那一份时,锚点不写名字,只写「话题」;用户改过名才写名字。
import type { TopicSummary } from '@gugu/core/shared/types/chat'
import { displayAgentReferences } from '@/lib/mentionMdast'

/** The chat UI passes this default to create_topic and uses it to recognize an unchanged automatic name. */
export const TOPIC_NAME_CUT_LENGTH = 40

export function topicNameFromMessage(content: string | null | undefined): string | null {
  const firstLine = displayAgentReferences(content ?? '', (_id, label) => `@${label}`).split('\n')[0]?.trim() ?? ''
  if (firstLine.length === 0) return null
  return firstLine.length <= TOPIC_NAME_CUT_LENGTH
    ? firstLine
    : `${firstLine.slice(0, TOPIC_NAME_CUT_LENGTH)}…`
}

/** 名字还是从来源消息截出来的那一份(= 没人改过名)。取不到来源正文时按「改过」处理,宁可多写一遍也不隐瞒。 */
export function isTopicNameCutFromSource(
  topicName: string | null | undefined,
  sourceContent: string | null | undefined,
): boolean {
  const cut = topicNameFromMessage(sourceContent)
  if (!cut) return false
  return (topicName ?? '').trim() === cut
}

export type TopicAnchorLine = {
  /** 第一段:改过名就是名字,没改过就是「话题」这个词(调用方给,便于 i18n)。 */
  lead: string
  /** 中间几段,按顺序用「 · 」接起来:条数、谁开的、最后动静。空数组表示只有 lead。 */
  segments: string[]
}

/**
 * 锚点只有**一行** —— 它是那条消息的附件,不是第二条消息。
 * owner 2026-09-19:「这个附件气泡不太好看」。两行 + 右对齐的参差在气泡底下比气泡本身还显眼。
 */
export function topicAnchorLine(
  topic: Pick<TopicSummary, 'name' | 'message_count' | 'last_message_at'>,
  opts: {
    sourceContent: string | null | undefined
    /** 「话题」这个词 */
    genericLead: string
    openedBy: string | null
    /** 已格式化好的时间;没有动静时给 null */
    activeAt: string | null
    /**
     * 同一条消息底下不止一条话题。那时**必须**写名字 —— 两行都读作「话题」就分不出谁是谁,
     * 「不重复上面那句话」这条让步在这里要给「能分清是哪条」让路。
     */
    disambiguate?: boolean
    labels: { messageCount: (count: number) => string; openedBy: (name: string) => string; quiet: string }
  },
): TopicAnchorLine {
  const named = opts.disambiguate === true || !isTopicNameCutFromSource(topic.name, opts.sourceContent)
  const lead = named && topic.name ? topic.name : opts.genericLead
  const segments: string[] = []
  if (topic.message_count > 0) segments.push(opts.labels.messageCount(topic.message_count))
  if (opts.openedBy) segments.push(opts.labels.openedBy(opts.openedBy))
  if (opts.activeAt) segments.push(opts.activeAt)
  // 一条都还没有、也说不出谁开的 ⇒ 至少说一句,❌ 不留一个光秃秃的「话题」。
  if (segments.length === 0) segments.push(opts.labels.quiet)
  return { lead, segments }
}
