import { CapacitorHttp, type HttpOptions, type HttpResponse } from '@capacitor/core'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'

export type NativeHttp = { request(options: HttpOptions): Promise<HttpResponse> }

const CONNECT_TIMEOUT_MS = 15_000
const READ_TIMEOUT_MS = 30_000
/** 这几种状态的 Response 不能带 body(构造会抛)。 */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])

function headersOf(init: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!init) return out
  const entries = init instanceof Headers ? [...init.entries()] : Array.isArray(init) ? init : Object.entries(init)
  for (const [key, value] of entries) out[key] = value
  return out
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name)
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError')
}

/**
 * 手机网页(`https://localhost`)请求第三方授权服务是跨域,而它们不发 CORS 头(飞书、滴答、腾讯文档、Notion、Linear 的
 * MCP 入口实测都没有 `access-control-allow-origin`)—— 浏览器层会直接拦掉。OAuth 的发现 / 注册 / 换令牌要走原生 HTTP
 * (Capacitor 自带的 CapacitorHttp,不必打开全局 fetch 劫持:那会改掉整个 App 的所有请求)。
 *
 * 只认 OAuth 流程会发的形状:字符串 / URLSearchParams 的 body。认不得的 body 抛错,❌ 悄悄发一个空的。
 */
export function createNativeFetch(http: NativeHttp = CapacitorHttp): FetchLike {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = headersOf(init?.headers)
    let data: string | undefined
    const body = init?.body
    if (body === undefined || body === null) data = undefined
    else if (typeof body === 'string') data = body
    else if (body instanceof URLSearchParams) {
      data = body.toString()
      if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8'
    } else throw new TypeError('native fetch only sends string bodies')

    const signal = init?.signal
    if (signal?.aborted) throw abortError(signal)
    let onAbort: (() => void) | undefined
    const aborted = signal
      ? new Promise<never>((_, reject) => {
          onAbort = () => reject(abortError(signal))
          signal.addEventListener('abort', onAbort, { once: true })
        })
      : null
    const sent = http.request({
      url,
      method,
      headers,
      ...(data !== undefined ? { data } : {}),
      connectTimeout: CONNECT_TIMEOUT_MS,
      readTimeout: READ_TIMEOUT_MS,
    })
    let reply: HttpResponse
    try {
      reply = await (aborted ? Promise.race([sent, aborted]) : sent)
    } catch (error) {
      if (signal?.aborted) throw abortError(signal)
      // fetch 的网络层失败是 TypeError;原生插件抛的是 { message }。
      throw new TypeError(error instanceof Error ? error.message : typeof error === 'object' && error && 'message' in error ? String((error as { message: unknown }).message) : String(error))
    } finally {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort)
    }

    const text = typeof reply.data === 'string' ? reply.data : reply.data === undefined || reply.data === null ? '' : JSON.stringify(reply.data)
    const responseHeaders = new Headers()
    for (const [key, value] of Object.entries(reply.headers ?? {})) {
      try {
        responseHeaders.set(key, value)
      } catch {
        // 原生给的头里夹了非法字符的:丢掉那一条,其余照用。
      }
    }
    return new Response(NULL_BODY_STATUSES.has(reply.status) ? null : text, { status: reply.status, headers: responseHeaders })
  }
}
