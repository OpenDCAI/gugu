/**
 * #7199 云电脑:平台替用户开、替用户托管的一台机器,里面跑的就是咕咕 server(规定草稿 cloud-computer)。
 * 在咕咕里它就是设备列表与「在哪跑」里的一台 server;开、睡、醒、删由服务端的「云电脑管家」负责,这里是它的客户端。
 *
 * 管家接口(base 见 `cloudComputerBaseUrl`;鉴权 = 用户自己的 JWT):
 *  · GET    /state      → { state, deviceId?, error?, since? }
 *  · POST   /provision  → 202(那台叫什么由管家定,默认「助理」;请求 ❌ 带设备名;可带 `{ assistant }`,见 CloudComputerProvisionInput)
 *  · POST   /wake       → 202(可带 `{ purpose: 'move_out' }`:搬回本机那一次,有家就放行,绕过套餐 / 积分、不计费)
 *  · DELETE /           销毁
 * 出错的响应体是 { error: <码>, message: <给人看的一句> };免费档 403 plan_required,积分用完 403 credits_exhausted,
 * 会员到期 403 membership_expired(管家从不因到期删 / 关机器,只拦唤醒);
 * 云端函数部署了、还没配管家 = 503 not_open(这里没开放,客户端整块不显示)。
 *
 * 不碰 node / electron:渲染层(设置 → 设备、「在哪跑」)和主进程(agent 的 session_* 跨机器)共用这一份。
 */
import type { CloudComputerPresence } from '../shared/types/deviceHost'

export type { CloudComputerPresence }

export type CloudComputerState = 'none' | 'provisioning' | 'asleep' | 'waking' | 'awake' | 'error'

const STATES: readonly CloudComputerState[] = ['none', 'provisioning', 'asleep', 'waking', 'awake', 'error']

export type CloudComputerSnapshot = {
  state: CloudComputerState
  /** 它在设备列表里是哪一行(开通后 server 登上账号才有)。认云电脑只靠它,❌ 按名字 / 平台猜。 */
  deviceId: string | null
  /** state = error 时管家给的、给人看的一句原因。 */
  error: string | null
  /** 进入这个状态的时刻(ISO)。 */
  since: string | null
  /** 开通中、且是把一位已有的助理接过来(搬家),不是新建 —— 界面据此说「正在搬家」而不是「正在开通」。不带 = 不是。 */
  adopting?: boolean
  /** 搬家时是从哪台机器来的(设备 id);管家没给 = null。 */
  adoptingFrom?: string | null
}

/**
 * 管家那一侧的码:plan_required = 免费档不能开;credits_exhausted = 积分用完、醒不来;already_exists / busy / not_found /
 * unauthorized / internal 照约定;请求没回来 = network;别的原样带回(体不是约定形状时记 `http_<状态>`)。
 */
export type CloudComputerErrorCode = string

export class CloudComputerError extends Error {
  constructor(
    /** HTTP 状态;请求没发出去 / 没回来 = 0。 */
    readonly status: number,
    readonly code: CloudComputerErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CloudComputerError'
  }
}

/**
 * 管家地址:开发实例用 `GUGU_CLOUD_COMPUTER_URL` 覆盖,否则是这套库的 `/functions/v1/cloud-computer`。
 * 两个都拿不到 = null,调用方据此不显示这个功能 —— ❌ 写兜底地址。
 */
export function cloudComputerBaseUrl(input: { enabled?: boolean; override?: string | null; supabaseUrl?: string | null }): string | null {
  if (input.enabled === false) return null
  const override = input.override?.trim()
  if (override) return override.replace(/\/+$/, '')
  const supabaseUrl = input.supabaseUrl?.trim()
  if (supabaseUrl) return `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/cloud-computer`
  return null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** GET /state 的应答 → 快照;形状不对就抛(❌ 当成「没有云电脑」)。 */
export function parseCloudComputerSnapshot(value: unknown): CloudComputerSnapshot {
  if (!value || typeof value !== 'object') throw new CloudComputerError(200, 'bad_response', 'cloud-computer /state returned a non-object')
  const record = value as Record<string, unknown>
  const state = record.state
  if (typeof state !== 'string' || !(STATES as readonly string[]).includes(state)) {
    throw new CloudComputerError(200, 'bad_response', `cloud-computer /state returned an unknown state: ${JSON.stringify(state)}`)
  }
  return {
    state: state as CloudComputerState,
    deviceId: text(record.deviceId),
    error: text(record.error),
    since: text(record.since),
    adopting: record.adopting === true,
    adoptingFrom: text(record.adopting_from),
  }
}

/** 非 2xx 的应答 → 带码的错误;体不是约定的形状时,码记成 `http_<状态>`,原文进 message。 */
export function cloudComputerErrorFromResponse(status: number, body: string): CloudComputerError {
  let code: string | null = null
  let message: string | null = null
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    code = text(parsed?.error)
    message = text(parsed?.message)
  } catch {
    // 不是 JSON:下面用原文
  }
  return new CloudComputerError(status, code ?? `http_${status}`, message ?? (body.trim() || `HTTP ${status}`))
}

/**
 * #7199 开通时一并交给管家的那位助理(新用户引导里起的名字、选的形象、主人留的「称呼和基本信息」):
 * 管家拿 name / avatar 建它,ownerProfile 在它建出来之前写进它的记忆夹(owner-profile.md),初始化任务里它读这条先开口。
 * 不带 = 管家用默认(「个人助理」、随机形象、没有那条记忆)。已有一台(409 already_exists)时管家忽略它。
 */
export type CloudComputerProvisionInput = {
  assistant?:
    | { name: string; avatar: string | null; ownerProfile: string }
    /**
     * 搬家(本机 → 云上):接过一位已有的助理 —— 复用它的身份与私聊、不发欢迎语、不派初始化任务,
     * 文件由客户端随后逐项拷过去。name / avatar / ownerProfile 此时不带。
     */
    | { existingAgentUserId: string }
}

/** 叫醒的缘由:搬回本机那一次管家有家就放行(不看套餐 / 积分、不计费);平时叫醒不带。 */
export type CloudComputerWakeInput = { purpose?: 'move_out' | 'close' }

function provisionBody(input: CloudComputerProvisionInput | undefined): Record<string, unknown> {
  const assistant = input?.assistant
  if (!assistant) return {}
  if ('existingAgentUserId' in assistant) return { assistant: { existing_agent_user_id: assistant.existingAgentUserId } }
  return { assistant }
}

export type CloudComputerClient = {
  matchVersion?(deviceId: string, start: boolean, signal?: AbortSignal): Promise<CloudVersionMatchState>
  state(signal?: AbortSignal): Promise<CloudComputerSnapshot>
  provision(input?: CloudComputerProvisionInput): Promise<void>
  wake(input?: CloudComputerWakeInput): Promise<void>
  destroy(): Promise<void>
  /** 删除身份之前，核对清理接口可用且仍是确认框里这一位。 */
  prepareAssistantClose(input: { deviceId: string; assistantId: string }): Promise<void>
  /** 身份与自己的会话已关闭后，只清助理资料并等待存档完成；保留宿主。 */
  closeAssistant(input: { deviceId: string; assistantId: string }, signal?: AbortSignal): Promise<void>
}

export type CloudVersionMatchState = { status: 'idle' } | { status: 'updating' | 'ready'; version: string } | { status: 'failed'; version?: string; error: string }

/**
 * 一次请求最多等多久。管家的四个接口都是立刻回的(开通、叫醒是 202 + 之后看 /state);挂住不回 = 当作连不上 ——
 * ❌ 让「正在唤醒」「正在关掉」一直挂着,也 ❌ 让后面的重试被这一次挡住。
 */
export const CLOUD_COMPUTER_REQUEST_TIMEOUT_MS = 20_000

export function createCloudComputerClient(options: {
  baseUrl: string
  /** 此刻登着的用户的 JWT;没登录就抛。 */
  accessToken: () => Promise<string>
  /** anon key(公开值):经 Supabase 网关时要带,与 supabase-js 调云端函数一致。 */
  anonKey?: string | null
  fetch?: typeof fetch
  requestTimeoutMs?: number
}): CloudComputerClient {
  const doFetch = options.fetch ?? fetch
  const timeoutMs = options.requestTimeoutMs ?? CLOUD_COMPUTER_REQUEST_TIMEOUT_MS
  const request = async (method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, signal?: AbortSignal): Promise<string> => {
    const headers: Record<string, string> = { Authorization: `Bearer ${await options.accessToken()}` }
    if (options.anonKey) headers.apikey = options.anonKey
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const timeout = AbortSignal.timeout(timeoutMs)
    let response: Response
    let raw: string
    try {
      response = await doFetch(`${options.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
      raw = await response.text()
    } catch (error) {
      if (signal?.aborted) throw error
      if (timeout.aborted) throw new CloudComputerError(0, 'network', `cloud-computer ${method} ${path} got no answer within ${Math.round(timeoutMs / 1000)} s`)
      throw new CloudComputerError(0, 'network', error instanceof Error ? error.message : String(error))
    }
    if (!response.ok) throw cloudComputerErrorFromResponse(response.status, raw)
    return raw
  }
  return {
    async matchVersion(deviceId, start, signal) {
      const raw = await request(start ? 'POST' : 'GET', start ? '/version-match' : `/version-match?${new URLSearchParams({ deviceId })}`,
        start ? { deviceId } : undefined, signal)
      const state = JSON.parse(raw) as CloudVersionMatchState
      if (!state || !['idle', 'updating', 'ready', 'failed'].includes(state.status)
        || ((state.status === 'updating' || state.status === 'ready') && typeof state.version !== 'string')
        || (state.status === 'failed' && typeof state.error !== 'string')) throw new CloudComputerError(200, 'bad_response', '云端咕咕没有返回有效的升级状态')
      return state
    },
    async state(signal) {
      const raw = await request('GET', '/state', undefined, signal)
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw new CloudComputerError(200, 'bad_response', `cloud-computer /state returned non-JSON: ${raw.slice(0, 200)}`)
      }
      return parseCloudComputerSnapshot(parsed)
    },
    async provision(input) {
      await request('POST', '/provision', provisionBody(input))
    },
    async wake(input) {
      await request('POST', '/wake', input?.purpose ? { purpose: input.purpose } : {})
    },
    async destroy() {
      await request('DELETE', '/')
    },
    async prepareAssistantClose(input) {
      const raw = await request('GET', `/assistant/close?${new URLSearchParams(input).toString()}`)
      let parsed: { status?: unknown }
      try { parsed = JSON.parse(raw) as { status?: unknown } } catch { throw new CloudComputerError(200, 'bad_response', 'assistant close check returned non-JSON') }
      if (parsed?.status !== 'ready') throw new CloudComputerError(409, 'stale_assistant', 'assistant close is not ready for this identity')
    },
    async closeAssistant(input, signal) {
      const read = async (start: boolean) => {
        const query = new URLSearchParams(input).toString()
        const raw = await request(start ? 'POST' : 'GET', start ? '/assistant/close' : `/assistant/close?${query}`, start ? input : undefined, signal)
        let parsed: { status?: unknown }
        try { parsed = JSON.parse(raw) as { status?: unknown } } catch { throw new CloudComputerError(200, 'bad_response', 'assistant close returned non-JSON') }
        if (parsed?.status !== 'cleaning' && parsed?.status !== 'closed') throw new CloudComputerError(200, 'bad_response', 'assistant close returned an unknown status')
        return parsed.status
      }
      let initial: string
      for (;;) {
        try { initial = await read(true); break } catch (error) {
          if (!(error instanceof CloudComputerError) || error.code !== 'busy') throw error
          signal?.throwIfAborted()
          await new Promise<void>((resolve) => setTimeout(resolve, 2_000))
        }
      }
      for (let status = initial; status !== 'closed'; status = await read(false)) {
        signal?.throwIfAborted()
        await new Promise<void>((resolve) => setTimeout(resolve, 2_000))
      }
    },
  }
}


/**
 * 这台设备是不是云电脑、此刻是什么样子;不是 = null。
 * 管家说睡了而库里的租约还没过期(心跳租约 2 分钟)时,以管家为准 —— 那台沙盒已经删了。
 */
export function cloudComputerPresence(
  device: { device_id: string; is_online: boolean },
  snapshot: CloudComputerSnapshot | null,
  now: number = Date.now(),
): CloudComputerPresence | null {
  if (!snapshot?.deviceId || snapshot.deviceId !== device.device_id) return null
  switch (snapshot.state) {
    case 'asleep':
      return 'asleep'
    case 'waking':
      return 'waking'
    case 'awake':
      if (device.is_online) return 'awake'
      // 管家说醒了、它的 server 过了叫醒的时限还没上线:照库里的离线说(❌ 一直「正在唤醒」)。
      return cloudComputerOverdue(snapshot, now) ? null : 'waking'
    case 'provisioning':
    case 'error':
      // 开通中 / 出错:没有「休眠中会自己醒」这回事,照设备行本来的在线与否说;出错的原因在云电脑那一块上说。
      return null
    case 'none':
      return null
  }
}

/**
 * 发命令 / 开会话之前:这台是不是一台要先叫醒的云电脑。睡着、正在醒都要先调 /wake(正在醒时再调一次无害),
 * 然后照常发出去 —— 命令进队列等它醒来领,管家也会因为这条待领的命令叫醒它。
 */
export function cloudComputerNeedsWake(presence: CloudComputerPresence | null): boolean {
  return presence === 'asleep' || presence === 'waking'
}

/**
 * 这台机器此刻接不接活:在线,或是睡着 / 正在醒的云电脑(先叫醒再发)。各端「对离线机器直接拒绝」的检查一律用它,
 * ❌ 只看 is_online —— 云电脑休眠中 ≠ 离线(规定草稿 cloud-computer「休眠与唤醒」)。
 */
export function deviceAcceptsWork(device: { is_online: boolean; cloud_computer?: CloudComputerPresence }): boolean {
  return device.is_online || cloudComputerNeedsWake(device.cloud_computer ?? null)
}

/** 叫醒云电脑没成:refused = 管家拒绝(积分用完等,`code` 是管家的码)/ failed = 管家报错 / timeout = 等满了还没上线。 */
export class CloudComputerWakeError extends Error {
  constructor(
    readonly reason: 'refused' | 'failed' | 'timeout',
    message: string,
    readonly code: string | null = null,
  ) {
    super(message)
    this.name = 'CloudComputerWakeError'
  }
}

/** 等它醒、并在库里上线,最多等多久(开机约 5 秒 + 放回数据 + server 启动,实测 10–20 秒;留足)。 */
export const CLOUD_COMPUTER_WAKE_TIMEOUT_MS = 120_000

/** 进入此刻这个状态已经超过 `limitMs`(默认叫醒时限);管家没给 since = 不知道,当作没超。 */
export function cloudComputerOverdue(snapshot: Pick<CloudComputerSnapshot, 'since'>, now: number, limitMs = CLOUD_COMPUTER_WAKE_TIMEOUT_MS): boolean {
  const since = snapshot.since ? Date.parse(snapshot.since) : NaN
  return Number.isFinite(since) && now - since > limitMs
}

/**
 * 在它上面开会话 / 打开它上面的会话这类要一条活连接的动作之前:这台是云电脑就叫醒它,等到它真的在线。
 * 不是这个账号的云电脑 = 'not-cloud'(调用方照它本来的离线处理);醒了 = 'online'。
 * 管家拒绝(积分用完)、报错、不在了、等满了还没上线,都以 CloudComputerWakeError 带着原因失败 —— ❌ 一直「正在唤醒」。
 */
export async function wakeCloudComputerUntilOnline(input: {
  client: Pick<CloudComputerClient, 'state' | 'wake'>
  deviceId: string
  /** 那一行此刻在库里在不在线(心跳翻了才算醒好)。 */
  isOnline: (deviceId: string) => Promise<boolean>
  /** 每问到一次 /state 就交出来(渲染层据此更新界面上的「正在唤醒」)。 */
  onSnapshot?: (snapshot: CloudComputerSnapshot) => void
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  signal?: AbortSignal
  /** 搬回本机那一次的叫醒:管家有家就放行,会员到期 / 积分用完也醒得来(不计费)。 */
  purpose?: CloudComputerWakeInput['purpose']
}): Promise<'not-cloud' | 'online'> {
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = input.now ?? Date.now
  const timeoutMs = input.timeoutMs ?? CLOUD_COMPUTER_WAKE_TIMEOUT_MS
  const deadline = now() + timeoutMs
  const read = async (): Promise<CloudComputerSnapshot> => {
    try {
      input.signal?.throwIfAborted()
      const snapshot = await input.client.state(input.signal)
      input.signal?.throwIfAborted()
      input.onSnapshot?.(snapshot)
      return snapshot
    } catch (error) {
      if (input.signal?.aborted) throw error
      throw new CloudComputerWakeError(
        'failed',
        error instanceof Error ? error.message : String(error),
        error instanceof CloudComputerError ? error.code : null,
      )
    }
  }
  const first = await read()
  if (first.deviceId !== input.deviceId) return 'not-cloud'
  if (first.state === 'error') throw new CloudComputerWakeError('failed', first.error ?? 'cloud computer reported an error')
  if (first.state === 'asleep' || first.state === 'waking') {
    try {
      await input.client.wake(input.purpose ? { purpose: input.purpose } : undefined)
    } catch (error) {
      if (error instanceof CloudComputerError) throw new CloudComputerWakeError('refused', error.message, error.code)
      throw error
    }
  }
  for (let snapshot = first; ; snapshot = await read()) {
    input.signal?.throwIfAborted()
    if (snapshot.state === 'error') throw new CloudComputerWakeError('failed', snapshot.error ?? 'cloud computer reported an error')
    if (snapshot.state === 'none') throw new CloudComputerWakeError('failed', 'cloud computer no longer exists', 'not_found')
    if (snapshot.state === 'awake' && (await input.isOnline(input.deviceId))) return 'online'
    if (now() >= deadline) {
      throw new CloudComputerWakeError('timeout', `cloud computer did not come online within ${Math.round(timeoutMs / 1000)} s`)
    }
    await sleep(2_000)
  }
}

/**
 * 给人看的原因只有这几类,各端用自己的文案说(common 词条 `cloudComputer.reason.*`);管家原话、异常原文只进日志 ——
 * 仓库的「文案泄漏」闸:原因进日志,文案只留用户能照做的下一步。规定草稿要的「醒不来就当场说原因」靠的是分得清这几类:
 *  · plan_required 免费档(去升级)· credits_exhausted 积分用完(去充值)· membership_expired 会员到期(去续费,或搬回自己的电脑)
 *  · timeout 两分钟没醒来 · network 连不上云电脑服务
 *  · signed_out 登录失效 · gone 云电脑已经不在了 · failed 云电脑那边出了问题(管家报错、5xx、别的码)
 */
export type CloudComputerFailureKind =
  | 'plan_required'
  | 'credits_exhausted'
  | 'membership_expired'
  | 'timeout'
  | 'network'
  | 'signed_out'
  | 'gone'
  | 'failed'

function failureKindOfCode(code: string | null): CloudComputerFailureKind {
  switch (code) {
    case 'plan_required':
    case 'credits_exhausted':
    case 'membership_expired':
    case 'network':
      return code
    case 'unauthorized':
      return 'signed_out'
    case 'not_found':
      return 'gone'
    default:
      return 'failed'
  }
}

/** 叫醒没成的那个形状(跨 bundle 时只剩字段)→ 给人看的那一类。 */
export function cloudComputerFailureKindOf(failure: { reason?: string | null; code: string | null }): CloudComputerFailureKind {
  return failure.reason === 'timeout' ? 'timeout' : failureKindOfCode(failure.code)
}

/**
 * 管家那扇门(云端函数)说「这里没开放」:部署了、还没配管家地址(503 not_open)。不是出错 —— 客户端把云电脑这一块整个藏起来,
 * 和拿不到管家地址同一个样子;配上以后下一次问到就出现。门在、管家连不上(502 unavailable)、云端函数没部署(404)照旧是出错:
 * 404 分不清「没部署」和「地址拼错」,藏了就是静默坏掉。
 */
export function isCloudComputerNotOpen(error: unknown): boolean {
  return error instanceof CloudComputerError && error.code === 'not_open'
}

/** 一次开通 / 叫醒 / 关掉 / 读状态没成 → 给人看的那一类。 */
export function cloudComputerFailureKind(error: unknown): CloudComputerFailureKind {
  if (error instanceof CloudComputerWakeError) return cloudComputerFailureKindOf(error)
  if (error instanceof CloudComputerError) return failureKindOfCode(error.code)
  return 'failed'
}
