import { createServer } from 'node:http'
import type { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'

vi.mock('../../../../apps/desktop/electron/lib/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }))
vi.mock('@gugu/session-shared', () => ({ onErrorEvent: (emitter: EventEmitter, listener: (error: Error) => void) => emitter.on('error', listener) }))
vi.mock('../../../../apps/desktop/electron/session/main/lib/stable-endpoint', () => ({ agentEndpointServer: (handler: Parameters<typeof createServer>[0]) => createServer(handler) }))
vi.mock('@gugu/session-plugins/integrations', async () => ({
  integrationMcpTransport: (await import('../../../../packages/session-plugins/src/integrations/helpers/mcp-transport')).integrationMcpTransport,
}))

import { buildIntegrationBridge, createIntegrationMcpHost, type IntegrationBridgeEntry } from '../../../../apps/desktop/electron/integration-mcp-bridge'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

describe('permanent connected-apps MCP', () => {
  it('starts empty, announces a connection and calls its tools in the same client', async () => {
    const host = createIntegrationMcpHost()
    cleanup.push(() => host.dispose())
    let entries: IntegrationBridgeEntry[] = []
    const [config] = await buildIntegrationBridge(host, 'session', 'owner', 'subject', async () => entries)
    const client = new Client({ name: 'fixture', version: '1' })
    cleanup.push(() => client.close())
    const notified = vi.fn()
    client.setNotificationHandler(ToolListChangedNotificationSchema, notified)
    await client.connect(new StreamableHTTPClientTransport(new URL(config.url!), { requestInit: { headers: Object.fromEntries(config.headers!.map(({ name, value }) => [name, value])) } }))
    expect((await client.listTools()).tools).toEqual([])
    const call = vi.fn(async (name: string) => ({ content: [{ type: 'text' as const, text: `${name}: /apps/咕咕/fixture.txt` }] }))
    entries = [{ integrationId: 'baidu-pan', upstream: { kind: 'local', tools: {
      list: async () => [{ name: 'list_files', inputSchema: { type: 'object' as const } }], call,
    } } }]
    await host.notifyToolsListChanged()
    await vi.waitFor(() => expect(notified).toHaveBeenCalledTimes(1))
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['baidu-pan__list_files'])
    expect(await client.callTool({ name: 'baidu-pan__list_files', arguments: { path: '/apps/咕咕' } })).toMatchObject({ content: [{ text: 'list_files: /apps/咕咕/fixture.txt' }] })
    expect(call).toHaveBeenCalledWith('list_files', { path: '/apps/咕咕' }, expect.any(AbortSignal))
    expect((await buildIntegrationBridge(host, 'session', 'owner', 'subject', async () => entries))[0].url).toBe(config.url)
    entries = []
    await host.notifyToolsListChanged()
    expect((await client.listTools()).tools).toEqual([])
    await expect(client.callTool({ name: 'baidu-pan__list_files' })).rejects.toThrow('no longer connected')
    expect(call).toHaveBeenCalledTimes(1)
  })
  it('keeps identically named tools from different apps distinct', async () => {
    const host = createIntegrationMcpHost()
    cleanup.push(() => host.dispose())
    const entries: IntegrationBridgeEntry[] = ['one', 'two'].map((integrationId) => ({ integrationId, upstream: { kind: 'local', tools: {
      list: async () => [{ name: 'search', inputSchema: { type: 'object' as const } }],
      call: async () => ({ content: [{ type: 'text' as const, text: integrationId }] }),
    } } }))
    const [config] = await buildIntegrationBridge(host, 'session', 'owner', 'subject', entries)
    const client = new Client({ name: 'fixture', version: '1' })
    cleanup.push(() => client.close())
    await client.connect(new StreamableHTTPClientTransport(new URL(config.url!), { requestInit: { headers: Object.fromEntries(config.headers!.map(({ name, value }) => [name, value])) } }))
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['one__search', 'two__search'])
    expect(await client.callTool({ name: 'two__search' })).toMatchObject({ content: [{ text: 'two' }] })
  })
  it('preserves healthy app tools when another app is unavailable, and reports total failure', async () => {
    const host = createIntegrationMcpHost()
    cleanup.push(() => host.dispose())
    const broken: IntegrationBridgeEntry = { integrationId: 'broken', upstream: { kind: 'local', tools: {
      list: async () => { throw new Error('fixture network failure') }, call: async () => { throw new Error('fixture failure') },
    } } }
    let entries: IntegrationBridgeEntry[] = [broken, { integrationId: 'healthy', upstream: { kind: 'local', tools: {
      list: async () => [{ name: 'search', inputSchema: { type: 'object' as const } }], call: async () => ({ content: [] }),
    } } }]
    const [config] = await buildIntegrationBridge(host, 'session', 'owner', 'subject', async () => entries)
    const client = new Client({ name: 'fixture', version: '1' })
    cleanup.push(() => client.close())
    await client.connect(new StreamableHTTPClientTransport(new URL(config.url!), { requestInit: { headers: Object.fromEntries(config.headers!.map(({ name, value }) => [name, value])) } }))
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['healthy__search'])
    entries = [broken]
    await expect(client.listTools()).rejects.toThrow('unavailable: broken')
  })
})
