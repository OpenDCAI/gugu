import type { HumanAuthSession } from '@gugu/core'
import { isAuthRetryableFetchError, type Session, type User } from '@supabase/supabase-js'
import { hydrateIdentityAuthUser } from './auth'
import { setRejectedAccessTokenRecovery } from './authBoundedFetch'
import { abortAuthSessionBoundary, keepAuthSessionBoundary, resetAuthSessionBoundary } from './authSessionLoss'
import { publishRendererSession } from './sessionPublication'
import { MAIN_AUTH_STORAGE_KEY, mainAuthSessionStorage, supabase } from './supabase'
import { phoneHostAuthAvailable, phoneHostGetSession, phoneHostRefreshSession, phoneHostRestoreSession, phoneHostSignOut, setPhoneHostAuthHandoffBarrier } from './phoneHostAuth'
import { platform } from '../platform'
import type { AuthUser } from '../store/auth'

export type SessionCoordinatorStatus = 'boot-restoring' | 'authenticated' | 'degraded' | 'anonymous' | 'expired'
export type SessionCoordinatorSnapshot = { status: SessionCoordinatorStatus; session: Session | null; user: AuthUser | null; error: Error | null }
export interface SessionCoordinatorDeps {
  getSession: () => Promise<{ data: { session: Session | null }; error: unknown }>
  getUser: (accessToken: string) => Promise<{ data: { user: User | null }; error: unknown }>
  refreshSession: (session: { refresh_token: string }) => Promise<{ data: { session: Session | null }; error: unknown }>
  restoreSession: (session: { access_token: string; refresh_token: string }) => Promise<{ data: { session: Session | null }; error: unknown }>
  onAuthStateChange: (listener: (event: string, session: Session | null) => void) => { data: { subscription: { unsubscribe: () => void } } }
  signOut: () => Promise<{ error: unknown; signedOutSession?: Session }>
  hydrateUser: (user: User, signal: AbortSignal) => Promise<AuthUser | null>
  publishSession: (event: string, session: Session | null) => void
  writeMirror: (session: Session) => Promise<void>
  clearMirror: (reason: 'signed-out' | 'lost') => Promise<void>
  getPersistedSessionState: () => { bootCandidate: Session | null; warning: Error | null }
  commitPersistedSession: (session: Session, signal: AbortSignal) => Promise<void>
  clearPersistedSession: (session: Session, signal: AbortSignal) => Promise<void>
  subscribeAppForeground: (listener: () => void, onError: (error: unknown) => void) => () => void
}

type RetryPurpose = 'restore' | 'validate' | 'refresh' | 'recovery' | 'terminal-storage' | 'mirror'
type Work = { generation: number; userId?: string; accessToken?: string; refreshToken?: string }
type TerminalPlan = { generation: number; session: Session | null; status: 'anonymous' | 'expired'; event: string }
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000]
const PROFILE_TIMEOUT_MS = 15_000
// @@@3916 「一次 auth 操作最多等多久」由**我们自己**命名并拥有。
//
// 此前这件事是被 supabase-js 的取锁超时(默认 5s)顺手决定的:启动时 getSession 等锁,靠那条超时
// 快速失败才走到 degrade、渲染出降级外壳。那个数字不是我们定的、不表达我们的意图、升级库就可能变
// —— 把它当成前提本身就是缺陷。有了这条显式预算之后:
//   · 超预算 → 我们自己 degrade(意图明确、可读、可测);
//   · 库那条取锁超时不再承重 ⇒ 取锁可以不设超时 ⇒ 那条会 reject 却无人 await 的 promise 根本不产生,
//     #3916 的未捕获异常随之消失。
// 也就是说:**每个持锁方都被我们自己的预算兜住,所以「取锁不设超时」是由构造保证安全的,不是靠运气。**
const AUTH_CALL_TIMEOUT_MS = 15_000
// 启动是**另一件事**,不该跟一般 auth 调用共用一个数:此刻我们手上已经有 boot candidate 可以渲染,
// 多等一秒买不到任何东西,只会让用户多盯一秒转圈。所以启动的预算显著更短,且理由写在这里 ——
// ❌ 它不是「随手挑的 5 秒」,是「等下去没有收益」这句话的数值形式。
const BOOT_RESTORE_TIMEOUT_MS = 5_000

class AuthCallTimeoutError extends Error {
  override name = 'AuthCallTimeoutError'
  constructor(label: string, ms: number) { super(`${label} exceeded ${ms}ms`) }
}

/** 给一次 auth 面调用套上我们自己的预算。Promise.race 会同时订阅两边,所以两条都不会成为无人观察的 rejection。 */
function withAuthBudget<T>(label: string, work: Promise<T>, ms = AUTH_CALL_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const budget = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AuthCallTimeoutError(label, ms)), ms)
  })
  return Promise.race([work, budget]).finally(() => { if (timer !== undefined) clearTimeout(timer) })
}
// @@@refresh-outside-sdk-margin (#6723) — auth-js(2.103.0 的 EXPIRY_MARGIN_MS)每次加载会话时,只要离到期
// 不足 90s 就自己刷新;它的 refreshSession 也先加载会话再刷,落在这 90s 里的一次续期就会变成两次请求
// (第二次拿同一个旧 refresh token,服务端只当重放)。协调器因此必须在 SDK 这道边界**之前**续期:
// 它排程的那一刻,SDK 看到的会话永远还没进边界,刷新只由协调器这一次发出。数据请求不经 SDK 会话,见 supabase.ts。
const AUTH_JS_EXPIRY_MARGIN_MS = 90_000
export const REFRESH_EARLY_MS = AUTH_JS_EXPIRY_MARGIN_MS + 30_000
const PERMANENT_AUTH_CODES = new Set(['session_not_found', 'session_expired', 'refresh_token_not_found',
  'refresh_token_already_used', 'user_not_found', 'user_banned'])

// 服务端不认这张通行证(签名章换了、被提前作废)。它不是「会话没了」—— 刷新凭证照样能换新证 ——
// 也不是「暂时失败」:拿同一张证重试永远不会好(#6338:换章后在线用户卡满一小时、重启也不好)。
function isRejectedAccessToken(value: unknown): boolean {
  if (!value || isAuthRetryableFetchError(value)) return false
  return (value as { code?: string }).code === 'bad_jwt'
}
function subjectOf(accessToken: string): string | null {
  try {
    const payload = accessToken.split('.')[1]
    if (!payload) return null
    const sub = (JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { sub?: unknown }).sub
    return typeof sub === 'string' ? sub : null
  } catch {
    return null
  }
}
function errorOf(value: unknown, fallback: string): Error { return value instanceof Error ? value : new Error(fallback) }
function isPermanentAuthError(value: unknown): boolean {
  if (!value || isAuthRetryableFetchError(value)) return false
  const error = value as { code?: string; name?: string }
  return error.name === 'AuthSessionMissingError' || (typeof error.code === 'string' && PERMANENT_AUTH_CODES.has(error.code))
}
function userFromSession(session: Session): AuthUser {
  const user = session.user
  return { id: user.id, email: user.email ?? '', nickname: '', identityPending: true }
}
function sessionWork(generation: number, session: Session): Work {
  return { generation, userId: session.user.id, accessToken: session.access_token, refreshToken: session.refresh_token }
}

export class SessionCoordinator {
  private snapshot: SessionCoordinatorSnapshot = { status: 'boot-restoring', session: null, user: null, error: null }
  private readonly listeners = new Set<() => void>()
  private readonly retries = new Map<RetryPurpose, { attempt: number; timer: ReturnType<typeof setTimeout> | null }>()
  private subscription: { unsubscribe: () => void } | null = null
  private foregroundUnsubscribe: (() => void) | null = null
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private readonly recoveredAccessTokens = new Set<string>()
  private refreshFlight: Promise<void> | null = null
  private validationFlight: { kind: 'automatic' | 'automatic-with-trailing-foreground' | 'foreground'; work: Work; promise: Promise<void> } | null = null
  private recoveryFlight: Promise<void> | null = null
  private restoring = false
  private terminalFlight: Promise<boolean> | null = null
  private generationAbort = new AbortController()
  private generation = 0
  private logoutWork: Work | null = null
  /** @@@4395 本代已请求过登出;用来认领那条迟到的 SIGNED_OUT(见 logout / handleAuthChange)。 */
  private signOutRequested: Work | null = null
  private interactiveAttempt = 0
  private mirrorVersion = 0
  private mirrorTail: Promise<void> = Promise.resolve()
  private active = false
  private readonly authHandoffs = new Set<Promise<void>>()

  constructor(private readonly deps: SessionCoordinatorDeps) {}
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  getSnapshot = (): SessionCoordinatorSnapshot => this.snapshot
  captureAuthHandoff = (): Promise<unknown> => Promise.all([...this.authHandoffs])
  private beginAuthHandoff(): () => void {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => { finish = resolve })
    this.authHandoffs.add(pending)
    return () => { this.authHandoffs.delete(pending); finish() }
  }
  start(): () => void {
    if (this.active) return () => this.stop()
    this.active = true
    this.subscription = this.deps.onAuthStateChange((event, session) => {
      void this.handleAuthChange(event, session).catch((error) => {
        if (this.active) this.degrade(errorOf(error, 'Auth state reconciliation failed'))
      })
    }).data.subscription
    this.foregroundUnsubscribe = this.deps.subscribeAppForeground(
      () => { void this.reconcileForeground() },
      (error) => { if (this.active) this.degrade(errorOf(error, 'App foreground subscription failed')) },
    )
    void this.restore()
    return () => this.stop()
  }
  updateUser = (user: AuthUser): void => { if (this.snapshot.session?.user.id === user.id) this.setSnapshot({ ...this.snapshot, user }) }
  getAccessToken(): string | null { return this.snapshot.session?.access_token ?? null }
  /**
   * #5025 「还不知道是谁」与「没人登录」必须是两个答案。
   *
   * 只看会话快照的问法对这两件事都返回 `null`,而主进程的开机归属过滤把 `null` 当成「不知道 ⇒ 全放行」。
   * 于是 boot-restoring 期间问一次,拿到的是一个**看起来正常、实际上错**的答案:过滤静默失效,日志照常打
   * 「已重注册 N 条」。真机 29 次冷启动实测,那条 race 中位 1.7s,一次都没触发超时 —— 坏的从来不是等待
   * 时长,是答案本身。所以这里不返回快照,而是**等状态定下来**再答,并把「定没定」跟归属一起交出去。
   *
   * 预算用完仍未定 ⇒ 如实回 `decided:false`,由调用方决定怎么兜底,❌ 不假装是「没登录」。
   */
  waitForDecidedOwner(waitMs: number): Promise<{ decided: boolean; userId: string | null }> {
    const read = () => {
      if (this.snapshot.status !== 'boot-restoring')
        return { decided: true, userId: this.snapshot.session?.user.id ?? null }
      // 恢复还没落地,但「上一次是谁」在启动那一刻就已经从持久化里同步读出来了(boot candidate)。
      // 归属判断问的正是这个,所以拿它直接作答,❌ 不必等一次网络刷新。
      // 拿它作答是安全的:候选若最终恢复失败,应用就是登出态,那时本来也不该按任何账号注册。
      const candidate = this.deps.getPersistedSessionState().bootCandidate
      if (candidate) return { decided: true, userId: candidate.user.id }
      // 没有候选 ⇒ 没有要恢复的东西,restore 很快会落到 anonymous。此时才真的「还不知道」。
      return { decided: false, userId: null }
    }
    const first = read()
    if (first.decided) return Promise.resolve(first)
    return new Promise((resolve) => {
      let unsubscribe: (() => void) | null = null
      let timer: ReturnType<typeof setTimeout> | null = null
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        if (timer !== null) clearTimeout(timer)
        unsubscribe?.()
        resolve(read())
      }
      timer = setTimeout(finish, Math.max(0, waitMs))
      unsubscribe = this.subscribe(() => { if (this.snapshot.status !== 'boot-restoring') finish() })
    })
  }

  beginInteractiveLogin(): number { return ++this.interactiveAttempt }
  acceptInteractiveSession(attempt: number, session: Session): Promise<void> {
    if (!this.active || attempt !== this.interactiveAttempt) return Promise.resolve()
    this.interactiveAttempt += 1
    return this.acceptSession('SIGNED_IN', session, true)
  }

  logout(): Promise<{ success: boolean }> {
    const release = this.beginAuthHandoff()
    return this.performLogout().finally(release)
  }
  private async performLogout(): Promise<{ success: boolean }> {
    const session = this.snapshot.session
    if (!session) return { success: true }
    const work = sessionWork(this.nextGeneration(), session)
    this.logoutWork = work
    abortAuthSessionBoundary()
    // @@@4395 预算只决定「我们还等不等」,**不决定那次调用结束了没有**。withAuthBudget 是 Promise.race,
    // 它不取消底层调用 —— 超时之后 signOut 仍在飞、仍持着 GoTrue 锁(取锁超时已在 #3939 移除)。
    // 此刻若把「这是我们自己要登出」的痕迹一并抹掉,等它真正落地发出 SIGNED_OUT 时就会被
    // handleAuthChange 读成「有人在背后把我们登出了」,进而走 recoverUnexpectedSignOut 去重交凭证。
    // 所以另留一个只跟随**真实落地**的标记,专门用来认领那条迟到的 SIGNED_OUT。
    // ❌ 别把这个标记绑在「调用落地」上:supabase-js 是在 _removeSession() **内部**先通知订阅者、
    // 之后 signOut 才 resolve,绑落地会漏掉那条最关键的 SIGNED_OUT。
    // 认领权只在「超出预算但**仍在飞**」时保留:调用一旦明确失败,它就不会再发 SIGNED_OUT,
    // 此后任何 SIGNED_OUT 都是真的意外签出,必须留给恢复路径(见 P1 probe:rejected signOut)。
    const signOutCall = this.deps.signOut()
    this.signOutRequested = work
    void signOutCall.then(() => {}, () => { if (this.signOutRequested === work) this.signOutRequested = null })
    const result = await withAuthBudget('signOut', signOutCall).catch((error) => ({ error, signedOutSession: undefined }))
    const { error, signedOutSession } = result
    if (error && !(error instanceof AuthCallTimeoutError) && this.signOutRequested === work) this.signOutRequested = null
    if (this.logoutWork === work) this.logoutWork = null
    if (!this.workIsCurrent(work)) return { success: false }
    if (error) {
      resetAuthSessionBoundary()
      this.scheduleRefresh(session)
      this.deps.publishSession('SESSION_RESTORED_AFTER_LOGOUT_FAILURE', session)
      this.degrade(errorOf(error, 'Logout failed'))
      throw errorOf(error, 'Logout failed')
    }
    if (signedOutSession && signedOutSession.user.id !== session.user.id) throw new Error('Signed out session owner changed')
    if (!await this.transitionWithoutSession('anonymous', 'SIGNED_OUT', signedOutSession ?? session))
      throw this.snapshot.error ?? new Error('Logout cleanup failed')
    return { success: true }
  }

  /**
   * 服务端拒了 `rejected` 这张通行证:换一张新的,返回新证;换不到(会话已不是它、或刷新失败)返回 null。
   * 与到期续期共用同一条 refresh 单飞,N 个请求同时被拒只换一次。当前会话已经换过证(别的请求先触发了)
   * 就直接交出当前证,不再换第二次。`validate` 用于启动验证路径:换证后按新证把身份补齐。
   */
  async recoverRejectedAccessToken(rejected: string, validate = false): Promise<string | null> {
    // 只替同一个人换证:请求发出后换了账号,A 的请求绝不能带着 B 的证重发。refresh 要一次网络往返,
    // 期间可能换号,所以换证前后各核一次。
    const owner = subjectOf(rejected)
    const current = this.snapshot.session
    if (!current || !owner || current.user.id !== owner) return null
    if (current.access_token !== rejected) return current.access_token
    // 刚换来的证又被拒:再换也不会好(比如服务端时钟/签名配置本身错了),交回常规的降级重试,别换证风暴。
    if (this.recoveredAccessTokens.has(rejected)) return null
    // 上一次刷新失败、重试已经排上(退避中):被拒的请求不另起一次 —— 刷新吃 429 时那会变成每个数据请求刷一次,
    // 绕过 1/2/5/10/30 s 的退避(#6723 的风暴)。交回原响应,等协调器自己的重试。
    if (this.retries.get('refresh')?.timer) return null
    await this.refresh()
    const next = this.snapshot.session
    if (!next || next.user.id !== owner || next.access_token === rejected) return null
    this.recoveredAccessTokens.add(next.access_token)
    if (validate) await this.validateSession(next, this.generation)
    return next.access_token
  }

  refresh(): Promise<void> {
    if (this.refreshFlight) return this.refreshFlight
    const session = this.snapshot.session
    if (!session) return Promise.resolve()
    const release = this.beginAuthHandoff()
    const work = sessionWork(this.generation, session)
    const flight = withAuthBudget('refreshSession', this.deps.refreshSession({ refresh_token: session.refresh_token })).then(async ({ data, error }) => {
      if (!this.workIsCurrent(work)) return
      if (error || !data.session) { await this.authCallFailed(error, 'Session refresh failed', session, 'REFRESH_EXPIRED', 'refresh', work, () => this.refresh()); return }
      if (data.session.user.id !== session.user.id) { await this.transitionWithoutSession('expired', 'REFRESH_OWNER_DRIFT', session); return }
      await this.acceptSession('TOKEN_REFRESHED', data.session, false, work)
    }).catch((error) => {
      if (!this.workIsCurrent(work)) return
      this.degrade(errorOf(error, 'Session refresh failed'))
      this.scheduleRetry('refresh', work, () => this.refresh())
    })
    this.refreshFlight = flight
    const clear = () => { release(); if (this.refreshFlight === flight) this.refreshFlight = null }
    void flight.then(clear, clear)
    return flight
  }

  private async restore(generation = this.nextGeneration()): Promise<void> {
    const release = this.beginAuthHandoff()
    this.restoring = true
    try {
      const { data, error } = await withAuthBudget('getSession', this.deps.getSession(), BOOT_RESTORE_TIMEOUT_MS)
        .finally(() => { this.restoring = false })
      if (!this.generationIsCurrent(generation)) return
      if (error) { await this.restoreFailed(error, generation); return }
      if (data.session) await this.acceptSession('INITIAL_SESSION', data.session, true, { generation }, release)
      else if (this.deps.getPersistedSessionState().bootCandidate) await this.restoreFailed(new Error('Persisted session was not restored by auth SDK'), generation)
      else await this.transitionWithoutSession('anonymous', 'INITIAL_SESSION', null)
    } catch (error) {
      if (!this.generationIsCurrent(generation)) return
      await this.restoreFailed(error, generation)
    } finally { release() }
  }
  private restoreFailed(error: unknown, generation: number): Promise<void> {
    const session = this.deps.getPersistedSessionState().bootCandidate
    // 候选只在要重试时才当已登录外壳亮出来。永久错误先亮一下再登出,已登录界面会挂上一瞬,
    // 它刚发出的请求被登出中断,在登录页上报「Could not restore the opening task」(#7172 A/B 实测)。
    if (session && !isPermanentAuthError(error)) this.snapshot = { ...this.snapshot, session, user: userFromSession(session) }
    return this.authCallFailed(error, 'Session restore failed', session, 'RESTORE_EXPIRED', 'restore', { generation }, () => this.restore(generation))
  }
  /**
   * #7172 一次 auth 调用失败之后只在这里分叉:服务端已不认这份会话(isPermanentAuthError)⇒ 转「已过期」、落登录页;
   * 其余(断网、5xx、超时)⇒ 降级、按退避重试 —— ❌ 因为一次暂时失败把人登出。
   * 启动恢复此前自己判、从不查永久错误:刷新令牌已死(在别处全局登出、改了密码)时每 30 s 重试同一个死令牌,
   * 界面一直是已登录外壳 +「连不上服务器」,永远不出登录页。
   */
  private async authCallFailed(error: unknown, fallback: string, session: Session | null, expiredEvent: string,
    purpose: RetryPurpose, work: Work, retry: () => void | Promise<unknown>): Promise<void> {
    if (isPermanentAuthError(error)) { await this.transitionWithoutSession('expired', expiredEvent, session); return }
    this.degrade(errorOf(error, fallback))
    this.scheduleRetry(purpose, work, retry)
  }

  private async handleAuthChange(event: string, session: Session | null): Promise<void> {
    if (!this.active || event === 'PASSWORD_RECOVERY') return
    if (session) {
      if (event === 'INITIAL_SESSION' && this.snapshot.status === 'boot-restoring')
        await this.acceptSession(event, session, true, { generation: this.generation })
      else if ((event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED')
        && this.workIsCurrent(sessionWork(this.generation, session)))
        await this.acceptSession(event, session, false, sessionWork(this.generation, session))
      return
    }
    if (event !== 'SIGNED_OUT' || (this.logoutWork && this.workIsCurrent(this.logoutWork)) || !this.snapshot.session) return
    // #6723 auth-js 刷新失败(429 这类也算)会顺带发 SIGNED_OUT;启动恢复的 getSession 遇到过期会话也会先刷新。
    // 我们自己的续期 / 恢复 / 启动恢复还在飞时,这条就是那次调用的失败,由它的结果决定:永久错误转过期,
    // 其余走 scheduleRetry 退避。❌ 当场再恢复一次 —— 那会绕过退避。
    if (this.refreshFlight || this.recoveryFlight || this.restoring) return
    // @@@4395 我们自己发起、只是超出了预算的 signOut 落地时也会发这条。用户本来就要求登出,
    // 这是**预期内**的终态 —— 干净地转 anonymous,❌ 不要当成意外签出去做恢复(那会重交已失败的凭证)。
    if (this.signOutRequested && this.signOutRequested.generation === this.generation) {
      await this.transitionWithoutSession('anonymous', 'SIGNED_OUT', this.snapshot.session)
      return
    }
    this.degrade(new Error('Auth signed out without an explicit expiry decision'))
    await this.recoverUnexpectedSignOut()
  }

  private async acceptSession(event: string, session: Session, validate: boolean, expected?: Work, onPublished?: () => void): Promise<void> {
    if (!this.active || (expected && !this.workIsCurrent(expected, false))) { onPublished?.(); return }
    const release = this.beginAuthHandoff()
    const generation = this.nextGeneration()
    const work = sessionWork(generation, session)
    try {
      try { await this.deps.commitPersistedSession(session, this.generationAbort.signal) }
      catch (error) { if (this.generationIsCurrent(generation)) this.degrade(errorOf(error, 'Session persistence failed')); throw error }
      if (!this.generationIsCurrent(generation)) return
      const previous = this.snapshot.user?.id === session.user.id ? this.snapshot.user : null
      // #7408 Same-owner refresh keeps the generation boundary of existing data requests.
      if (previous) keepAuthSessionBoundary()
      else resetAuthSessionBoundary()
      this.deps.publishSession(event, session)
      const warning = this.deps.getPersistedSessionState().warning
      this.setSnapshot({ status: warning ? 'degraded' : 'authenticated', session, user: previous ?? userFromSession(session), error: warning })
      this.scheduleRefresh(session)
    } finally { release(); onPublished?.() }
    await this.setMirrorDesired(session, work)
    if (validate) await this.validateSession(session, generation)
  }

  private validateSession(session: Session, generation: number, foreground = false): Promise<void> {
    const work = sessionWork(generation, session)
    const current = this.validationFlight
    if (current && this.workIsCurrent(current.work)) {
      if (foreground && current.kind === 'automatic') {
        const run = () => {
          if (this.validationFlight !== current || !this.workIsCurrent(work)
            || this.logoutWork || this.terminalFlight || this.retries.has('terminal-storage')) return
          this.resetRetry('validate')
          return this.runValidation(session, work)
        }
        const promise = current.promise.then(run, run)
        current.kind = 'automatic-with-trailing-foreground'
        current.promise = promise
        const clear = () => { if (this.validationFlight?.promise === promise) this.validationFlight = null }
        void promise.then(clear, clear)
      }
      return current.promise
    }
    if (foreground) this.resetRetry('validate')
    const promise = this.runValidation(session, work)
    this.validationFlight = { kind: foreground ? 'foreground' : 'automatic', work, promise }
    const clear = () => { if (this.validationFlight?.promise === promise) this.validationFlight = null }
    void promise.then(clear, clear)
    return promise
  }
  private async runValidation(session: Session, work: Work): Promise<void> {
    try {
      const { data, error } = await this.deps.getUser(session.access_token)
      if (!this.workIsCurrent(work)) return
      if (error) {
        if (isRejectedAccessToken(error) && await this.recoverRejectedAccessToken(session.access_token, true) !== null) return
        // 换证路径里可能已经换了会话(刷新成功后的新代验证、或换了号),旧会话的降级别盖到新会话上。
        if (!this.workIsCurrent(work)) return
        await this.authCallFailed(error, 'User validation failed', session, 'USER_EXPIRED', 'validate', work, () => this.validateSession(session, work.generation))
        return
      }
      if (!data.user) { this.degrade(new Error('Auth user response was empty without an expiry code')); this.scheduleRetry('validate', work, () => this.validateSession(session, work.generation)); return }
      if (data.user.id !== session.user.id) { await this.transitionWithoutSession('expired', 'USER_OWNER_DRIFT', session); return }
      const user = await this.deps.hydrateUser(data.user, AbortSignal.timeout(PROFILE_TIMEOUT_MS))
      if (!this.workIsCurrent(work)) return
      if (!user) { this.degrade(new Error('Canonical identity profile is unavailable')); this.scheduleRetry('validate', work, () => this.validateSession(session, work.generation)); return }
      this.resetRetry('validate')
      this.setSnapshot({ status: this.deps.getPersistedSessionState().warning ? 'degraded' : 'authenticated', session, user, error: this.deps.getPersistedSessionState().warning })
    } catch (error) {
      if (!this.workIsCurrent(work)) return
      this.degrade(errorOf(error, 'User hydration failed'))
      this.scheduleRetry('validate', work, () => this.validateSession(session, work.generation))
    }
  }

  private reconcileForeground(): Promise<void> {
    const { session } = this.snapshot
    if (!this.active || !session || this.logoutWork || this.terminalFlight || this.retries.has('terminal-storage')) return Promise.resolve()
    const refreshDue = session.expires_at && session.expires_at * 1_000 - Date.now() <= REFRESH_EARLY_MS
    return refreshDue ? this.refresh() : this.validateSession(session, this.generation, true)
  }

  private recoverUnexpectedSignOut(): Promise<void> {
    if (this.recoveryFlight) return this.recoveryFlight
    const snapshotSession = this.snapshot.session
    if (!snapshotSession) return Promise.resolve()
    const release = this.beginAuthHandoff()
    const work = sessionWork(this.generation, snapshotSession)
    // @@@4395 恢复要优先用**持久化里的那份**,而不是内存快照里那份。走到这条路径的 SIGNED_OUT 多半由
    // 一次失败的 refresh 触发,而内存里那个 refresh token 正是刚失败的那一个;服务端开着轮换、且只有
    // 10s 的复用窗口(GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL),把它原样再交一次基本必然换回
    // refresh_token_already_used —— 该码属于 PERMANENT_AUTH_CODES,于是一次**本可重试**的失败被我们
    // 自己升级成不可恢复的终态,用户表现为「睡一觉醒来必须重新登录」。持久化那份可能已被上一次成功的
    // 轮换写新(响应丢失但服务端已换发),优先用它;两者相同则退回原行为。
    const persisted = this.deps.getPersistedSessionState().bootCandidate
    const session = persisted && persisted.user.id === snapshotSession.user.id
      && persisted.refresh_token !== snapshotSession.refresh_token ? persisted : snapshotSession
    const flight = this.deps.restoreSession({ access_token: session.access_token, refresh_token: session.refresh_token }).then(async ({ data, error }) => {
      if (!this.workIsCurrent(work)) return
      if (error || !data.session) { await this.authCallFailed(error, 'Session recovery failed', session, 'SESSION_RESTORE_EXPIRED', 'recovery', work, () => this.recoverUnexpectedSignOut()); return }
      if (data.session.user.id !== session.user.id) { await this.transitionWithoutSession('expired', 'RECOVERY_OWNER_DRIFT', session); return }
      await this.acceptSession('SESSION_RESTORED', data.session, false, work)
    }).catch((error) => {
      if (!this.workIsCurrent(work)) return
      this.degrade(errorOf(error, 'Session recovery failed'))
      this.scheduleRetry('recovery', work, () => this.recoverUnexpectedSignOut())
    })
    this.recoveryFlight = flight
    const clear = () => { release(); if (this.recoveryFlight === flight) this.recoveryFlight = null }
    void flight.then(clear, clear)
    return flight
  }

  private transitionWithoutSession(status: 'anonymous' | 'expired', event: string, session: Session | null): Promise<boolean> {
    if (this.terminalFlight) return this.terminalFlight
    const generation = this.nextGeneration()
    // A null session is the normal initial anonymous path; there is no persisted
    // session to clean up, so publishing a cleanup warning would misclassify boot.
    if (session) this.degrade(new Error('Session cleanup pending'))
    return this.startTerminal({ generation, session, status, event })
  }
  private startTerminal(plan: TerminalPlan): Promise<boolean> {
    const flight = this.finishTerminal(plan)
    this.terminalFlight = flight
    const clear = () => { if (this.terminalFlight === flight) this.terminalFlight = null }
    void flight.then(clear, clear)
    return flight
  }
  private async finishTerminal(plan: TerminalPlan): Promise<boolean> {
    const session = plan.session
    if (session) try {
      await this.deps.clearPersistedSession(session, this.generationAbort.signal)
      if (!this.generationIsCurrent(plan.generation)) return false
      plan.session = null
      this.resetRetry('terminal-storage')
    } catch (error) {
      if (!this.generationIsCurrent(plan.generation)) return false
      this.degrade(errorOf(error, 'Session storage cleanup failed'))
      this.scheduleRetry('terminal-storage', sessionWork(plan.generation, session), () => this.startTerminal(plan))
      return false
    }
    if (!this.generationIsCurrent(plan.generation)) return false
    abortAuthSessionBoundary()
    this.deps.publishSession(plan.event, null)
    this.setSnapshot({ status: plan.status, session: null, user: null, error: this.deps.getPersistedSessionState().warning })
    return this.setMirrorDesired(null, { generation: plan.generation }, true).then(() => true, () => false)
  }

  private async setMirrorDesired(session: Session | null, work: Work, drainAfterStop = false,
    version = ++this.mirrorVersion, attempt = 0): Promise<void> {
    const task = this.mirrorTail.catch(() => undefined).then(async () => {
      if ((!drainAfterStop && !this.workIsCurrent(work, false)) || version !== this.mirrorVersion) return
      if (session) await this.deps.writeMirror(session); else await this.deps.clearMirror(this.snapshot.status === 'expired' ? 'lost' : 'signed-out')
    })
    this.mirrorTail = task
    try {
      await task; this.resetRetry('mirror')
      if (!session && drainAfterStop && version === this.mirrorVersion) this.setSnapshot({ ...this.snapshot, error: this.deps.getPersistedSessionState().warning })
    }
    catch (error) {
      if (!session && drainAfterStop && version === this.mirrorVersion) {
        this.setSnapshot({ ...this.snapshot, error: new Error('Session mirror cleanup pending', { cause: error }) })
        const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]
        setTimeout(() => {
          if (version === this.mirrorVersion) void this.setMirrorDesired(null, work, true, version, attempt + 1).catch(() => undefined)
        }, delay)
        throw error
      }
      if (!session) throw error
      if (!this.workIsCurrent(work)) return
      this.degrade(errorOf(error, 'Session mirror failed'))
      this.scheduleRetry('mirror', work, () => this.setMirrorDesired(session, work))
    }
  }
  private scheduleRetry(purpose: RetryPurpose, work: Work, action: () => void | Promise<unknown>): void {
    const retry = this.retries.get(purpose) ?? { attempt: 0, timer: null }
    if (!this.workIsCurrent(work, false) || retry.timer) return
    const delay = RETRY_DELAYS_MS[Math.min(retry.attempt++, RETRY_DELAYS_MS.length - 1)]
    retry.timer = setTimeout(() => {
      retry.timer = null
      if (this.workIsCurrent(work, false)) void action()
    }, delay)
    this.retries.set(purpose, retry)
  }
  private resetRetry(purpose: RetryPurpose): void {
    const retry = this.retries.get(purpose)
    if (retry?.timer) clearTimeout(retry.timer)
    this.retries.delete(purpose)
  }
  private nextGeneration(): number {
    this.generationAbort.abort(); this.generationAbort = new AbortController()
    this.generation += 1; this.terminalFlight = null; this.recoveryFlight = null; this.refreshFlight = null; this.validationFlight = null; this.restoring = false
    this.retries.forEach(({ timer }) => { if (timer) clearTimeout(timer) }); this.retries.clear()
    if (this.refreshTimer) clearTimeout(this.refreshTimer); this.refreshTimer = null
    return this.generation
  }
  private generationIsCurrent(generation: number): boolean { return this.active && generation === this.generation }
  private workIsCurrent(work: Work, requireSession = true): boolean {
    if (!this.active || work.generation !== this.generation) return false
    if (!work.userId) return true
    const session = this.snapshot.session
    if (!session) return !requireSession
    return session.user.id === work.userId && session.access_token === work.accessToken && session.refresh_token === work.refreshToken
  }
  private scheduleRefresh(session: Session): void {
    if (!session.expires_at) return
    const delay = Math.max(1_000, session.expires_at * 1_000 - Date.now() - REFRESH_EARLY_MS)
    this.refreshTimer = setTimeout(() => { this.refreshTimer = null; void this.refresh() }, delay)
  }
  private degrade(error: Error): void { this.setSnapshot({ ...this.snapshot, status: 'degraded', error }); console.error('[auth] session degraded', error) }
  private setSnapshot(snapshot: SessionCoordinatorSnapshot): void { this.snapshot = snapshot; this.listeners.forEach((listener) => listener()) }
  private stop(): void {
    this.active = false; this.interactiveAttempt += 1; this.nextGeneration()
    this.subscription?.unsubscribe(); this.subscription = null
    this.foregroundUnsubscribe?.(); this.foregroundUnsubscribe = null
  }
}
async function writeHostMirror(session: Session): Promise<void> {
  if (!platform.capabilities.localHumanAuthSession) return
  const mirror: HumanAuthSession = { user_id: session.user.id, email: session.user.email ?? null,
    access_token: session.access_token, refresh_token: session.refresh_token,
    refresh_owner: 'desktop', updated_at: new Date().toISOString() }
  await platform.writeHumanAuthSession(mirror)
}
export const sessionCoordinator = new SessionCoordinator({
  getSession: async () => {
    // A live background host may need network renewal. Load its persisted boot candidate first,
    // so a slow renewal keeps the known owner's degraded shell instead of losing their identity.
    if (phoneHostAuthAvailable()) await mainAuthSessionStorage.storage.getItem(MAIN_AUTH_STORAGE_KEY)
    return phoneHostGetSession(() => supabase.auth.getSession())
  },
  getUser: (accessToken) => supabase.auth.getUser(accessToken),
  refreshSession: (session) => phoneHostRefreshSession(session.refresh_token, async () => {
    if (!phoneHostAuthAvailable()) return supabase.auth.refreshSession(session)
    // A stopped native host may have rotated the token since this renderer snapshot was published.
    const raw = await mainAuthSessionStorage.storage.getItem(MAIN_AUTH_STORAGE_KEY)
    const saved = raw ? JSON.parse(raw) as Session : null
    const current = sessionCoordinator.getSnapshot().session
    const refreshToken = saved?.user.id === current?.user.id ? saved?.refresh_token : session.refresh_token
    return supabase.auth.refreshSession({ refresh_token: refreshToken ?? session.refresh_token })
  }),
  restoreSession: (session) => phoneHostRestoreSession(() => supabase.auth.setSession(session)),
  onAuthStateChange: (listener) => supabase.auth.onAuthStateChange((event, session) => listener(event, session)),
  // @@@6659 退出只吊销这一个会话 —— 不传 scope 时 supabase-js 默认 global,同账号所有设备一起被踢下线。
  signOut: () => phoneHostSignOut(() => supabase.auth.signOut({ scope: 'local' })),
  hydrateUser: hydrateIdentityAuthUser,
  publishSession: publishRendererSession,
  writeMirror: writeHostMirror,
  clearMirror: (reason) => platform.capabilities.localHumanAuthSession ? platform.clearHumanAuthSession(reason) : Promise.resolve(),
  getPersistedSessionState: () => mainAuthSessionStorage.getState(),
  commitPersistedSession: (session, signal) => mainAuthSessionStorage.commit(session, signal),
  clearPersistedSession: (session, signal) => mainAuthSessionStorage.remove(session, signal),
  subscribeAppForeground: (listener, onError) => platform.subscribeAppForeground(listener, onError),
})
setRejectedAccessTokenRecovery((rejected) => sessionCoordinator.recoverRejectedAccessToken(rejected))
setPhoneHostAuthHandoffBarrier(sessionCoordinator.captureAuthHandoff)
