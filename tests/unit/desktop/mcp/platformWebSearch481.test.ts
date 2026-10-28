import { createServer, type Server } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDesktopGuguMcpHost, type DesktopGuguMcpHost } from '../../../../apps/desktop/electron/acp-engine-utils'
import { platformWebSearchForSession } from '../../../../apps/desktop/electron/sessionpage/sessionpage-platform-search'

const state = vi.hoisted(() => ({
  held: null as { model: string; relayUrl: string; callableRoutes?: Record<string, string[]> } | null,
  selected: 'glm-5.3',
  credential: vi.fn<(id: string) => Promise<string>>(async () => 'test-search-credential'),
}))
vi.mock('../../../../apps/desktop/electron/sessionpage/sessionpage-platform-model', () => ({
  claudePlatformSearchSession: () => state.held,
  credentialForRuntimeRequest: (id: string) => state.credential(id),
}))
vi.mock('../../../../apps/desktop/electron/session/main/core/sessions/getSessions', () => ({
  getSessions: async () => [{ id: 'search-session', model: state.selected }],
}))
let host: DesktopGuguMcpHost | undefined
let server: Server | undefined
let client: Client | undefined
let reply = { status: 200, body: JSON.stringify({ output: 'Results\n[source](https://example.com)\n' }) }
const calls: { path?: string; method?: string; auth?: string; body: unknown }[] = []

beforeEach(async () => {
  state.credential.mockReset().mockResolvedValue('test-search-credential')
  state.selected = 'glm-5.3'
  reply = { status: 200, body: JSON.stringify({ output: 'Results\n[source](https://example.com)\n' }) }
  calls.length = 0
  server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += String(chunk) })
    request.on('end', () => {
      calls.push({ path: request.url, method: request.method, auth: request.headers.authorization, body: JSON.parse(body) })
      response.writeHead(reply.status, { 'content-type': 'application/json' }).end(reply.body)
    })
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  state.held = { model: 'glm-5.3', relayUrl: `http://127.0.0.1:${address.port}`, callableRoutes: { '/v1/alpha/search': ['glm-5.3', 'deepseek-v4'] } }
})
afterEach(async () => {
  vi.useRealTimers()
  await client?.close()
  await host?.dispose()
  client = undefined
  host = undefined
  await new Promise<void>(resolve => { server!.closeAllConnections(); server!.close(() => resolve()) })
})

async function connect(personalAssistant = false) {
  host = createDesktopGuguMcpHost()
  await host.start()
  const grant = await host.grant('search-session', {
    kind: 'session-only', expectedOwnerUserId: 'owner', subjectId: 'agent',
    ...(personalAssistant ? { personalAssistant: true as const } : {}),
    webSearch: platformWebSearchForSession('search-session'), runSessionAction: async () => ({}),
  })
  client = new Client({ name: 'search-probe', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(grant.url), {
    requestInit: { headers: { Authorization: `Bearer ${grant.capability}` } },
  }))
  return client
}

describe('direct platform search (#481)', () => {
  it.each([false, true])('lists and calls search directly (assistant=%s), returning output bytes unchanged', async (assistant) => {
    const c = await connect(assistant)
    expect((await c.listTools()).tools.map(tool => tool.name)).toContain('web_search')
    expect(await c.callTool({ name: 'web_search', arguments: { query: '咕咕 search' } })).toEqual({
      content: [{ type: 'text', text: 'Results\n[source](https://example.com)\n' }],
    })
    expect(calls).toEqual([{
      path: '/v1/alpha/search', method: 'POST', auth: 'Bearer test-search-credential',
      body: { id: 'search-session', model: 'glm-5.3', commands: { search_query: [{ q: '咕咕 search' }] } },
    }])
    expect(state.credential).toHaveBeenCalledExactlyOnceWith('search-session')
    const catalog = await c.callTool({ name: 'catalog_list', arguments: {} })
    expect(JSON.stringify(catalog)).not.toContain('web_search')
  })

  it.each([null, {}, { '/v1/alpha/search': ['another-model'] }] as Array<Record<string, string[]> | null>)('preserves the native list without a matching route: %j', async (routes) => {
    if (routes === null) state.held = null
    else state.held!.callableRoutes = routes
    const c = await connect()
    const names = (await c.listTools()).tools.map(tool => tool.name)
    expect(names).not.toContain('web_search')
    expect(names).toEqual(expect.arrayContaining(['session_spawn', 'catalog_list', 'guide_read']))
  })

  it('uses the current model after a model switch and refuses a model outside the route', async () => {
    const c = await connect()
    state.selected = 'deepseek-v4'
    await c.callTool({ name: 'web_search', arguments: { query: 'test' } })
    expect(calls[0].body).toMatchObject({ model: 'deepseek-v4' })
    state.selected = 'ungranted'
    expect(await c.callTool({ name: 'web_search', arguments: { query: 'test' } })).toMatchObject({
      isError: true, content: [{ text: expect.stringContaining('unavailable for the current platform model') }],
    })
    expect(calls).toHaveLength(1)
  })

  it.each([
    [403, '{"error":"secret upstream credential"}', 'HTTP 403'],
    [429, '{}', 'quota or rate limit'],
    [502, '{}', 'HTTP 502'],
    [200, 'not json', 'invalid JSON'],
    [200, '{"output":12}', 'missing its text output'],
  ])('reports an actionable error without retrying (%s, %s)', async (status, body, message) => {
    reply = { status, body }
    const c = await connect()
    const result = await c.callTool({ name: 'web_search', arguments: { query: 'test' } })
    expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining(message) }] })
    expect(JSON.stringify(result)).not.toContain('secret upstream credential')
    expect(calls).toHaveLength(1)
  })

  it('rejects invalid input and credential failures before sending a billed request', async () => {
    const c = await connect()
    expect(await c.callTool({ name: 'web_search', arguments: {} })).toMatchObject({ isError: true })
    expect(await c.callTool({ name: 'web_search', arguments: { query: ' ' } })).toMatchObject({ isError: true })
    state.credential.mockRejectedValue(new Error('private credential diagnostic'))
    expect(await c.callTool({ name: 'web_search', arguments: { query: 'test' } })).toMatchObject({
      isError: true, content: [{ text: expect.stringContaining('valid platform credential') }],
    })
    expect(calls).toHaveLength(0)
  })

  it('honors cancellation and a released lease without contacting the gateway', async () => {
    const search = platformWebSearchForSession('search-session')
    const abort = new AbortController()
    abort.abort()
    await expect(search.run('test', abort.signal)).rejects.toThrow('cancelled or timed out')
    state.credential.mockImplementation(async () => { state.held = null; return 'test-search-credential' })
    await expect(search.run('test', new AbortController().signal)).rejects.toThrow('no longer available')
    expect(calls).toHaveLength(0)
  })

  it('normalizes Claude runtime model suffixes before sending the gateway alias', async () => {
    const c = await connect()
    state.held!.callableRoutes!['/v1/alpha/search'].push('claude-opus-5')
    state.selected = 'claude-opus-5[1m]'
    await c.callTool({ name: 'web_search', arguments: { query: 'test' } })
    expect(calls[0].body).toMatchObject({ model: 'claude-opus-5' })
  })
})
