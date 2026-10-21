// @@@mention-token (#951 → #6819) —— 「@名字」算不算提及,全仓只有这一份判据:输入框候选、发送路由(to_user_ids)、
// 正文高亮、agent 信封的 message_context、IM server 核 @ 与收件人,都从这里 import。❌ 别在别处再写一条正则。
// - @ 前面不看:中英混写「detail@Claude 84」、中文「你好@小明」都算。
// - 名字后面接字母/数字/下划线不算:「@张三」不在「@张三丰」里,「@Bob」不在「@Bobby」里。
// - 名字后面是域名尾巴(. + ASCII 字母数字)不算:alice@gmail.com 不提及叫 gmail 的人;句末的「@Alice.」照算。
// - 同一处能读成几个名字时取最长:「@Claude 2」只提及 Claude 2,不连带 Claude。
const DOMAIN_TAIL = '\\.[A-Za-z0-9]'
const NAME_END = `(?![\\p{L}\\p{N}_]|${DOMAIN_TAIL})`

function escapeName(name) {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 正文里的「@名字」提及:[start,end) 含 @,按 start 升序、互不重叠。空名字不参与(它会退化成匹配任何裸 @,#5610)。 */
export function findMentionSpans(text, names, { ignoreCase = false } = {}) {
  const candidates = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length)
  if (!candidates.length) return []
  const token = new RegExp(`@(${candidates.map(escapeName).join('|')})${NAME_END}`, ignoreCase ? 'giu' : 'gu')
  const canonical = (hit) => (ignoreCase ? candidates.find((name) => name.toLowerCase() === hit.toLowerCase()) : hit)
  return [...String(text ?? '').matchAll(token)].map((m) => ({ start: m.index, end: m.index + m[0].length, name: canonical(m[1]) }))
}

/** @ 后面这一段已经是域名形状:输入框里一个人都匹配不上时,据此收起候选(打邮箱不挂着「没有匹配的成员」)。 */
export function hasDomainTail(value) {
  return new RegExp(DOMAIN_TAIL).test(value)
}
