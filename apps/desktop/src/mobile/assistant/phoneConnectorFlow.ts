import type { IntegrationError } from '@gugu/session-plugins/integrations'
import {
  cliMethodOf,
  formMethodOf,
  mcpOAuthServerUrlOf,
} from '@/session/renderer/features/integrations/integration-setup-model'

// #7199 手机助理 App 的「连接应用」:连 / 断一家云端账号服务的纯逻辑(没有界面、不直接碰 rpc —— 依赖都从参数进来,
// 单测在 tests/unit/mobile/phoneConnectorFlow7199.test.ts)。界面在 PhoneConnectorSetup.tsx。
//
// 桌面连一家有四条路,各自有一步在手机上做不了,手机上换成等价的:
//  · 表单(邮箱授权码、各家 API key):桌面是会话页的弹窗 → 手机一页表单,同一份字段定义与校验,同一个 `connect`。
//  · 浏览器授权(飞书、腾讯文档、滴答、Notion、Linear):桌面在**本机**起 127.0.0.1 监听收回跳、`shell.openExternal` 开浏览器,
//    凭据再交给那台机器的 `connect`(library-host 的 authorize)。手机没有监听,助理的家是没有浏览器的宿主,
//    所以由手机做浏览器那一半:原生 HTTP 做发现 / 注册 / 换令牌,系统浏览器同意授权,回跳由人把地址贴回来。
//  · 官方命令行(钉钉、企业微信):装与登录都跑在那台机器上,手机只看它给的链接 / 二维码 → 同一组 cliLogin* 动词。
//  · GitHub:设备码流程,码经机器推送的事件到手机,在系统浏览器里输入。

/** 平台:手机壳(capacitor)有原生 HTTP;手机浏览器里的网页版没有(跨域被拦),浏览器授权做不了。桌面 Electron 不进手机壳。 */
export type PlatformKind = 'electron' | 'capacitor' | 'web'

export type SetupPlan =
  | { kind: 'form' }
  | { kind: 'browser'; serverUrl: string }
  | { kind: 'cli' }
  | { kind: 'github' }
  /** `needs-app` = 这条路要咕咕手机 App 的原生能力(网页版没有);`no-method` = 目录里没有手机上认得的连接方式。 */
  | { kind: 'unavailable'; reason: 'needs-app' | 'no-method' }

type AuthDescribed = { id: string; auth: { methods: readonly { kind: string }[] } }

/**
 * 这一家在手机上走哪条路。次序与桌面一致(GitHub 单独一条;命令行 > 浏览器授权 > 表单)。
 * 手机浏览器里的网页版没有原生 HTTP,浏览器授权会被跨域拦掉 —— 如实说去 App,❌ 摆一个必然失败的钮。
 */
export function setupPlanOf(metadata: AuthDescribed, platformKind: PlatformKind): SetupPlan {
  if (metadata.id === 'github') return { kind: 'github' }
  if (cliMethodOf(metadata)) return { kind: 'cli' }
  const serverUrl = mcpOAuthServerUrlOf(metadata)
  if (serverUrl) return platformKind === 'capacitor' ? { kind: 'browser', serverUrl } : { kind: 'unavailable', reason: 'needs-app' }
  if (formMethodOf(metadata)) return { kind: 'form' }
  return { kind: 'unavailable', reason: 'no-method' }
}

// ── 路由名:`connector:<id>`(详情)、`connector:<id>:connect`(连接页)。返回箭头回上一层见 assistant-context.parentRoute。

export type ConnectorRoute = { id: string; view: 'detail' | 'connect' }

export function connectSub(id: string): string {
  return `connector:${id}:connect`
}

export function parseConnectorSub(sub: string | null): ConnectorRoute | null {
  if (!sub?.startsWith('connector:')) return null
  const rest = sub.slice('connector:'.length)
  const cut = rest.indexOf(':')
  if (cut < 0) return rest ? { id: rest, view: 'detail' } : null
  const id = rest.slice(0, cut)
  return id && rest.slice(cut + 1) === 'connect' ? { id, view: 'connect' } : null
}

// ── 连接结果与失败

export type ConnectOutcome =
  | { success: true; displayName?: string; displayDetail?: string }
  | { success: false; error: string; errorType?: IntegrationError['type'] }

export type SetupStep =
  /** 浏览器授权:找授权服务、注册。 */
  | 'prepare'
  /** 浏览器授权:人在浏览器里同意(或没同意)。 */
  | 'authorize'
  /** 浏览器授权:拿授权码换令牌。 */
  | 'exchange'
  /** 把凭据交给助理的家验证、存起来(表单提交也是这一步)。 */
  | 'save'
  /** 命令行:装工具、起登录。 */
  | 'install'
  /** 命令行:等人在对方 App 里确认。 */
  | 'login'
  /** GitHub 设备码。 */
  | 'github'

export type SetupFailure = {
  step: SetupStep
  /** denied = 人点了拒绝;timeout = 等过头;rejected = 助理的家那边核过不认;failed = 别的(网络、对方没回)。 */
  reason: 'denied' | 'timeout' | 'rejected' | 'failed'
  /** 那一家分好的类:界面按它用界面语言说,❌ 按原话猜。 */
  errorType?: IntegrationError['type']
  /** 对方 / 工具自己的话:只作小字补充,主文案是「哪一步没成」。 */
  detail?: string
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 小字补充只留一小段:对方的原话可能带整段输出。 */
export function detailOf(text: string | undefined): string | undefined {
  const trimmed = text?.trim()
  if (!trimmed) return undefined
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed
}

function detailField(text: string | undefined): { detail?: string } {
  const detail = detailOf(text)
  return detail ? { detail } : {}
}

/** 这次失败界面该说哪一条主文案(assistant 目录 connectors.setup.* 下的键)。 */
export function failureKey(failure: SetupFailure): string {
  if (failure.reason === 'denied') return 'denied'
  if (failure.reason === 'timeout') return 'timeout'
  return `failedAt.${failure.step}`
}

// ── 表单

/** 把一份凭据(表单填的、或浏览器授权拿到的)交给助理的家 `connect`:它去对方那边核一遍再存。 */
export async function connectWithInput(
  connect: (input: Record<string, unknown>) => Promise<ConnectOutcome>,
  input: Record<string, unknown>,
): Promise<{ ok: true; displayName?: string } | { ok: false; failure: SetupFailure }> {
  try {
    const outcome = await connect(input)
    if (outcome.success) return { ok: true, ...(outcome.displayName ? { displayName: outcome.displayName } : {}) }
    return {
      ok: false,
      failure: { step: 'save', reason: 'rejected', ...(outcome.errorType ? { errorType: outcome.errorType } : {}), ...detailField(outcome.error) },
    }
  } catch (error) {
    return { ok: false, failure: { step: 'save', reason: 'failed', ...detailField(messageOf(error)) } }
  }
}

// ── 浏览器授权

/** 5 分钟没把授权结果贴回来就算超时(与桌面等回跳的时长一致)。 */
export const OAUTH_TIMEOUT_MS = 5 * 60_000

export type AuthorizationReturn =
  | { kind: 'code'; code: string }
  | { kind: 'denied'; description: string }
  /** 贴的不是回跳:empty 什么都没有;not-callback 里没有授权结果;state-mismatch 是另一次授权的(或被改过)。 */
  | { kind: 'invalid'; reason: 'empty' | 'not-callback' | 'state-mismatch' }

/**
 * 读人贴回来的那一段:浏览器授权完会跳到 `http://127.0.0.1:<端口>/callback?code=…&state=…`,手机上没有人听那个端口,
 * 页面打不开,但地址栏里的完整地址就是授权结果。认三种写法:完整网址、没带协议的 `127.0.0.1:端口/callback?…`、只复制了查询串。
 * state 必须与这一次的相等(与桌面监听一样严:❌ 收下另一次授权或被改过的回跳)。
 */
export function parseAuthorizationReturn(text: string, expected: { state: string }): AuthorizationReturn {
  const raw = text.trim()
  if (!raw) return { kind: 'invalid', reason: 'empty' }
  const question = raw.indexOf('?')
  const query = (question >= 0 ? raw.slice(question + 1) : raw.includes('=') ? raw : '').split('#')[0] ?? ''
  const params = new URLSearchParams(query)
  const code = params.get('code')
  const denied = params.get('error')
  if (!code && !denied) return { kind: 'invalid', reason: 'not-callback' }
  if (params.get('state') !== expected.state) return { kind: 'invalid', reason: 'state-mismatch' }
  if (denied) return { kind: 'denied', description: params.get('error_description') || denied }
  return { kind: 'code', code: code ?? '' }
}

export type OauthPending = {
  authorizationUrl: string
  complete(code: string): Promise<Record<string, unknown>>
}

export type OauthSetupDeps = {
  /** 授权的第一段(发现 / 注册 / 拼授权页地址);取消时抛名叫 McpAuthorizationCancelledError 的错。 */
  begin(options: { serverUrl: string; redirectUrl: string; state: string; signal: AbortSignal }): Promise<OauthPending>
  openUrl(url: string): void
  /** 凭据交给助理的家 `connect`。 */
  connect(credentials: Record<string, unknown>): Promise<ConnectOutcome>
  /** 这一次授权的回跳地址与 state(随机,每次重来换新的)。 */
  newAttempt(): { redirectUrl: string; state: string }
  timeoutMs?: number
}

export type OauthState =
  | { phase: 'preparing' }
  | { phase: 'awaiting'; deadline: number; authorizationUrl: string; hint?: 'empty' | 'not-callback' | 'state-mismatch' }
  | { phase: 'finishing' }
  | { phase: 'done'; displayName?: string }
  | { phase: 'failed'; failure: SetupFailure }
  | { phase: 'cancelled' }

export type OauthSetupHandle = {
  /** 人把浏览器地址栏里的回跳贴回来。 */
  submit(text: string): void
  /** 浏览器没弹出来 / 关掉了:再开一次授权页。 */
  reopen(): void
  /** 放弃这次授权。 */
  cancel(): void
}

const CANCELLED = 'McpAuthorizationCancelledError'

/**
 * 浏览器授权的状态机(手机这一半):准备 → 开系统浏览器等人贴回地址 → 换令牌 → 交给助理的家 → 已连接。
 * 终局:done / failed / cancelled,出了终局不再发状态(❌ 取消之后晚到的结果把页面又改回去)。
 */
export function startOauthSetup(deps: OauthSetupDeps, input: { serverUrl: string }, onState: (state: OauthState) => void): OauthSetupHandle {
  const abort = new AbortController()
  const attempt = deps.newAttempt()
  const timeoutMs = deps.timeoutMs ?? OAUTH_TIMEOUT_MS
  let pending: OauthPending | null = null
  let closed = false
  let busy = false
  let deadline = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const emit = (state: OauthState) => {
    if (!closed) onState(state)
  }
  const finish = (state: OauthState) => {
    if (closed) return
    clearTimeout(timer)
    emit(state)
    closed = true
  }
  const fail = (failure: SetupFailure) => finish({ phase: 'failed', failure })

  emit({ phase: 'preparing' })
  void (async () => {
    try {
      pending = await deps.begin({ serverUrl: input.serverUrl, redirectUrl: attempt.redirectUrl, state: attempt.state, signal: abort.signal })
    } catch (error) {
      if (closed) return
      if (error instanceof Error && error.name === CANCELLED) return finish({ phase: 'cancelled' })
      return fail({ step: 'prepare', reason: 'failed', ...detailField(messageOf(error)) })
    }
    if (closed) return
    deps.openUrl(pending.authorizationUrl)
    deadline = Date.now() + timeoutMs
    timer = setTimeout(() => fail({ step: 'authorize', reason: 'timeout' }), timeoutMs)
    emit({ phase: 'awaiting', deadline, authorizationUrl: pending.authorizationUrl })
  })()

  return {
    submit(text) {
      if (closed || busy || !pending) return
      const parsed = parseAuthorizationReturn(text, attempt)
      if (parsed.kind === 'invalid') {
        emit({ phase: 'awaiting', deadline, authorizationUrl: pending.authorizationUrl, hint: parsed.reason })
        return
      }
      if (parsed.kind === 'denied') {
        fail({ step: 'authorize', reason: 'denied', ...detailField(parsed.description) })
        return
      }
      busy = true
      clearTimeout(timer)
      emit({ phase: 'finishing' })
      const exchanging = pending
      void (async () => {
        let credentials: Record<string, unknown>
        try {
          credentials = await exchanging.complete(parsed.code)
        } catch (error) {
          return fail({ step: 'exchange', reason: 'failed', ...detailField(messageOf(error)) })
        }
        const saved = await connectWithInput(deps.connect, credentials)
        if (saved.ok) finish({ phase: 'done', ...(saved.displayName ? { displayName: saved.displayName } : {}) })
        else fail(saved.failure)
      })()
    },
    reopen() {
      if (!closed && pending && !busy) deps.openUrl(pending.authorizationUrl)
    },
    cancel() {
      if (closed) return
      // 已经在换令牌 / 交给家验证的那几秒撤不回(那一问已经发出去了):不再更新页面,让它做完。
      if (busy) {
        closed = true
        return
      }
      abort.abort()
      finish({ phase: 'cancelled' })
    },
  }
}

/** 这一次授权的回跳地址 + state:回跳是回环地址上一个没人听的端口(授权服务器认任意端口的 127.0.0.1,飞书只认回环),state 是随机串。 */
export function randomOauthAttempt(fill: (bytes: Uint8Array<ArrayBuffer>) => void = (bytes) => void crypto.getRandomValues(bytes)): {
  redirectUrl: string
  state: string
} {
  const bytes = new Uint8Array(18)
  fill(bytes)
  const state = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  // 49152–65535:动态端口段,平时没有什么在听。
  const port = 49152 + (((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0)) % (65536 - 49152)
  return { redirectUrl: `http://127.0.0.1:${port}/callback`, state }
}

// ── 官方命令行(钉钉 dws、企业微信 wecom-cli)

export type CliPrompt = { kind: 'device-link'; url: string; code: string } | { kind: 'qr-code'; image: string; url?: string }

export type CliSetupDeps = {
  start(): Promise<{ success: true; prompt: CliPrompt } | { success: true; connected: true } | { success: false; error: string }>
  /** 一问最多挂二十来秒,`pending` 就再问。 */
  wait(): Promise<{ status: 'pending'; prompt?: CliPrompt } | { status: 'connected' } | { status: 'failed'; error: string }>
  /** 撤掉那台机器上还在跑 / 在装的那一次。 */
  cancel(): Promise<unknown>
}

export type CliSetupState =
  | { phase: 'starting' }
  | { phase: 'waiting'; prompt: CliPrompt }
  | { phase: 'done' }
  | { phase: 'failed'; failure: SetupFailure }
  | { phase: 'cancelled' }

export function startCliSetup(deps: CliSetupDeps, onState: (state: CliSetupState) => void): { cancel(): void } {
  let closed = false
  const emit = (state: CliSetupState) => {
    if (!closed) onState(state)
  }
  const finish = (state: CliSetupState) => {
    emit(state)
    closed = true
  }
  const failed = (step: SetupStep, error: unknown) =>
    finish({ phase: 'failed', failure: { step, reason: 'failed', ...detailField(typeof error === 'string' ? error : messageOf(error)) } })

  emit({ phase: 'starting' })
  void (async () => {
    try {
      const started = await deps.start()
      if (closed) return
      if (!started.success) return failed('install', started.error)
      if ('connected' in started) return finish({ phase: 'done' })
      emit({ phase: 'waiting', prompt: started.prompt })
      for (;;) {
        const result = await deps.wait()
        if (closed) return
        if (result.status === 'pending') {
          if (result.prompt) emit({ phase: 'waiting', prompt: result.prompt })
          continue
        }
        if (result.status === 'failed') return failed('login', result.error)
        return finish({ phase: 'done' })
      }
    } catch (error) {
      if (!closed) failed('login', error)
    }
  })()

  return {
    cancel() {
      if (closed) return
      closed = true
      void deps.cancel().catch(() => undefined)
      onState({ phase: 'cancelled' })
    },
  }
}

// ── GitHub 设备码

export type GithubDeviceCode = { userCode: string; verificationUri: string; expiresIn: number }

export type GithubSetupDeps = {
  /** 订设备码推送;返回退订。先订、再 `auth`。 */
  onCode(listener: (code: GithubDeviceCode) => void): () => void
  auth(): Promise<{ success: true; account: { login: string } } | { success: false; error: string }>
  cancel(): Promise<unknown>
}

export type GithubSetupState =
  | { phase: 'starting' }
  | { phase: 'code'; code: GithubDeviceCode }
  | { phase: 'done'; login: string }
  | { phase: 'failed'; failure: SetupFailure }
  | { phase: 'cancelled' }

export function startGithubSetup(deps: GithubSetupDeps, onState: (state: GithubSetupState) => void): { cancel(): void } {
  let closed = false
  const emit = (state: GithubSetupState) => {
    if (!closed) onState(state)
  }
  const off = deps.onCode((code) => emit({ phase: 'code', code }))
  const finish = (state: GithubSetupState) => {
    off()
    emit(state)
    closed = true
  }

  emit({ phase: 'starting' })
  void (async () => {
    try {
      const result = await deps.auth()
      if (closed) return
      if (result.success) return finish({ phase: 'done', login: result.account.login })
      finish({ phase: 'failed', failure: { step: 'github', reason: 'failed', ...detailField(result.error) } })
    } catch (error) {
      if (!closed) finish({ phase: 'failed', failure: { step: 'github', reason: 'failed', ...detailField(messageOf(error)) } })
    }
  })()

  return {
    cancel() {
      if (closed) return
      off()
      closed = true
      void deps.cancel().catch(() => undefined)
      onState({ phase: 'cancelled' })
    },
  }
}

// ── 详情页:连着的健康度、日期

export type ConnectorHealth = 'ok' | 'reauth' | 'issue' | 'unknown'

/**
 * 凭据还存着,联网核一遍的结果:核得通 = ok;对方不认了 / 授权失效 = reauth(给「重新连接」);别的失败(限流、对方没回…)= issue ——
 * 不当成要重新授权;还没核到 = unknown(❌ 当成有问题)。
 */
export function connectorHealth(status: { connected: boolean; errorType?: IntegrationError['type'] } | null | undefined): ConnectorHealth {
  if (!status) return 'unknown'
  if (status.connected) return 'ok'
  return status.errorType === 'auth_failed' || status.errorType === 'authorization_expired' || status.errorType === 'key_rejected' ? 'reauth' : 'issue'
}

/** 「连接于 2026-10-16」那一天(本地日期)。 */
export function formatDay(epochMs: number): string {
  const date = new Date(epochMs)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

// ── 断开

export type DisconnectResult = { success: boolean; error?: string }

/** 断开一家(多账号里只断开 `accountId` 那一个)。没成功就抛:确认卡据此留在原地说「没断开」。 */
export async function disconnectIntegration(
  disconnect: (id: string, accountId?: string) => Promise<DisconnectResult>,
  id: string,
  accountId?: string,
): Promise<void> {
  const result = await disconnect(id, accountId)
  if (!result.success) throw new Error(result.error ?? `disconnect ${id} failed`)
}

/** GitHub 的账号不在集成的凭据库里,有自己的移除口。 */
export async function removeGithubAccount(
  remove: (accountId: string) => Promise<DisconnectResult>,
  accountId: string,
): Promise<void> {
  const result = await remove(accountId)
  if (!result.success) throw new Error(result.error ?? 'remove github account failed')
}

/** 多账号的一行写谁:账号名 > 邮箱地址 > 这一家的名字(与桌面 accountLabel 同序)。 */
export function accountLabel(account: { displayName?: string; fields: Record<string, string> }, integrationName: string): string {
  return account.displayName ?? account.fields.email ?? integrationName
}
