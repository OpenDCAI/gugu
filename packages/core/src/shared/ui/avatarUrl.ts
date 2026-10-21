// @@@1482 头像 URL 规范化 — 单一来源，render 层(Avatar)与数据入口(乐观建 chat)共用。
// JS 字符串化产物 "undefined"/"null"(或空串/纯空白)绝非合法头像 URL：某些乐观/插值路径会把未初始化
// 变量塞进 avatar 字段（如 `${maybeUndefined}`），渲染成 <img src="undefined"> 破图。统一视作「无头像」
// → null，由调用方进入明确空态。在数据入口规范化(createOptimisticChat)杜绝脏串进 store；在 render
// 边界(Avatar)再兜一层，覆盖其它路径。
export function normalizeAvatarUrl(url: string | null | undefined): string | null {
  if (url == null) return null
  const trimmed = url.trim()
  if (trimmed === '' || trimmed === 'undefined' || trimmed === 'null') return null
  // 返回 trimmed（非原串）：带前后空白的有效 URL 原样返回时，<img src> 在部分浏览器/程序消费者会破图。
  return trimmed
}

const diagnosedInvalidAvatarUrls = new Set<string>()

export function reportInvalidAvatarUrl(url: string | null | undefined, surface: string): void {
  if (url == null || normalizeAvatarUrl(url) !== null) return
  const key = `${surface}\0${url}`
  if (diagnosedInvalidAvatarUrls.has(key)) return
  diagnosedInvalidAvatarUrls.add(key)
  console.error(`[Avatar] invalid avatar URL at ${surface}: ${JSON.stringify(url)}`)
}
