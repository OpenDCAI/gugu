import OpenCC from 'opencc-js/t2cn'
import { graphemes } from '../graphemes'

const simplified = OpenCC.Converter({ from: 't', to: 'cn' })
const CJK = /[\p{Script=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script=Hangul}]/u
const WORD = /[\p{L}\p{N}\p{M}]/u

export interface SearchToken {
  text: string
  start: number
  end: number
  cjk: boolean
}

/** Same per-grapheme normalization for documents, queries and original-text hit offsets. */
export function searchTokens(text: string): SearchToken[] {
  const result: SearchToken[] = []
  let word: SearchToken | undefined
  const flush = () => { if (word) result.push(word); word = undefined }
  for (const { segment, index } of graphemes.segment(text)) {
    let normalized = simplified(segment.normalize('NFKC')).toUpperCase().toLowerCase().replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    // unicode61 remove_diacritics=2 folds Latin marks, not kana voicing or other scripts.
    if (/\p{Script=Latin}/u.test(normalized)) normalized = normalized.normalize('NFD').replace(/\p{M}/gu, '')
    for (const character of normalized) {
      if (CJK.test(character)) {
        flush()
        result.push({ text: character, start: index, end: index + segment.length, cjk: true })
      } else if (WORD.test(character)) {
        if (!word) word = { text: '', start: index, end: index + segment.length, cjk: false }
        word.text += character
        word.end = index + segment.length
      } else flush()
    }
  }
  flush()
  return result
}

export function segment(text: string): string {
  return searchTokens(text).map((token) => token.text).join(' ')
}

export function queryTokenGroups(text: string, phrase = false): { tokens: SearchToken[]; prefix: boolean }[] {
  const tokens = searchTokens(text)
  if (phrase) return tokens.length ? [{ tokens, prefix: false }] : []
  const groups: { tokens: SearchToken[]; prefix: boolean }[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token.cjk) { groups.push({ tokens: [token], prefix: true }); continue }
    const characters = [token]
    while (tokens[index + 1]?.cjk && tokens[index + 1].start <= tokens[index].end) characters.push(tokens[++index])
    groups.push({ tokens: characters, prefix: false })
  }
  return groups
}

/** Quote every FTS literal. Only unquoted Latin/number terms receive prefix matching. */
export function segmentQuery(text: string, phrase = false): string {
  return queryTokenGroups(text, phrase)
    .map((group) => `"${group.tokens.map((token) => token.text).join(' ')}"${group.prefix ? '*' : ''}`)
    .join(' AND ')
}
