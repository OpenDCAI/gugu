/** 引用里的摘要截到 24 个字(与会话页 #705 同一个数);一行放不下再由 CSS 省略。 */
const QUOTE_CHARS = 24

export function quoteSummary(text: string): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim())
  return chars.length > QUOTE_CHARS ? `${chars.slice(0, QUOTE_CHARS).join('')}…` : chars.join('')
}
