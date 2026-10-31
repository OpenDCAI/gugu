import { graphemes } from '@/lib/mentionMatch'

/** 引用里的摘要截到 24 个字(与会话页 #705 同一个数,按字形簇数,不把 emoji 切成两半);一行放不下再由 CSS 省略。 */
const QUOTE_CHARS = 24

export function quoteSummary(text: string): string {
  const chars = Array.from(graphemes.segment(text.replace(/\s+/g, ' ').trim()), ({ segment }) => segment)
  return chars.length > QUOTE_CHARS ? `${chars.slice(0, QUOTE_CHARS).join('')}…` : chars.join('')
}
