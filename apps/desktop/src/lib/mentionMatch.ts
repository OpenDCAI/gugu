// @ 候选的匹配与开合判定 —— 纯函数,composer 与测试共用。
//
// owner 3a:「群里明明有人却经常 @ 不到」。三个根因都在这里收口:
//   ① 名字带空格/标点(「Claude 2」「gpt-5.4」):原来一遇空格/标点就关框,且拿原串 includes 比
//      → 两边都去掉空白与标点再比,空格不再直接关框;
//   ② 只认 display_name:再加咕咕号、owner 给的备注;
//   ③ 中文名只能敲汉字:支持拼音全拼、首字母与混拼(pinyin-pro 的 match)。
import { matchText, normalizeMentionKey } from '@gugu/core/shared/search/textMatch'
export { matchText, normalizeMentionKey } from '@gugu/core/shared/search/textMatch'
export type { TextMatch } from '@gugu/core/shared/search/textMatch'
export { graphemes } from '@gugu/core/shared/graphemes'
import { hasDomainTail } from '@gugu/core/shared/mentionToken.mjs'

export interface MentionSearchable {
  name: string
  type?: 'all' | 'human' | 'agent'
  session_archived_at?: string | null
  /** owner 给这个人起的备注(联系人 alias)。 */
  alias?: string | null
  guguNumber?: number | null
}

/** 在 @ 后面出现就说明「这已经不是在打名字」的断句符(仅在一个都匹配不上时才据此关框)。 */
const SENTENCE_BREAK = /[\s,，。!！?？;；:：、]/
/** 超过这个长度还一个都匹配不上,就不是名字。 */
const MAX_QUERY_LENGTH = 40

/** 0 = 不匹配;越大越靠前(全等 > 前缀 > 包含 > 拼音)。空查询匹配所有可选成员,归档 Agent 不进入匹配。 */
export function mentionMatchScore(candidate: MentionSearchable, query: string): number {
  // Both the group ranker and the task picker use this score; keep the existing archive fact through their projections.
  if (candidate.type === 'agent' && candidate.session_archived_at != null) return 0
  const key = normalizeMentionKey(query)
  if (!key) return 1
  const numberScore = candidate.guguNumber != null && /^\d+$/.test(key)
    ? (String(candidate.guguNumber) === key ? 4 : String(candidate.guguNumber).startsWith(key) ? 3 : 0)
    : 0
  const textScore = (text: string | null | undefined) => matchText(text, query)?.score ?? 0
  return Math.max(textScore(candidate.name), textScore(candidate.alias), numberScore)
}

/** 过滤并按匹配度排序;同分保持原顺序(名册顺序本身有意义,如话题成员在前)。 */
export function filterMentionCandidates<T extends MentionSearchable>(candidates: readonly T[], query: string): T[] {
  return candidates
    .map((candidate, index) => ({ candidate, index, score: mentionMatchScore(candidate, query) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((row) => row.candidate)
}

function isExactName(candidate: MentionSearchable, key: string): boolean {
  return normalizeMentionKey(candidate.name) === key || (!!candidate.alias && normalizeMentionKey(candidate.alias) === key)
}

/**
 * @ 之后到光标这一段(query)还算不算「正在打名字」。
 * - 换行、或超长还没人匹配 → 不算;
 * - 以空白结尾且已经有人名字全等(「@Claude 2 」、选中候选后插入的那个空格)→ 名字打完了,不算;
 * - 有人匹配 → 算(空格、点、横线都可能是名字的一部分);
 * - 一个都不匹配:还没出现断句符、也还不是域名形状(a@b.com)就继续开着(框里显示「没有匹配的成员」),否则不算。
 */
export function isMentionQueryActive(query: string, candidates: readonly MentionSearchable[]): boolean {
  if (query.includes('\n')) return false
  const key = normalizeMentionKey(query)
  if (/\s$/.test(query) && key && candidates.some((candidate) => isExactName(candidate, key))) return false
  const anyMatch = candidates.some((candidate) => mentionMatchScore(candidate, query) > 0)
  if (anyMatch) return query.length <= MAX_QUERY_LENGTH
  return query.length <= MAX_QUERY_LENGTH && !SENTENCE_BREAK.test(query) && !hasDomainTail(query)
}

/** 往回找触发这次 @ 的位置;找不到返回 null。@ 前面是什么字都算(#6819,与 shared/mentionToken 同一判据)。 */
export function findMentionStart(value: string, cursor: number): number | null {
  const floor = Math.max(0, cursor - MAX_QUERY_LENGTH - 1)
  for (let i = cursor - 1; i >= floor; i -= 1) {
    const ch = value[i]
    if (ch === '\n') return null
    if (ch === '@') return i
  }
  return null
}
