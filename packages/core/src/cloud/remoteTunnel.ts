/**
 * 远程隧道(只经咕咕云连着、没从这台电脑经 SSH 装的机器)—— 开放。
 *
 * owner 2026-09-25 先关:「要不远程隧道能力先不开放吧,我没想到我们目前用 supabase 实现不了还需要额外依赖」;
 * 2026-10-15 要求打开:「按理说这个功能应该先被启用,才能考虑在这个 agent 设备上去连云 agent」。
 * 缺的那一条中转 = frp(调研结论,见 design notes):终端、浏览器、端口经它到那台机器。
 *
 * 一条路(照 VS Code 远程隧道 / Coder:中转只搬字节,里面跑 SSH):
 *  · 那台机器(咕咕 server 的账号进程)起一个只认咕咕钥匙的 SSH 服务端(只听本机回环),由 frpc 以 stcp 挂到中转上;
 *  · 这台电脑问它要「怎么连」(设备 RPC `tunnel.open`,走咕咕云那条只有本人进得去的频道),顺带登记自己的公钥;
 *  · 这台电脑起 frpc 访问端,ssh 经它连过去 —— 之后与远程 SSH 的机器同一套:设备连接、终端、端口转发、浏览器。
 * 中转看到的只有 SSH 密文;stcp 的密钥每次起进程随机生成、只经那条频道交给本人。
 */
export const REMOTE_TUNNEL_OPEN = true

/** 服务器上「还没账号 / 登录失效了,怎么办」那一句里的动作。 */
export const SERVER_LOGIN_ACTION = REMOTE_TUNNEL_OPEN
  ? '执行 gugu-server login'
  : '在咕咕桌面「设置 → 设备 → 添加一台机器」用远程 SSH 添加这台机器'

// ── 中转在哪 ───────────────────────────────────────────────────────────────────

/**
 * 一个 frps:地址、端口、令牌。令牌随客户端发出去,等于公开值 —— 隔离靠 stcp 密钥与里面那层 SSH。
 * protocol = 'wss':frps 部署在反向代理后面(443),frpc 经 TLS + WebSocket
 * 连过去 —— 不另开端口、出网只要 443;缺席 = frp 自己的 TCP 端口。
 */
export type RelayEndpoint = { serverAddr: string; serverPort: number; token: string; protocol?: 'wss' }

const RELAY_HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/
const RELAY_TOKEN = /^[A-Za-z0-9._~-]{1,128}$/

/**
 * `frp://<令牌>@<主机>:<端口>`(frp 自己的 TCP 端口)或 `frp+wss://<令牌>@<主机>[:<端口>]`(nginx 后面,端口缺省 443)
 * → RelayEndpoint。一库一中转(与一库一网关同一条规矩):构建时按库烘进去,开发时可由环境变量 GUGU_RELAY_URL 覆盖。
 * 看不懂 = null(❌ 猜一个默认中转)。纯函数。
 */
export function parseRelayUrl(value: string | null | undefined): RelayEndpoint | null {
  const text = value?.trim()
  if (!text) return null
  const match = text.match(/^frp(\+wss)?:\/\/([^@/]+)@([^:/]+)(?::(\d{1,5}))?\/?$/)
  if (!match) return null
  const [, wss, token, host, portText] = match
  // frp 自己的端口没有约定俗成的缺省,❌ 猜;wss 走 nginx 的 443。
  if (!portText && !wss) return null
  const port = portText ? Number(portText) : 443
  if (!RELAY_TOKEN.test(token) || !RELAY_HOST.test(host) || !Number.isInteger(port) || port <= 0 || port >= 65536) return null
  return { serverAddr: host, serverPort: port, token, ...(wss ? { protocol: 'wss' as const } : {}) }
}

declare const __GUGU_RELAY_URL__: string | undefined

/** 这个构建连哪个中转:环境变量优先(开发、测试),其次构建时烘进去的那一份;都没有 = 不开远程隧道的终端。 */
export function resolveRelayEndpoint(env: NodeJS.ProcessEnv = process.env): RelayEndpoint | null {
  const baked = typeof __GUGU_RELAY_URL__ !== 'undefined' ? __GUGU_RELAY_URL__ : ''
  return parseRelayUrl(env.GUGU_RELAY_URL || baked)
}

// ── 设备 RPC:tunnel.open ───────────────────────────────────────────────────────

export const TUNNEL_OPEN_RPC_TYPE = 'tunnel.open'

/** 这台电脑交过去的:自己那把咕咕钥匙的公钥(`ssh-ed25519 AAAA… 注释`)。 */
export type TunnelOpenRequest = { publicKey: string }

/** 那台机器答的:经哪个中转、找哪个 stcp、用什么密钥;它 SSH 服务端的主机公钥;登哪个用户。 */
export type TunnelOpenResponse = {
  relay: RelayEndpoint & { user: string; serverName: string; secretKey: string }
  /** `ssh-ed25519 AAAA…`(不带注释),写进这台电脑自己的 known_hosts,严格核对。 */
  hostKey: string
  sshUser: string
}

const KEY_TYPE = /^(ssh-ed25519|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|ssh-rsa)$/
const KEY_BLOB = /^[A-Za-z0-9+/]+={0,2}$/
const NAME = /^[A-Za-z0-9_.-]{1,128}$/

/** `类型 base64 [注释]` → `类型 base64`;形状不对 = null。纯函数。 */
export function normalizeOpenSshPublicKey(text: unknown): string | null {
  if (typeof text !== 'string' || text.length > 16_384) return null
  const [type, blob] = text.trim().split(/\s+/)
  if (!type || !blob || !KEY_TYPE.test(type) || !KEY_BLOB.test(blob)) return null
  return `${type} ${blob}`
}

export function parseTunnelOpenRequest(payload: unknown): TunnelOpenRequest | null {
  const publicKey = normalizeOpenSshPublicKey((payload as { publicKey?: unknown } | null)?.publicKey)
  return publicKey ? { publicKey } : null
}

export function parseTunnelOpenResponse(value: unknown): TunnelOpenResponse | null {
  const v = value as Partial<TunnelOpenResponse> | null
  const relay = v?.relay as Partial<TunnelOpenResponse['relay']> | undefined
  if (!v || !relay) return null
  // protocol 只认缺席(老 server 的应答 = frp 自己的端口)与 'wss';别的值 = 这台电脑看不懂的连法,❌ 当成 TCP 去连。
  if (relay.protocol !== undefined && relay.protocol !== 'wss') return null
  const scheme = relay.protocol === 'wss' ? 'frp+wss' : 'frp'
  const endpoint = parseRelayUrl(`${scheme}://${String(relay.token)}@${String(relay.serverAddr)}:${String(relay.serverPort)}`)
  const hostKey = normalizeOpenSshPublicKey(v.hostKey)
  if (!endpoint || !hostKey) return null
  if (typeof relay.user !== 'string' || !NAME.test(relay.user)) return null
  if (typeof relay.serverName !== 'string' || !NAME.test(relay.serverName)) return null
  if (typeof relay.secretKey !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(relay.secretKey)) return null
  if (typeof v.sshUser !== 'string' || !NAME.test(v.sshUser)) return null
  return { relay: { ...endpoint, user: relay.user, serverName: relay.serverName, secretKey: relay.secretKey }, hostKey, sshUser: v.sshUser }
}

// ── 心跳随行报的「中转通着」 ───────────────────────────────────────────────────

let relayUp = false
const relayListeners = new Set<(up: boolean) => void>()

/** 账号进程的远程隧道端点报:frpc 把 stcp 挂上中转了 / 掉了。心跳据此报 capabilities.tunnel_relay。 */
export function setTunnelRelayUp(up: boolean): void {
  if (relayUp === up) return
  relayUp = up
  for (const listener of [...relayListeners]) listener(up)
}

export function tunnelRelayUp(): boolean {
  return relayUp
}

export function onTunnelRelayChange(listener: (up: boolean) => void): () => void {
  relayListeners.add(listener)
  return () => relayListeners.delete(listener)
}

// ── 心跳随行报的「隧道最近一次有流量」 ─────────────────────────────────────────
//
// 云电脑的管家据此判「在用」:最近 10 分钟有人在用就不自动睡。「在用」是白名单(总控 2026-10-15 定),只认人在用的:
//   · 端口转发(页面预览 / 端口)上的任何字节;
//   · 终端的输入与输出(设备连接上的 pty.sendInput / pty:data,判定在 electron/server/device-link-host.ts);
//   · 明确的人类交互由服务直接调 noteTunnelActivity。
// ❌ 别的都不算:心跳、状态轮询、刚连上的订阅与打开、机器推来的变动 —— 那是「光连着」,算了机器就永远醒着、一直计费
// (10-15 实测:状态轮询和机器推的 files:changes 曾把没人用的云电脑一直顶着醒)。
// 新加一个要人在用、又走隧道的功能:把它的输入加进白名单或在服务里调 noteTunnelActivity,漏了的代价是机器会睡 —— 看得见。
// 心跳每 30 秒一次,随行带上最近那一刻;账号进程起来之后还没有过 = 不报。

let activeAtMs: number | null = null

/** 隧道 / 直连上刚有一笔真流量(调用很频繁:只记一个数)。 */
export function noteTunnelActivity(nowMs: number = Date.now()): void {
  if (activeAtMs === null || nowMs > activeAtMs) activeAtMs = nowMs
}

/** 最近一次真流量的时刻(ISO,UTC);还没有过 = null。 */
export function tunnelActiveAt(): string | null {
  return activeAtMs === null ? null : new Date(activeAtMs).toISOString()
}

/** 测试用。 */
export function resetTunnelActivityForTest(): void {
  activeAtMs = null
}
