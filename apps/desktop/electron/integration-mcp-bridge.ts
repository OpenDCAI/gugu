import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import type { AcpMcpServer } from './acp-engine-utils'
import { GuguMcpHost, type GuguMcpHostPersistence } from './gugu-mcp-host'
import { createLogger } from './lib/logger'

const log = createLogger('integration-mcp-bridge')

/**
 * 一条已连接集成在会话里的样子。
 *
 * ⚠️ `endpoint`(令牌 / key)是**每次调用现取**,❌ 不是会话启动时定死的一份令牌。
 * 会话进程的 MCP 配置在它启动那一刻就写死了(环境变量 / 配置文件),而 Linear、Notion 这类
 * 授权是会过期、会轮换的:把令牌直接写进会话,续期之后那条会话就一直拿着过期的那份,
 * 表现为「连着,但 agent 一调就失败」。咕咕在中间转这一道,会话拿到的始终是咕咕自己的
 * 会话令牌,换谁的授权都不打断它。
 */
/**
 * #7240 咕咕自己答的那几家(邮箱:IMAP / SMTP 在连着的那台机器上收发):没有对方的托管 MCP 可转,
 * 工具由咕咕给。每次现读账号(连了 / 断了第二个邮箱,不必重开会话)。
 */
export interface LocalIntegrationTools {
  list(signal: AbortSignal): Promise<Tool[]>
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult>
}

/** 每次调用现取的对方地址与请求头:OAuth 那几家是固定地址 + 现取的 Bearer 令牌,高德是带用户 key 的地址。 */
export type IntegrationEndpoint = { url: string; headers: Record<string, string> }

/** 工具从哪来:转发给对方的托管 MCP,或咕咕自己答。 */
export type IntegrationUpstream =
  | { kind: 'remote'; endpoint: (signal?: AbortSignal) => Promise<IntegrationEndpoint> }
  | { kind: 'local'; tools: LocalIntegrationTools }

export interface IntegrationGrantContext {
  ownerUserId: string
  subjectId: string
  integrationId: string
  upstream: IntegrationUpstream
}

export type IntegrationMcpHost = GuguMcpHost<IntegrationGrantContext>

async function withUpstream<T>(
  upstream: Extract<IntegrationUpstream, { kind: 'remote' }>,
  signal: AbortSignal | undefined,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const { url, headers } = await upstream.endpoint(signal)
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } })
  const client = new Client({ name: 'gugu', version: '1.0.0' })
  await client.connect(transport)
  try {
    return await run(client)
  } finally {
    await client.close()
  }
}

/**
 * 把一家已连接的集成转成会话里的一台 MCP server —— 工具清单与调用**原样转发**给对方的托管 MCP。
 *
 * ❌ 不在这里挑工具、不改名、不加壳:集成给什么,agent 就看见什么。咕咕在这条链上只做两件事,
 * 换令牌和记账;它不是一层策略(与 `gugu-extension-api-gives-mechanism-not-policy` 同一条立场)。
 */
export function createIntegrationMcpHost(persistence?: GuguMcpHostPersistence): IntegrationMcpHost {
  return new GuguMcpHost<IntegrationGrantContext>(
    (getContext, grantSignal, trackRequest) => {
      const { integrationId } = getContext()
      const server = new McpServer(
        { name: integrationId, version: '0.1.0' },
        { capabilities: { tools: {} } },
      )
      server.server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
        const { upstream } = getContext()
        const signal = AbortSignal.any([grantSignal, extra.signal])
        return trackRequest(
          upstream.kind === 'local'
            ? upstream.tools.list(signal).then((tools) => ({ tools }))
            : withUpstream(upstream, signal, async (client) => ({ tools: (await client.listTools()).tools })),
          'tools/list',
        )
      })
      server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        const { upstream } = getContext()
        const signal = AbortSignal.any([grantSignal, extra.signal])
        return trackRequest(
          upstream.kind === 'local'
            ? upstream.tools.call(request.params.name, request.params.arguments ?? {}, signal)
            : withUpstream(upstream, signal, (client) => client.callTool(request.params)),
          request.params.name,
        )
      })
      return server
    },
    (context) => ({
      ownerId: context.ownerUserId,
      subjectId: context.subjectId,
      toolScope: `integration:${context.integrationId}`,
    }),
    persistence,
  )
}

export interface IntegrationBridgeEntry {
  integrationId: string
  upstream: IntegrationUpstream
}

/**
 * 每家已连接的集成一台 server。
 *
 * `owner: 'integration'` 是自己一档,不是 `'gugu'` 也不是 `'user'`(见 McpServerOwner):
 * 地址是咕咕的转发口,所以由咕咕投递、不能交给各家原生发现;但它**随连随变**,所以不在
 * 各家静态能力包的名单里 —— 那份名单只管咕咕自己那台。用户可以在 `/mcp` 面板里为某条会话
 * 关掉它,咕咕自己那台则不可关。
 */
export async function buildIntegrationBridge(
  host: IntegrationMcpHost,
  grantKey: string,
  ownerUserId: string,
  subjectId: string,
  entries: readonly IntegrationBridgeEntry[],
): Promise<AcpMcpServer[]> {
  if (entries.length === 0) return []
  await host.start()
  const servers: AcpMcpServer[] = []
  for (const entry of entries) {
    try {
      const grant = await host.grant(`${grantKey}:${entry.integrationId}`, {
        ownerUserId,
        subjectId,
        integrationId: entry.integrationId,
        upstream: entry.upstream,
      })
      servers.push({
        name: entry.integrationId,
        transport: 'http',
        url: grant.url,
        headers: [{ name: 'Authorization', value: `Bearer ${grant.capability}` }],
        alwaysLoad: true,
        owner: 'integration',
      })
    } catch (error) {
      // 一家接不上不该把整条会话拖住 —— 但也❌不能静默:日志里要能看出是哪一家、为什么。
      log.warn(
        { integrationId: entry.integrationId, error: (error as Error).message },
        'integration MCP bridge unavailable for this session',
      )
    }
  }
  return servers
}
