/** 设备名长得像 IP 地址,或是 IP 地址截出来的那一截(`192`)—— 人认不出,❌ 当设备名。纯函数(渲染端也用)。 */
const IPV4_ISH = /^\d{1,3}(\.\d{1,3}){0,3}$/
const IPV6_ISH = /^[0-9a-f:]+$/i

export function isIpLikeLabel(label: string): boolean {
  const text = label.trim()
  if (!text) return false
  return IPV4_ISH.test(text) || (text.includes(':') && IPV6_ISH.test(text))
}

