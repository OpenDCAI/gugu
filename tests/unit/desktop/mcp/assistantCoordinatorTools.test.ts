import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { buildSocialBridge, createDesktopGuguMcpHost, type DesktopGuguMcpHost } from '../../../../apps/desktop/electron/acp-engine-utils'

let host: DesktopGuguMcpHost
const clients: Client[] = []
const run = vi.fn(async () => ({ ok: true, data: 'actual dispatcher' }))
const runtime = {
  authProvider: { getAuth: async () => ({ accessToken: 'test-token', userId: 'owner' }) },
  // Same home for the assistant and its executor: location cannot confer the role.
  env: { GUGU_HOME: '/tmp/gugu-assistant-role-test' },
}

beforeEach(() => { host = createDesktopGuguMcpHost(); run.mockClear() })
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()))
  await host.dispose()
})

const bridge = (key: string, personalAssistant: boolean) => buildSocialBridge(runtime, key, null, {
  host, grantKey: key, ...(personalAssistant ? { personalAssistant: true as const } : {}),
  getSupabaseUrl: () => 'https://supabase.example', getSupabaseAnonKey: () => 'anon',
  runSessionAction: run,
})

async function connect(key: string, personalAssistant: boolean) {
  const [server] = await bridge(key, personalAssistant)
  if (!('url' in server)) throw new Error('Expected HTTP Gugu grant')
  const client = new Client({ name: 'assistant-role-test', version: '1' })
  clients.push(client)
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])) },
  }))
  return client
}

it('the coordinator can inspect availability but cannot execute directly or through the catalog', async () => {
  const client = await connect('assistant', true)
  const names = (await client.listTools()).tools.map(tool => tool.name)
  expect(names).toContain('device_actions')
  expect(names).not.toContain('device_call')
  const args = { device: 'device:phone', name: 'health.summary' }
  expect(await client.callTool({ name: 'device_call', arguments: args })).toMatchObject({ isError: true })
  expect(await client.callTool({ name: 'catalog_call', arguments: { tool: 'device_call', args } })).toMatchObject({ isError: true })
  expect(run).not.toHaveBeenCalled()
})

it('an executor sharing the assistant home retains native execution on its own grant', async () => {
  await connect('assistant', true)
  const executor = await connect('executor-in-the-same-home', false)
  expect((await executor.listTools()).tools.map(tool => tool.name)).toContain('device_call')
  expect(await executor.callTool({ name: 'device_call', arguments: { device: 'device:phone', name: 'health.summary' } }))
    .not.toMatchObject({ isError: true })
  expect(run).toHaveBeenCalledOnce()
  expect(run.mock.calls[0]).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'device_call' })]))
})

it('all assistants share one fixed tool prefix and a grant cannot flip roles', async () => {
  const one = await connect('assistant-one', true)
  const other = await connect('assistant-two', true)
  expect((await one.listTools()).tools).toEqual((await other.listTools()).tools)
  await expect(bridge('assistant-one', false)).rejects.toThrow('cannot change subject or tool scope')
  const executor = await connect('executor', false)
  await expect(bridge('executor', true)).rejects.toThrow('cannot change subject or tool scope')
  expect((await executor.listTools()).tools.map(tool => tool.name)).toContain('device_call')
})
