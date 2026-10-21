/**
 * @@@5641 Linux 上先确认桌面通知服务真的在线,再去碰 Electron 的 `Notification`。
 *
 * 症状:偶发整个界面冻结最长 120 秒 —— 不吃点击、不吃键盘、不重绘、不回应 `_NET_WM_PING`;
 * 同一时刻桌面上其它程序完全正常。超时结束后自愈,所以表现为「卡几分钟又自己好」。
 *
 * 根因(d15 真机读数,Ubuntu 24.04 / XFCE / Xtigervnc):`Notification.isSupported()` 在主进程里是
 * **同步**调用,Linux 实现经 libnotify 向 D-Bus 查询服务能力(`notify_get_server_caps`)。当
 * `org.freedesktop.Notifications` 在当前会话总线上**未注册但被标记为可激活**时,D-Bus 不会立刻
 * 失败,而是去尝试激活服务并等满 `service_start_timeout`(默认 **120000 ms**)。整段时间主线程
 * 停在 `g_dbus_proxy_new_for_bus_sync` 里。`eu-stack` 间隔 18 秒连采 3 次,栈一模一样:
 *   `__poll ← g_main_loop_run ← g_dbus_proxy_new_for_bus_sync ← notify_get_server_caps ← v8::Function::Call`
 * A/B 实测(同机同刻两条会话总线):服务已注册的那条 `GetCapabilities` 0.01 秒;咕咕实际连的那条
 * 13.39 秒后报 `Failed to activate service 'org.freedesktop.Notifications': timed out
 * (service_start_timeout=120000ms)`。把服务补到咕咕那条总线上,同一进程 `_NET_WM_PING` 立刻
 * 从「5 秒无回应」变成 20 ms。
 *
 * 修法:在碰 `Notification` 之前,先用**异步 socket** 直接问总线一句
 * `org.freedesktop.DBus.NameHasOwner("org.freedesktop.Notifications")`,自带秒级超时。两个要点:
 *   1. 异步 I/O 走事件循环,主线程不停;
 *   2. `NameHasOwner` 只问「现在有没有人占着这个名字」,**不触发服务激活** —— 这正是绕开
 *      那 120 秒的关键。已注册就秒回 true,没注册就秒回 false,两条路都不会挂。
 * 答案为 true 才去调 `Notification.isSupported()`(此时它必然秒回);为 false 就据实返回
 * 现有契约里的 `unsupported: true` 并记日志。
 *
 * ❌ 不给 `Notification.isSupported()` 套超时/try-catch:同步调用没法被外部打断,套了也照样冻。
 * ❌ 不静默吞掉「探测不出来」:探测失败按「服务不可用」如实上报并留日志,不假装通知发出去了。
 * ❌ 不引 D-Bus 依赖:只用到一个方法调用,手写这一条的编解码比拉一个库进来更小、更可审。
 * ❌ 不在 mac / Windows 上探测:那两个平台的通知 API 不经 D-Bus,`isSupported()` 本身就是廉价的。
 */
import { connect, type Socket } from 'node:net'

/** 桌面通知服务在会话总线上的公认名字。 */
export const NOTIFICATION_BUS_NAME = 'org.freedesktop.Notifications'

/** 探测超时。总线在线时应答是亚毫秒级,秒级上限只为兜住总线本身无响应的情况。 */
export const PROBE_TIMEOUT_MS = 2000

/** 探测结果的缓存时长 —— 通知守护进程可能中途启动或退出,所以不永久缓存。 */
export const PROBE_CACHE_TTL_MS = 60_000

const LITTLE_ENDIAN = 0x6c
const MESSAGE_TYPE_METHOD_CALL = 1
const MESSAGE_TYPE_METHOD_RETURN = 2
const MESSAGE_TYPE_ERROR = 3
const PROTOCOL_VERSION = 1

const FIELD_PATH = 1
const FIELD_INTERFACE = 2
const FIELD_MEMBER = 3
const FIELD_REPLY_SERIAL = 5
const FIELD_DESTINATION = 6
const FIELD_SIGNATURE = 8

const FIXED_HEADER_BYTES = 16

function pad(length: number, alignment: number): number {
  const remainder = length % alignment
  return remainder === 0 ? 0 : alignment - remainder
}

function alignTo(parts: number[], alignment: number): void {
  for (let i = pad(parts.length, alignment); i > 0; i -= 1) parts.push(0)
}

/** DBus STRING / OBJECT_PATH:4 字节对齐的长度前缀 + 内容 + NUL。 */
function putString(parts: number[], value: string): void {
  alignTo(parts, 4)
  const bytes = Buffer.from(value, 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(bytes.length, 0)
  parts.push(...header, ...bytes, 0)
}

/** DBus SIGNATURE:1 字节长度前缀 + 内容 + NUL,不对齐。 */
function putSignature(parts: number[], value: string): void {
  const bytes = Buffer.from(value, 'ascii')
  parts.push(bytes.length, ...bytes, 0)
}

/** 一个头字段 = STRUCT(byte code, VARIANT value),STRUCT 按 8 字节对齐。 */
function putStringField(parts: number[], code: number, signature: string, value: string): void {
  alignTo(parts, 8)
  parts.push(code)
  putSignature(parts, signature)
  putString(parts, value)
}

/**
 * SIGNATURE 头字段(code 8)的变体值本身是 SIGNATURE 类型,用 **1 字节**长度前缀,
 * ❌ 不能按 STRING 的 4 字节前缀写 —— 写错整条消息结构就错位,总线会直接断开连接。
 */
function putSignatureField(parts: number[], code: number, value: string): void {
  alignTo(parts, 8)
  parts.push(code)
  putSignature(parts, 'g')
  putSignature(parts, value)
}

/**
 * 编码一条无参数或单字符串参数的 METHOD_CALL。
 * 导出是为了能对着 DBus 规范逐字节单测,不用真起一条总线。
 */
export function encodeMethodCall(options: {
  serial: number
  path: string
  iface: string
  member: string
  destination: string
  stringArgument?: string
}): Buffer {
  const body: number[] = []
  if (options.stringArgument !== undefined) putString(body, options.stringArgument)

  const fields: number[] = []
  putStringField(fields, FIELD_PATH, 'o', options.path)
  putStringField(fields, FIELD_DESTINATION, 's', options.destination)
  putStringField(fields, FIELD_INTERFACE, 's', options.iface)
  putStringField(fields, FIELD_MEMBER, 's', options.member)
  if (options.stringArgument !== undefined) putSignatureField(fields, FIELD_SIGNATURE, 's')

  const header = Buffer.alloc(FIXED_HEADER_BYTES)
  header.writeUInt8(LITTLE_ENDIAN, 0)
  header.writeUInt8(MESSAGE_TYPE_METHOD_CALL, 1)
  header.writeUInt8(0, 2)
  header.writeUInt8(PROTOCOL_VERSION, 3)
  header.writeUInt32LE(body.length, 4)
  header.writeUInt32LE(options.serial, 8)
  header.writeUInt32LE(fields.length, 12)

  return Buffer.concat([
    header,
    Buffer.from(fields),
    Buffer.alloc(pad(FIXED_HEADER_BYTES + fields.length, 8)),
    Buffer.from(body),
  ])
}

export type DecodedMessage = {
  type: number
  serial: number
  replySerial: number | null
  signature: string
  body: Buffer
  byteLength: number
}

/**
 * 从缓冲区头部解出一条完整消息;字节不够返回 null 等下一批。
 * 导出以便单测直接喂构造好的字节。
 */
export function decodeMessage(buffer: Buffer): DecodedMessage | null {
  if (buffer.length < FIXED_HEADER_BYTES) return null
  if (buffer.readUInt8(0) !== LITTLE_ENDIAN) {
    throw new Error('D-Bus 回包不是小端序,本探测只与本机会话总线通信,不应出现')
  }
  const bodyLength = buffer.readUInt32LE(4)
  const fieldsLength = buffer.readUInt32LE(12)
  const bodyStart = FIXED_HEADER_BYTES + fieldsLength + pad(FIXED_HEADER_BYTES + fieldsLength, 8)
  const total = bodyStart + bodyLength
  if (buffer.length < total) return null

  let cursor = FIXED_HEADER_BYTES
  const fieldsEnd = FIXED_HEADER_BYTES + fieldsLength
  let replySerial: number | null = null
  let signature = ''
  while (cursor < fieldsEnd) {
    cursor += pad(cursor - FIXED_HEADER_BYTES, 8)
    if (cursor >= fieldsEnd) break
    const code = buffer.readUInt8(cursor)
    cursor += 1
    const sigLength = buffer.readUInt8(cursor)
    const fieldSignature = buffer.toString('ascii', cursor + 1, cursor + 1 + sigLength)
    cursor += 1 + sigLength + 1
    if (fieldSignature === 'u') {
      cursor += pad(cursor - FIXED_HEADER_BYTES, 4)
      const value = buffer.readUInt32LE(cursor)
      cursor += 4
      if (code === FIELD_REPLY_SERIAL) replySerial = value
    } else if (fieldSignature === 'g') {
      const length = buffer.readUInt8(cursor)
      const value = buffer.toString('ascii', cursor + 1, cursor + 1 + length)
      cursor += 1 + length + 1
      if (code === FIELD_SIGNATURE) signature = value
    } else {
      cursor += pad(cursor - FIXED_HEADER_BYTES, 4)
      const length = buffer.readUInt32LE(cursor)
      cursor += 4 + length + 1
    }
  }

  return {
    type: buffer.readUInt8(1),
    serial: buffer.readUInt32LE(8),
    replySerial,
    signature,
    body: buffer.subarray(bodyStart, total),
    byteLength: total,
  }
}

/**
 * 解析 `DBUS_SESSION_BUS_ADDRESS`,拿出可以给 `net.connect` 用的 unix socket 路径。
 * 抽象命名空间(`unix:abstract=`)在 Linux 上以 `\0` 开头表示,Node 支持这种路径。
 *
 * 只有地址**完全没给**时才用 `/run/user/<uid>/bus` —— 那是 DBus 规范规定的默认位置,
 * GLib 自己也这么找,所以此时两边问的是同一条总线。
 * ❌ 地址给了却不是 unix 传输(如 `tcp:`)时不许退到默认路径:那是**另一条**总线,
 *   在它上面问出来的答案与应用实际要用的总线无关,等于给出一个看着合理的错答案。
 *   这种情况返回 null,由调用方当作「探测不出来」如实上报。
 */
export function resolveSessionBusPath(
  address: string | undefined,
  uid: number,
): string | null {
  const raw = (address ?? '').trim()
  if (raw.length === 0) return Number.isInteger(uid) ? `/run/user/${uid}/bus` : null
  for (const candidate of raw.split(';')) {
    const trimmed = candidate.trim()
    if (!trimmed.startsWith('unix:')) continue
    for (const pair of trimmed.slice('unix:'.length).split(',')) {
      const [key, ...rest] = pair.split('=')
      const value = rest.join('=')
      if (key === 'path' && value) return value
      if (key === 'abstract' && value) return `\0${value}`
    }
  }
  return null
}

/** SASL EXTERNAL 要求把 uid 的十进制写法再做一次 hex 编码。 */
export function externalAuthLine(uid: number): string {
  return `AUTH EXTERNAL ${Buffer.from(String(uid), 'ascii').toString('hex')}\r\n`
}

/**
 * 问总线:`name` 现在有没有属主。
 * 全程异步,超时或任何异常都会 reject —— 调用方据实当作「服务不可用」,不假装成功。
 */
export function probeBusNameHasOwner(options: {
  name: string
  socketPath: string
  uid: number
  timeoutMs: number
}): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    let socket: Socket | null = null
    let settled = false
    let authorized = false
    let pending = Buffer.alloc(0)
    let helloSerial = 0

    const finish = (error: Error | null, value?: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket?.destroy()
      if (error) reject(error)
      else resolve(value === true)
    }

    const timer = setTimeout(
      () => finish(new Error(`D-Bus 探测超时(${options.timeoutMs}ms)`)),
      options.timeoutMs,
    )

    try {
      socket = connect({ path: options.socketPath })
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
      return
    }

    socket.on('error', (error) => finish(error))
    socket.on('close', () => finish(new Error('D-Bus 连接在拿到结果前被关闭')))

    socket.on('connect', () => {
      // 协议要求先发一个 NUL 字节,再走 SASL 文本握手。
      socket?.write(Buffer.concat([Buffer.from([0]), Buffer.from(externalAuthLine(options.uid), 'ascii')]))
    })

    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])

      if (!authorized) {
        const text = pending.toString('ascii')
        const lineEnd = text.indexOf('\r\n')
        if (lineEnd < 0) return
        const line = text.slice(0, lineEnd)
        if (!line.startsWith('OK ')) {
          finish(new Error(`D-Bus 认证被拒: ${line}`))
          return
        }
        authorized = true
        pending = pending.subarray(lineEnd + 2)
        helloSerial = 1
        socket?.write(Buffer.from('BEGIN\r\n', 'ascii'))
        // Hello 是规范要求的第一条消息,拿到 unique name 之后才能发别的调用。
        socket?.write(encodeMethodCall({
          serial: helloSerial,
          path: '/org/freedesktop/DBus',
          iface: 'org.freedesktop.DBus',
          member: 'Hello',
          destination: 'org.freedesktop.DBus',
        }))
        socket?.write(encodeMethodCall({
          serial: helloSerial + 1,
          path: '/org/freedesktop/DBus',
          iface: 'org.freedesktop.DBus',
          member: 'NameHasOwner',
          destination: 'org.freedesktop.DBus',
          stringArgument: options.name,
        }))
        if (pending.length === 0) return
      }

      for (;;) {
        let message: DecodedMessage | null
        try {
          message = decodeMessage(pending)
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)))
          return
        }
        if (!message) return
        pending = pending.subarray(message.byteLength)
        if (message.replySerial !== helloSerial + 1) continue
        if (message.type === MESSAGE_TYPE_ERROR) {
          finish(new Error(`D-Bus NameHasOwner 返回错误(serial ${message.replySerial})`))
          return
        }
        if (message.type === MESSAGE_TYPE_METHOD_RETURN) {
          if (message.signature !== 'b' || message.body.length < 4) {
            finish(new Error(`D-Bus NameHasOwner 回包格式异常: signature=${message.signature}`))
            return
          }
          finish(null, message.body.readUInt32LE(0) === 1)
          return
        }
      }
    })
  })
}

export type NotificationGate = {
  /** 通知此刻能不能用。Linux 上先确认服务在线,其它平台直接问 Electron。 */
  usable: () => Promise<boolean>
}

export type NotificationGateDeps = {
  platform: NodeJS.Platform
  /** Electron 的 `Notification.isSupported`。Linux 上只在探测为真之后才会被调用。 */
  isSupported: () => boolean
  probe: () => Promise<boolean>
  now?: () => number
  /** 探测判定不可用时回调一次,用于记日志 —— ❌ 不静默吞掉。 */
  onUnavailable?: (reason: string) => void
  cacheTtlMs?: number
}

/**
 * 通知可用性的缓存门。
 *
 * 单飞:热路径上每条聊天消息都会问一次,不能每次都开一条 socket。
 * TTL:通知守护进程可能中途起来或退出,所以缓存会过期重探,不永久钉死。
 */
export function createNotificationGate(deps: NotificationGateDeps): NotificationGate {
  const ttl = deps.cacheTtlMs ?? PROBE_CACHE_TTL_MS
  const now = deps.now ?? (() => Date.now())
  let cachedAt = 0
  let cached: boolean | null = null
  let inFlight: Promise<boolean> | null = null

  async function linuxServiceOnline(): Promise<boolean> {
    if (cached !== null && now() - cachedAt < ttl) return cached
    if (inFlight) return inFlight
    inFlight = deps
      .probe()
      .then((online) => {
        if (!online) deps.onUnavailable?.(`会话总线上没有 ${NOTIFICATION_BUS_NAME} 的属主`)
        return online
      })
      .catch((error: unknown) => {
        // 探不出来就当不可用并留痕:此时去碰同步 API 正是会冻住主线程的那条路。
        deps.onUnavailable?.(`探测失败: ${error instanceof Error ? error.message : String(error)}`)
        return false
      })
      .then((online) => {
        cached = online
        cachedAt = now()
        inFlight = null
        return online
      })
    return inFlight
  }

  return {
    async usable(): Promise<boolean> {
      if (deps.platform !== 'linux') return deps.isSupported()
      if (!(await linuxServiceOnline())) return false
      return deps.isSupported()
    },
  }
}
