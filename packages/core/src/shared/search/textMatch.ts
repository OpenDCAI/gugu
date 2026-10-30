import { match as matchPinyin } from 'pinyin-pro'
import { graphemes } from '../graphemes'

const IGNORED = /[\s\p{P}\p{S}]+/gu
const HAN = /\p{Script=Han}/u
const LATIN_LETTERS = /^[a-z]+$/

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
  // 拼音只在命中了汉字时才算:pinyin-pro 对整串匹配,「设计评审 gugu」里的拉丁字母会被当成 g…g 首字母(owner 10-28)。
  const pinyinHits = matchPinyin(text, query.replace(IGNORED, ''), { insensitive: true })
  return pinyinHits?.some((at) => HAN.test(text[at] ?? '')) ? { score: 1, hits: pinyinHits } : null
}
