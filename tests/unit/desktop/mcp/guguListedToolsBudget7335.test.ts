import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { createDesktopGuguMcpHost, type DesktopGuguMcpHost } from '../../../../apps/desktop/electron/acp-engine-utils'
import { estimatePromptTokens } from '../../../../apps/desktop/electron/product-platform-prompt'
import { GUGU_LISTED_TOOLS } from '../../../../apps/desktop/electron/mcp/gugu-catalog-tools'
import { setExtensionCheckAvailable } from '../../../../apps/desktop/electron/mcp/gugu-extension-tool'
import { GUGU_LISTED_TOOLS_TOKEN_BUDGET } from '../../../../apps/desktop/electron/mcp/mcp-tool-description-budget.mjs'

// #7335 咕咕 MCP 是 alwaysLoad,原生 tools/list 列出的那组工具每个会话开场全额付。量的是模型真拿到的东西:
// 起真 host、按会话页 agent 的 grant(社交 + session + 扩展三域都注册)拉 tools/list,对整份 JSON 计数。
let host: DesktopGuguMcpHost | undefined
afterEach(async () => {
  setExtensionCheckAvailable(false)
  await host?.dispose().catch(() => undefined)
  host = undefined
})

async function listedTools() {
  setExtensionCheckAvailable(true)
  host = createDesktopGuguMcpHost()
  await host.start()
  const grant = await host.grant('listed-budget', {
    kind: 'social',
    expectedOwnerUserId: 'owner-1',
    subjectId: 'agent-1',
    supabaseUrl: 'https://supabase.example',
    anonKey: 'anon-key',
    agentId: 'agent-1',
    threadRootId: null,
    guguHome: '/tmp/gugu-listed-budget',
    getAccessToken: async () => 'token',
    runSessionAction: async () => ({}),
    runExtensionAction: async () => ({}),
  })
  const client = new Client({ name: 'listed-budget-probe', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(grant.url), {
    requestInit: { headers: { Authorization: `Bearer ${grant.capability}` } },
  }))
  const { tools } = await client.listTools()
  await client.close()
  return tools
}

const cost = (tools: Array<{ name: string }>) => tools.reduce((sum, tool) => sum + estimatePromptTokens(JSON.stringify(tool)), 0)

describe('the listed gugu tools stay within their always-paid budget (#7335)', () => {
  it('tools/list as a session-page agent gets it fits GUGU_LISTED_TOOLS_TOKEN_BUDGET', async () => {
    const tools = await listedTools()
    // 阳控:读的是完整的那组,不是空清单(空清单 0 token 也「在预算内」)。
    expect(new Set(tools.map((tool) => tool.name))).toEqual(GUGU_LISTED_TOOLS)
    const perTool = tools.map((tool) => ({ name: tool.name, tokens: cost([tool]) })).sort((a, b) => b.tokens - a.tokens)
    const total = cost(tools)
    process.stdout.write(`[listed-tools-budget] ${total}/${GUGU_LISTED_TOOLS_TOKEN_BUDGET} ${JSON.stringify(perTool)}\n`)
    expect(total, `listed tools cost ${total}; delete words before adding any`).toBeLessThanOrEqual(GUGU_LISTED_TOOLS_TOKEN_BUDGET)
  })

  // 反例对照:同一份清单里一条描述长出预算余量,判据就红 —— 证明描述(不只是名字)被计进去了。
  it('a description grown past the headroom fails it', async () => {
    const tools = await listedTools()
    const headroom = GUGU_LISTED_TOOLS_TOKEN_BUDGET - cost(tools)
    const grown = tools.map((tool, i) => (i === 0 ? { ...tool, description: `${tool.description}${' word'.repeat(headroom + 1)}` } : tool))
    expect(cost(grown)).toBeGreaterThan(GUGU_LISTED_TOOLS_TOKEN_BUDGET)
  })
})
