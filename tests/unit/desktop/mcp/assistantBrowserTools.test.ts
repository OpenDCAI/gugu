import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, expect, it, vi } from 'vitest'
import { buildBrowserAgentBridge, createBrowserAgentMcpHost, type AgentBrowserBridge } from '../../../../apps/desktop/electron/browser-agent-mcp'

const bridge: AgentBrowserBridge = {
  openTransport: vi.fn(), toolStarting: vi.fn(() => ({ ok: true as const })), toolFinished: vi.fn(),
  setInitialUrl: vi.fn(), workspaceRoot: vi.fn(async () => '/same/assistant/home'),
  requestLogin: vi.fn(async () => ({ ok: true, message: 'executor login' })),
}
const hosts: ReturnType<typeof createBrowserAgentMcpHost>[] = []
const clients: Client[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()))
  await Promise.all(hosts.splice(0).map(host => host.dispose()))
  vi.clearAllMocks()
})

async function setup() {
  const host = createBrowserAgentMcpHost(() => bridge)
  hosts.push(host)
  await host.start()
  async function connect(key: string, personalAssistant?: true) {
    const grant = await host.grant(key, { sessionId: key, ownerUserId: 'owner', subjectId: key, personalAssistant })
    const client = new Client({ name: 'browser-role-test', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL(grant.url), {
      requestInit: { headers: { Authorization: `Bearer ${grant.capability}` } },
    }))
    return client
  }
  return { host, connect }
}

it('assistant browser grants list no tools and refuse direct calls without opening a browser', async () => {
  const { host, connect } = await setup()
  const assistant = await connect('assistant', true)
  const other = await connect('other-assistant', true)
  expect((await assistant.listTools()).tools).toEqual([])
  expect((await other.listTools()).tools).toEqual([])
  for (const name of ['browser_navigate', 'browser_request_login']) {
    expect(await assistant.callTool({ name, arguments: { url: 'https://example.com' } })).toMatchObject({ isError: true })
  }
  expect(bridge.openTransport).not.toHaveBeenCalled()
  expect(bridge.requestLogin).not.toHaveBeenCalled()
  await expect(host.grant('assistant', { sessionId: 'assistant', ownerUserId: 'owner', subjectId: 'assistant' }))
    .rejects.toThrow('cannot change subject or tool scope')
})

it('an executor in the same workspace keeps the browser tool surface and can use it', async () => {
  const { connect } = await setup()
  await connect('assistant', true)
  const executor = await connect('executor')
  expect((await executor.listTools()).tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['browser_navigate', 'browser_request_login']))
  expect(await executor.callTool({ name: 'browser_request_login', arguments: {} })).not.toMatchObject({ isError: true })
  expect(bridge.requestLogin).toHaveBeenCalledOnce()
})

it('the personal assistant capability bundle receives no browser server', async () => {
  const { host } = await setup()
  expect(await buildBrowserAgentBridge(host, 'personal', 'session', 'owner', 'assistant', true)).toEqual([])
  expect(await buildBrowserAgentBridge(host, 'task', 'session', 'owner', 'executor')).toHaveLength(1)
})
