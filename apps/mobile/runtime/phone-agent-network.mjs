import { setTimeout as delay } from 'node:timers/promises'

const transportCodes = new Map([
  ['ENOTFOUND', 'dns'], ['EAI_AGAIN', 'dns'],
  ['ETIMEDOUT', 'timeout'], ['UND_ERR_CONNECT_TIMEOUT', 'timeout'], ['UND_ERR_HEADERS_TIMEOUT', 'timeout'], ['UND_ERR_BODY_TIMEOUT', 'timeout'],
  ['ECONNRESET', 'connection_reset'], ['EPIPE', 'connection_reset'], ['UND_ERR_SOCKET', 'connection_reset'],
  ['ECONNREFUSED', 'unreachable'], ['ENETUNREACH', 'unreachable'], ['EHOSTUNREACH', 'unreachable'],
])
const transientStatus = new Set([408, 425, 500, 502, 503, 504])

/** Whitelist transport facts. Never retain an error message, URL, body, header, or ticket. */
export function phoneRequestFailure(error, status) {
  if (['dns', 'timeout', 'connection_reset', 'unreachable', 'network', 'service', 'authorization', 'quota', 'other'].includes(error?.category)) {
    return { category: error.category, ...(transportCodes.has(error.code) ? { code: error.code } : {}), ...(Number.isInteger(error.status) ? { status: error.status } : {}), retryable: error.retryable === true }
  }
  const codes = []
  const seen = new Set()
  const visit = (item) => {
    if (!item || typeof item !== 'object' || seen.has(item) || seen.size >= 12) return
    seen.add(item)
    if (transportCodes.has(item.code)) codes.push(item.code)
    if (item.name === 'TimeoutError') codes.push('ETIMEDOUT')
    visit(item.cause)
    if (Array.isArray(item.errors)) item.errors.forEach(visit)
  }
  visit(error)
  const code = codes[0]
  if (code) return { category: transportCodes.get(code), code, retryable: true }
  const httpStatus = status ?? error?.status
  if (Number.isInteger(httpStatus)) return { category: [401, 403].includes(httpStatus) ? 'authorization' : httpStatus === 429 ? 'quota' : 'service', status: httpStatus, retryable: transientStatus.has(httpStatus) }
  if (/fetch failed|failed to fetch|network request failed|networkerror/i.test(error?.message ?? '')) return { category: 'network', retryable: true }
  if (/timed out|timeout/i.test(error?.message ?? '')) return { category: 'timeout', retryable: true }
  return { category: 'other', retryable: false }
}

/** Only the API operation is named. Query strings and request values never enter diagnostics. */
export function phoneRequestOperation(input, init = {}) {
  const path = new URL(typeof input === 'string' || input instanceof URL ? input : input.url).pathname
  if (path === '/auth/v1/token') return 'auth.refresh'
  if (path === '/auth/v1/user') return 'auth.verify'
  if (path === '/auth/v1/logout') return 'auth.logout'
  if (path === '/functions/v1/model-access') {
    let body
    try { body = JSON.parse(init.body) } catch { /* only known action names are useful */ }
    return ['catalog', 'issue', 'renew', 'checkpoint', 'revoke'].includes(body?.action) ? `model-access.${body.action}` : 'model-access'
  }
  const rest = /^\/rest\/v1\/(rpc\/)?([a-z_]{1,64})$/.exec(path)
  return rest ? `${rest[1] ? 'rpc' : 'table'}.${rest[2]}` : 'http.request'
}

export function phonePreparationFailureText(error) {
  const failure = phoneRequestFailure(error)
  const reason = { dns: '网络地址暂时解析不了', timeout: '网络连接持续超时', connection_reset: '网络连接反复中断', unreachable: '暂时连不上服务', network: '网络暂时连不上', service: '服务暂时不可用', authorization: '登录或授权已失效', quota: '当前可用额度不足' }[failure.category]
  return reason ? `这次手机任务没能完成，${reason}。` : null
}

/** One deadline across verification, status reporting and model access; never replays a tool action. */
export function createPhonePreparation({ signal, run = (action) => action(), record = () => undefined, budgetMs = 45_000, maxAttempts = 3, retryDelayMs = 500, now = Date.now, wait = delay }) {
  const deadline = now() + budgetMs
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(budgetMs)])
  return async (operation, action) => {
    for (let attempt = 1; ; attempt++) {
      signal.throwIfAborted()
      bounded.throwIfAborted()
      try {
        return await run(action, { signal: bounded, deadline })
      } catch (error) {
        signal.throwIfAborted()
        const failure = phoneRequestFailure(error)
        const pause = retryDelayMs * 2 ** (attempt - 1)
        const retry = failure.retryable && attempt < maxAttempts && now() + pause < deadline && !bounded.aborted
        await record({ operation, attempt, ...failure, retry })
        if (!retry) throw error
        try { await wait(pause, undefined, { signal: bounded }) }
        catch (error) { signal.throwIfAborted(); bounded.throwIfAborted(); throw error }
      }
    }
  }
}
