// #6264 tmux 里的 agent 活得比宿主进程久(升级、看门人重启、回滚、崩溃):它手里的咕咕 MCP 与钩子地址、令牌
// 必须在新进程里照样能用 —— 端口绑回原来那个、令牌落盘认回;盘上有、还没被重新接上的,先唤醒那条会话再答。
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { GuguMcpHost, type GuguMcpGrant, type GuguMcpServerFactory } from '../../../../apps/desktop/electron/gugu-mcp-host'
import { createStableMcpPersistence, sessionpageSessionOfGrantKey } from '../../../../apps/desktop/electron/stable-mcp-persistence'
import { EndpointPorts, listenStable, PersistedRecords } from '../../../../apps/desktop/electron/session/main/lib/stable-endpoint'

type Ctx = { ownerId: string; subjectId: string; toolScope: string; value: string }
const dirs: string[] = []
const cleanups: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await Promise.resolve(cleanup()).catch(() => undefined)
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
const tmp = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-endpoints-'))
  dirs.push(dir)
  return dir
}
const log = { info: vi.fn(), warn: vi.fn() }
/** 会话页后端早已就绪、宿主没在退。 */
const booted = { ready: async () => undefined, quitting: () => false }
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

const factory: GuguMcpServerFactory<Ctx> = async (getContext) => {
  const server = new McpServer({ name: 'gugu', version: '1.0.0' })
  server.registerTool('read', { inputSchema: z.object({}) }, async () => ({ content: [{ type: 'text' as const, text: getContext().value }] }))
  return server
}
const invariant = ({ ownerId, subjectId, toolScope }: Ctx) => ({ ownerId, subjectId, toolScope })
const ctx = (value: string): Ctx => ({ ownerId: 'o', subjectId: 's', toolScope: 'gugu', value })

async function readVia(grant: GuguMcpGrant): Promise<string> {
  const client = new Client({ name: 'agent', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(grant.url), {
    requestInit: { headers: { Authorization: `Bearer ${grant.capability}` } },
  })
  await client.connect(transport)
  cleanups.push(() => client.close())
  const result = await client.callTool({ name: 'read', arguments: {} })
  return (result.content as Array<{ text: string }>)[0]!.text
}

async function withReconnect<T>(run: () => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 1; ; i += 1) {
    try {
      return await run()
    } catch (error) {
      if (i >= attempts) throw error
    }
  }
}

describe('listenStable', () => {
  it('第二个进程绑回同一个端口;端口被别的程序占着就另挑一个、记下新的并响亮说一声', async () => {
    const dataDir = tmp()
    const ports = new EndpointPorts(dataDir)
    const first = http.createServer()
    const a = await listenStable(first, { name: 'x', ports, log })
    expect(a.reused).toBe(false)
    await new Promise((resolve) => first.close(resolve))
    const second = http.createServer()
    cleanups.push(() => new Promise((resolve) => second.close(resolve)))
    await expect(listenStable(second, { name: 'x', ports, log })).resolves.toEqual({ port: a.port, reused: true })
    const third = http.createServer()
    cleanups.push(() => new Promise((resolve) => third.close(resolve)))
    const c = await listenStable(third, { name: 'x', ports, log, retries: 1, retryDelayMs: 1 })
    expect(c.reused).toBe(false)
    expect(c.port).not.toBe(a.port)
    expect(log.warn).toHaveBeenCalled()
    expect(new EndpointPorts(dataDir).get('x')).toBe(c.port)
    expect(fs.statSync(path.join(dataDir, 'endpoints.json')).mode & 0o777).toBe(0o600)
  })

  it('上一个进程还没放端口:等一会儿再绑回去', async () => {
    const ports = new EndpointPorts(tmp())
    const holder = net.createServer()
    const { port } = await listenStable(holder, { name: 'y', ports, log })
    setTimeout(() => holder.close(), 150)
    const next = net.createServer()
    cleanups.push(() => new Promise((resolve) => next.close(resolve)))
    await expect(listenStable(next, { name: 'y', ports, log, retries: 10, retryDelayMs: 50 })).resolves.toEqual({ port, reused: true })
  })

  it('落盘记录:同 key 覆盖、按 key 删、超过上限丢最旧的', () => {
    const records = new PersistedRecords<{ key: string; v: number }>(path.join(tmp(), 'r.json'), 2)
    records.put({ key: 'a', v: 1 })
    records.put({ key: 'b', v: 1 })
    records.put({ key: 'a', v: 2 })
    records.put({ key: 'c', v: 1 })
    expect(records.list()).toEqual([{ key: 'a', v: 2 }, { key: 'c', v: 1 }])
    records.remove('a')
    expect(records.list()).toEqual([{ key: 'c', v: 1 }])
  })
})

describe('咕咕 MCP 活过宿主进程重启', () => {
  // PR-7(Known 1):端口早绑时接回的 claude 只丢了 SSE 流、留着原来的 MCP 会话,不再 list —— 「这张卡 list 过」
  // 必须随卡活过重启,接回的会话登记时读它。撤销后盘上那一行跟着删,新签的卡从没 list 过起。
  it('list 过工具随卡落盘:重启后认回同一张卡仍算 list 过;撤销、重新签发的卡从 false 起', async () => {
    const dataDir = tmp()
    const persistence = () => createStableMcpPersistence({ name: 'gugu-mcp', dataDir, ...booted, wake: async () => undefined, log })
    const before = new GuguMcpHost<Ctx>(factory, invariant, persistence())
    await before.start()
    const grant = await before.grant('taskpage:conv-l', ctx('before'))
    const client = new Client({ name: 'agent', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(grant.url), {
      requestInit: { headers: { Authorization: `Bearer ${grant.capability}` } },
    }))
    const heard = new Promise<void>((resolve) => { const off = before.onToolsListed('taskpage:conv-l', () => { off(); resolve() }) })
    await client.listTools()
    await heard
    await client.close()
    expect(before.hasListedTools('taskpage:conv-l')).toBe(true)
    await before.dispose()

    const after = new GuguMcpHost<Ctx>(factory, invariant, persistence())
    cleanups.push(() => after.dispose())
    await after.start()
    expect(after.hasListedTools('taskpage:conv-l')).toBe(false) // 还没人认回这张卡
    expect(await after.grant('taskpage:conv-l', ctx('after'))).toEqual(grant)
    expect(after.hasListedTools('taskpage:conv-l')).toBe(true)

    await after.revoke('taskpage:conv-l')
    expect(after.hasListedTools('taskpage:conv-l')).toBe(false)
    expect(await after.grant('taskpage:conv-l', ctx('again'))).not.toEqual(grant)
    expect(after.hasListedTools('taskpage:conv-l')).toBe(false)
  })

  it('重启前发的卡:新进程绑回同一端口;agent 拿旧卡来敲门时先唤醒那条会话,再答它 —— 拿回的是同一张卡', async () => {
    const dataDir = tmp()
    const persistence = () => createStableMcpPersistence({ name: 'gugu-mcp', dataDir, ...booted, wake: async (id) => wake(id), log })
    let wake: (sessionId: string) => Promise<void> = async () => undefined

    const before = new GuguMcpHost<Ctx>(factory, invariant, persistence())
    await before.start()
    const grant = await before.grant('taskpage:conv-1', ctx('before'))
    await expect(readVia(grant)).resolves.toBe('before')
    await before.dispose()

    const after = new GuguMcpHost<Ctx>(factory, invariant, persistence())
    cleanups.push(() => after.dispose())
    await after.start()
    const woken: string[] = []
    let regranted: GuguMcpGrant | null = null
    wake = async (sessionId) => {
      woken.push(sessionId)
      // 唤醒走正常起会话的路:对同一个 key、同一张卡面再 grant 一次。
      regranted = await after.grant('taskpage:conv-1', ctx('after'))
    }
    // agent 还拿着重启前那张卡(同一个地址、同一个令牌),重新 initialize(Claude Code 见 404 即如此)。
    // 它连接池里那几条旧的保活连接随旧进程断了:头几发是 ECONNRESET,重连即可(Claude Code 同样重连)。
    await expect(withReconnect(() => readVia(grant))).resolves.toBe('after')
    expect(woken).toEqual(['conv-1'])
    expect(regranted).toEqual(grant)
  })

  it('卡比会话页后端先到:请求挂着等它就绪(❌ 拒绝、❌ 先唤醒),就绪后唤醒并答 —— 拿回的是同一张卡', async () => {
    const dataDir = tmp()
    const boot = deferred()
    const askedReady = deferred()
    const woken: string[] = []
    let after: GuguMcpHost<Ctx> | null = null
    const persistence = (ready: () => Promise<unknown>) => createStableMcpPersistence({
      name: 'gugu-mcp', dataDir, ready, quitting: () => false, log,
      wake: async (id) => {
        woken.push(id)
        await after!.grant('taskpage:conv-6', ctx('after'))
      },
    })
    const before = new GuguMcpHost<Ctx>(factory, invariant, persistence(booted.ready))
    await before.start()
    const grant = await before.grant('taskpage:conv-6', ctx('before'))
    await before.dispose()

    after = new GuguMcpHost<Ctx>(factory, invariant, persistence(() => { askedReady.resolve(); return boot.promise }))
    cleanups.push(() => after!.dispose())
    await after.start()
    let settled = false
    const reading = withReconnect(() => readVia(grant)).finally(() => { settled = true })
    await askedReady.promise
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    expect(woken).toEqual([])
    boot.resolve()
    await expect(reading).resolves.toBe('after')
    expect(woken).toEqual(['conv-6'])
  })

  it('挂着等就绪的时候宿主开始退:放开以后 ❌ 再唤醒会话,卡不认', async () => {
    const dataDir = tmp()
    const first = new GuguMcpHost<Ctx>(factory, invariant, createStableMcpPersistence({ name: 'gugu-mcp', dataDir, ...booted, wake: async () => undefined, log }))
    await first.start()
    const grant = await first.grant('taskpage:conv-7', ctx('x'))
    await first.dispose()

    const boot = deferred()
    const askedReady = deferred()
    let quitting = false
    const wake = vi.fn(async () => undefined)
    const second = new GuguMcpHost<Ctx>(factory, invariant, createStableMcpPersistence({
      name: 'gugu-mcp', dataDir, wake, log,
      ready: () => { askedReady.resolve(); return boot.promise },
      quitting: () => quitting,
    }))
    cleanups.push(() => second.dispose())
    await second.start()
    const status = fetch(grant.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${grant.capability}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
    }).then((response) => response.status)
    await askedReady.promise
    quitting = true
    boot.resolve()
    expect(await status).toBe(401)
    expect(wake).not.toHaveBeenCalled()
  })

  it('旧的 MCP 会话号在新进程里是 404(MCP 规范:客户端据此重新 initialize,Claude Code 实现了)', async () => {
    const dataDir = tmp()
    const host = new GuguMcpHost<Ctx>(factory, invariant, createStableMcpPersistence({ name: 'gugu-mcp', dataDir, ...booted, wake: async () => undefined, log }))
    cleanups.push(() => host.dispose())
    await host.start()
    const grant = await host.grant('taskpage:conv-2', ctx('v'))
    const status = await fetch(grant.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${grant.capability}`, 'mcp-session-id': 'from-the-old-process', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }).then((response) => response.status)
    expect(status).toBe(404)
  })

  it('正式收回的卡(会话真结束)不再认;不是任务页会话的卡不唤醒', async () => {
    const dataDir = tmp()
    const wake = vi.fn(async () => undefined)
    const first = new GuguMcpHost<Ctx>(factory, invariant, createStableMcpPersistence({ name: 'gugu-mcp', dataDir, ...booted, wake, log }))
    await first.start()
    const ended = await first.grant('taskpage:conv-3', ctx('x'))
    const chat = await first.grant('agent:abc', ctx('y'))
    await first.revoke('taskpage:conv-3')
    await first.dispose()
    const second = new GuguMcpHost<Ctx>(factory, invariant, createStableMcpPersistence({ name: 'gugu-mcp', dataDir, ...booted, wake, log }))
    cleanups.push(() => second.dispose())
    await second.start()
    const post = (grant: GuguMcpGrant) => fetch(grant.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${grant.capability}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
    }).then((response) => response.status)
    expect(await post(ended)).toBe(401)
    expect(await post(chat)).toBe(401)
    expect(wake).not.toHaveBeenCalled()
  })

  it('#6938 撤一个身份的卡也撤它在盘上休眠的那张:新进程里不再认、不唤醒;别的身份的照留', async () => {
    const dataDir = tmp()
    const wake = vi.fn(async () => undefined)
    const persistence = () => createStableMcpPersistence({ name: 'gugu-mcp', dataDir, ...booted, wake, log })
    const first = new GuguMcpHost<Ctx>(factory, invariant, persistence())
    await first.start()
    const gone = await first.grant('taskpage:conv-4', { ownerId: 'o', subjectId: 'agent-x', toolScope: 'gugu', value: 'x' })
    await first.grant('taskpage:conv-5', ctx('kept'))
    await first.dispose()
    // 新进程:两张都在盘上休眠,这个进程还没重新发过。
    const second = new GuguMcpHost<Ctx>(factory, invariant, persistence())
    cleanups.push(() => second.dispose())
    await second.start()
    await second.revokeSubject('agent-x')
    const status = await fetch(gone.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${gone.capability}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
    }).then((response) => response.status)
    expect(status).toBe(401)
    expect(wake).not.toHaveBeenCalled()
    expect(persistence().grants.list().map((record) => record.key)).toEqual(['taskpage:conv-5'])
  })

  it('grant key → 任务页会话', () => {
    expect(sessionpageSessionOfGrantKey('taskpage:c-1')).toBe('c-1')
    expect(sessionpageSessionOfGrantKey('taskpage:c-1:linear')).toBe('c-1')
    expect(sessionpageSessionOfGrantKey('agent:x')).toBeNull()
  })
})
