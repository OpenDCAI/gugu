import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

const text = (result: unknown) => (result as { content: Array<{ text?: string }> }).content.map(part => part.text ?? '').join('')

async function renderPrefix(kind: 'computer' | 'cloud', clock: string, seed: number) {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(clock))
  let state = seed
  vi.spyOn(Math, 'random').mockImplementation(() => { state = (1664525 * state + 1013904223) >>> 0; return state / 2 ** 32 })
  vi.stubEnv('GUGU_SERVER_MODE', kind === 'cloud' ? '1' : '0')
  // Re-evaluate production definitions too: a timestamp/random value added at
  // module initialization must not escape this guard through the module cache.
  vi.resetModules()
  const { createDesktopGuguMcpHost } = await import('../../../apps/desktop/electron/acp-engine-utils')
  const { buildSessionBundle, loadSessionAcpCapabilities } = await import('../../../apps/desktop/electron/capability-bundle')
  const { buildAgentIdentityBlock } = await import('@gugu/core/local/agent/deviceCommandRuntime')
  const { personalAssistantContext, assistantHomeTaskContext } = await import('../../../apps/desktop/electron/sessionpage/assistant-context')
  const { setExtensionCheckAvailable } = await import('../../../apps/desktop/electron/mcp/gugu-extension-tool')
  setExtensionCheckAvailable(true)
  const host = createDesktopGuguMcpHost()
  const client = new Client({ name: 'assistant-prefix-stability', version: '1' })
  try {
    const bundle = await buildSessionBundle({
      runtime: {
        authProvider: { getAuth: async () => ({ accessToken: 'test-token', userId: 'owner' }) },
        env: { GUGU_HOME: '/prefix-stability', GUGU_SERVER_MODE: kind === 'cloud' ? '1' : '0' },
      },
      agentUserId: 'assistant', threadRootId: null, sessionKey: 'assistant-session', model: null, autonomy: null,
      promptBlocks: { identity: buildAgentIdentityBlock({ guguUserId: 'assistant' }) },
      socialBridgeDeps: {
        host, grantKey: 'assistant-prefix', personalAssistant: true,
        getSupabaseUrl: () => 'https://supabase.example', getSupabaseAnonKey: () => 'anon',
        runSessionAction: async () => ({}), runExtensionAction: async () => ({}),
      },
    })
    const normal = loadSessionAcpCapabilities('claude', bundle, { cwd: '/prefix-stability/assistant', lifecycle: 'resume' })
    const prepared = personalAssistantContext(normal, kind)
    const options = (prepared.sessionNewPatch!.meta!.claudeCode as { options: Record<string, unknown> }).options
    expect(options.systemPrompt).toMatchObject({ type: 'custom', snapshot: false })
    const originalOptions = (normal.sessionNewPatch!.meta!.claudeCode as { options: Record<string, unknown> }).options
    expect(originalOptions.systemPrompt).toBeUndefined()
    const executor = assistantHomeTaskContext(normal, '/prefix-stability/assistant', '/prefix-stability')
    expect(typeof (executor.sessionNewPatch!.meta!.claudeCode as { options: Record<string, unknown> }).options.systemPrompt).toBe('string')
    const server = bundle.mcpServers.find(entry => entry.name === 'gugu')!
    if (server.transport === 'stdio') throw Error('Expected HTTP Gugu capabilities')
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: Object.fromEntries(server.headers.map(header => [header.name, header.value])) },
    }))
    const listed = (await client.listTools()).tools
    const catalog = JSON.parse(text(await client.callTool({ name: 'catalog_list', arguments: {} }))) as { items: Array<{ call?: string }> }
    const deferred = []
    for (const row of catalog.items) {
      if (!row.call) continue
      const name = row.call.slice(0, row.call.indexOf('('))
      const result = await client.callTool({ name: 'catalog_describe', arguments: { tool: name } })
      expect(result.isError).not.toBe(true)
      deferred.push(JSON.parse(text(result)))
    }
    expect(listed.some(tool => tool.name === 'activity_list')).toBe(true)
    expect(deferred.some(tool => tool.name === 'project_create')).toBe(true)
    expect(deferred.some(tool => tool.name === 'session_list_harnesses')).toBe(true)
    return JSON.stringify({ systemPrompt: options.systemPrompt, listed, deferred })
  } finally {
    await client.close()
    await host.dispose()
    setExtensionCheckAvailable(false)
  }
}

it.each(['computer', 'cloud'] as const)('keeps the complete %s assistant system and tool/catalog prefix independent of time and randomness', async kind => {
  const first = await renderPrefix(kind, '2025-01-02T03:04:05Z', 17)
  const second = await renderPrefix(kind, '2031-11-12T13:14:15Z', 9187)
  expect(second).toBe(first)
})
