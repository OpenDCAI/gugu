import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { proxyPlatformCredentialRequest, withinCredentialDeadline } from '../../../../apps/desktop/electron/sessionpage/platform-credential-proxy'
import { deferred } from '../../../support/testHarness'

const servers: Server[] = []
async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test endpoint')
  return `http://127.0.0.1:${address.port}/v1/messages?stream=true`
}
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections()
    server.close(() => resolve())
  })))
})

describe('the host credential relay', () => {
  it('waits for the shared credential and replaces both local auth headers without changing bytes', async () => {
    const issued = deferred<string>()
    const readCredential = deferred<void>()
    const calls: Array<{ body: Buffer; headers: IncomingMessage['headers'] }> = []
    const upstream = await serve((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(chunk))
      request.on('end', () => {
        calls.push({ body: Buffer.concat(chunks), headers: request.headers })
        response.end('accepted')
      })
    })
    const warn = vi.fn()
    const relay = await serve((request, response) => {
      void proxyPlatformCredentialRequest(request, response, {
        upstream: () => new URL(upstream), localOnlyHeaders: new Set(['x-local-hint']),
        credential: () => { readCredential.resolve(); return issued.promise },
        refresh: vi.fn(), warn,
      })
    })
    const body = Buffer.from('{"prompt":"原图与报告\\n","stream":true} \n')
    const result = fetch(relay, { method: 'POST', headers: {
      authorization: 'Bearer local-secret', 'x-api-key': 'local-secret',
      'x-local-hint': 'local-only', 'anthropic-version': '2023-06-01', 'x-custom': 'unchanged',
    }, body })
    await readCredential.promise
    expect(calls).toHaveLength(0)
    issued.resolve('platform-fresh')
    expect(await (await result).text()).toBe('accepted')
    expect(calls[0].body).toEqual(body)
    expect(calls[0].headers).toMatchObject({ authorization: 'Bearer platform-fresh', 'x-api-key': 'platform-fresh', 'x-custom': 'unchanged', 'anthropic-version': '2023-06-01' })
    expect(calls[0].headers['x-local-hint']).toBeUndefined()
    expect(JSON.stringify(calls)).not.toContain('local-secret')
    expect(warn).not.toHaveBeenCalled()
  })

  it.each([200, 401])('refreshes and replays a 401 only once, including when the second status is %s', async (secondStatus) => {
    const bodies: Buffer[] = []
    const auth: unknown[] = []
    const upstream = await serve((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(chunk))
      request.on('end', () => {
        bodies.push(Buffer.concat(chunks)); auth.push(request.headers.authorization)
        response.writeHead(bodies.length === 1 ? 401 : secondStatus)
        response.end(bodies.length === 1 ? 'first rejection' : 'second response')
      })
    })
    const refresh = vi.fn(async () => 'platform-next')
    const warn = vi.fn()
    const relay = await serve((request, response) => {
      void proxyPlatformCredentialRequest(request, response, {
        upstream: () => new URL(upstream), localOnlyHeaders: new Set(),
        credential: async () => 'platform-first', refresh, warn,
      })
    })
    const body = Buffer.from(JSON.stringify({ prompt: '字节'.repeat(60_000), stream: true }))
    const result = await fetch(relay, { method: 'POST', body })
    expect(result.status).toBe(secondStatus)
    expect(await result.text()).toBe('second response')
    expect(bodies).toEqual([body, body])
    expect(auth).toEqual(['Bearer platform-first', 'Bearer platform-next'])
    expect(refresh).toHaveBeenCalledExactlyOnceWith('platform-first')
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/platform-first|platform-next/)
  })

  it('delivers SSE chunks before the upstream finishes', async () => {
    const finish = deferred<void>()
    const upstream = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'x-stream-test': 'kept' })
      response.write('event: message_start\ndata: first\n\n')
      void finish.promise.then(() => response.end('event: message_stop\ndata: last\n\n'))
    })
    const relay = await serve((request, response) => {
      void proxyPlatformCredentialRequest(request, response, {
        upstream: () => new URL(upstream), localOnlyHeaders: new Set(),
        credential: async () => 'fresh', refresh: vi.fn(), warn: vi.fn(),
      })
    })
    const result = await fetch(relay, { method: 'POST', body: '{}' })
    expect(result.headers.get('x-stream-test')).toBe('kept')
    const reader = result.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('event: message_start\ndata: first\n\n')
    finish.resolve()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('event: message_stop\ndata: last\n\n')
    expect((await reader.read()).done).toBe(true)
  })

  it('reports passive stream timings once without recording response content or credentials', async () => {
    const wire = 'event: ping\ndata: {"type":"ping"}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"private response"}}\n\n'
    const upstream = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(wire)
    })
    const streamTiming = vi.fn()
    const relay = await serve((request, response) => {
      void proxyPlatformCredentialRequest(request, response, {
        upstream: () => new URL(upstream), localOnlyHeaders: new Set(),
        credential: async () => 'private-token', refresh: vi.fn(), warn: vi.fn(), streamTiming,
      })
    })
    expect(await (await fetch(relay, { method: 'POST', body: '{}' })).text()).toBe(wire)
    await vi.waitFor(() => expect(streamTiming).toHaveBeenCalledTimes(1))
    expect(streamTiming.mock.calls[0][0]).toMatchObject({ frames: 2, heartbeatFrames: 1, progressFrames: 1, complete: true })
    expect(JSON.stringify(streamTiming.mock.calls)).not.toMatch(/private response|private-token|content_block_delta/)
  })

  it('records the trailing quiet interval when the native client aborts a stalled stream', async () => {
    const upstream = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('event: message_start\ndata: {"type":"message_start"}\n\n')
    })
    const streamTiming = vi.fn()
    const relay = await serve((request, response) => {
      void proxyPlatformCredentialRequest(request, response, {
        upstream: () => new URL(upstream), localOnlyHeaders: new Set(),
        credential: async () => 'fresh', refresh: vi.fn(), warn: vi.fn(), streamTiming,
      })
    })
    const controller = new AbortController()
    const result = await fetch(relay, { method: 'POST', body: '{}', signal: controller.signal })
    const reader = result.body!.getReader()
    await reader.read()
    controller.abort()
    await expect(reader.read()).rejects.toThrow()
    await vi.waitFor(() => expect(streamTiming).toHaveBeenCalledTimes(1))
    expect(streamTiming.mock.calls[0][0]).toMatchObject({ complete: false, progressFrames: 1 })
  })

  it('bounds waiting without cancelling or returning the old credential', async () => {
    vi.useFakeTimers()
    const issued = deferred<string>()
    const pending = withinCredentialDeadline(issued.promise)
    const rejection = expect(pending).rejects.toThrow('credential refresh timed out')
    await vi.advanceTimersByTimeAsync(2_000)
    await rejection
    issued.resolve('late-fresh')
    await expect(issued.promise).resolves.toBe('late-fresh')
  })

  it('logs transport failure metadata without either credential value', async () => {
    const upstream = await serve((_request, response) => response.end())
    await new Promise<void>(resolve => servers[0].close(() => resolve()))
    const warn = vi.fn()
    const relay = await serve((request, response) => {
      void proxyPlatformCredentialRequest(request, response, {
        upstream: () => new URL(upstream), localOnlyHeaders: new Set(),
        credential: async () => 'platform-private', refresh: vi.fn(), warn,
      })
    })
    const result = await fetch(relay, { headers: { authorization: 'Bearer local-private', 'x-api-key': 'local-private' } })
    expect(result.status).toBe(502)
    expect(warn).toHaveBeenCalledWith({ kind: 'connection', code: 'ECONNREFUSED' })
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/platform-private|local-private/)
  })
})
