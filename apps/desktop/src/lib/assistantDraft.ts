/**
 * #7199 「问它」「添加组件」这类按钮交来的那句话:接在人已经打的字后面(append),❌ 盖掉 ——
 * 人正写到一半点了个按钮,写的东西不能没。输入框空着就是这句话本身。
 */
export function appendDraft(previous: string, text: string): string {
  return previous.trim() ? `${previous.replace(/\s+$/, '')}\n${text}` : text
}
