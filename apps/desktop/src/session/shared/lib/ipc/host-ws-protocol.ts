// @@@task-web-host — 会话页宿主的 WebSocket 线协议(浏览器侧与 node 侧共用,❌ 引 Buffer / electron)。
//
// 一条 WebSocket 连接 = 一个"渲染窗口":承载 preload 那五个方法里要过网的四个
//   invoke(channel, ...args) → result          (请求/应答,JSON)
//   eventSend(channel, data)                    (渲染层 → 宿主,JSON)
//   eventOn(channel)  ← event                   (宿主 → 渲染层广播,JSON)
//   requestWirePort(channel) → port + pm 帧     (双工 wire 端口:宿主宣告一个 portId,之后两侧
//                                                 用 pm 帧互相泵 WireMessage;blob-chunk 走二进制帧)
// getPathForFile 不过网:浏览器拿不到本机绝对路径,客户端固定返回空串,由调用点退化。
//
// 帧格式:文本帧 = JSON 信封;二进制帧 = [u32 headerLen][header JSON 信封][body bytes],只用于
// wire 的 blob-chunk(其 data 是 Uint8Array,JSON 放不下)。与 @gugu/session-wire stream.ts 的
// 分帧同源,但 WebSocket 自带消息边界,不需要总长前缀。

// 2 = #6264 加了事件订阅(sub / unsub)与客户端心跳:别的桌面经网络连进来时只推它订的频道。
// 3 = #6914 删掉了 task:`tasks.*` 去掉了 11 个方法,会话 / 终端 / PR 类方法的参数从 task id 换成会话 id。
//     客户端读到宿主 hello 里的号比自己小,就把那台机器标成「版本太旧」(machine-clients.ts),❌ 在某个动作上半截失败。
// 4 = PR-2 改名:宿主的方法与参数跟着会话的名字改(`tasks.*` → `sessionCreate.*`、`conversations.*` → `sessions.*`、
//     `conversationId` → `sessionId`)。
export const HOST_WS_PROTOCOL_VERSION = 4

export type HostWsClientMessage =
  | { t: 'invoke'; id: number; channel: string; args: unknown[] }
  | { t: 'send'; channel: string; data: unknown }
  | { t: 'pm'; port: number; msg: unknown }
  | { t: 'pc'; port: number }
  /** 只要这个频道的推送(报过一次订阅之后,没订的频道一律不推)。 */
  | { t: 'sub'; channel: string }
  | { t: 'unsub'; channel: string }
  /** 客户端心跳:没有传输层 ping 的线(设备连接)靠它让宿主判活。 */
  | { t: 'hb' }

export type HostWsServerMessage =
  /** app = 宿主的咕咕版本(老宿主不报)。 */
  | { t: 'hello'; v: number; sender: number; app?: string }
  | { t: 'result'; id: number; ok: true; value: unknown }
  | { t: 'result'; id: number; ok: false; error: { name: string; message: string; code?: string } }
  | { t: 'event'; channel: string; data: unknown }
  | { t: 'port'; channel: string; port: number }
  | { t: 'pm'; port: number; msg: unknown }
  | { t: 'pc'; port: number }
  /** 宿主心跳:与 ws ping 同拍发出,让浏览器侧也看得见"线还活着"。 */
  | { t: 'hb' }

export type HostWsMessage = HostWsClientMessage | HostWsServerMessage

// 跨境家宽的 NAT / 中间设备会把空闲 TCP 悄悄掐掉,两侧都察觉不到,直到下一次要发东西才发现连接
// 已死 → 页面反复「断开/重连」(owner 在 d15 公网直连验收时撞到)。宿主每 HEARTBEAT 发一次
// ws ping + hb;浏览器超过 STALE 没收到任何消息就自己关掉重连,不再抱着死连接等。
// STALE = 宿主自己的关窗规矩(frame-host:连续两拍什么都没收到就关),两边一个数:这边这么久没收到一帧时,
// 对面多半也这么久没收到这边的(App 被冻住、断网),窗口已经被关了。
export const HOST_WS_HEARTBEAT_MS = 20_000
export const HOST_WS_STALE_MS = 2 * HOST_WS_HEARTBEAT_MS

type BlobChunkLike = { kind: 'blob-chunk'; data: Uint8Array } & Record<string, unknown>

function isBlobChunk(value: unknown): value is BlobChunkLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'blob-chunk' &&
    (value as { data?: unknown }).data instanceof Uint8Array
  )
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

// invoke 参数 / result 值里也会出现字节(网页版粘贴图片:拿不到本机路径,`pty.persistDroppedBlob`
// 把整张图的 Uint8Array 交给宿主落盘)。裸 JSON 会把 Uint8Array 写成 {"0":…,"1":…},宿主端
// byteLength 读不到 → 落盘抛错 → 粘贴静默失败(#4866 web 验收撞到)。文本帧里的字节一律按
// 带标签的 base64 走,两侧对称;标签键名故意生僻,不与业务字段撞。Buffer 是 Uint8Array 子类,同样命中。
const U8_TAG = '$gugu_u8'
const B64_CHUNK = 0x8000

function u8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + B64_CHUNK) as unknown as number[])
  }
  return btoa(binary)
}

function base64ToU8(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function u8Replacer(this: unknown, _key: string, value: unknown): unknown {
  return value instanceof Uint8Array ? { [U8_TAG]: u8ToBase64(value) } : value
}

function u8Reviver(this: unknown, _key: string, value: unknown): unknown {
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)[U8_TAG] === 'string' &&
    Object.keys(value).length === 1
  ) {
    return base64ToU8((value as Record<string, string>)[U8_TAG]!)
  }
  return value
}

/** 编码一条信封:含 blob-chunk 的 pm 帧走二进制,其余走文本。 */
export function encodeHostWsMessage(message: HostWsMessage): string | Uint8Array<ArrayBuffer> {
  if (message.t === 'pm' && isBlobChunk(message.msg)) {
    const { data, ...rest } = message.msg
    const header = textEncoder.encode(JSON.stringify({ ...message, msg: rest }, u8Replacer))
    const frame = new Uint8Array(new ArrayBuffer(4 + header.byteLength + data.byteLength))
    new DataView(frame.buffer).setUint32(0, header.byteLength)
    frame.set(header, 4)
    frame.set(data, 4 + header.byteLength)
    return frame
  }
  return JSON.stringify(message, u8Replacer)
}

/** 解码一帧;坏帧返回 null(调用方按协议错误断开)。 */
export function decodeHostWsMessage(raw: string | Uint8Array): HostWsMessage | null {
  try {
    if (typeof raw === 'string') return JSON.parse(raw, u8Reviver) as HostWsMessage
    if (raw.byteLength < 4) return null
    const headerLength = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(0)
    if (4 + headerLength > raw.byteLength) return null
    const envelope = JSON.parse(
      textDecoder.decode(raw.subarray(4, 4 + headerLength)),
      u8Reviver,
    ) as HostWsMessage
    if (envelope.t !== 'pm') return null
    const body = raw.subarray(4 + headerLength)
    // 复制一份:WebSocket 的接收缓冲会被复用,wire 侧会把 chunk 存起来。
    return { ...envelope, msg: { ...(envelope.msg as object), data: new Uint8Array(body) } }
  } catch {
    return null
  }
}

/** 宿主 → 浏览器错误的可序列化形态(Electron 的 invoke 也只把 message 带过桥)。 */
/** 原因码(`code`)随错误一起过线:调用方按码说人话(「版本太旧」「在目录外」),❌ 去解析 message。 */
export function serializeHostWsError(error: unknown): { name: string; message: string; code?: string } {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? { name: error.name, message: error.message, code } : { name: error.name, message: error.message }
  }
  return { name: 'Error', message: String(error) }
}

/** 浏览器地址里带 token / 宿主地址的约定:`#sessionHost=ws://127.0.0.1:PORT&sessionHostToken=…`。 */
export const HOST_WS_URL_PARAM = 'sessionHost'
export const HOST_WS_TOKEN_PARAM = 'sessionHostToken'
export const HOST_WS_DEFAULT_PORT = 47613
export const HOST_WS_TOKEN_QUERY = 'token'

// #6264 设备连接(SSH / 咕咕云)上的信封是 JSON:帧装进去时文本帧原样、二进制帧转 base64。
export type HostFrameCarrier = { f: string } | { b: string }

export function frameToCarrier(frame: string | Uint8Array): HostFrameCarrier {
  return typeof frame === 'string' ? { f: frame } : { b: u8ToBase64(frame) }
}

export function carrierToFrame(value: unknown): string | Uint8Array | null {
  if (!value || typeof value !== 'object') return null
  const carrier = value as { f?: unknown; b?: unknown }
  if (typeof carrier.f === 'string') return carrier.f
  if (typeof carrier.b === 'string') {
    try {
      return base64ToU8(carrier.b)
    } catch {
      return null
    }
  }
  return null
}
