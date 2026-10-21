// @ 候选的匹配与开合判定 —— 纯函数,composer 与测试共用。
//
// owner 3a:「群里明明有人却经常 @ 不到」。三个根因都在这里收口:
//   ① 名字带空格/标点(「Claude 2」「gpt-5.4」):原来一遇空格/标点就关框,且拿原串 includes 比
//      → 两边都去掉空白与标点再比,空格不再直接关框;
//   ② 只认 display_name:再加咕咕号、owner 给的备注;
//   ③ 中文名只能敲汉字:支持拼音全拼、首字母与混拼(pinyin-pro 的 match)。
import { match as matchPinyin } from 'pinyin-pro'
import { hasDomainTail } from '@gugu/core/shared/mentionToken.mjs'

export interface MentionSearchable {
  name: string
  /** owner 给这个人起的备注(联系人 alias)。 */
  alias?: string | null
  guguNumber?: number | null
}

const IGNORED = /[\s\p{P}\p{S}]+/gu
const HAN = /\p{Script=Han}/u
const LATIN_LETTERS = /^[a-z]+$/
/** 在 @ 后面出现就说明「这已经不是在打名字」的断句符(仅在一个都匹配不上时才据此关框)。 */
const SENTENCE_BREAK = /[\s,，。!！?？;；:：、]/
/** 超过这个长度还一个都匹配不上,就不是名字。 */
const MAX_QUERY_LENGTH = 40

/** 字形簇:分解形(e + 重音、韩文字母)在簇内才合得回一个字,高亮也按簇切,不把代理对切成两半。 */
export const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** 逐簇折叠:NFKC(全角→半角、分解形合成)、先大写再小写(ς/σ 这类只差大小写的并成一种)、去掉空白/标点/符号。
 *  from[i] = 折叠后第 i 个字来自原文哪个簇(簇首下标)。查询与名字走同一套,两边才比得上。 */
function fold(value: string): { key: string; from: number[] } {
  let key = ''
  const from: number[] = []
  for (const { segment, index } of graphemes.segment(value)) {
    const folded = segment.normalize('NFKC').toUpperCase().toLowerCase().replace(IGNORED, '')
    key += folded
    for (let k = 0; k < folded.length; k += 1) from.push(index)
  }
  return { key, from }
}

/** 比较用的键(见 fold)。 */
export function normalizeMentionKey(value: string): string {
  return fold(value).key
}

/** 名字对查询的命中:score 同 mentionMatchScore 的档位,hits = 命中字形簇在原文里的簇首下标(高亮用)。 */
export interface TextMatch {
  score: number
  hits: number[]
}

export function matchText(text: string | null | undefined, query: string): TextMatch | null {
  const key = normalizeMentionKey(query)
  if (!text || !key) return null
  const { key: normalized, from } = fold(text)
  const at = normalized.indexOf(key)
  if (at >= 0) {
    const score = normalized === key ? 4 : at === 0 ? 3 : 2
    return { score, hits: [...new Set(from.slice(at, at + key.length))] }
  }
  if (!HAN.test(text) || !LATIN_LETTERS.test(key)) return null
  const pinyinHits = matchPinyin(text, query.replace(IGNORED, ''), { insensitive: true })
  return pinyinHits ? { score: 1, hits: pinyinHits } : null
}

/** 0 = 不匹配;越大越靠前(全等 > 前缀 > 包含 > 拼音)。空查询匹配所有人。 */
export function mentionMatchScore(candidate: MentionSearchable, query: string): number {
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
