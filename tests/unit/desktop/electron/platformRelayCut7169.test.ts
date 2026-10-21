// #7169 平台中转口:回答中途一头断了,另一头当场跟着断。
// 网关掐断流(上游停流、网关超时)时,原来的 `pipe` 不把中断传给 harness —— Codex 等满 300 s(stream_idle_timeout)才重试;
// harness 先断开时,它在网关上的那条请求也一直开着。这里用本机假网关走真的中转口(platformModelForSession 起的那个),量两头。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const loadEngine = vi.fn<(...args: unknown[]) => Promise<unknown>>()
const resolveAgentModelLaunch = vi.fn<(...args: unknown[]) => Promise<unknown>>()
const revokePlatformModelAccess = vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined)
const logged = vi.hoisted(() => new Map<string, Record<string, ReturnType<typeof import('vitest').vi.fn>>>())
vi.mock('../../../../apps/desktop/electron/lib/logger', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // Every logger records its calls by name; this file reads the relay's.
  createLogger: (name: string) => {
    const methods: Record<string, ReturnType<typeof vi.fn>> = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    logged.set(name, methods)
    return new Proxy(methods, { get: (target, key: string) => (target[key] ??= vi.fn()) })
  },
}))
vi.mock('@gugu/core', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // The session's agent (as #6264's test finds it): without one the session is not on the platform and gets no relay.
  listAgents: async () => [{ gugu_user_id: 'agent-1', cache: { emdash_session_id: 'conv-relay-cut' } }],
}))
vi.mock('../../../../apps/desktop/electron/acp-engine-utils', () => ({ loadEngine: (...args: unknown[]) => loadEngine(...args) }))
vi.mock('../../../../apps/desktop/electron/model-access', () => ({
  checkpointPlatformModelAccess: async () => undefined,
  issuePlatformModelAccess: async () => { throw new Error('not issued in this test') },
  resolveAgentModelLaunch: (...args: unknown[]) => resolveAgentModelLaunch(...args),
  revokePlatformModelAccess: (...args: unknown[]) => revokePlatformModelAccess(...args),
  renewPlatformModelAccess: async () => ({ expiresAt: new Date(Date.now() + 900_000).toISOString(), membershipLocked: [] }),
  markPlatformAccessDetached: async () => undefined,
  settleAdoptedPlatformAccessAtExit: async () => undefined,
  claimPlatformAccessForThisProcess: async () => undefined,
}))
vi.mock('../../../../apps/desktop/electron/session/main/core/sessions/getSessions', () => ({ getSessions: async () => [] }))
vi.mock('../../../../apps/desktop/electron/sessionpage/emdash-agent-provisioning', () => ({ SESSION_CACHE_KEY: 'emdash_session_id' }))
vi.mock('../../../../apps/desktop/electron/session/main/core/agents/harness-model-catalog', () => ({
  getHarnessModelCatalog: async () => ({ kind: 'ready', models: [], selected: null, efforts: [], selectedEffort: null }),
  lookupHarnessModelCatalog: async () => ({ state: { kind: 'ready', models: [], selected: null, efforts: [], selectedEffort: null }, refreshing: false }),
}))
const {
  configurePlatformRelayPersistence,
  platformModelForSession,
  releasePlatformModelForSession,
  resetPlatformRelayPersistenceForTest,
} = await import('../../../../apps/desktop/electron/sessionpage/sessionpage-platform-model')

const CONV = 'conv-relay-cut'
const authProvider = { getAuth: async () => ({ accessToken: 't', refreshToken: null, userId: 'owner-1' }) } as never
const env = { ...process.env, GUGU_HOME: join(tmpdir(), `gugu-relay-cut-${process.pid}`) }
/** How long either end may take to see the other gone: a promptness bound, far under Codex's 300 s. */
const PROMPT_MS = 1500

let gateway: { url: string; close: () => Promise<void>; requestClosed: () => Promise<number>; received: () => number }
let answer: (request: IncomingMessage, response: ServerResponse) => void

/** A local gateway: `answer` decides what each request gets; `requestClosed` resolves when the last request's socket closed. */
async function startGateway(): Promise<typeof gateway> {
  let closed: Promise<number> = new Promise(() => undefined)
  let received = 0
  const server = createServer((request, response) => {
    received += 1
    const t0 = Date.now()
    closed = new Promise((resolve) => request.socket.once('close', () => resolve(Date.now() - t0)))
    answer(request, response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
    requestClosed: () => closed,
    received: () => received,
  }
}

/** The relay's own address for a codex session on the platform model, as the harness gets it. */
async function relayForCodex(): Promise<{ baseUrl: string; apiKey: string }> {
  loadEngine.mockResolvedValue({ id: 'codex', modelConfigInjection: 'codex-config-flags' })
  resolveAgentModelLaunch.mockResolvedValue({
    selection: { source: 'platform', modelId: 'glm-5.3-flash', protocol: 'openai-responses' },
    model: 'glm-5.3-flash',
    env: { OPENAI_BASE_URL: `${gateway.url}/v1`, OPENAI_API_KEY: 'sk-session' },
    access: {
      accessSessionId: 'sess-1', relayUrl: gateway.url, token: 'sk-session', model: 'glm-5.3-flash', modelId: 'glm-5.3-flash',
      protocol: 'openai-responses', expiresAt: new Date(Date.now() + 900_000).toISOString(), contextWindow: 200_000,
      switchableModels: [], membershipLocked: [],
    },
  })
  const platform = await platformModelForSession({ surface: 'tui', sessionId: CONV, providerId: 'codex', authProvider, env })
  return platform.platformProvider!
}

const within = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what}: not within ${ms} ms`)), ms))])

/** The relay's own lines (平台中转…) at any level — the module logs other things on the same logger (session setup). */
const relayLines = () => Object.values(logged.get('sessionpage/platform-model') ?? {})
  .flatMap((fn) => fn.mock.calls.map((call) => String(call[1] ?? '')))
  .filter((message) => message.includes('平台中转'))

const SSE = (event: string, data: object) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

describe('#7169 平台中转口:一头中途断了,另一头当场跟着断', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    resetPlatformRelayPersistenceForTest()
    configurePlatformRelayPersistence({ dataDir: await mkdtemp(join(tmpdir(), 'gugu-relay-cut-')), log: { info: vi.fn(), warn: vi.fn() } })
    gateway = await startGateway()
  })
  afterEach(async () => {
    await releasePlatformModelForSession(CONV).catch(() => undefined)
    await gateway.close()
  })

  it('正常的流原样转过去:状态、响应头、每一段、结尾都在', async () => {
    answer = (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'x-oneapi-request-id': 'req-1' })
      response.write(SSE('response.created', { type: 'response.created' }))
      setTimeout(() => response.end(SSE('response.completed', { type: 'response.completed' })), 50)
    }
    const relay = await relayForCodex()
    const response = await fetch(`${relay.baseUrl}/responses`, { method: 'POST', headers: { authorization: `Bearer ${relay.apiKey}` }, body: '{}' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(response.headers.get('x-oneapi-request-id')).toBe('req-1')
    expect(await within(response.text(), PROMPT_MS, 'the whole answer')).toBe(
      SSE('response.created', { type: 'response.created' }) + SSE('response.completed', { type: 'response.completed' }),
    )
    expect(relayLines()).toEqual([])
  })

  it('网关中途掐断(没有正常收尾):harness 的读当场出错,而不是一直挂着;日志记一笔', async () => {
    answer = (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(SSE('response.output_item.done', { type: 'response.output_item.done', item: { type: 'function_call' } }))
      setTimeout(() => response.socket?.destroy(), 50) // what nginx logged: "upstream prematurely closed connection"
    }
    const relay = await relayForCodex()
    const response = await fetch(`${relay.baseUrl}/responses`, { method: 'POST', headers: { authorization: `Bearer ${relay.apiKey}` }, body: '{}' })
    const read = response.text().then(() => 'ended cleanly', (error: unknown) => `failed: ${error instanceof Error ? error.message : String(error)}`)
    // Before: no end, no error — the harness waited for its own idle timeout. Now: the read fails at once.
    expect(await within(read, PROMPT_MS, 'the harness seeing the cut')).toMatch(/^failed: /)
    await vi.waitFor(() => expect(logged.get('sessionpage/platform-model')?.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: CONV, path: '/v1/responses', status: 200 }),
      expect.stringContaining('网关中途掐断'),
    ))
  })

  it('harness 在回答中途断开:它在网关上的那条请求当场关掉;一条日志都不记(不当成网关掐断)', async () => {
    answer = (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(SSE('response.created', { type: 'response.created' })) // and keeps the answer open: the model still writing
    }
    const relay = await relayForCodex()
    const abort = new AbortController()
    const response = await fetch(`${relay.baseUrl}/responses`, { method: 'POST', headers: { authorization: `Bearer ${relay.apiKey}` }, body: '{}', signal: abort.signal })
    const reader = response.body!.getReader()
    await reader.read() // the first part arrived
    abort.abort()
    expect(await within(gateway.requestClosed(), PROMPT_MS, 'the gateway seeing its request closed')).toBeGreaterThan(0)
    // Codex hangs up like this right after response.completed too (the non-regression run; review ee9fa446e4: 10 lines in
    // 10 turns when the gateway kept the answer open 200 ms after it): not the gateway's cut, and nothing to log.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(relayLines()).toEqual([])
  })

  it('harness 在网关还没回第一个字节时就断开:它在网关上的那条请求也当场关掉', async () => {
    answer = () => undefined // the model still thinking: no status, no byte
    const relay = await relayForCodex()
    const abort = new AbortController()
    const pending = fetch(`${relay.baseUrl}/responses`, { method: 'POST', headers: { authorization: `Bearer ${relay.apiKey}` }, body: '{}', signal: abort.signal }).catch(() => undefined)
    await vi.waitFor(() => expect(gateway.received()).toBe(1)) // the request reached the gateway, which sends nothing
    await new Promise((resolve) => setTimeout(resolve, 100))
    abort.abort()
    await pending
    expect(await within(gateway.requestClosed(), PROMPT_MS, 'the gateway seeing its request closed')).toBeGreaterThan(0)
    // Ours to drop, not the gateway out of reach: no 「连不上网关」 for it.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(relayLines()).toEqual([])
  })

  it('连不上网关:harness 拿到 502,日志说清连不上(和网关掐断一样,下次查得到)', async () => {
    const relay = await relayForCodex()
    await gateway.close() // its port is free now: the relay's request is refused
    const response = await fetch(`${relay.baseUrl}/responses`, { method: 'POST', headers: { authorization: `Bearer ${relay.apiKey}` }, body: '{}' })
    expect(response.status).toBe(502)
    await vi.waitFor(() => expect(logged.get('sessionpage/platform-model')?.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: CONV, path: '/v1/responses', error: expect.stringMatching(/ECONNREFUSED/) }),
      expect.stringContaining('连不上网关'),
    ))
  })
})
