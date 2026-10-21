import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  offlineResponse,
  relayEnvSuffix,
  relayTarget,
} from '../../../../apps/desktop/electron/runtime/gugu-mcp-stdio-relay.mjs'

// #6335 Antigravity 终端腿:共用的 mcp_config.json 里只写一条与会话无关的 stdio 条目(本中继),
// 会话的地址与令牌只在 spawn 环境里。这里钉住中继的两种形态:有环境 → 透明转发并带上本会话令牌;
// 没环境(聊天面板腿读到同一份文件时)→ 静默成一台没有工具的 server,❌ 起不来。

const RELAY = fileURLToPath(new URL('../../../../apps/desktop/electron/runtime/gugu-mcp-stdio-relay.mjs', import.meta.url))
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()))
})

function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('GUGU_SESSION_MCP_')) env[key] = value
  }
  return { ...env, ...extra }
}

async function connectRelay(env: Record<string, string>): Promise<Client> {
  const client = new Client({ name: 'relay-test', version: '1' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [RELAY, 'gugu'], env }))
  cleanups.push(() => client.close())
  return client
}

async function startUpstream(): Promise<{ url: string; authorizations: string[] }> {
  const authorizations: string[] = []
  const server: Server = createServer(async (req, res) => {
    authorizations.push(String(req.headers.authorization ?? ''))
    const mcp = new McpServer({ name: 'upstream', version: '1' })
    mcp.registerTool('echo_auth', { inputSchema: z.object({ word: z.string() }) }, async ({ word }) => ({
      content: [{ type: 'text' as const, text: `${word}:${req.headers.authorization}` }],
    }))
    // 无状态:每个请求一台 server + 一个 transport(SDK 文档的 stateless 形态)。
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => void transport.close())
    await mcp.connect(transport)
    await transport.handleRequest(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, authorizations }
}

describe('gugu-mcp-stdio-relay', () => {
  it('环境变量名与 codex 那条腿同一个后缀归一;没有地址 = 没有上游', () => {
    expect(relayEnvSuffix('gugu-local.v2')).toBe('GUGU_LOCAL_V2')
    expect(relayTarget('gugu', { GUGU_SESSION_MCP_URL_GUGU: ' http://x/mcp ', GUGU_SESSION_MCP_BEARER_GUGU: 'b' })).toEqual({
      url: 'http://x/mcp',
      bearer: 'b',
    })
    expect(relayTarget('gugu', { GUGU_SESSION_MCP_BEARER_GUGU: 'b' })).toBeNull()
  })

  it('离线应答:initialize 成功、工具表为空、其余请求报方法不存在、通知不回', () => {
    expect(offlineResponse({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }))
      .toMatchObject({ id: 1, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} } } })
    expect(offlineResponse({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).toEqual({ jsonrpc: '2.0', id: 2, result: { tools: [] } })
    expect(offlineResponse({ jsonrpc: '2.0', id: 3, method: 'tools/call' })).toMatchObject({ id: 3, error: { code: -32601 } })
    expect(offlineResponse({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
  })

  it('没有会话环境时静默成一台没有工具的 server —— 聊天面板腿读到同一份文件也不会「failed to initialize」', async () => {
    const client = await connectRelay(baseEnv())
    expect(client.getServerVersion()?.name).toBe('gugu-mcp-stdio-relay')
    expect((await client.listTools()).tools).toEqual([])
  })

  it('有会话环境时透明转发,每个进程只带自己那份令牌', async () => {
    const upstream = await startUpstream()
    const a = await connectRelay(baseEnv({ GUGU_SESSION_MCP_URL_GUGU: upstream.url, GUGU_SESSION_MCP_BEARER_GUGU: 'tok-A' }))
    const b = await connectRelay(baseEnv({ GUGU_SESSION_MCP_URL_GUGU: upstream.url, GUGU_SESSION_MCP_BEARER_GUGU: 'tok-B' }))
    expect((await a.listTools()).tools.map((tool) => tool.name)).toEqual(['echo_auth'])
    const callA = await a.callTool({ name: 'echo_auth', arguments: { word: 'a' } })
    const callB = await b.callTool({ name: 'echo_auth', arguments: { word: 'b' } })
    expect(callA.content).toEqual([{ type: 'text', text: 'a:Bearer tok-A' }])
    expect(callB.content).toEqual([{ type: 'text', text: 'b:Bearer tok-B' }])
    expect(new Set(upstream.authorizations)).toEqual(new Set(['Bearer tok-A', 'Bearer tok-B']))
  })
})
