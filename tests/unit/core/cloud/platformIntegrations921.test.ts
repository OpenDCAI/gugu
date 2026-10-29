// #921 平台保管凭据的客户端:管家 /integrations 的路径、方法、请求体、出错码;MCP 转发口地址与现取的令牌;
// 转发口说「没存」/「对方拒了存着的凭据」时各给一句说得清的错(❌ 当成登录问题)。
import { describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  createPlatformIntegrationsClient,
  isPlatformServiceMissing,
  PlatformCredentialRejectedError,
  PlatformForwarderBusyError,
  PlatformForwarderRefusedError,
  PlatformProviderUnavailableError,
  PlatformIntegrationNotConnectedError,
} from '@gugu/core/cloud/platformIntegrations'

const BASE = 'https://db.test/functions/v1/cloud-computer'
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

function client(respond: (method: string, url: string, body: unknown) => Response, token = { value: 'jwt-1' }) {
  const calls: Array<{ method: string; url: string; body: unknown; headers: Record<string, string> }> = []
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method: String(init?.method ?? 'GET'), url: String(url), body, headers: init?.headers as Record<string, string> })
    return respond(String(init?.method ?? 'GET'), String(url), body)
  }) as unknown as typeof fetch
  const c = createPlatformIntegrationsClient({ baseUrl: BASE, accessToken: async () => token.value, anonKey: 'anon', fetch: fetchImpl })
  return { calls, c, token }
}

describe('platform integrations client (#921)', () => {
  it('lists, saves and deletes a credential on the paths the platform serves, with the person’s token', async () => {
    const listed = { providers: [{ provider: 'amap', accounts: [{ accountId: 'default', connected: true, state: 'connected', updatedAt: '2026-10-29T01:00:00Z', checkedAt: '2026-10-29T01:00:01Z', disconnectedAt: null }] }] }
    const { calls, c } = client((method) => {
      if (method === 'GET') return json(listed)
      if (method === 'PUT') return json({ connected: true, updatedAt: '2026-10-29T01:00:00Z', checkedAt: '2026-10-29T01:00:01Z' })
      return new Response(null, { status: 204 })
    })
    await expect(c.list()).resolves.toEqual([{
      provider: 'amap',
      accounts: [{ accountId: 'default', connected: true, state: 'connected', updatedAt: '2026-10-29T01:00:00Z', checkedAt: '2026-10-29T01:00:01Z' }],
      disconnectedAt: {},
    }])
    await expect(c.saveCredential('amap', { apiKey: 'k-123' }, { connect: 'manual' })).resolves.toEqual({ connected: true, updatedAt: '2026-10-29T01:00:00Z', checkedAt: '2026-10-29T01:00:01Z' })
    await expect(c.deleteCredential('amap')).resolves.toBeUndefined()
    expect(calls.map((x) => `${x.method} ${x.url.replace(BASE, '')} ${x.body === undefined ? '' : JSON.stringify(x.body)}`.trim())).toEqual([
      'GET /integrations',
      'PUT /integrations/amap/credential {"fields":{"apiKey":"k-123"},"connect":"manual"}',
      'DELETE /integrations/amap/credential',
    ])
    expect(calls[1].headers).toMatchObject({ Authorization: 'Bearer jwt-1', apikey: 'anon', 'Content-Type': 'application/json' })
  })

  it('brings the platform’s error codes back as they are', async () => {
    for (const [status, code] of [[400, 'invalid_fields'], [404, 'unknown_provider'], [422, 'auth_failed'], [502, 'upstream_unavailable'], [503, 'not_open']] as const) {
      const { c } = client(() => json({ error: code, message: 'nope' }, status))
      await expect(c.saveCredential('amap', { apiKey: 'k' }, { connect: 'manual' })).rejects.toMatchObject({ status, code })
    }
  })

  it('points the MCP endpoint at the forwarder, with the token read anew on every call and no key in it', async () => {
    const { c, token } = client(() => json({ jsonrpc: '2.0', id: 1, result: {} }))
    const first = await c.mcpEndpoint('amap')
    expect(first.url).toBe(`${BASE}/integrations/amap/mcp`)
    expect(first.headers).toEqual({ Authorization: 'Bearer jwt-1', apikey: 'anon' })
    token.value = 'jwt-2'
    expect((await c.mcpEndpoint('amap')).headers.Authorization).toBe('Bearer jwt-2')
    expect(first.url).not.toMatch(/key=|jwt/)
  })

  it('turns the forwarder’s not_connected into a clear “not connected”', async () => {
    const onNotConnected = vi.fn()
    const { c } = client(() => json({ error: 'not_connected', message: 'nothing stored' }, 404))
    const endpoint = await c.mcpEndpoint('amap', { onNotConnected })
    const error = await endpoint.fetch(endpoint.url, { method: 'POST', headers: endpoint.headers, body: '{}' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PlatformIntegrationNotConnectedError)
    expect((error as Error).message).toBe('amap is not connected in Gugu any more; reconnect it.')
    expect(onNotConnected).toHaveBeenCalledOnce()
  })

  it('turns credential_rejected into “the saved credential was rejected; reconnect”, never a sign-in problem', async () => {
    const onCredentialRejected = vi.fn()
    const { c } = client(() => json({ error: 'credential_rejected', message: 'upstream said no' }, 409))
    const endpoint = await c.mcpEndpoint('amap', { onCredentialRejected })
    const error = await endpoint.fetch(endpoint.url, { method: 'POST', headers: endpoint.headers, body: '{}' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PlatformCredentialRejectedError)
    expect((error as Error).message).toMatch(/saved amap credential was rejected; reconnect/)
    expect((error as Error).message).not.toMatch(/sign|log ?in|401|unauthori/i)
    expect(onCredentialRejected).toHaveBeenCalledOnce()
  })

  it('passes every other forwarder answer through untouched', async () => {
    const { c } = client(() => json({ jsonrpc: '2.0', id: 1, result: { tools: [] } }))
    const endpoint = await c.mcpEndpoint('amap')
    const response = await endpoint.fetch(endpoint.url, { method: 'POST', headers: endpoint.headers, body: '{}' })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [] } })
  })

  it('tells “this installation has no such service” (the gateway’s 404) apart from the platform’s own answers', async () => {
    // Supabase's gateway when the function is not deployed; a self-hosted gateway with no route for it.
    for (const body of [{ code: 'NOT_FOUND', message: 'Requested function was not found' }, { message: 'no Route matched with those values' }]) {
      const error = await client(() => json(body, 404)).c.list().catch((e: unknown) => e)
      expect(isPlatformServiceMissing(error)).toBe(true)
    }
    // The service is there and answered: not a reason to keep anything on the device.
    for (const [status, code] of [[503, 'not_open'], [404, 'unknown_provider'], [404, 'not_found'], [401, 'unauthorized']] as const) {
      const error = await client(() => json({ error: code, message: 'no' }, status)).c.saveCredential('amap', { apiKey: 'k' }, { connect: 'manual' }).catch((e: unknown) => e)
      expect(isPlatformServiceMissing(error), code).toBe(false)
    }
    expect(isPlatformServiceMissing(new Error('offline'))).toBe(false)
  })

  it('reads each account’s state: reconnect is a kept row that needs a reconnect; not_connected is no row at all', async () => {
    const { c } = client(() => json({ providers: [
      { provider: 'amap', accounts: [
        { accountId: 'default', connected: false, state: 'reconnect', updatedAt: '2026-10-29T01:00:00Z', checkedAt: '2026-10-29T01:00:01Z', disconnectedAt: null },
        { accountId: 'spare', connected: false, state: 'not_connected', updatedAt: null, checkedAt: null, disconnectedAt: null },
      ] },
      { provider: 'didi', accounts: [{ accountId: 'default', connected: true, state: 'connected', updatedAt: null, checkedAt: null, disconnectedAt: null }] },
    ] }))
    expect(await c.list()).toEqual([
      { provider: 'amap', accounts: [{ accountId: 'default', connected: false, state: 'reconnect', updatedAt: '2026-10-29T01:00:00Z', checkedAt: '2026-10-29T01:00:01Z' }], disconnectedAt: {} },
      { provider: 'didi', accounts: [{ accountId: 'default', connected: true, state: 'connected', updatedAt: null, checkedAt: null }], disconnectedAt: {} },
    ])
  })

  it('reads when each account was disconnected; an account with nothing stored still tells it', async () => {
    const { c } = client(() => json({ providers: [
      { provider: 'amap', accounts: [
        { accountId: 'default', connected: false, state: 'not_connected', updatedAt: null, checkedAt: null, disconnectedAt: '2026-10-29T03:00:00.000Z' },
        { accountId: 'spare', connected: true, state: 'connected', updatedAt: null, checkedAt: null, disconnectedAt: null },
      ] },
      { provider: 'didi', accounts: [] },
    ] }))
    expect(await c.list()).toEqual([
      { provider: 'amap', accounts: [{ accountId: 'spare', connected: true, state: 'connected', updatedAt: null, checkedAt: null }], disconnectedAt: { default: '2026-10-29T03:00:00.000Z' } },
      { provider: 'didi', accounts: [], disconnectedAt: {} },
    ])
  })

  it('an answer that lacks state or disconnectedAt is a bad answer, not a guess', async () => {
    const full = { accountId: 'default', connected: true, state: 'connected', updatedAt: null, checkedAt: null, disconnectedAt: null }
    for (const missing of ['state', 'disconnectedAt'] as const) {
      const { [missing]: _dropped, ...account } = full
      const { c } = client(() => json({ providers: [{ provider: 'amap', accounts: [account] }] }))
      await expect(c.list()).rejects.toMatchObject({ code: 'bad_response' })
    }
  })

  it('a #649 key goes up marked as a migration and never as manual; the connection page marks its PUT manual', async () => {
    const { calls, c } = client(() => json({ connected: true, updatedAt: null, checkedAt: null }))
    await c.saveCredential('amap', { apiKey: 'k' }, { migration: { savedAt: null } })
    await c.saveCredential('amap', { apiKey: 'k' }, { migration: { savedAt: '2026-10-29T01:00:00.000Z' } })
    await c.saveCredential('amap', { apiKey: 'k' }, { connect: 'manual' })
    // A PUT without a marker would count as a migration with an unknown save time: no path sends one.
    expect(calls.map((call) => call.body)).toEqual([
      { fields: { apiKey: 'k' }, migration: { savedAt: null } },
      { fields: { apiKey: 'k' }, migration: { savedAt: '2026-10-29T01:00:00.000Z' } },
      { fields: { apiKey: 'k' }, connect: 'manual' },
    ])
  })

  it('brings a turned-down migration back by its code', async () => {
    for (const code of ['already_connected', 'disconnected_after'] as const) {
      const { c } = client(() => json({ error: code, message: 'no' }, 409))
      await expect(c.saveCredential('amap', { apiKey: 'k' }, { migration: { savedAt: null } })).rejects.toMatchObject({ status: 409, code })
    }
  })
})

/** The platform forwarder answering as AMap's MCP until a tool is called, then `onCall`. */
function forwarder(onCall: () => Response) {
  return (method: string, _url: string, body: unknown) => {
    if (method !== 'POST') return new Response(null, { status: 405 })
    const message = body as { id?: number; method?: string }
    if (message.id === undefined) return new Response(null, { status: 202 })
    if (message.method === 'initialize') {
      return Response.json({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'amap', version: '1' } } })
    }
    if (message.method === 'tools/list') return Response.json({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'maps_weather', inputSchema: { type: 'object' } }] } })
    return onCall()
  }
}

/** A session's call through the real MCP transport: connect, list, then call a tool. */
async function callAmapTool(onCall: () => Response) {
  const { c } = client(forwarder(onCall))
  const endpoint = await c.mcpEndpoint('amap')
  const mcp = new Client({ name: 'test', version: '1' })
  await mcp.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: endpoint.headers }, fetch: endpoint.fetch }))
  try {
    await mcp.listTools()
    return await mcp.callTool({ name: 'maps_weather', arguments: { city: '北京' } })
  } finally {
    await mcp.close()
  }
}

describe('a forwarded call that the platform turns down (#921)', () => {
  it('says “the saved credential was rejected; reconnect” on any call, not only on initialize', async () => {
    const error = await callAmapTool(() => json({ error: 'credential_rejected', message: 'upstream said no' }, 409)).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PlatformCredentialRejectedError)
  })

  it.each([
    ['too many calls open at once', 429, 'too_many_streams', '7', /try again in 7 s/],
    ['rate-limited', 429, 'rate_limited', '3', /try again in 3 s/],
    ['timed out', 408, 'request_timeout', null, /didn't reach the Gugu platform in time; try again shortly/],
  ] as const)('reads %s as temporary: try again later, never reconnect, sign-in or not connected', async (_case, status, code, retryAfter, wording) => {
    const answer = () => new Response(JSON.stringify({ error: code, message: 'busy' }), { status, headers: retryAfter ? { 'retry-after': retryAfter } : {} })
    const error = await callAmapTool(answer).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PlatformForwarderBusyError)
    expect((error as Error).message).toMatch(wording)
    expect((error as Error).message).not.toMatch(/not connected|reconnect|sign|log ?in|401/i)
  })

  it.each([
    ['a request it cannot read', 400, 'invalid_request', /could not read this amap request/i],
    ['a batch with too many tool calls', 413, 'too_large', /too many amap tool calls in one request/i],
  ] as const)('says plainly when the platform turns down %s: not a reconnect, not sign-in, not busy', async (_case, status, code, wording) => {
    const error = await callAmapTool(() => json({ error: code, message: 'no' }, status)).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PlatformForwarderRefusedError)
    expect((error as Error).message).toMatch(wording)
    expect((error as Error).message).not.toMatch(/not connected|reconnect|sign|log ?in|401|try again/i)
  })

  it('a call AMap cannot serve right now (502 upstream_unavailable) says so: not a reconnect, not sign-in, not “not connected”', async () => {
    const error = await callAmapTool(() => json({ error: 'upstream_unavailable', message: 'AMap quota' }, 502)).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PlatformProviderUnavailableError)
    expect((error as Error).message).toMatch(/amap isn't available right now; try again later/i)
    expect((error as Error).message).not.toMatch(/not connected|reconnect|sign|log ?in|401/i)
  })
})
