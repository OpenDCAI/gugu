// 复核 93 ②:claude 的 `/mcp` 开关改走它自己的 `disallowedTools` 以后(#6980 第 3 个提交),strict 整份接管没了,
// claude 照常自己读它的每一层 MCP 配置 ⇒ 会话包不再复述用户的 server。复述过来也没人读(插件清单跳过
// `owner === 'user'`,`session/new.mcpServers` 恒为空),它们的 env / 地址 / Authorization 只会留在 claude
// 和它起的子进程环境里。
import { describe, expect, it, vi } from 'vitest'
import { sessionBundleUserMcpFor } from '../../../../apps/desktop/electron/capability-bundle'

const configured = [
  {
    name: 'echo-user',
    transport: 'stdio' as const,
    command: 'node',
    args: ['echo-mcp.mjs'],
    env: { ECHO_TOKEN: 'fake-token-value' },
    providers: ['mimocode'],
  },
]

describe('会话包带不带用户自己的 MCP server(sessionUserServers)', () => {
  it('claude:一台都不带,env 成对丢掉,而且不去读(读了也是扔掉,它在启动的等待路径上)', async () => {
    const read = vi.fn(async () => configured)
    expect(await sessionBundleUserMcpFor('claude', read)).toEqual({ servers: [], env: {} })
    expect(read).not.toHaveBeenCalled()
  })

  it('阳控:没声明 inherit 的家(MiMo)照旧读、照旧复述', async () => {
    const bundle = await sessionBundleUserMcpFor('mimocode', async () => configured)
    expect(bundle.servers.map((server) => server.name)).toEqual(['echo-user'])
    expect(Object.values(bundle.env)).toEqual(['fake-token-value'])
  })
})
