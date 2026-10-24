import { currentAuthSessionSignal } from './authSessionLoss'

// @@@clock-skew-guard-removed (#4935, owner 2026-09-04) — 这里曾有 #2755 的时钟偏移守卫:拿「响应被处理的时刻」减
// 响应头 Date,两次一致就整屏锁死并指控用户电脑。它把页面挂起(合盖/App Nap/后台冻结)期间在路上的响应
// 读成「本地钟快了」,三边钟全准也锁(owner 撞到「快约 66 分钟」= 页面挂起了 66 分钟)。owner 定性为过度防御,
// 整套删除:钟真错时由登录/续期失败自己说话。❌ 别再加回任何「按响应时间判钟」的整屏闸。
export const AUTH_NETWORK_TIMEOUT_MS = 15_000
// 共享测试库 pg_stat_statements(09-17 起 2823 万次 authenticated 调用):PostgREST 语句服务端最长 7.9s(sync_since),
// 均值都在 250ms 以内。30s = 最慢那条的近 4 倍,留给弱网传输;再长就只可能是连接已经死了。
export const REST_NETWORK_TIMEOUT_MS = 30_000

// @@@auth-teardown-boundary (#2187) — 渲染层通向云端的数据面请求(主客户端与 schema-scoped clients 的
// REST/storage)生命周期以 auth generation 为界。边界 = auth-session AbortSignal(会话存续期武装;用户点
// 退出或会话丢失即 abort;下一个会话换新 signal)。每个请求绑定发起时刻的当前 signal:在途请求在边界处
// 就地中止,边界后旧 generation 的晚发请求在发出前即被拒——而不是静默回落 anon key(后者曾表现为
// teardown 期对 chat_members/identity.users 的 REST 401 burst)。新登录换新 signal,新 generation 不受影响。
// 唯一豁免:/auth/v1(GoTrue)。auth 面是边界自身的控制通道——登出 POST 发生在边界形成之后,重新登录
// 发生在下一个 generation 建立之前,二者都必须跨代可达;数据面(/rest/v1、/storage/v1)才受边界约束。
function requestPath(input: RequestInfo | URL): string {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  try {
    return new URL(url).pathname
  } catch {
    return ''
  }
}

async function fetchWithSignals(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  signals: AbortSignal[],
): Promise<Response> {
  // PostgREST reads the finite body after fetch resolves; keep that read inside the same deadline and signal cleanup.
  const complete = async (response: Response): Promise<Response> => requestPath(input).startsWith('/rest/v1/') && response.body
    ? new Response(await response.arrayBuffer(), response)
    : response
  if (signals.length === 1) return fetch(input, { ...init, signal: signals[0] }).then(complete)
  if (typeof AbortSignal.any === 'function') {
    return fetch(input, { ...init, signal: AbortSignal.any(signals) }).then(complete)
  }

  const controller = new AbortController()
  const listeners: Array<() => void> = []
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort()
      break
    }
    const listener = () => controller.abort()
    signal.addEventListener('abort', listener, { once: true })
    listeners.push(() => signal.removeEventListener('abort', listener))
  }
  try {
    return await fetch(input, { ...init, signal: controller.signal }).then(complete)
  } finally {
    listeners.forEach((remove) => remove())
  }
}

// @@@rejected-token-recovery (#6338) — 服务端不认这张登录通行证时(换了签名章、被提前作废),数据面请求
// 以前只会原样把 401 交回去,续期只按到期时间排程 ⇒ 在线用户要卡到通行证自然到期(最长一小时),重启也不好。
// 现在:带着**用户通行证**的数据面请求被拒,就请会话协调器换证(与到期续期共用一条单飞),换到新证后用它
// 把这一个请求重发一次。只重发一次;访客 key(anon)被拒不在此列 —— 那不是换证能解决的。
// 协调器在 supabase.ts 之后才构造,所以用注册而不是 import,避免循环依赖。
type RejectedAccessTokenRecovery = (rejected: string) => Promise<string | null>
let recoverRejectedAccessToken: RejectedAccessTokenRecovery | null = null
export function setRejectedAccessTokenRecovery(recovery: RejectedAccessTokenRecovery | null): void {
  recoverRejectedAccessToken = recovery
}

function bearerOf(headers: HeadersInit | undefined): string | null {
  const value = new Headers(headers).get('Authorization')
  return value?.startsWith('Bearer ') ? value.slice('Bearer '.length) : null
}

function isUserAccessToken(token: string): boolean {
  try {
    const payload = token.split('.')[1]
    if (!payload) return false
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    return (JSON.parse(json) as { role?: unknown }).role === 'authenticated'
  } catch {
    return false
  }
}

// PostgREST / edge functions 用 401 说「这张证不认」;storage 用 400/403 + 描述 JWT 的正文。
async function isRejectedTokenResponse(input: RequestInfo | URL, response: Response): Promise<boolean> {
  if (response.status === 401) return true
  if (response.status !== 400 && response.status !== 403) return false
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (!new URL(url).pathname.startsWith('/storage/v1/')) return false
  const body = await response.clone().text().catch(() => '')
  return /jwt|signature|token/i.test(body)
}

export async function authBoundedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const path = requestPath(input)
  if (path.startsWith('/auth/v1/')) {
    const timeout = AbortSignal.timeout(AUTH_NETWORK_TIMEOUT_MS)
    return fetchWithSignals(input, init, init?.signal ? [init.signal, timeout] : [timeout])
  }
  const boundary = currentAuthSessionSignal()
  const callerSignal = init?.signal && init.signal !== boundary ? init.signal : null
  // @@@rest-deadline — PostgREST 请求都是有界读写,连接悄悄断了(手机切后台/换网)就永远等不到回包:
  // 修订派发等这一批的 listener 全部结算,一个挂住就冻住整条实时投递;历史窗口的 loading 也一直不清,
  // 点「N 条新消息」、往下翻、退出再进全都不动(岳 10-08)。超时让它变成响亮的失败,交给调用方已有的重试
  // (修订派发按 consumer 退避,历史窗口清 loading)。读写都是约 30s 失败:超时不再让 postgrest-js 自带的
  // 读重试(1/2/4s 退避 3 次)再叠三个 30s,见 restDeadlineError。storage 上传下载可以合法地很久,不在此列。
  const deadline = path.startsWith('/rest/v1/') ? AbortSignal.timeout(REST_NETWORK_TIMEOUT_MS) : null
  const send = (requestInit: RequestInit | undefined, sessionBoundary: AbortSignal) =>
    fetchWithSignals(input, requestInit, [...(callerSignal ? [callerSignal] : []), sessionBoundary, ...(deadline ? [deadline] : [])])
      // 按「哪个 signal 触发了」认超时,不按 fetch 抛出的错误对象认:WebView <116 的 fetch 不管 signal.reason,
      // 一律抛「The user aborted a request.」的 AbortError(mac1 WebView 113 实测),超时会被当成生命周期取消悄悄吞掉。
      .catch((error: unknown) => {
        throw deadline?.aborted && !sessionBoundary.aborted && !callerSignal?.aborted ? restDeadlineError() : error
      })
  const response = await send(init, boundary)

  const sent = bearerOf(init?.headers)
  if (!recoverRejectedAccessToken || !sent || !isUserAccessToken(sent) || input instanceof Request) return response
  if (!(await isRejectedTokenResponse(input, response))) return response
  const next = await recoverRejectedAccessToken(sent)
  if (!next || next === sent) return response
  const headers = new Headers(init?.headers)
  headers.set('Authorization', `Bearer ${next}`)
  // 重发绑此刻的边界(同一个人换证不重建边界,#7408,这里就是原来那个;换了人的证上面已经拒了)。
  const retryBoundary = currentAuthSessionSignal()
  return send({ ...init, headers }, retryBoundary)
}

// 秒级的网络抖动(Failed to fetch、503/520)仍由 postgrest-js 重试;超时这一种失败只留上层一层重试。
// ⚠ 依赖 postgrest-js(2.103)executeWithRetry 对 code==='ABORT_ERR' 直接抛出、不重试 —— 升级 postgrest-js 时先看这条,
// restRequestDeadline.test.ts 用真的 PostgrestClient 钉着它。name 是 TimeoutError:不是生命周期取消,照样响亮失败。
function restDeadlineError(): Error {
  return Object.assign(new Error(`REST request timed out after ${REST_NETWORK_TIMEOUT_MS} ms`), { name: 'TimeoutError', code: 'ABORT_ERR' })
}

// 预期的生命周期取消(上面的边界,或调用方自己的 .abortSignal)不是数据失败——消费方据此安静收场,
// 不落 console.error / 不置 error 态。PostgREST-js 把被中止的 fetch 包成 `{ message: 'AbortError: …' }`,
// 产品链路再 `throw new Error(error.message)`,所以除 DOMException 外还要认包装后的 message 形状。
// 只匹配 abort 形状:会话仍有效时的真实失败(401/5xx/网络错)不在此列,照常 fail loud。
export function isLifecycleCancellation(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true
  return error instanceof Error && (error.name === 'AbortError' || error.message.startsWith('AbortError'))
}
