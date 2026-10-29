// #921 平台保管凭据的客户端:管家 /integrations 的路径、方法、请求体、出错码;MCP 转发口地址与现取的令牌;
// 转发口说「没存」/「对方拒了存着的凭据」时各给一句说得清的错(❌ 当成登录问题)。
import { describe, expect, it, vi } from 'vitest'
import {
  createPlatformIntegrationsClient,
  PlatformCredentialRejectedError,
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
    const listed = { providers: [{ provider: 'amap', accounts: [{ accountId: 'default', connected: true, updatedAt: '2026-10-29T01:00:00Z', checkedAt: '2026-10-29T01:00:01Z' }] }] }
    const { calls, c } = client((method) => {
      if (method === 'GET') return json(listed)
      if (method === 'PUT') return json({ connected: true, updatedAt: '2026-10-29T01:00:00Z', checkedAt: '2026-10-29T01:00:01Z' })
      return new Response(null, { status: 204 })
    })
    await expect(c.list()).resolves.toEqual(listed.providers)
    await expect(c.saveCredential('amap', { apiKey: 'k-123' })).resolves.toEqual({ connected: true, updatedAt: '2026-10-29T01:00:00Z', checkedAt: '2026-10-29T01:00:01Z' })
    await expect(c.deleteCredential('amap')).resolves.toBeUndefined()
    expect(calls.map((x) => `${x.method} ${x.url.replace(BASE, '')} ${x.body === undefined ? '' : JSON.stringify(x.body)}`.trim())).toEqual([
      'GET /integrations',
      'PUT /integrations/amap/credential {"fields":{"apiKey":"k-123"}}',
      'DELETE /integrations/amap/credential',
    ])
    expect(calls[1].headers).toMatchObject({ Authorization: 'Bearer jwt-1', apikey: 'anon', 'Content-Type': 'application/json' })
  })

  it('brings the platform’s error codes back as they are', async () => {
    for (const [status, code] of [[400, 'invalid_fields'], [404, 'unknown_provider'], [422, 'auth_failed'], [502, 'upstream_unavailable'], [503, 'not_open']] as const) {
      const { c } = client(() => json({ error: code, message: 'nope' }, status))
      await expect(c.saveCredential('amap', { apiKey: 'k' })).rejects.toMatchObject({ status, code })
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
})
