import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { buildSocialBridge, createDesktopGuguMcpHost, type DesktopGuguMcpHost } from '../../../../apps/desktop/electron/acp-engine-utils'
import { ASSISTANT_TASK_EXECUTION, assistantExecutionAction } from '../../../../packages/core/src/shared/assistantWorkflow'
import { AssistantWorkStore, type AssistantWorkBinding } from '../../../../apps/desktop/electron/sessionpage/assistant-work'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startupDiscovery } from '../../../../apps/desktop/electron/sessionpage/startup-discovery'

let host: DesktopGuguMcpHost
const clients: Client[] = []
const run = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true, data: 'actual dispatcher' }))
const runtime = {
  authProvider: { getAuth: async () => ({ accessToken: 'test-token', userId: 'owner' }) },
  // Same home for the assistant and its executor: location cannot confer the role.
  env: { GUGU_HOME: '/tmp/gugu-assistant-role-test' },
}

it('keeps the dispatch contract below 500 tokens using a conservative UTF-8 byte bound', () => {
  expect(new TextEncoder().encode(ASSISTANT_TASK_EXECUTION).length).toBeLessThanOrEqual(500)
  expect(ASSISTANT_TASK_EXECUTION).not.toMatch(/主人|用户/)
  expect(ASSISTANT_TASK_EXECUTION).toContain('本机路径')
  expect(ASSISTANT_TASK_EXECUTION).toContain('咕咕报错按 <gugu_work> 报')
  expect(ASSISTANT_TASK_EXECUTION).toContain('禁读咕咕程序、调试平台')
})

beforeEach(() => { host = createDesktopGuguMcpHost(); run.mockClear() })
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()))
  await host.dispose()
})

const bridge = (key: string, personalAssistant: boolean, assistantWork?: AssistantWorkBinding) => buildSocialBridge(runtime, key, null, {
  host, grantKey: key, ...(personalAssistant ? { personalAssistant: true as const } : {}),
  getSupabaseUrl: () => 'https://supabase.example', getSupabaseAnonKey: () => 'anon',
  runSessionAction: run, assistantWork,
})

async function connect(key: string, personalAssistant: boolean, assistantWork?: AssistantWorkBinding) {
  const [server] = await bridge(key, personalAssistant, assistantWork)
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

it('dispatches activity review and confirmed stopping from the coordinator direct tools', async () => {
  const client = await connect('assistant-core-work', true)
  const tools = (await client.listTools()).tools
  expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['activity_list', 'activity_context', 'session_stop']))
  for (const [name, args, action] of [
    ['activity_list', { since: '2026-10-24T00:00:00Z', until: '2026-10-25T00:00:00Z' }, 'activity_list'],
    ['activity_context', { event_id: 'work' }, 'activity_context'],
    ['session_stop', { session_id: 'session:child' }, 'stop'],
  ] as const) {
    run.mockResolvedValueOnce({ session_id: 'child', status: 'idle', detail: 'plain', settled: true })
    const result = await client.callTool({ name, arguments: args })
    expect(result).not.toMatchObject({ isError: true })
    expect(run.mock.calls.at(-1)![0]).toMatchObject({ action })
    if (name === 'session_stop') expect(JSON.stringify(result)).toContain('idle')
  }
  const message = tools.find(tool => tool.name === 'session_message')!
  expect(JSON.stringify(message.inputSchema)).toContain('this never stops recipients')
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

it('releases cloud background discovery after a coordinator tool, never on listing or executor calls', async () => {
  const release = vi.spyOn(startupDiscovery, 'release')
  try {
    const assistant = await connect('startup-coordinator', true)
    await assistant.listTools()
    const executor = await connect('startup-executor', false)
    await executor.callTool({ name: 'device_call', arguments: { device: 'device:phone', name: 'health.summary' } })
    expect(release).not.toHaveBeenCalled()
    await assistant.callTool({ name: 'device_actions', arguments: {} })
    expect(release).toHaveBeenCalledOnce()
  } finally { release.mockRestore() }
})

it('a first tool requesting all runtimes awaits complete discovery rather than returning only the selected runtime', async () => {
  const client = await connect('first-tool-inventory', true)
  const ready = Promise.withResolvers<void>()
  run.mockImplementationOnce(async () => { await ready.promise; return { harnesses: ['selected-runtime', 'another-runtime'] } })
  let finished = false
  const call = client.callTool({ name: 'catalog_call', arguments: { tool: 'session_list_harnesses', args: {} } })
    .then(result => { finished = true; return result })
  try {
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
    expect(finished).toBe(false)
  } finally { ready.resolve() }
  const result = await call
  expect(JSON.stringify(result)).toContain('selected-runtime')
  expect(JSON.stringify(result)).toContain('another-runtime')
})

it('host adds the actual execution contract to spawn and reuse', async () => {
  const client = await connect('coordinator', true)
  const source = 'gugu-chat://3be752cb-0925-447e-8bbc-70de8a867bd1/bfb72f98-986e-4314-b242-d9b95a0c8083'
  for (const [tool, args, field] of [
    ['session_spawn', { prompt: 'Produce the requested artifact.', device: 'device:remote', source_link: source }, 'prompt'],
    ['session_message', { to: ['session:existing'], text: 'Continue with the revised constraint.', source_link: source, purpose: 'task' }, 'text'],
  ] as const) {
    const result = await client.callTool({ name: tool, arguments: args })
    expect(result).not.toMatchObject({ isError: true })
    const actual = run.mock.calls.at(-1)![0] as Record<string, unknown>
    expect(actual[field]).toBe(`${field === 'prompt' ? args.prompt : args.text}\n\n<gugu_task_context>\n${ASSISTANT_TASK_EXECUTION}\n</gugu_task_context>`)
    expect(actual.source_link).toBe(source)
    if (field === 'prompt') expect(actual.device).toBe('remote')
    else expect(actual.to).toEqual(['session:existing'])
    expect(assistantExecutionAction(actual)).toBe(actual)
  }
})

it('an ordinary executor message is unchanged, and non-work actions are not rewritten', async () => {
  const executor = await connect('executor', false)
  await executor.callTool({ name: 'session_message', arguments: { to: ['session:parent'], text: 'Verified and complete.' } })
  expect(run.mock.calls.at(-1)![0]).toMatchObject({ action: 'message', text: 'Verified and complete.' })
  for (const value of [null, [], 'invalid', { action: 'get' }, { action: 'spawn', prompt: 3 }]) {
    expect(assistantExecutionAction(value)).toBe(value)
  }
})

it('returns a host work reference from the real MCP grant and reuses it for a later constraint', async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), 'assistant-grant-work-'))
  try {
    const client = await connect('tracked-assistant', true, { sessionId: 'parent', memoryDir })
    run.mockResolvedValueOnce({ session_id: 'child' })
    const response = await client.callTool({ name: 'session_spawn', arguments: { prompt: 'Produce the artifact.' } })
    const [work] = new AssistantWorkStore(memoryDir).list()
    expect(JSON.stringify(response)).toContain(work.id)
    expect(run.mock.calls.at(-1)![0]).toMatchObject({ prompt: expect.stringContaining(ASSISTANT_TASK_EXECUTION) })
    run.mockResolvedValueOnce({ recipients: [{ to: 'session:child', status: 'delivered', message_id: 'constraint-receipt' }] })
    await client.callTool({ name: 'session_message', arguments: { to: ['session:child'], text: 'Wait for the owner’s approval.', work_id: work.id, purpose: 'task' } })
    expect(new AssistantWorkStore(memoryDir).list()).toHaveLength(1)
    expect(new AssistantWorkStore(memoryDir).list()[0].receipt_ids).toContain('constraint-receipt')
  } finally { await rm(memoryDir, { recursive: true, force: true }) }
})
