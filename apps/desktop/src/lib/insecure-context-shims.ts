// @@@task-web-host — 非安全上下文的垫片。全仓 59 个文件裸用 `crypto.randomUUID()`,那是默认自己跑在
// Electron 或 https 里;而网页形态可能按 `http://<ip>:<port>` 直开(owner 在 d15 上验收就是这么开的),
// 浏览器只在安全上下文(https / localhost)暴露 `crypto.randomUUID`,于是会话页脚本一启动就
// `TypeError: crypto.randomUUID is not a function` → 整页白。`crypto.getRandomValues` 不受此限,
// 按 RFC 4122 v4 拼一个;已有原生实现时什么都不做。import 即生效,必须排在业务模块之前。
const HEX = Array.from({ length: 256 }, (_, i) => (i + 0x100).toString(16).slice(1))

export function randomUuidV4(): `${string}-${string}-${string}-${string}-${string}` {
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = (i: number) => HEX[b[i]!]!
  return `${h(0)}${h(1)}${h(2)}${h(3)}-${h(4)}${h(5)}-${h(6)}${h(7)}-${h(8)}${h(9)}-${h(10)}${h(11)}${h(12)}${h(13)}${h(14)}${h(15)}`
}

export function installInsecureContextShims(target: Crypto | undefined = globalThis.crypto): void {
  if (!target || typeof target.getRandomValues !== 'function') return
  if (typeof (target as { randomUUID?: unknown }).randomUUID === 'function') return
  Object.defineProperty(target, 'randomUUID', { value: randomUuidV4, configurable: true, writable: true })
}

installInsecureContextShims()
