// ACP 引擎运行时工具 —— 从已删除的 JSON-RPC automation 层(原 rpc/methods/acpEngine.ts)抽出的
// 纯生产函数：引擎配置加载 / provider 凭据 allowlist / 注入式社交桥。
// 由 session-page 会话路径调用。原文件的 registerAcpEngineMethods()(HTTP RPC 端点)随对外
// automation 面一起删除；这些函数只依赖保留的 ipc-bridge + supabase 工厂。

import { getSupabaseAnonKey, getSupabaseUrl } from '@gugu/core/cloud/config'
import { requireRuntimeAuth, resolveGuguHome, type RuntimeAuth, type RuntimeAuthProvider } from '@gugu/core'
import { makeIdentityClient } from './supabase'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { GuguMcpHost, type GuguMcpHostPersistence } from './gugu-mcp-host'
// @ts-expect-error -- the MCP tool implementation is an untyped ESM module.
import { createGuguImServer, serveToolsList } from './mcp/gugu-im-server.mjs'
import { GUGU_MCP_SERVER_NAME } from './mcp/gugu-mcp-name.mjs'
import { registerGuguScheduleTools } from './mcp/gugu-schedule-tool'
import { registerGuguProjectTools } from './mcp/gugu-project-tool'
import { registerGuguLibraryTools } from './mcp/gugu-library-tool'
import { registerAssistantResource } from './mcp/gugu-assistant-resource'
import type { AssistantLocalSource } from './sessionpage/assistant-local-index'
import { registerGuguSessionTools, type SessionDispatcher } from './mcp/gugu-session-tool'
import { registerGuguExtensionTools } from './mcp/gugu-extension-tool'
import { runAppAction } from './mcp/app-tool-host'
import { registerGuguGuideTools } from './mcp/gugu-guide-tool'
import type { ExtensionSkill } from '@gugu/session-core/agents/plugins'
import { GUGU_LISTED_TOOLS, registerGuguCatalogTools, type CatalogTool } from './mcp/gugu-catalog-tools'
import { registerGuguAppSearchTool, type AppSearchHit } from './mcp/gugu-app-search-tool'
import { buildAgentIdentityBlock } from '@gugu/core/local/agent/deviceCommandRuntime'
import type { McpServerOwner } from '@gugu/session-core/mcp'

export type AcpMcpServer =
  | {
      name: string
      transport?: 'http'
      url: string
      headers: { name: string; value: string }[]
      alwaysLoad?: boolean
      owner?: McpServerOwner
      /** 资源库 → MCP 勾上的那台(见 core 的 SessionMcpServer.library)。 */
      library?: true
    }
  | {
      name: string
      transport: 'stdio'
      command: string
      args?: readonly string[]
      /** Map of MCP env names to references in the child-process environment. */
      env?: Readonly<Record<string, string>>
      cwd?: string
      alwaysLoad?: boolean
      owner?: McpServerOwner
      /** 资源库 → MCP 勾上的那台(见 core 的 SessionMcpServer.library)。 */
      library?: true
    }

export interface AcpEngineRuntimeContext {
  authProvider: RuntimeAuthProvider
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
}

async function getAuthenticatedIdentityClient(context: AcpEngineRuntimeContext) {
  const { accessToken } = await requireRuntimeAuth(context.authProvider, 'ACP identity client')
  return makeIdentityClient(accessToken)
}

/** A provision's explicit member role distinguishes the personal assistant from task agents. */
export async function isPersonalAssistant(context: AcpEngineRuntimeContext, agentUserId: string): Promise<boolean> {
  const client = await getAuthenticatedIdentityClient(context)
  const { data, error } = await client.from('agent_provisions').select('id')
    .eq('agent_user_id', agentUserId).eq('member_key', 'assistant').limit(1)
  if (error) throw new Error(`Assistant context role could not be read: ${error.message}`)
  return Boolean(data?.length)
}

// 身份 bootstrap — 新 ACP 会话(session/new,非 resume)的 session system block:agent 是谁 + 它的
// persona(special_focus)。消息 delivery 只携带 message-local facts/body，不再前置身份。
// 与 greeting 的身份块同形(participant_id/special_focus),但不带 DM 专属的行为文案
// (回复契约已由每封投递信封自带,@@@self-describing-deliver)。显示名不进这个块(#6490):它会变,agent 要知道就调 profile_whoami。
export async function buildAgentIdentityBootstrap(
  context: AcpEngineRuntimeContext,
  agentUserId: string,
  /**
   * #5323 调用方已经知道 persona 时直接给 —— 铸身份的那一步知道 persona 为空,
   * 再去 `identity.users` 读一趟纯属重复劳动(真机实测 416 ms,挡在用户面前)。
   * 不给就照旧查库(复用既有身份时 persona 可能被别处改过)。
   */
  known?: { specialFocus: string | null },
): Promise<string> {
  if (known) {
    return buildAgentIdentityBlock({
      guguUserId: agentUserId,
      specialFocus: known.specialFocus,
    }) + '\n'
  }
  const client = await getAuthenticatedIdentityClient(context)
  const { data, error } = await client
    .from('users')
    .select('special_focus')
    .eq('id', agentUserId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return ''
  const row = data as { special_focus: string | null }
  // 模板本体在 core(@@@identity-block-ssot,与 greeting 同源);本层只负责取库里的身份字段。
  return buildAgentIdentityBlock({
    guguUserId: agentUserId,
    specialFocus: row.special_focus,
  }) + '\n'
}


// provider 凭据 allowlist（聚焦 claude + codex；对齐 core 的 safeEnvForAgentSpawn，后续收敛到一处）。
const ENGINE_ENV_ALLOWLIST = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  // qwen 的第三个 canonical 变量。这张白名单过的是**用户自己 export 的**环境(不是咕咕注入的那份),
  // 所以缺了它的后果只落在 BYOK:用户 export 的 `OPENAI_MODEL` 被静默丢掉,而 qwen 缺这个键会
  // 直接拒启动(实测 0.22.0,见 capability-bundle 的 `qwen-openai-env`)。
  // 对 codex / opencode 无影响 —— 它们都不读这个变量,各自从自己的配置面取模型。
  'OPENAI_MODEL',
  // gemini 的三个 canonical 变量(实测 0.57.0,#4655)。同 OPENAI_MODEL 那条:这张白名单过的是
  // **用户自己 export 的**环境,缺了它们的后果只落在 BYOK —— 用户 export 的 GEMINI_API_KEY /
  // GOOGLE_GEMINI_BASE_URL / GEMINI_MODEL 被静默丢掉。对其余家无影响(谁都不读这三个名字)。
  'GEMINI_API_KEY',
  'GOOGLE_GEMINI_BASE_URL',
  'GEMINI_MODEL',
  'CLAUDE_CODE_EXECUTABLE',
] as const

export function providerEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ENGINE_ENV_ALLOWLIST) {
    const v = source[key]
    if (v) env[key] = v
  }
  return env
}

interface GuguMcpContextBase {
  expectedOwnerUserId: string
  subjectId: string
  runSessionAction?: (action: unknown, signal?: AbortSignal) => Promise<unknown>
  readAssistantResources?: () => Promise<AssistantLocalSource[]>
  /** @@@2374 `gugu_session` 的 app_* 动作:写一个会话页 tab 扩展并装上。不需要 owner 令牌。 */
  runExtensionAction?: (action: unknown, signal?: AbortSignal) => Promise<unknown>
  /** #6615 这张卡的 key(`taskpage:<会话>`):扩展目录按它认会话。 */
  grantKey?: string
}

/** #6615 会话经 catalog_* 够得到的扩展工具,与此刻被排除在外的程序(问题 16);扩展服务就绪后由宿主设上,没设 = 没有。 */
interface SessionExtensionCatalog {
  /** `agentUserId`: the calling agent's gugu id, stamped on its program calls (F16 `_meta['gugu/agent']`). */
  tools(grantKey: string, agentUserId?: string, name?: string): Promise<CatalogTool[]>
  /** Every installed App and what this session can do with it now; with `withMarket`, the market's Apps not installed here too. */
  apps(grantKey: string | undefined, withMarket: boolean): Promise<{ apps: AppSearchHit[]; market?: string }>
  /** The skills of the Apps this session reaches now, listed with their tools (an App given after it opened, too). */
  skills(grantKey: string): Promise<ExtensionSkill[]>
}
let sessionExtensionCatalog: SessionExtensionCatalog | null = null

export function setSessionExtensionCatalog(catalog: SessionExtensionCatalog | null): void {
  sessionExtensionCatalog = catalog
}

export type GuguMcpContext = GuguMcpContextBase & (
  | {
      kind: 'social'
      supabaseUrl: string
      anonKey: string
      agentId: string
      threadRootId: string | null
      guguHome: string
      getAccessToken: (signal?: AbortSignal) => Promise<string>
      runHostAction?: (action: unknown, signal?: AbortSignal) => Promise<unknown>
      /**
       * 有值 = 这条 grant 属于一条**运行时分叉**(侧边聊天),值是来源 agent 的显示名。
       *
       * 分叉拿的是和来源**一模一样**的能力包 —— 同一份系统提示、同一份工具清单。这不是偷懒:
       * 工具清单和系统提示都在模型前缀里,只要有一处不同,分叉继承来的那整段上下文就命中不了
       * 缓存(主会话实测量级 `input=23,695 (+30,208 cached)`),等于每开一次侧边聊天都全价重算。
       *
       * 但分叉**没有咕咕身份**(#3805 不落库),所以 IM 那组工具虽然照常注册,调用一律拒绝 ——
       * 见 gugu-im-server.mjs 的 handler。「注册」与「可执行」在这里被有意拆开:前者是缓存的
       * 代价,后者是身份的边界。❌ 别用「不注册」来实现「不许用」,那会连带打掉缓存。
       */
      forkOf?: string
    }
  | { kind: 'session-only' }
)

export type DesktopGuguMcpHost = GuguMcpHost<GuguMcpContext>

export function createDesktopGuguMcpHost(persistence?: GuguMcpHostPersistence): DesktopGuguMcpHost {
  return new GuguMcpHost<GuguMcpContext>(
    (getContext, grantSignal, trackRequest) => {
      const initial = getContext()
      const server = initial.kind === 'social'
        ? createGuguImServer(() => {
            const latest = getContext()
            if (latest.kind !== 'social') throw new Error('Gugu MCP grant changed context kind')
            return latest
          }, { signal: grantSignal, trackRequest })
        : new McpServer({ name: GUGU_MCP_SERVER_NAME, version: '0.3.0' })
      // session_* 与 app_* 两个域(#4191)与社交域同 server 注册:
      // 一条 grant 只要拿得到其中任一半就两个域全部注册,缺的那一半在调用时报错 —— 工具清单不随
      // grant 变,否则每种组合都是一份新的模型前缀。
      if (getContext().runSessionAction || getContext().runExtensionAction) {
        const sessionDispatcher: SessionDispatcher | undefined = getContext().runSessionAction
          ? (action, requestSignal) => {
              const run = getContext().runSessionAction
              if (!run) throw new Error('session_* tools are unavailable for this grant')
              return run(action, AbortSignal.any([grantSignal, requestSignal]))
            }
          : undefined
        registerGuguSessionTools(server, sessionDispatcher, trackRequest)
        registerGuguProjectTools(server, sessionDispatcher, trackRequest)
        registerGuguLibraryTools(server, sessionDispatcher, trackRequest)
        if (sessionDispatcher) registerAssistantResource(server, {
          accountId: async () => {
            const context = getContext()
            if (context.kind !== 'social' || context.forkOf !== undefined) return null
            await context.getAccessToken(grantSignal)
            return context.expectedOwnerUserId
          },
          run: (action, signal) => sessionDispatcher(action, AbortSignal.any([grantSignal, signal])),
          ...(initial.readAssistantResources ? { localSources: () => {
            const read = getContext().readAssistantResources
            if (!read) throw new Error('Personal assistant context is unavailable')
            return read()
          } } : {}),
        })
        // #7221 schedule_* 与 session_* 同一个分派器:给自己排的已安排只作用于这条会话。
        registerGuguScheduleTools(server, sessionDispatcher, trackRequest)
        registerGuguExtensionTools(
          server,
          getContext().runExtensionAction
            ? (action, requestSignal) => {
                const run = getContext().runExtensionAction
                if (!run) throw new Error('app_* tools are unavailable for this grant')
                const signal = AbortSignal.any([grantSignal, requestSignal])
                const runSession = getContext().runSessionAction
                return runAppAction(
                  action,
                  getContext(),
                  (ready) => run(ready, signal),
                  runSession ? (session) => runSession(session, signal) : undefined,
                )
              }
            : undefined,
          trackRequest,
        )
      }
      registerGuguGuideTools(server)
      // 侧边聊天(分叉)不带扩展,与原生条目同一条规矩。
      const extensionsFor = (context: GuguMcpContext) =>
        context.kind === 'social' && context.forkOf === undefined && context.grantKey ? sessionExtensionCatalog : null
      registerGuguCatalogTools(server, async (name) => {
        const context = getContext()
        const agentUserId = context.kind === 'social' ? context.agentId : undefined
        return context.grantKey ? await extensionsFor(context)?.tools(context.grantKey, agentUserId, name) ?? [] : []
      }, async () => {
        // #6634 问题 16: the installed Apps this session cannot use, and why — the same states app_search shows.
        const found = await extensionsFor(getContext())?.apps(getContext().grantKey, false)
        return (found?.apps ?? []).filter((app) => app.state !== 'on').map((app) => `${app.manifest.name} (${app.manifest.id}): ${app.next}`)
      }, async () => {
        const context = getContext()
        return context.grantKey ? await extensionsFor(context)?.skills(context.grantKey) ?? [] : []
      })
      // 10-19 Finding an App is app_search's alone (owner: catalog_list lists tools, not Apps); in the catalog, not the native list.
      registerGuguAppSearchTool(server, () => extensionsFor(getContext())?.apps(getContext().grantKey, true) ?? null)
      serveToolsList(server, getContext, (name: string) => GUGU_LISTED_TOOLS.has(name))
      return server
    },
    (context) => ({
      ownerId: context.expectedOwnerUserId,
      subjectId: context.subjectId,
      // 分叉的 IM 工具「注册但不可执行」—— 台账要照实记,否则一条不能收发消息的 grant 会以
      // 「gugu+session」的面目留在审计里。
      toolScope: context.kind !== 'social'
        ? 'session-only'
        : context.forkOf !== undefined
          ? (context.runSessionAction ? 'runtime-fork+session' : 'runtime-fork')
          : (context.runSessionAction ? 'gugu+session' : 'gugu'),
    }),
    persistence,
  )
}

export interface BuildSocialBridgeDeps {
  getSupabaseUrl?: () => string
  getSupabaseAnonKey?: () => string
  host: DesktopGuguMcpHost
  grantKey: string
  runHostAction?: (action: unknown, auth: RuntimeAuth, signal: AbortSignal) => Promise<unknown>
  runSessionAction?: (action: unknown, auth: RuntimeAuth, signal: AbortSignal) => Promise<unknown>
  readAssistantResources?: () => Promise<AssistantLocalSource[]>
  /** @@@2374 无需 owner 令牌:写文件与装扩展都不代表用户去调任何云端接口。 */
  runExtensionAction?: (action: unknown, signal?: AbortSignal) => Promise<unknown>
  /** 运行时分叉:来源 agent 的显示名。见 GuguMcpContext.forkOf。 */
  forkOf?: string
}

export async function buildSocialBridge(
  context: AcpEngineRuntimeContext,
  agentUserId: string,
  threadRootId: string | null | undefined,
  deps: BuildSocialBridgeDeps,
): Promise<AcpMcpServer[]> {
  try {
    const supabaseUrl = (deps.getSupabaseUrl ?? getSupabaseUrl)()
    const anonKey = (deps.getSupabaseAnonKey ?? getSupabaseAnonKey)()
    const { userId: expectedOwnerUserId } = await requireRuntimeAuth(
      context.authProvider,
      'gugu MCP bridge',
    )
    await deps.host.start()
    const getBoundAuth = async (signal?: AbortSignal): Promise<RuntimeAuth> => {
      signal?.throwIfAborted()
      const auth = await requireRuntimeAuth(context.authProvider, 'gugu MCP tool call')
      signal?.throwIfAborted()
      if (auth.userId !== expectedOwnerUserId) {
        throw new Error('gugu MCP owner changed; revoke the old session grant')
      }
      return auth
    }
    const grantContext = {
      kind: 'social' as const,
      expectedOwnerUserId,
      subjectId: agentUserId,
      supabaseUrl,
      anonKey,
      agentId: agentUserId,
      threadRootId: threadRootId ?? null,
      guguHome: resolveGuguHome(context.env),
      grantKey: deps.grantKey,
      getAccessToken: async (signal?: AbortSignal) => (await getBoundAuth(signal)).accessToken,
      ...(deps.forkOf === undefined ? {} : { forkOf: deps.forkOf }),
      ...(deps.readAssistantResources ? { readAssistantResources: async () => {
        await getBoundAuth()
        const resources = await deps.readAssistantResources!()
        await getBoundAuth()
        return resources
      } } : {}),
      ...(deps.runHostAction
        ? { runHostAction: async (action: unknown, signal?: AbortSignal) => {
            const result = await deps.runHostAction!(action, await getBoundAuth(signal), signal!)
            signal?.throwIfAborted()
            return result
          } }
        : {}),
      ...(deps.runExtensionAction ? { runExtensionAction: deps.runExtensionAction } : {}),
      ...(deps.runSessionAction
        ? { runSessionAction: async (action: unknown, signal?: AbortSignal) => {
            const result = await deps.runSessionAction!(action, await getBoundAuth(signal), signal!)
            signal?.throwIfAborted()
            return result
          } }
        : {}),
    }
    const grant = await deps.host.grant(deps.grantKey, grantContext)
    return [{
      name: GUGU_MCP_SERVER_NAME,
      transport: 'http',
      url: grant.url,
      headers: [{ name: 'Authorization', value: `Bearer ${grant.capability}` }],
      alwaysLoad: true,
      owner: 'gugu',
    }]
  } catch (err) {
    throw new Error(`gugu MCP bridge unavailable: ${(err as Error).message}`)
  }
}

export async function buildSessionOnlyBridge(
  context: AcpEngineRuntimeContext,
  subjectId: string,
  deps: Pick<BuildSocialBridgeDeps, 'host' | 'grantKey' | 'runSessionAction' | 'runExtensionAction'>,
): Promise<AcpMcpServer[]> {
  if (!deps.runSessionAction) throw new Error('session_* action dispatcher is required')
  const { userId: expectedOwnerUserId } = await requireRuntimeAuth(
    context.authProvider,
    'gugu session MCP bridge',
  )
  await deps.host.start()
  const getBoundAuth = async (signal?: AbortSignal): Promise<RuntimeAuth> => {
    signal?.throwIfAborted()
    const auth = await requireRuntimeAuth(context.authProvider, 'session_* MCP tool call')
    signal?.throwIfAborted()
    if (auth.userId !== expectedOwnerUserId) {
      throw new Error('gugu session MCP owner changed; revoke the old session grant')
    }
    return auth
  }
  const grant = await deps.host.grant(deps.grantKey, {
    kind: 'session-only',
    expectedOwnerUserId,
    subjectId,
    runSessionAction: async (action, signal) => {
      const result = await deps.runSessionAction!(action, await getBoundAuth(signal), signal!)
      signal?.throwIfAborted()
      return result
    },
    // #6387 调用方传了扩展分派器就接上 —— 从前这里只挑了 session 那半,于是侧边聊天里的
    // app_* 全部报「unavailable」,哪怕调用方明明给了分派器。
    ...(deps.runExtensionAction ? { runExtensionAction: deps.runExtensionAction } : {}),
  })
  return [{
    name: GUGU_MCP_SERVER_NAME,
    transport: 'http',
    url: grant.url,
    headers: [{ name: 'Authorization', value: `Bearer ${grant.capability}` }],
    alwaysLoad: true,
    owner: 'gugu',
  }]
}
