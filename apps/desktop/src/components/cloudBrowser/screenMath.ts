import { CLOUD_BROWSER_TEXT_CHUNK } from '@/session/shared/cloud-browser'

// #7199 云浏览器画面的几样纯算术(CloudBrowserScreen 用,单测直接测)。

/** 本地指针 → 远端 CSS 坐标;落在画面外 = null。纯函数。 */
export function remotePoint(
  client: { x: number; y: number },
  rect: { left: number; top: number; width: number; height: number },
  frame: { width: number; height: number; viewportWidth: number; viewportHeight: number },
): { x: number; y: number } | null {
  const scale = Math.min(rect.width / frame.width, rect.height / frame.height)
  if (!Number.isFinite(scale) || scale <= 0) return null
  const offsetX = (rect.width - frame.width * scale) / 2
  const offsetY = (rect.height - frame.height * scale) / 2
  const imageX = (client.x - rect.left - offsetX) / scale
  const imageY = (client.y - rect.top - offsetY) / scale
  if (imageX < 0 || imageY < 0 || imageX > frame.width || imageY > frame.height) return null
  return { x: (imageX / frame.width) * frame.viewportWidth, y: (imageY / frame.height) * frame.viewportHeight }
}

/** 一段要发的文字切成 4096 字一块,❌ 切开代理对。 */
export function chunkText(text: string): string[] {
  const chunks: string[] = []
  let rest = text
  while (rest.length > CLOUD_BROWSER_TEXT_CHUNK) {
    let cut = CLOUD_BROWSER_TEXT_CHUNK
    const code = rest.charCodeAt(cut - 1)
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest) chunks.push(rest)
  return chunks
}

let textId = 0
export function nextTextId(): string {
  textId += 1
  return `t${Date.now().toString(36)}${textId}`
}
