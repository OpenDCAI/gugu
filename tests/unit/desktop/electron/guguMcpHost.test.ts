import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Server as McpLowLevelServer } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Agent, request as httpRequest, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { awaitPending } from '../../../support/awaitFact'
import {
  GuguMcpHost,
  TOOL_CALL_PROGRESS_MS,
  type GuguMcpGrant,
  type GuguMcpServerFactory,
} from '../../../../apps/desktop/electron/gugu-mcp-host'
import { claudeSessionDelivery, toolsListedReadySource } from '../../../../apps/desktop/electron/sessionpage/claude-session-delivery'

interface TestContext { session: string; value: string; ownerId: string; subjectId: string; toolScope: string; route: string }
const clients: Client[] = []
const hosts: Array<GuguMcpHost<TestContext>> = []

afterEach(async () => {
  await Promise.allSettled(hosts.splice(0).map((host) => host.dispose()))
  await Promise.allSettled(clients.splice(0).map((client) => client.close()))
  vi.restoreAllMocks()
})

function contextFactory(servers: McpServer[] = []) {
  return vi.fn<GuguMcpServerFactory<TestContext>>(async (getContext) => {
    const server = new McpServer({ name: 'gugu-host-test', version: '1.0.0' })
    servers.push(server)
    server.registerTool(
      'read_context',
      { description: 'Read the current grant context.', inputSchema: z.object({}) },
      async () => ({
        content: [{ type: 'text' as const, text: JSON.stringify(getContext()) }],
      }),
    )
    server.registerTool('measure_payload', { inputSchema: z.object({ value: z.string() }) }, async ({ value }) => ({
      content: [{ type: 'text' as const, text: String(Buffer.byteLength(value, 'base64')) }],
    }))
    return server
  })
}

function context(session: string, value: string, ownerId = 'owner-1',
  subjectId = 'agent-1', toolScope = 'gugu', route = 'chat'): TestContext {
  return { session, value, ownerId, subjectId, toolScope, route }
}

async function startHost(factory: GuguMcpServerFactory<TestContext> = contextFactory()) {
  const invariant = ({ ownerId, subjectId, toolScope }: TestContext) => ({ ownerId, subjectId, toolScope })
  const host = new GuguMcpHost<TestContext>(factory, invariant)
  hosts.push(host)
  await host.start()
  return { host, factory }
}

async function openClient(grant: GuguMcpGrant) {
  const client = new Client({ name: 'gugu-host-client', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(grant.url), {
    requestInit: { headers: { Authorization: `Bearer ${grant.capability}` } },
  })
  clients.push(client)
  await client.connect(transport)
  return { client, transport }
}

async function connect(grant: GuguMcpGrant): Promise<Client> {
  return (await openClient(grant)).client
}

async function readContext(client: Client): Promise<TestContext> {
  const result = await client.callTool({ name: 'read_context', arguments: {} })
  const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text
  return JSON.parse(text ?? '') as TestContext
}

describe('GuguMcpHost', () => {
  // #4896 —— 「宿主为 grant K 送出了 tools/list」是 claude TUI 的可投递就绪信号(spec delivery-routing
  // 「session-live 的产地」)。通知点在应答写出之后、按 grant 键控、订阅可取消。
  it('onToolsListed fires per grant once the tools/list response has been sent, and unsubscribes cleanly', async () => {
    const { host } = await startHost()
    const alpha = await host.grant('alpha', context('alpha', 'A'))
    const beta = await host.grant('beta', context('beta', 'B'))
    const seen: string[] = []
    let heard: (() => void) | null = null
    const note = (key: string) => { seen.push(key); heard?.() }
    const stopAlpha = host.onToolsListed('alpha', () => note('alpha'))
    host.onToolsListed('beta', () => note('beta'))

    // 通知点在宿主把应答流写完之后,client 解析到应答与宿主发通知是同一事件循环里的两个尾巴,谁先不定:
    // 等「通知到齐」这件事本身(每来一条叫醒一次),到齐了再逐条比,❌ 2s 上限的轮询。
    const settled = async (expected: string[]) => {
      if (seen.length < expected.length) {
        await awaitPending(`tools/list 通知到第 ${expected.length} 条`, new Promise<void>((resolve) => {
          heard = () => { if (seen.length >= expected.length) resolve() }
        }))
        heard = null
      }
      expect(seen).toEqual(expected)
    }
    const alphaClient = await connect(alpha)
    // initialize 完成 ≠ tools/list:连上不算就绪。
    expect(seen).toEqual([])
    await alphaClient.listTools()
    await settled(['alpha'])
    // 别的 grant 的 tools/list 不串台;一个 client 的第二次 tools/list 再通知一次(订阅者自己做幂等)。
    const betaClient = await connect(beta)
    await betaClient.listTools()
    await settled(['alpha', 'beta'])
    await alphaClient.listTools()
    await settled(['alpha', 'beta', 'alpha'])
    // 工具调用不是 tools/list。
    await readContext(alphaClient)
    expect(seen).toEqual(['alpha', 'beta', 'alpha'])

    stopAlpha()
    await alphaClient.listTools()
    // 退订之后 alpha 不该再有通知。「没有」要在它本该出现之后判:再让 beta 走一次 tools/list、等到它的通知 ——
    // alpha 那次应答早于 beta 这次请求发出,若 alpha 仍有通知,必然排在 beta 的前面。
    await betaClient.listTools()
    await settled(['alpha', 'beta', 'alpha', 'beta'])
  })

  /**
   * 一台宿主、一个端口,但**每张卡一个地址**。
   *
   * 从前每张卡都返回同一个 `/mcp`,只靠 bearer 区分 —— 一条会话上只有一张卡时看不出问题。
   * 集成上来之后一条会话上有 N 张卡(linear、notion……),harness 于是拿到 N 台 **URL 完全相同**
   * 的 server:Claude Code 按地址去重,只连第一台,后面的**静默消失**(不报错、不留日志,
   * 模型只是少一组工具)。owner 2026-09-15 实测:授权了 Notion,新会话里只有 `gugu` 和 `linear`。
   *
   * ⇒ 地址必须逐卡不同。尾段**不是**鉴权(它可猜、可公开);谁能进仍然只看 Authorization。
   */
  it('serves isolated sessions on one loopback port, each grant on its own /mcp/<slot> address', async () => {
    const { host, factory } = await startHost()
    const alphaContext = context('alpha', 'A')
    const betaContext = context('beta', 'B')
    const alpha = await host.grant('alpha', alphaContext)
    const beta = await host.grant('beta', betaContext)

    expect(alpha.url).not.toBe(beta.url)
    expect(new URL(alpha.url).port).toBe(new URL(beta.url).port)
    for (const grant of [alpha, beta]) {
      const url = new URL(grant.url)
      expect(url.hostname).toBe('127.0.0.1')
      expect(url.pathname).toMatch(/^\/mcp\/[A-Za-z0-9_-]+$/)
    }
    // 同一张卡再取一次,地址稳定 —— 会话重连不该换 URL。
    await expect(host.grant('alpha', alphaContext)).resolves.toMatchObject({ url: alpha.url })
    expect(alpha.capability).not.toBe(beta.capability)
    // 尾段不鉴权:拿 alpha 的 bearer 打 beta 的地址,进的仍然是 **alpha** 那张卡的上下文。
    const otherPath = await fetch(new URL('/other', alpha.url), {
      headers: { Authorization: `Bearer ${alpha.capability}` },
    })
    expect(otherPath.status).toBe(404)

    const [alphaClient, betaClient] = await Promise.all([connect(alpha), connect(beta)])
    await expect(readContext(alphaClient)).resolves.toEqual(alphaContext)
    await expect(readContext(betaClient)).resolves.toEqual(betaContext)
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('supports two concurrent clients on one capability and refreshes both contexts', async () => {
    const closeTransport = vi.spyOn(StreamableHTTPServerTransport.prototype, 'close')
    const { host, factory } = await startHost()
    const first = await host.grant('alpha', context('alpha', 'A'))
    const [firstClient, reopenedClient] = await Promise.all([connect(first), connect(first)])
    await expect(readContext(firstClient)).resolves.toMatchObject({ value: 'A' })
    await expect(readContext(reopenedClient)).resolves.toMatchObject({ value: 'A' })

    const refreshed = await host.grant('alpha', context('alpha', 'B', 'owner-1', 'agent-1', 'gugu', 'local-direct'))

    expect(refreshed).toEqual(first)
    await expect(readContext(firstClient)).resolves.toMatchObject({ value: 'B', route: 'local-direct' })
    await expect(readContext(reopenedClient)).resolves.toMatchObject({ value: 'B', route: 'local-direct' })
    expect(factory).toHaveBeenCalledTimes(2)

    await host.revoke('alpha')
    expect(closeTransport).toHaveBeenCalledTimes(2)
  })

  // #4277 owner 拍板:会话不带账号,起 agent 那一刻读当下登录的是谁就以它跑。同一条会话的格子换了
  // 主人 ⇒ 撤旧发新;旧卡上还连着的客户端被切断(它们本来也过不了逐调用的身份核对)。
  it('re-issues the grant when the owner changes: old capability dies, new one serves the new owner', async () => {
    const closeTransport = vi.spyOn(StreamableHTTPServerTransport.prototype, 'close')
    const { host } = await startHost()
    const first = await host.grant('alpha', context('alpha', 'A', 'owner-1', 'agent-1'))
    const firstClient = await connect(first)
    await expect(readContext(firstClient)).resolves.toMatchObject({ value: 'A', ownerId: 'owner-1' })

    const second = await host.grant('alpha', context('alpha', 'B', 'owner-2', 'agent-2'))
    expect(second.capability).not.toBe(first.capability)
    expect(closeTransport).toHaveBeenCalled()

    const stale = await fetch(first.url, { headers: { Authorization: `Bearer ${first.capability}` } })
    expect(stale.status).toBe(401)
    const secondClient = await connect(second)
    await expect(readContext(secondClient)).resolves.toMatchObject({ value: 'B', ownerId: 'owner-2', subjectId: 'agent-2' })
  })

  // 同主人却换 subject / toolScope 不是账号切换,是两条腿对同一条会话说了两种话 ⇒ 仍然拒绝。
  it('still rejects a same-owner grant that changes subject or tool scope', async () => {
    const { host } = await startHost()
    const first = await host.grant('alpha', context('alpha', 'A'))

    await expect(host.grant('alpha', context('alpha', 'B', 'owner-1', 'agent-2'))).rejects.toThrow(
      'cannot change subject or tool scope',
    )
    await expect(host.grant('alpha', context('alpha', 'B', 'owner-1', 'agent-1', 'gugu+session'))).rejects.toThrow(
      'cannot change subject or tool scope',
    )
    await expect(host.grant('alpha', context('alpha', 'B', 'owner-1', 'agent-1', 'gugu', 'local-direct')))
      .resolves.toEqual(first)
  })

  // #6938 名册删掉一个身份(云端已没有它)⇒ 发给它的每一张卡都作废;同一把 key 随后发给新身份,不再撞上面那道检查。
  it('revokeSubject retires every grant of that subject, so the same key can then be granted to a new subject', async () => {
    const { host } = await startHost()
    const gone = await host.grant('taskpage:conv-1', context('gone', 'A', 'owner-1', 'agent-x'))
    const goneIntegration = await host.grant('taskpage:conv-1:linear', context('gone-linear', 'AL', 'owner-1', 'agent-x'))
    const peer = await host.grant('taskpage:conv-2', context('peer', 'P', 'owner-1', 'agent-other'))
    // 没有身份的会话拿的是 session-only 卡,subject 是会话 id(buildSessionOnlyBridge):按 agent id 撤碰不到它。
    const sessionOnly = await host.grant('taskpage:conv-3', context('solo', 'S', 'owner-1', 'conv-3'))
    const [peerClient, soloClient] = await Promise.all([connect(peer), connect(sessionOnly)])
    // 阳控:不撤,新身份就拿不到这把 key 上的卡(#6938 复现的那一句)。
    await expect(host.grant('taskpage:conv-1', context('gone', 'B', 'owner-1', 'agent-y'))).rejects.toThrow(
      'cannot change subject or tool scope',
    )

    await host.revokeSubject('agent-x')

    for (const grant of [gone, goneIntegration]) {
      const refused = await fetch(grant.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${grant.capability}` },
        body: '{not-json',
      })
      expect(refused.status).toBe(401)
    }
    await expect(readContext(peerClient)).resolves.toMatchObject({ value: 'P', subjectId: 'agent-other' })
    await expect(readContext(soloClient)).resolves.toMatchObject({ value: 'S', subjectId: 'conv-3' })
    const fresh = await host.grant('taskpage:conv-1', context('gone', 'B', 'owner-1', 'agent-y'))
    expect(fresh.capability).not.toBe(gone.capability)
    await expect(readContext(await connect(fresh))).resolves.toMatchObject({ value: 'B', subjectId: 'agent-y' })
  })

  it('revokes only the selected grant while its peer stays usable', async () => {
    const closeTransport = vi.spyOn(StreamableHTTPServerTransport.prototype, 'close')
    const grantSignals = new Map<string, AbortSignal>()
    const delegate = contextFactory()
    const { host } = await startHost((getContext, signal) => {
      grantSignals.set(getContext().session, signal)
      return delegate(getContext, signal, (work) => work)
    })
    const alpha = await host.grant('alpha', context('alpha', 'A'))
    const beta = await host.grant('beta', context('beta', 'B'))
    const [alphaClient, betaClient] = await Promise.all([connect(alpha), connect(beta)])
    await Promise.all([readContext(alphaClient), readContext(betaClient)])

    await host.revoke('alpha')

    expect(closeTransport).toHaveBeenCalledTimes(1)
    expect(grantSignals.get('alpha')?.aborted).toBe(true)
    expect(grantSignals.get('beta')?.aborted).toBe(false)
    const revoked = await fetch(alpha.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${alpha.capability}` },
      body: '{not-json',
    })
    expect(revoked.status).toBe(401)
    expect(await revoked.text()).toBe('')
    await expect(readContext(betaClient)).resolves.toMatchObject({ value: 'B' })
  })

  it('retains a revoked grant until a failed client close can be retried', async () => {
    const servers: McpServer[] = []
    const { host } = await startHost(contextFactory(servers))
    const grant = await host.grant('alpha', context('alpha', 'A'))
    await connect(grant)
    const close = vi.spyOn(servers[0]!, 'close')
    close.mockRejectedValueOnce(new Error('close failed once'))

    await expect(host.revoke('alpha')).rejects.toThrow('Failed to close Gugu MCP grant')
    await expect(host.grant('alpha', context('alpha', 'B'))).rejects.toThrow('is still closing')
    await expect(host.revoke('alpha')).resolves.toBeUndefined()
    expect(close).toHaveBeenCalledTimes(2)

    const rejected = await fetch(grant.url, {
      headers: { Authorization: `Bearer ${grant.capability}` },
    })
    expect(rejected.status).toBe(401)
  })

  it('rejects unauthorized input before factory or transport handling', async () => {
    const handleRequest = vi.spyOn(StreamableHTTPServerTransport.prototype, 'handleRequest')
    const { host, factory } = await startHost()
    const grant = await host.grant('alpha', context('alpha', 'A'))

    for (const authorization of [undefined, 'Bearer definitely-wrong']) {
      const response = await fetch(grant.url, {
        method: 'POST',
        headers: authorization ? { Authorization: authorization } : {},
        body: '{not-json',
      })
      expect(response.status).toBe(401)
      expect(await response.text()).toBe('')
    }

    expect(factory).not.toHaveBeenCalled()
    expect(handleRequest).not.toHaveBeenCalled()
  })

  // MCP 规范的 DNS rebinding 防护:浏览器里的页面把自己域名解析到 127.0.0.1 时,Host / Origin 仍是它的域名。
  // 放行判据是「走到了 handler」:带对 bearer 的无会话 GET 在 handler 里回 400;闸拦下的回 403、不建 client。
  it('refuses a non-local Host or Origin before authorization, and lets loopback and Origin-less requests through', async () => {
    const { host, factory } = await startHost()
    const grant = await host.grant('alpha', context('alpha', 'A'))
    const { port } = new URL(grant.url)
    const authorization = `Bearer ${grant.capability}`
    const get = (headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
      const request = httpRequest(grant.url, { headers }, (response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
      })
      request.on('error', reject)
      request.end()
    })

    const reachesHandler: Array<Record<string, string>> = [
      { authorization },
      { authorization, host: `localhost:${port}` },
      { authorization, host: `[::1]:${port}` },
      { authorization, origin: 'http://localhost:5173' },
      { authorization, origin: `http://127.0.0.1:${port}` },
    ]
    const refused: Array<Record<string, string>> = [
      { authorization, host: `evil.example:${port}` },
      { authorization, host: `127.0.0.1@evil.example:${port}` },
      { authorization, origin: 'http://evil.example' },
      { authorization, origin: 'http://127.0.0.1.evil.example' },
      { authorization, origin: 'null' },
      { origin: 'http://evil.example' },
    ]
    for (const headers of reachesHandler) expect(await get(headers), JSON.stringify(headers)).toBe(400)
    for (const headers of refused) expect(await get(headers), JSON.stringify(headers)).toBe(403)

    expect(factory).not.toHaveBeenCalled()
    await expect(readContext(await connect(grant))).resolves.toMatchObject({ value: 'A' })
  })

  it('rejects an oversized authorized request before buffering its body', async () => {
    const { host, factory } = await startHost()
    const grant = await host.grant('alpha', context('alpha', 'A'))
    const { client, transport } = await openClient(grant)
    const legalPayload = Buffer.alloc(25 * 1024 * 1024).toString('base64')
    const accepted = await client.callTool({ name: 'measure_payload', arguments: { value: legalPayload } })
    expect((accepted.content as Array<{ text?: string }>)[0]?.text).toBe(String(25 * 1024 * 1024))
    const response = await fetch(grant.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${grant.capability}`,
        'Mcp-Session-Id': transport.sessionId!,
      },
      body: 'x'.repeat(40 * 1024 * 1024 + 1),
    })

    expect(response.status).toBe(413)
    expect(factory).toHaveBeenCalledOnce()
    await expect(readContext(client)).resolves.toMatchObject({ value: 'A' })
  })

  it('retains a partially initialized runtime when its first close fails', async () => {
    const server = new McpServer({ name: 'partial-client', version: '1.0.0' })
    vi.spyOn(server, 'connect').mockRejectedValue(new Error('connect failed'))
    const close = vi.spyOn(server, 'close').mockRejectedValueOnce(new Error('close failed once'))
    const { host } = await startHost(async () => server)
    const grant = await host.grant('alpha', context('alpha', 'A'))

    await expect(connect(grant)).rejects.toThrow()
    await expect(host.revoke('alpha')).resolves.toBeUndefined()
    expect(close).toHaveBeenCalledTimes(2)
  })

  it('keeps timed-out active request ownership until a later revoke drains it', async () => {
    let started!: () => void
    let release!: () => void
    const requestStarted = new Promise<void>((resolve) => { started = resolve })
    const held = new Promise<void>((resolve) => { release = resolve })
    const factory: GuguMcpServerFactory<TestContext> = async (_getContext, _signal, trackRequest) => {
      const server = new McpServer({ name: 'drain-test', version: '1.0.0' })
      server.registerTool('hold', { inputSchema: z.object({}) }, () => {
        started()
        return trackRequest(held.then(() => ({ content: [{ type: 'text' as const, text: 'released' }] })))
      })
      return server
    }
    const { host } = await startHost(factory)
    const grant = await host.grant('alpha', context('alpha', 'A'))
    const client = await connect(grant)
    void client.callTool({ name: 'hold', arguments: {} }).catch(() => undefined)
    await requestStarted

    vi.useFakeTimers()
    const revoking = host.revoke('alpha').catch((error: unknown) => error)
    try {
      await vi.advanceTimersByTimeAsync(5_001)
      const error = await revoking
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).message).toBe('Failed to close Gugu MCP grant')
      expect((error as AggregateError).errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ message: 'MCP drain timed out' }),
      ]))
      await expect(host.grant('alpha', context('alpha', 'B'))).rejects.toThrow('is still closing')
    } finally {
      vi.useRealTimers()
      release()
    }
    await expect(host.revoke('alpha')).resolves.toBeUndefined()
  })

  it('removes a DELETEd client runtime without disturbing its peer', async () => {
    const closeTransport = vi.spyOn(StreamableHTTPServerTransport.prototype, 'close')
    const { host } = await startHost()
    const grant = await host.grant('alpha', context('alpha', 'A'))
    const [departing, peer] = await Promise.all([openClient(grant), connect(grant)])

    await departing.transport.terminateSession()

    await expect(readContext(departing.client)).rejects.toThrow()
    await expect(readContext(peer)).resolves.toMatchObject({ value: 'A' })
    await host.revoke('alpha')
    expect(closeTransport).toHaveBeenCalledTimes(1)
  })

  it('dispose closes every grant transport and MCP server, then the listener', async () => {
    const closeTransport = vi.spyOn(StreamableHTTPServerTransport.prototype, 'close')
    const servers: McpServer[] = []
    const { host } = await startHost(contextFactory(servers))
    const alpha = await host.grant('alpha', context('alpha', 'A'))
    const beta = await host.grant('beta', context('beta', 'B'))
    await Promise.all([connect(alpha), connect(beta)])
    const closeServers = servers.map((server) => vi.spyOn(server, 'close'))

    await host.dispose()

    expect(closeTransport).toHaveBeenCalledTimes(2)
    for (const closeServer of closeServers) expect(closeServer).toHaveBeenCalledOnce()
    await expect(fetch(alpha.url)).rejects.toThrow()
  })

  // 摩擦单 F45:Node 默认在回答之后给连接挂 5 s(+1 s 余量)的闲置计时器、到点由 host 关;Codex 的连接池闲 90 s,隔 6 s 左右的
  // 调用就写进 host 刚关的连接。host 建在 agentEndpointServer 上:回答之后这头的连接上没有闲置计时器,由复用它的客户端关。
  // 真竞态(reqwest 客户端 × 0.5 ms 扫过关闭那一刻)是 2026-09-30 实测的。
  it('F45: after an answer the host arms no idle timer on the connection — the pool that reuses it closes it', async () => {
    const { host } = await startHost()
    const grant = await host.grant('alpha', context('alpha', 'A'))
    const server = (host as unknown as { server: Server }).server
    const hostSide = new Promise<Socket>((resolve) => server.once('connection', resolve))
    const answered = new Promise<void>((resolve) => server.once('request', (_request, response) => response.on('finish', () => resolve())))
    const agent = new Agent({ keepAlive: true })
    await new Promise<void>((resolve, reject) => {
      httpRequest(grant.url, { agent }, (response) => {
        response.resume()
        response.on('end', resolve)
      }).on('error', reject).end()
    })
    await answered
    expect((await hostSide).timeout).toBeUndefined()
    agent.destroy()
  })
})

// PR-7(Known 1):宿主重启后接回 tmux 里的 claude,它重连早绑的端口、list 工具,都可能早于这条会话的登记
// (钩子在中间等平台票)。就绪于是是这张卡的**状态**,登记时先读,❌ 只等下一次事件。
describe('tools/list as state for a reattached claude', () => {
  async function listedOnce(host: GuguMcpHost<TestContext>, key: string, client: Client) {
    const heard = new Promise<void>((resolve) => { const off = host.onToolsListed(key, () => { off(); resolve() }) })
    await client.listTools()
    await awaitPending(`${key} 的 tools/list 通知`, heard)
  }

  it('remembers per card that tools were listed; a revoked and re-issued card starts over', async () => {
    const { host } = await startHost()
    const client = await connect(await host.grant('alpha', context('alpha', 'A')))
    expect(host.hasListedTools('alpha')).toBe(false)
    await listedOnce(host, 'alpha', client)
    expect(host.hasListedTools('alpha')).toBe(true)
    // 接回时同一张卡再 grant 一次:还是那张卡,状态留着。
    await host.grant('alpha', context('alpha', 'B'))
    expect(host.hasListedTools('alpha')).toBe(true)
    // 撤销、重新签发:新卡从没 list 过起。
    await host.revoke('alpha')
    expect(host.hasListedTools('alpha')).toBe(false)
    await host.grant('alpha', context('alpha', 'C'))
    expect(host.hasListedTools('alpha')).toBe(false)
  })

  it('a reattached session that already listed is ready inside register; a fresh one still waits for the event', async () => {
    const { host } = await startHost()
    const key = 'taskpage:s-known1'
    const client = await connect(await host.grant(key, context('s-known1', 'A')))
    await listedOnce(host, key, client)
    const onLive = vi.fn()
    claudeSessionDelivery.setLiveHooks({ onLive, onOverdue: vi.fn() })
    const reg = { guguAgentUserId: 'agent-known1', sessionId: 's-known1', cwd: '/tmp', chatId: null, providerId: 'claude' }
    try {
      // 新起:同一宿主里上一个引擎留下的「list 过」不算它的。
      claudeSessionDelivery.register(reg, { readySource: toolsListedReadySource(host, key, 'fresh') })
      expect(claudeSessionDelivery.readinessOf('s-known1')).toBe('awaiting')
      expect(onLive).not.toHaveBeenCalled()
      // 接回:readySource 在 register 里同步 markReady —— 这时 entry 已建好、release 还没赋值。
      claudeSessionDelivery.register(reg, { readySource: toolsListedReadySource(host, key, 'reattach') })
      expect(claudeSessionDelivery.readinessOf('s-known1')).toBe('ready')
      expect(onLive).toHaveBeenCalledTimes(1)
      // 订阅仍挂着(release 随后赋上):再来一次 tools/list 是幂等的,不再转 live。
      await listedOnce(host, key, client)
      expect(onLive).toHaveBeenCalledTimes(1)
    } finally {
      claudeSessionDelivery.teardown('s-known1')
      claudeSessionDelivery.setLiveHooks(null)
    }
    // teardown 调了 release:这张卡上不再有就绪订阅。
    expect((host as unknown as { toolsListedListeners: Map<string, Set<() => void>> }).toolsListedListeners.has(key)).toBe(false)
  })
})

describe('a tool call that waits for minutes keeps telling its caller it is still running', () => {
  function waitingFactory(release: { now: () => void }) {
    return vi.fn<GuguMcpServerFactory<TestContext>>(async () => {
      const server = new McpServer({ name: 'gugu-host-test', version: '1.0.0' })
      server.registerTool('wait_for_person', { inputSchema: z.object({}) }, async () => {
        await new Promise<void>((resolve) => { release.now = resolve })
        return { content: [{ type: 'text' as const, text: 'answered' }] }
      })
      return server
    })
  }

  it('sends progress on that call every interval while it waits, and stops when it returns', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const release = { now: () => {} }
      const { host } = await startHost(waitingFactory(release))
      const client = await connect(await host.grant('alpha', context('alpha', 'A')))
      const seen: number[] = []
      const call = client.callTool({ name: 'wait_for_person', arguments: {} }, undefined, { onprogress: ({ progress }) => { seen.push(progress) } })
      const initial = release.now
      await vi.waitFor(() => expect(release.now).not.toBe(initial))
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(TOOL_CALL_PROGRESS_MS)
        await vi.waitFor(() => expect(seen).toHaveLength(i + 1))
      }
      expect(seen).toEqual([1, 2, 3])
      release.now()
      await expect(call).resolves.toMatchObject({ content: [{ type: 'text', text: 'answered' }] })
      await vi.advanceTimersByTimeAsync(TOOL_CALL_PROGRESS_MS * 3)
      expect(seen).toEqual([1, 2, 3])

    } finally {
      vi.useRealTimers()
    }
  })

  it('sends nothing to a caller that sent no progressToken (the spec allows no progress then)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const sent = vi.spyOn(McpLowLevelServer.prototype, 'notification')
    try {
      const release = { now: () => {} }
      const { host } = await startHost(waitingFactory(release))
      const client = await connect(await host.grant('beta', context('beta', 'B')))
      const initial = release.now
      const call = client.callTool({ name: 'wait_for_person', arguments: {} })
      await vi.waitFor(() => expect(release.now).not.toBe(initial))
      await vi.advanceTimersByTimeAsync(TOOL_CALL_PROGRESS_MS * 3)
      release.now()
      await expect(call).resolves.toMatchObject({ content: [{ type: 'text', text: 'answered' }] })
      expect(sent.mock.calls.filter(([notification]) => notification.method === 'notifications/progress')).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('is well inside both limits the Claude CLI applies to a silent MCP call (300 s idle, 360 s without a byte)', () => {
    expect(TOOL_CALL_PROGRESS_MS).toBeLessThan(300_000)
  })
})
