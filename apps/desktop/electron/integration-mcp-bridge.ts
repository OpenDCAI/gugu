import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { integrationMcpTransport, type McpTransportKind } from '@gugu/session-plugins/integrations'
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
import { anySignal } from '@gugu/core/shared/anySignal'

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

/**
 * 每次调用现取的对方地址与请求头:OAuth 那几家是固定地址 + 现取的 Bearer 令牌;凭据由平台保管的那几家(高德,#921)
 * 是平台的转发口 + 本人现取的会话令牌。`fetch`:认得那一端特有的「不成」应答、把它说成一句清楚的错(平台转发口的
 * 「没连」「存着的凭据被拒」);不给 = 全局 fetch。
 */
export type IntegrationEndpoint = { url: string; headers: Record<string, string>; transport?: McpTransportKind; fetch?: typeof fetch }

/** 工具从哪来:转发给对方的托管 MCP,或咕咕自己答。 */
export type IntegrationUpstream =
  | { kind: 'remote'; endpoint: (signal?: AbortSignal) => Promise<IntegrationEndpoint> }
  | { kind: 'local'; tools: LocalIntegrationTools }

export interface IntegrationGrantContext {
  ownerUserId: string
  subjectId: string
  entries: () => Promise<readonly IntegrationBridgeEntry[]>
}

export type IntegrationMcpHost = GuguMcpHost<IntegrationGrantContext>

async function withUpstream<T>(
  upstream: Extract<IntegrationUpstream, { kind: 'remote' }>,
  signal: AbortSignal | undefined,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const transport = integrationMcpTransport(await upstream.endpoint(signal))
  const client = new Client({ name: 'gugu', version: '1.0.0' })
  let rejectAbort: (reason?: unknown) => void = () => {}
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const abort = () => {
    rejectAbort(signal?.reason)
    void client.close().catch((error: unknown) => log.warn({ error }, 'integration MCP cancellation failed'))
  }
  signal?.throwIfAborted()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    await Promise.race([client.connect(transport), aborted])
    signal?.throwIfAborted()
    return await run(client)
  } finally {
    signal?.removeEventListener('abort', abort)
    await client.close()
  }
}

/**
 * One permanent server per session, including sessions with no connected apps yet.
 * Names carry the integration id because different services can expose the same tool name.
 * Each list/call resolves current connections; disconnected tools cannot keep using old grants.
 */
export function createIntegrationMcpHost(persistence?: GuguMcpHostPersistence): IntegrationMcpHost {
  return new GuguMcpHost<IntegrationGrantContext>(
    (getContext, grantSignal, trackRequest) => {
      const server = new McpServer(
        { name: 'connected-apps', version: '0.1.0' },
        { capabilities: { tools: { listChanged: true } } },
      )
      server.server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
        const signal = anySignal([grantSignal, extra.signal])
        // entries() precedes the tracked upstream work; retain that metric boundary and its original error.
        const entries = await getContext().entries().catch((error: unknown) => {
          const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
          log.warn({ errorType: error instanceof Error ? error.name : 'unknown',
            errorCode: typeof code === 'number' ? code : undefined,
            mcpSessionId: extra.sessionId, requestId: extra.requestId }, 'connected app entries unavailable')
          throw error
        })
        return trackRequest(
          listConnectedTools(entries, signal, extra).then((tools) => ({ tools })),
          'tools/list',
          extra.requestId,
        )
      })
      server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        const entries = await getContext().entries()
        const entry = entries.find(({ integrationId }) => request.params.name.startsWith(`${integrationId}__`))
        if (!entry) throw new Error('This app is no longer connected in Gugu; reconnect it.')
        const { upstream, integrationId } = entry
        const params = { ...request.params, name: request.params.name.slice(integrationId.length + 2) }
        const signal = anySignal([grantSignal, extra.signal])
        return trackRequest(
          upstream.kind === 'local'
            ? upstream.tools.call(params.name, params.arguments ?? {}, signal)
            : withUpstream(upstream, signal, (client) => client.callTool(params)),
          request.params.name,
          extra.requestId,
        )
      })
      return server
    },
    (context) => ({
      ownerId: context.ownerUserId,
      subjectId: context.subjectId,
      toolScope: 'integration:connected-apps',
    }),
    persistence,
  )
}

export interface IntegrationBridgeEntry {
  integrationId: string
  upstream: IntegrationUpstream
}

async function listConnectedTools(entries: readonly IntegrationBridgeEntry[], signal: AbortSignal,
  request: { sessionId?: string; requestId: string | number }): Promise<Tool[]> {
  const tools: Tool[] = []
  const unavailable: string[] = []
  for (const { integrationId, upstream } of entries) {
    signal.throwIfAborted()
    try {
    const listed = upstream.kind === 'local' ? await upstream.tools.list(signal) : await withUpstream(upstream, signal, async (client) => {
      const all: Tool[] = []
      const cursors = new Set<string>()
      let cursor: string | undefined
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, { signal })
        all.push(...page.tools)
        cursor = page.nextCursor
        if (cursor && cursors.has(cursor)) throw new Error(`${integrationId} returned a repeated tools cursor`)
        if (cursor) cursors.add(cursor)
      } while (cursor)
      return all
    })
    tools.push(...listed.map((tool) => ({ ...tool, name: `${integrationId}__${tool.name}` })))
    } catch (error) {
      signal.throwIfAborted()
      unavailable.push(integrationId)
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      log.warn({ integrationId, errorType: error instanceof Error ? error.name : 'unknown',
        errorCode: typeof code === 'number' ? code : undefined,
        mcpSessionId: request.sessionId, requestId: request.requestId }, 'connected app tools unavailable')
    }
  }
  if (unavailable.length && tools.length === 0) throw new Error(`Connected app tools are unavailable: ${unavailable.join(', ')}. Check their connections.`)
  return tools
}

/**
 * One stable MCP configuration; new connections are discovered through list_changed.
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
  entries: readonly IntegrationBridgeEntry[] | (() => Promise<readonly IntegrationBridgeEntry[]>),
): Promise<Extract<AcpMcpServer, { url: string }>[]> {
  await host.start()
  const grant = await host.grant(`${grantKey}:connected-apps`, {
    ownerUserId,
    subjectId,
    entries: typeof entries === 'function' ? entries : async () => entries,
  })
  return [{
    name: 'connected-apps', transport: 'http', url: grant.url,
    headers: [{ name: 'Authorization', value: `Bearer ${grant.capability}` }],
    alwaysLoad: true, owner: 'integration',
  }]
}
