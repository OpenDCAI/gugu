/**
 * 咕咕 server 的登录态:主进程自己持有、自己续期(没有渲染进程可问)。
 *
 * 会话密文落在 `<userData>/server-session.enc`,用 safeStorage 加密(server 替身的实现是本机密钥文件 +
 * AES-256-GCM,见 session/headless/electron-shim.ts)。续期复用 core 的 createRefreshingRuntimeAuthProvider ——
 * 附加账号 host 已经在用的同一份,GoTrue 一次性轮换、唯一刷新者这些规矩都在里面。
 *
 * 这个进程只在账号有登录态时才被守护进程拉起(server-supervisor.ts);登录失效时 getAuth() 返回 null,
 * 进程随即退出,等人重新 `gugu-server login`。
 */
import fs from 'node:fs'
import path from 'node:path'
import { app, safeStorage } from 'electron'
import {
  createRefreshingRuntimeAuthProvider,
  userIdFromSupabaseAccessToken,
  type RuntimeAuth,
  type RuntimeAuthProvider,
} from '@gugu/core'
import { clearSignedOutMark, writeSignedOutMark } from './server-layout'
import { createLogger } from '../lib/logger'

const log = createLogger('server/auth')

export type ServerSessionTokens = { accessToken: string; refreshToken: string }

export type ServerAuthProvider = RuntimeAuthProvider & {
  invalidate: () => void
  /** 登录成功(短码确认完成)后装入新会话;同时持久化。 */
  adopt: (tokens: ServerSessionTokens) => Promise<string>
  /** 当前是否已登录(只看手上有没有会话,不发网络请求)。 */
  signedInUserId: () => string | null
  signOut: () => Promise<void>
  /**
   * #6264 账号主人在「设置 → 设备」里移除了这台机器:先向 GoTrue 注销这台 server 自己的会话
   * (续期令牌作废;移除那一侧通常已经吊销过,这里再做一次是兜底),再清掉本地登录态。
   * 与 `gugu-server logout` 一样只删登录态,这个账号的会话记录、任务库留着 —— 同一个人再登录,东西都还在。
   */
  revokeAndSignOut: () => Promise<void>
}

function sessionPath(): string {
  return path.join(app.getPath('userData'), 'server-session.enc')
}

export function readStoredServerSession(): ServerSessionTokens | null {
  const file = sessionPath()
  if (!fs.existsSync(file)) return null
  const plain = safeStorage.decryptString(fs.readFileSync(file))
  const parsed = JSON.parse(plain) as Partial<ServerSessionTokens>
  if (typeof parsed.accessToken !== 'string' || typeof parsed.refreshToken !== 'string') {
    throw new Error(`server 会话文件格式不对: ${file}`)
  }
  return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken }
}

/**
 * #6264 下一次续期要写的那个文件,**续期之前**就占好盘上的位置。
 *
 * GoTrue 的续期令牌用一次就作废。以前的顺序是「先续期、再落盘」:盘满时落盘失败被当成暂时性错误吞掉,
 * 新令牌只活在内存里,盘上那枚已经作废 —— 进程一重启(崩溃、升级、机器重启)这台机器就被永久登出。
 * 现在反过来:先把这个文件按 {@link SESSION_SLOT_BYTES} 写满零并 fsync(占住数据块),占不到就**不续期**
 * (访问令牌还没过期就接着用;过期了机器暂时连不上云,但盘上那枚续期令牌仍然有效,腾出空间就恢复)。
 * 续期拿到新令牌后覆盖写进这些已分配的块、截到实际长度、再改名成正式文件 —— 覆盖已分配的块不需要新空间。
 */
export const SESSION_SLOT_BYTES = 16 * 1024

const slotPath = (): string => `${sessionPath()}.next`

export function reserveSessionSlot(): void {
  const slot = slotPath()
  try {
    if (fs.statSync(slot).size >= SESSION_SLOT_BYTES) return
  } catch {
    // 还没有,下面建
  }
  fs.mkdirSync(path.dirname(slot), { recursive: true })
  const fd = fs.openSync(slot, 'w', 0o600)
  try {
    fs.writeSync(fd, Buffer.alloc(SESSION_SLOT_BYTES))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

export function writeStoredServerSession(tokens: ServerSessionTokens): void {
  const file = sessionPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // 写进预先占好的那个文件(没有就现建),再改名:续期写到一半断电,不能留下一个解不开的会话文件(那等于被登出)。
  const slot = slotPath()
  const data = safeStorage.encryptString(JSON.stringify(tokens))
  let fd: number
  try {
    fd = fs.openSync(slot, 'r+')
  } catch {
    fd = fs.openSync(slot, 'w', 0o600)
  }
  try {
    fs.writeSync(fd, data, 0, data.length, 0)
    fs.ftruncateSync(fd, data.length)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.chmodSync(slot, 0o600)
  fs.renameSync(slot, file)
}

/**
 * 续期后的新令牌落盘:写不进就留在手上,每 {@link PERSIST_RETRY_MS} 再试一次、进程退出前再试最后一次,
 * 直到写进去为止 —— ❌ 当成暂时性错误吞掉(那样盘上永远是作废的那一枚)。
 */
export const PERSIST_RETRY_MS = 30_000

export function createSessionPersister(deps: {
  write: (tokens: ServerSessionTokens) => void
  onFailure: (error: unknown) => void
  onRecovered: () => void
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void }
  clearTimer?: (handle: unknown) => void
}): { persist: (tokens: ServerSessionTokens) => void; flush: () => void; pending: () => boolean } {
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setInterval(fn, ms))
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearInterval(handle as NodeJS.Timeout))
  let pending: ServerSessionTokens | null = null
  let timer: { unref?: () => void } | null = null
  const attempt = (): boolean => {
    if (!pending) return true
    try {
      deps.write(pending)
    } catch (error) {
      deps.onFailure(error)
      return false
    }
    pending = null
    if (timer) {
      clearTimer(timer)
      timer = null
    }
    deps.onRecovered()
    return true
  }
  return {
    persist(tokens) {
      const wasPending = pending !== null
      pending = tokens
      if (attempt()) return
      if (!wasPending && !timer) {
        timer = setTimer(() => void attempt(), PERSIST_RETRY_MS)
        timer.unref?.()
      }
    },
    flush: () => void attempt(),
    pending: () => pending !== null,
  }
}

export function clearStoredServerSession(): void {
  fs.rmSync(sessionPath(), { force: true })
  fs.rmSync(slotPath(), { force: true })
}

export function createServerAuthProvider(input: {
  supabaseUrl: string
  anonKey: string
  onAuthExpired: (message: string) => void
}): ServerAuthProvider {
  let current: { provider: RuntimeAuthProvider; userId: string } | null = null
  let recovered = true
  const persister = createSessionPersister({
    write: writeStoredServerSession,
    onFailure: (error) => {
      recovered = false
      // 不带令牌,只说事实与后果:这里的日志会被人贴出去排查。
      log.error({ code: (error as NodeJS.ErrnoException).code ?? String(error) }, '续期后的登录态写不进磁盘,30 秒后重试;腾出磁盘空间前不要重启这台机器上的咕咕 server')
    },
    onRecovered: () => {
      if (!recovered) log.info('登录态已写进磁盘')
      recovered = true
    },
  })
  process.on('exit', () => persister.flush())

  const install = (tokens: ServerSessionTokens): string => {
    const userId = userIdFromSupabaseAccessToken(tokens.accessToken)
    if (!userId) throw new Error('登录令牌里没有用户 id(sub)')
    const provider = createRefreshingRuntimeAuthProvider({
      supabaseUrl: input.supabaseUrl,
      anonKey: input.anonKey,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expectedUserId: userId,
      // 每次轮换都落盘:GoTrue 的续期令牌用一次就作废,重启后拿旧的去续 = 永久登出。
      // #6264 续期前先占好盘上的位置(占不到就先不续期),续期后写不进就一直重试,见上面两段。
      beforeRefresh: reserveSessionSlot,
      onTokens: (next) => persister.persist(next),
      onAuthExpired: (error) => {
        clearStoredServerSession()
        // 记下「为什么不登着了」:`gugu-server status` 与经 SSH 来问的桌面据此说「登录已失效,去重新登录」,❌ 只显示离线。
        markSignedOut('expired')
        current = null
        input.onAuthExpired(error.message)
      },
    })
    current = { provider, userId }
    return userId
  }

  const stored = readStoredServerSession()
  if (stored) install(stored)

  return {
    invalidate() {},
    async getAuth(): Promise<RuntimeAuth | null> {
      return current ? current.provider.getAuth() : null
    },
    async adopt(tokens) {
      writeStoredServerSession(tokens)
      clearSignedOutMark(app.getPath('userData'))
      return install(tokens)
    },
    signedInUserId: () => current?.userId ?? null,
    async signOut() {
      clearStoredServerSession()
      current = null
    },
    async revokeAndSignOut() {
      const auth = current ? await current.provider.getAuth().catch(() => null) : null
      if (auth?.accessToken) {
        await fetch(`${input.supabaseUrl.replace(/\/$/, '')}/auth/v1/logout?scope=local`, {
          method: 'POST',
          headers: { apikey: input.anonKey, authorization: `Bearer ${auth.accessToken}` },
          signal: AbortSignal.timeout(10_000),
        }).catch(() => undefined)
      }
      clearStoredServerSession()
      markSignedOut('removed')
      current = null
    },
  }
}

function markSignedOut(reason: 'expired' | 'removed'): void {
  try {
    writeSignedOutMark(app.getPath('userData'), reason)
  } catch {
    // 记不下只是少一句解释(磁盘满之类);登出本身已经完成
  }
}
