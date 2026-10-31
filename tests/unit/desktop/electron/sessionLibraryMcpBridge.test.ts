import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createDesktopGuguMcpHost, type DesktopGuguMcpHost } from '../../../../apps/desktop/electron/acp-engine-utils'
import { buildSessionBundle, setSessionLibraryMcpBridge, setSessionExtensionBridge } from '../../../../apps/desktop/electron/capability-bundle'
import { GUGU_MCP_SERVER_NAME } from '../../../../apps/desktop/electron/mcp/gugu-mcp-name.mjs'
import { GUGU_RESERVED_MCP_NAMES } from '../../../../apps/desktop/src/session/shared/mcp-library'
import { sessionMcpDeliveryOn } from '@gugu/session-core/agents/plugins'
import { pluginRegistry } from '@gugu/session-plugins/agents'

/**
 * 资源库 → MCP(owner 10-18):新建时带上的那几台经会话能力包送进去,和集成同一层(`owner: 'integration'`),
 * 密钥换成 env 引用 —— 与用户自己那批同一种转换,值不进 argv、不进配置。
 */

const hosts: DesktopGuguMcpHost[] = []
afterEach(async () => {
  setSessionLibraryMcpBridge(null)
  setSessionExtensionBridge(null)
  await Promise.all(hosts.splice(0).map((host) => host.dispose().catch(() => undefined)))
})

async function bundleFor(grantKey: string, extensionTools?: 'catalog') {
  const host = createDesktopGuguMcpHost()
  hosts.push(host)
  return buildSessionBundle({
    runtime: {
      authProvider: { getAuth: async () => ({ accessToken: 'token', userId: randomUUID() }) },
      env: { GUGU_HOME: '/tmp/gugu-session-library-mcp' },
    },
    agentUserId: randomUUID(),
    ...(extensionTools ? { extensionTools } : {}),
    threadRootId: null,
    autonomy: null,
    socialBridgeDeps: { host, grantKey, getSupabaseUrl: () => 'https://supabase.example', getSupabaseAnonKey: () => 'anon-key' },
  })
}

describe('资源库 MCP 进会话能力包', () => {
  it('asks the App bridge for catalog disclosure only for the assistant, preserving library choices', async () => {
    const modes: Array<'catalog' | undefined> = []
    setSessionExtensionBridge(async (session) => {
      modes.push(session.extensionTools)
      return { servers: [], skills: [], apps: [], origins: [] }
    })
    setSessionLibraryMcpBridge(async () => ({
      servers: [{ name: 'chosen-by-owner', transport: 'stdio', command: 'node', providers: [] }],
      settle: () => {},
    }))
    const assistant = await bundleFor(`taskpage:${randomUUID()}`, 'catalog')
    await bundleFor(`taskpage:${randomUUID()}`)
    expect(modes).toEqual(['catalog', undefined])
    expect(assistant.mcpServers.find((server) => server.name === 'chosen-by-owner')).toMatchObject({ alwaysLoad: true, library: true })
  })

  it('问的是这条会话自己;stdio 与 http 都送,记成 integration,密钥走 env 引用', async () => {
    const asked: string[] = []
    const settled: unknown[] = []
    setSessionLibraryMcpBridge(async (sessionId) => {
      asked.push(sessionId)
      return {
        servers: [
          { name: 'lib-echo', transport: 'stdio', command: 'node', args: ['echo.mjs'], env: { API_KEY: 'secret-1' }, providers: [] },
          { name: 'lib-http', transport: 'http', url: 'https://mcp.example.test/mcp', headers: { Authorization: 'Bearer secret-2' }, providers: [] },
        ],
        settle: (outcome) => settled.push(outcome),
      }
    })
    const sessionId = randomUUID()
    const bundle = await bundleFor(`taskpage:${sessionId}`)
    expect(asked).toEqual([sessionId])

    const echo = bundle.mcpServers.find((server) => server.name === 'lib-echo')
    const http = bundle.mcpServers.find((server) => server.name === 'lib-http')
    expect(echo).toMatchObject({ transport: 'stdio', command: 'node', args: ['echo.mjs'], alwaysLoad: true, owner: 'integration', library: true })
    expect(http).toMatchObject({ transport: 'http', url: 'https://mcp.example.test/mcp', owner: 'integration', library: true })
    expect(settled).toEqual([{ delivered: ['lib-echo', 'lib-http'], collided: [] }])
    // 值只在 env 里,声明里是引用。
    expect(JSON.stringify(bundle.mcpServers)).not.toContain('secret-1')
    expect(JSON.stringify(bundle.mcpServers)).not.toContain('secret-2')
    expect(Object.values(bundle.env)).toEqual(expect.arrayContaining(['secret-1', 'Bearer secret-2']))
  })

  it('没有会话编号的卡(不是会话页的会话)不问', async () => {
    const asked: string[] = []
    setSessionLibraryMcpBridge(async (sessionId) => {
      asked.push(sessionId)
      return { servers: [], settle: () => {} }
    })
    const bundle = await bundleFor(`accounting-${randomUUID()}`)
    expect(asked).toEqual([])
    expect(bundle.mcpServers.some((server) => server.name.startsWith('lib-'))).toBe(false)
  })

  it('和咕咕自己送的那台撞名:那台留在外面、说出撞了谁,包照常建出来(❌ 整条任务起不来)', async () => {
    const settled: { delivered: string[]; collided: { name: string; with: string }[] }[] = []
    setSessionLibraryMcpBridge(async () => ({
      servers: [{ name: 'gugu', transport: 'stdio', command: 'node', args: ['fake.mjs'], providers: [] }],
      settle: (outcome) => settled.push(outcome),
    }))
    const bundle = await bundleFor(`taskpage:${randomUUID()}`)
    const gugu = bundle.mcpServers.filter((server) => server.name === 'gugu')
    expect(gugu).toHaveLength(1)
    expect(gugu[0]).not.toMatchObject({ library: true })
    expect(settled).toEqual([{ delivered: [], collided: [{ name: 'gugu', with: 'gugu' }] }])
  })

  it('资源库里两台名字只差标点(a-b / a_b):后一台留在外面,❌ 抛', async () => {
    const settled: { delivered: string[]; collided: { name: string; with: string }[] }[] = []
    setSessionLibraryMcpBridge(async () => ({
      servers: [
        { name: 'a-b', transport: 'stdio', command: 'node', providers: [] },
        { name: 'a_b', transport: 'stdio', command: 'node', providers: [] },
      ],
      settle: (outcome) => settled.push(outcome),
    }))
    const bundle = await bundleFor(`taskpage:${randomUUID()}`)
    expect(bundle.mcpServers.map((server) => server.name)).toContain('a-b')
    expect(bundle.mcpServers.map((server) => server.name)).not.toContain('a_b')
    expect(settled).toEqual([{ delivered: ['a-b'], collided: [{ name: 'a_b', with: 'a-b' }] }])
  })

  it('资源库的保留名:宿主自己送的那台(改了宿主的名字,这里会红),外加旧的 gugu-browser(已不再送,名字仍保留)', () => {
    expect([...GUGU_RESERVED_MCP_NAMES].sort()).toEqual([GUGU_MCP_SERVER_NAME, 'gugu-browser'].sort())
  })

  it('各家这条腿收不收、收哪几种,读的是 descriptor 的 units.mcp', () => {
    const on = (id: string, surface: 'acp' | 'tui') => sessionMcpDeliveryOn(pluginRegistry.get(id)?.capabilities.sessionBundle, surface)
    expect(on('antigravity', 'tui')).toEqual({ channel: true, transports: ['http'] })
    expect(on('antigravity', 'acp')).toEqual({ channel: true, transports: ['stdio', 'http'] })
    expect(on('claude', 'tui')).toEqual({ channel: true, transports: ['stdio', 'http'] })
    expect(on('cursor', 'acp')).toEqual({ channel: false })
    // codex 的终端腿挂在 app-server 这个 surface 上,不是 'tui'。
    expect(on('codex', 'tui')).toEqual({ channel: true, transports: ['stdio', 'http'] })
  })
})
