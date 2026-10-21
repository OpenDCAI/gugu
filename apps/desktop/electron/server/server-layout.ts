/**
 * 咕咕 server 的目录布局(product spec 第 7 条:一台服务器多人各自登录,含共用同一个 Linux 账号)。
 *
 *   <GUGU_SERVER_HOME>/                 默认 ~/.gugu-server
 *     versions/<版本>/  current  channel   安装与升级(install.sh / server-updater.ts)
 *     data/                              守护进程自己的:日志、单实例锁、CA 证书兜底
 *     accounts/<咕咕账号 id>/
 *       account.json                     明文的「这是谁」(给 status 看,不含任何凭据)
 *       data/                            这个账号的全部状态:登录态(加密)、任务库、日志
 *       home/                            这个账号的 GUGU_HOME:agent 名册、影子 agent home
 *
 * 每个账号一个独立进程、独立目录:两个人共用一个 Linux 用户,他们的会话、agent、任务库互不相见;
 * 一个人退出登录不影响另一个。登录态存在即「这个账号在这台机器上」。
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { parseServerConnectVia, SERVER_CONNECT_VIA_FILE } from '@gugu/core/cloud/serverConnectVia'
import type { DeviceConnectVia } from '@gugu/core/shared/types/deviceHost'

export type ServerAccount = {
  userId: string
  email: string | null
  addedAt: string | null
  dir: string
  dataDir: string
  homeDir: string
  signedIn: boolean
  /** 不是自己退出的、而是被迫登出的:登录失效 / 这台机器被从账号里移除了(见 SignedOutMark)。 */
  signedOut: SignedOutMark | null
}

/**
 * #6264 这个账号为什么不在这台机器上登着了 —— 只记「被迫」的两种,自己 `gugu-server logout` 的不记。
 *  · expired:续期令牌被拒(在别处退出了所有设备、改了密码、令牌作废);
 *  · removed:有人在「设置 → 设备」里把这台机器从账号里移除了。
 * 照 VS Code Tunnels / Tailscale:离线的机器要说清是「没开机」还是「登录没了」,后者告诉人去那台机器上重新登录。
 * `gugu-server status` 打出来,桌面经 SSH 读它;重新登录成功即删掉。
 */
export type SignedOutMark = { reason: 'expired' | 'removed'; at: string }

export const SIGNED_OUT_FILE = 'signed-out.json'

export function readSignedOutMark(dataDir: string): SignedOutMark | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dataDir, SIGNED_OUT_FILE), 'utf8')) as Partial<SignedOutMark>
    if ((value.reason === 'expired' || value.reason === 'removed') && typeof value.at === 'string') {
      return { reason: value.reason, at: value.at }
    }
  } catch {
    // 没有 = 没被迫登出过
  }
  return null
}

export function writeSignedOutMark(dataDir: string, reason: SignedOutMark['reason'], at: Date = new Date()): void {
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, SIGNED_OUT_FILE), `${JSON.stringify({ reason, at: at.toISOString() })}\n`, { mode: 0o600 })
}

export function clearSignedOutMark(dataDir: string): void {
  fs.rmSync(path.join(dataDir, SIGNED_OUT_FILE), { force: true })
}

export function serverHome(): string {
  const home = process.env.GUGU_SERVER_HOME
  if (!home) throw new Error('GUGU_SERVER_HOME 未设置(应由 server 入口设置)')
  return home
}

export const supervisorDataDir = (): string => path.join(serverHome(), 'data')
export const accountsDir = (): string => path.join(serverHome(), 'accounts')
export const accountDir = (userId: string): string => path.join(accountsDir(), userId)
export const accountDataDir = (userId: string): string => path.join(accountDir(userId), 'data')
export const accountHomeDir = (userId: string): string => path.join(accountDir(userId), 'home')
/** 登录态文件名与 server-auth.ts 的 sessionPath() 一致(那边按当前进程的 userData 拼)。 */
export const SESSION_FILE = 'server-session.enc'

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function listAccounts(): ServerAccount[] {
  let names: string[]
  try {
    names = fs.readdirSync(accountsDir())
  } catch {
    return []
  }
  return names
    .filter((name) => USER_ID.test(name))
    .map((userId) => {
      let meta: { email?: unknown; addedAt?: unknown } = {}
      try {
        meta = JSON.parse(fs.readFileSync(path.join(accountDir(userId), 'account.json'), 'utf8'))
      } catch {
        meta = {}
      }
      return {
        userId,
        email: typeof meta.email === 'string' ? meta.email : null,
        addedAt: typeof meta.addedAt === 'string' ? meta.addedAt : null,
        dir: accountDir(userId),
        dataDir: accountDataDir(userId),
        homeDir: accountHomeDir(userId),
        signedIn: fs.existsSync(path.join(accountDataDir(userId), SESSION_FILE)),
        signedOut: readSignedOutMark(accountDataDir(userId)),
      }
    })
    .sort((a, b) => (a.addedAt ?? '').localeCompare(b.addedAt ?? ''))
}

export function writeAccountMeta(userId: string, email: string | null): void {
  fs.mkdirSync(accountDir(userId), { recursive: true })
  const file = path.join(accountDir(userId), 'account.json')
  let addedAt = new Date().toISOString()
  try {
    const previous = JSON.parse(fs.readFileSync(file, 'utf8')) as { addedAt?: unknown }
    if (typeof previous.addedAt === 'string') addedAt = previous.addedAt
  } catch {
    // 第一次登录这个账号
  }
  fs.writeFileSync(file, `${JSON.stringify({ userId, email, addedAt }, null, 2)}\n`)
}

/** 把一个账号的进程环境指到它自己的目录(在加载主进程之前调用)。 */
export function applyAccountEnv(userId: string, env: NodeJS.ProcessEnv = process.env): void {
  env.GUGU_SERVER_ACCOUNT = userId
  env.GUGU_TASK_HOST_USER_DATA = accountDataDir(userId)
  env.GUGU_HOME = accountHomeDir(userId)
  // tmux 按账号分 socket:同一个 Linux 用户下两个账号各有各的 tmux 服务端,
  // 一个账号回收孤儿会话时碰不到另一个账号的终端。
  env.GUGU_TMUX_SOCKET_LABEL = `${ACCOUNT_TMUX_LABEL_PREFIX}${userId.slice(0, 8)}`
}

const ACCOUNT_TMUX_LABEL_PREFIX = 'gugu-server-'

/**
 * 账号被主人从「设置 → 设备」移除:结束这个账号的 tmux 服务端,里面还在跑的 agent 与终端一并结束。
 * ❌ 普通退出登录不调 —— 那时保留会话是有意的(重新登录接着用)。只动这个账号自己的 socket(applyAccountEnv 定的那个),
 * 同一个 Linux 用户下别的账号、用户自己的 tmux 都不碰。没有服务端在跑 = 本来就干净,不算失败。
 */
export async function killAccountTmuxServer(
  env: NodeJS.ProcessEnv,
  run: (command: string, args: string[]) => Promise<unknown> = (command, args) => promisify(execFile)(command, args, { timeout: 10_000 }),
): Promise<boolean> {
  const label = env.GUGU_TMUX_SOCKET_LABEL?.trim()
  if (!label?.startsWith(ACCOUNT_TMUX_LABEL_PREFIX)) return false
  await run(env.GUGU_TMUX_BIN?.trim() || 'tmux', ['-L', label, 'kill-server']).catch(() => undefined)
  return true
}

/** 从 Supabase access token 里读 email(只用于显示;缺省 null)。 */
export function emailFromAccessToken(accessToken: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
      email?: unknown
    }
    return typeof payload.email === 'string' && payload.email ? payload.email : null
  } catch {
    return null
  }
}

/** 子进程每 10 秒写一次忙闲;超过这么久没写,当它不存在(卡死的进程不该永远挡住升级)。 */
const ACTIVITY_STALE_MS = 60_000

/** 这个账号的子进程写下的忙闲(见 main.ts 的 server 分支):有 agent 在跑一轮或等人批准。 */
export function accountIsBusy(dataDir: string, now = Date.now()): boolean {
  try {
    const activity = JSON.parse(fs.readFileSync(path.join(dataDir, 'activity.json'), 'utf8')) as {
      busy?: unknown
      at?: unknown
    }
    return activity.busy === true && typeof activity.at === 'number' && now - activity.at < ACTIVITY_STALE_MS
  } catch {
    return false
  }
}

/**
 * #6264 这个账号是怎么登上这台机器的(远程 SSH / 远程隧道,见 core/cloud/serverConnectVia.ts)。
 * 登录时写;`onlyIfUnknown`:老机器第一次被装它的那台桌面经 SSH 接上时补记,已经记着的(哪怕是远程隧道)不改。
 * @returns 这次写没写。
 */
export function writeServerConnectVia(
  dataDir: string,
  via: DeviceConnectVia,
  options: { onlyIfUnknown?: boolean; at?: Date; name?: string | null } = {},
): boolean {
  const file = path.join(dataDir, SERVER_CONNECT_VIA_FILE)
  if (options.onlyIfUnknown) {
    let existing: string | null = null
    try {
      existing = fs.readFileSync(file, 'utf8')
    } catch {
      existing = null
    }
    if (parseServerConnectVia(existing)) return false
  }
  fs.mkdirSync(dataDir, { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify({ via, at: (options.at ?? new Date()).toISOString(), ...(options.name ? { name: options.name } : {}) })}\n`, { mode: 0o600 })
  fs.renameSync(tmp, file)
  return true
}
