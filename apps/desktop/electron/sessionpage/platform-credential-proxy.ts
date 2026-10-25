import { request as httpRequest, type IncomingMessage, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { finished, pipeline } from 'node:stream'

const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

export interface CredentialProxyOptions {
  upstream: () => URL
  localOnlyHeaders: ReadonlySet<string>
  credential: () => Promise<string>
  refresh: (rejected: string) => Promise<string>
  warn: (event: { kind: 'connection' | 'stream'; status?: number; code?: string }) => void
}

/** The deadline bounds the caller, not the shared rotation: a late successful issue remains usable. */
export async function withinCredentialDeadline<T>(pending: Promise<T>, timeoutMs = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Platform credential refresh timed out')), timeoutMs)
    })])
  } finally {
    clearTimeout(timer)
  }
}

function upstreamHeaders(headers: IncomingHttpHeaders, options: CredentialProxyOptions, token: string, upstream: URL) {
  const result: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase()
    if (value === undefined || HOP_HEADERS.has(key) || options.localOnlyHeaders.has(key)) continue
    // A Claude helper value can appear in BOTH headers. Neither local credential may escape.
    if (key === 'authorization' || key === 'x-api-key') continue
    result[name] = value
  }
  result.host = upstream.host
  result.authorization = `Bearer ${token}`
  if (headers['x-api-key'] !== undefined) result['x-api-key'] = token
  return result
}

/** Replay only an unaccepted 401, once. Request bytes are retained; response SSE is never buffered. */
export async function proxyPlatformCredentialRequest(
  request: IncomingMessage, response: ServerResponse, options: CredentialProxyOptions,
): Promise<void> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const body = Buffer.concat(chunks)
  let upstreamRequest: ReturnType<typeof httpRequest> | undefined
  let harnessGone = response.destroyed
  let gatewayCut = false
  finished(response, (error) => {
    if (!error) return
    if (!gatewayCut) harnessGone = true
    upstreamRequest?.destroy()
  })
  const send = (token: string, retried: boolean): void => {
    if (harnessGone) return
    const upstream = options.upstream()
    const transport = upstream.protocol === 'https:' ? httpsRequest : httpRequest
    upstreamRequest = transport(upstream, {
      method: request.method,
      headers: upstreamHeaders(request.headers, options, token, upstream),
    }, (upstreamResponse) => {
      if (upstreamResponse.statusCode === 401 && !retried) {
        // No inference was accepted and no response headers/bytes have reached the harness.
        upstreamResponse.resume()
        void options.refresh(token).then(next => send(next, true), () => {
          if (!response.headersSent && !harnessGone) {
            response.writeHead(503, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'Platform credential refresh failed' } }))
          }
        })
        return
      }
      const headers: Record<string, string | string[]> = {}
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (value !== undefined && !HOP_HEADERS.has(name.toLowerCase())) headers[name] = value
      }
      response.writeHead(upstreamResponse.statusCode ?? 502, headers)
      upstreamResponse.once('close', () => {
        if (!upstreamResponse.complete && !harnessGone) gatewayCut = true
      })
      pipeline(upstreamResponse, response, (error) => {
        if (!error) return
        upstreamRequest?.destroy()
        if (gatewayCut) options.warn({ kind: 'stream', status: upstreamResponse.statusCode })
      })
    })
    upstreamRequest.on('error', (error: NodeJS.ErrnoException) => {
      if (!harnessGone) options.warn({ kind: 'connection', code: error.code })
      if (!response.headersSent) response.writeHead(502).end()
      else response.destroy()
    })
    upstreamRequest.end(body)
  }
  send(await options.credential(), false)
}
