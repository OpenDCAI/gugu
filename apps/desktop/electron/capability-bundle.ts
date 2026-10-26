import { join } from 'node:path'
import { platformModelAccessEnv, resolveGuguHome } from '@gugu/core'
import type {
  CapabilityPackage,
  ExtensionSkill,
  DirectorySymlinkOverlay,
  GeneratedArtifact,
  GeneratedSymlink,
  HarnessSessionSurface,
  JsonMerge,
  JsonOverlay,
  ModelConfigDialect,
  PlatformCallableRoutes,
  SessionModelCapability,
  RetiredArtifact,
  SessionBundleDescriptor,
  SessionCapabilityBundle as CoreSessionCapabilityBundle,
  SessionMaterialization as CoreSessionMaterialization,
  SessionMaterializationContext,
  SessionMcpServer,
  TomlOverlay,
} from '@gugu/session-core/agents/plugins'
import { mcpToolNamesOn, mountsExtensionSkillsNatively, positiveWindow, resolveUnitDelivery, unitDeliveryIsNativeAnywhere } from '@gugu/session-core/agents/plugins'
import { GUGU_MCP_SERVER_NAME } from './mcp/gugu-mcp-name.mjs'
import { platformProtocolForEngine } from './engine-injection-contract'
import { pluginRegistry, PRODUCT_CAPABILITY_PACKAGES } from '@gugu/session-plugins/agents'
import {
  buildSocialBridge,
  providerEnv,
  type AcpMcpServer,
  type AcpEngineRuntimeContext,
  type BuildSocialBridgeDeps,
} from './acp-engine-utils'
import type { ExtensionCatalogApp, ExtensionSessionMcp } from './extension-session-mcp'
import { sessionpageSessionOfGrantKey } from './stable-mcp-persistence'
import type { McpServer as CanonicalMcpServer } from '@gugu/session-core/mcp'
import type { GuguPermissionMode } from '@gugu/session-core/acp'
import { GUGU_PLATFORM_BLOCK, estimatePromptTokens } from './product-platform-prompt'
import { firstSentence } from './mcp/first-sentence'
import { mcpEnvSuffix } from '../src/session/shared/mcp-library'

export { PRODUCT_CAPABILITY_PACKAGES } from '@gugu/session-plugins/agents'

/** Harness-neutral declaration of the capabilities Gugu gives one agent session. */
export interface SessionCapabilityBundle {
  /** Generic conversation key; adapters may ignore it when they have no per-session state. */
  sessionKey?: string
  mcpServers: AcpMcpServer[]
  /**
   * 用户在 `/mcp` 里关掉的那几台(spec `mcp-session-toggle`)。`[]` 与缺席不同,❌ 不归一。
   *
   * ⚠️ **故意不写 `?`** —— 键必答,值可以是 `undefined`。
   * 可选字段在这条链上会**静默断链**:入口类型有它、出口类型也有它,而中间某一跳的对象字面量
   * 没写这个键,tsc 一声不吭。2026-09-07 实撞:`buildSessionBundle` 收下了 `deps.mcpDisabled`,
   * 返回的却是 `buildSessionBootstrapBundle(deps)` 的结果 —— 那个字面量里根本没有这个键,
   * 于是关闭集合在这一跳整个掉了,四门全绿,产品面表现为「界面说关了、工具表纹丝不动」。
   * 键必答之后,**每一个**构造点都必须把它写出来,断链会变成一条编译错误。
   */
  mcpDisabled: readonly string[] | undefined
  env: NodeJS.ProcessEnv
  model: SessionModelCapability | null
  autonomy: SessionAutonomyCapability | null
  promptBlocks: SessionPromptBlocks
  packages: readonly CapabilityPackage[]
  /**
   * #6387 Skills installed extensions bring. Required like `mcpDisabled`: an optional key on
   * this chain drops silently at whichever hop forgets to copy it.
   */
  extensionSkills: readonly ExtensionSkill[]
  /** 上下文工程第二批 P3: the Apps whose tools this session reaches through the catalog (`<gugu_apps>` names them). Required, same reason. */
  extensionApps: readonly ExtensionCatalogApp[]
  /** #6387 Which extension each extension program in `mcpServers` came from (for the `/mcp` panel). */
  extensionServerOrigins: readonly { name: string; extensionId: string }[]
}

// Keep the Electron-side declaration available at this boundary as well. The core and
// Electron bundles intentionally share the same discriminated stdio/http shape; conversion
// below is the only place where the wire-oriented AcpMcpServer is normalized.
export type { SessionMcpServer }

function sessionMcpEnvRef(serverName: string, key: string): string {
  const sanitize = (value: string) => value.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()
  return `GUGU_SESSION_MCP_ENV_${sanitize(serverName)}_${sanitize(key)}`
}

/** Convert user MCP config into the transport-neutral session declaration. */
export function canonicalMcpServersToSessionServers(
  servers: readonly CanonicalMcpServer[],
): { servers: AcpMcpServer[]; env: Record<string, string> } {
  const env: Record<string, string> = {}
  const converted: AcpMcpServer[] = []
  for (const server of servers) {
    if (server.enabled === false) continue
    if (server.transport === 'stdio') {
      if (!server.command) throw new Error(`MCP '${server.name}' is stdio but has no command`)
      const refs: Record<string, string> = {}
      for (const [key, value] of Object.entries(server.env ?? {})) {
        if (value === undefined) continue
        const ref = sessionMcpEnvRef(server.name, key)
        refs[key] = ref
        env[ref] = value
      }
      converted.push({
        name: server.name,
        transport: 'stdio',
        command: server.command,
        ...(server.args ? { args: [...server.args] } : {}),
        ...(Object.keys(refs).length > 0 ? { env: refs } : {}),
        ...(server.cwd ? { cwd: server.cwd } : {}),
        owner: 'user',
      })
      continue
    }
    const url = server.url
    if (!url) throw new Error(`MCP '${server.name}' is HTTP but has no URL`)
    const unsupported = Object.keys(server.headers ?? {}).filter((name) => name.toLowerCase() !== 'authorization')
    if (unsupported.length > 0) {
      throw new Error(`MCP '${server.name}' has unsupported headers: ${unsupported.join(', ')}`)
    }
    converted.push({
      name: server.name,
      transport: 'http',
      url,
      headers: server.headers
        ? Object.entries(server.headers).map(([name, value]) => ({
            name,
            value: name.toLowerCase() === 'authorization'
              ? `\${${sessionMcpEnvRef(server.name, 'AUTH')}}`
              : value,
          }))
        : [],
      owner: 'user',
    })
    const authorization = Object.entries(server.headers ?? {}).find(
      ([name]) => name.toLowerCase() === 'authorization',
    )
    if (authorization) env[sessionMcpEnvRef(server.name, 'AUTH')] = authorization[1]
  }
  return { servers: converted, env }
}

export type { ModelConfigDialect }

export type { SessionModelCapability }

export interface SessionAutonomyCapability {
  mode: 'approval-required' | 'full-access'
  /**
   * Exact product tier, authoritative when present. `mode` is the legacy coarse channel derived from
   * this value; old boolean-only callers omit it and retain their historical behavior.
   */
  permissionMode?: GuguPermissionMode
}

export interface SessionPromptBlocks {
  /**
   * 平台自述：agent 运行在咕咕上、咕咕是什么、这里怎么说话办事。
   *
   * 与 identity 的分工：identity 说「你是谁」（每个 agent 不同，查库得来），platform 说「你在哪」
   * （所有 agent 相同，编译期常量）。platform 排在最前，因为「这是个群聊、你说的话所有人看得见」
   * 是理解后面身份与消息事实的前提。threadBootstrap 保留为兼容字段，但不再由 system prompt renderer 消费；
   * thread 前情由 canonical message delivery 的 message-local instruction 携带。
   *
   * 它是**常驻**的，不是渐进披露的 skill：「@Name 写在正文里不通知任何人」这类纪律一旦漏读就直接
   * 把事做砸，不能留「模型可能没触发它」的口子（owner 2026-08-07 拍板，代价是每会话固定花一笔）。
   * 因为是常量，它由 buildSessionBundle 无条件带上；有原生 system-prompt 通道的 loader 在
   * session-open 就投它，没有的按 capability contract 显式 degraded；不得把它随普通消息前置。
   */
  platform?: string
  identity?: string
  threadBootstrap?: string
}

export type CapabilityUnit = 'mcp' | 'env' | 'model' | 'promptBlocks' | 'autonomy' | 'packages'

export interface CapabilityLoadReport {
  adapterId: string
  surface: HarnessSessionSurface
  loaded: CapabilityUnit[]
  degraded: { unit: CapabilityUnit; reason: string }[]
  discoveredCommands: string[]
}

/** Pure harness-specific actions. Callers only apply these values to their native channel. */
export interface Materialization {
  extraArgs?: string[]
  /** Native app-server thread config overrides, kept separate from process argv. */
  threadConfig?: Readonly<Record<string, unknown>>
  /** Native fields for the provider's thread/start call, kept out of process argv. */
  threadStart?: Readonly<Record<string, unknown>>
  /** #6387 Skill roots the engine registers at runtime (codex app-server `skills/extraRoots/set`). */
  skillRoots?: readonly string[]
  /** Provider-native fields for an HTTP/session create request. */
  sessionCreatePatch?: Readonly<{ agent?: string }>
  /**
   * A settings **document** that has to out-rank the user's own settings files, not just their
   * environment.
   *
   * Deliberately the document and not a ready-made argv: the only safe way to hand it over is a
   * 0600 file whose path goes on the command line (`--settings <path>`), because the document
   * carries this session's relay token and argv is world-readable from the process table. Writing
   * that file is IO and belongs to whoever owns the session's lifetime (it has to be deleted when
   * the session ends), so this layer stops at the value.
   *
   * Kept apart from `extraArgs` because it also has a different destination: it belongs to the
   * process that actually reads those settings files (Claude Code's own CLI), whereas `extraArgs`
   * goes to whatever process an adapter is assembling — for the ACP path that is the trusted
   * adapter entrypoint. An adapter that does not know this field simply never reads it.
   */
  settingsOverride?: Record<string, unknown>
  spawnEnv?: Record<string, string>
  developerInstructions?: string
  sessionNewPatch?: {
    mcpServers?: AcpProtocolMcpServer[]
    meta?: Record<string, unknown>
  }
  /**
   * ACP/session-open system prompt projection. It is never a message delivery channel and must not
   * be attached through hiddenContext; session-TUI launch consumes the same bytes through its native
   * system-prompt materialization.
   */
  sessionPrompt?: string
  /** 上面那段走哪根管子(behavior `agent-context-injection` ②/③);缺省 `'system'`。 */
  sessionPromptCarrier?: 'system' | 'session-context'
  configMerges?: readonly JsonMerge[]
  artifacts?: readonly GeneratedArtifact[]
  tomlOverlays?: readonly TomlOverlay[]
  jsonOverlays?: readonly JsonOverlay[]
  symlinks?: readonly GeneratedSymlink[]
  directorySymlinkOverlays?: readonly DirectorySymlinkOverlay[]
  retiredArtifacts?: readonly RetiredArtifact[]
  /**
   * promptBlocks 里已经通过本 loader 的**原生 session-open 通道**送达的那些键。
   *
   * 调用方不得再把它们随任何消息前置 —— 否则同一段话在一个会话里出现两次。没有原生通道的 loader
   * 必须对 system prompt unit 返回结构化 degraded，不能把 session-level bytes 伪装成用户内容。
   */
  sessionOpenPromptBlocks?: readonly (keyof SessionPromptBlocks)[]
  report: CapabilityLoadReport
}

export interface CapabilityLoader {
  id: 'gugu-acp'
  supports: ReadonlySet<CapabilityUnit>
  load(
    bundle: SessionCapabilityBundle,
    identity?: { adapterId: string; surface: HarnessSessionSurface },
  ): Materialization
}

export interface BuildSessionBundleDeps {
  runtime: AcpEngineRuntimeContext
  agentUserId: string
  /** Stable product conversation/session key used by harnesses with per-session config roots. */
  sessionKey?: string
  /** Assistant reception discovers App tools through the existing catalog. */
  extensionTools?: 'catalog'
  threadRootId?: string | null
  additionalMcpServers?: readonly AcpMcpServer[]
  additionalEnv?: NodeJS.ProcessEnv
  model?: SessionModelCapability | null
  /**
   * 这条会话**已解析**的权限档(spec [[capability-bundle]] 场景 A.7)。
   *
   * ⚠️ **故意不写 `?`** —— 与上面 `mcpDisabled` 同一条纪律,同一个失败模式:键可选时,
   * 任何一处构造点漏写都不会红,`?? null` 会把它补成「没人选过」,于是那条腿上每一个把
   * `units.autonomy` 声明成 native 的家都恒定物化成 degraded —— 声明是真的、物化器也写好了,
   * 只是没人喂。2026-09-08 实撞:session-ACP 腿一格都没递,五家的自治通道成了永不被喂的死代码,
   * 四门全绿,产品面表现为「界面上选了需要批准、工具却直接跑」。
   * 键必答之后,「这条腿不带档」必须显式写成 `null` 说出口,漏接变成一条编译错误。
   */
  autonomy: SessionAutonomyCapability | null
  promptBlocks?: SessionPromptBlocks
  /**
   * 用户在 `/mcp` 里为这条会话**关掉**的那几台 server(spec `mcp-session-toggle`)。
   *
   * ⚠️ **只有 ACP 那条腿传它**:pty 会话不经 ACP 拿 MCP,那两处调用点故意不带 ——
   * 这条边界是 typecheck 替我划出来的(第一版我用一次全局替换把四处都加上了,
   * 而其中两处的入参类型是 `EmdashPtySessionpageStartInfo`)。
   * ⚠️ `[]` 与缺席不同,❌ 不许在这里归一。
   */
  mcpDisabled?: readonly string[]
  socialBridgeDeps: BuildSocialBridgeDeps
}

export type BuildSessionBootstrapBundleDeps = Pick<
  BuildSessionBundleDeps,
  'runtime' | 'additionalMcpServers' | 'additionalEnv' | 'model' | 'autonomy' | 'promptBlocks' | 'sessionKey'
>

export interface SessionTuiSessionIdentityBundleDeps {
  agentUserId: string
  promptBlocks?: SessionPromptBlocks
  socialBridgeDeps: BuildSocialBridgeDeps
}

/** Build session-open capabilities that do not require a Gugu identity or social bridge. */
export function buildSessionBootstrapBundle(
  deps: BuildSessionBootstrapBundleDeps,
): SessionCapabilityBundle {
  const sessionKey = deps.sessionKey?.trim()
  return {
    ...(sessionKey ? { sessionKey } : {}),
    mcpServers: [...(deps.additionalMcpServers ?? [])],
    // 这个构造器服务 pty / session-TUI 那条腿 —— 它不经 ACP 拿 MCP,所以**没有**关闭集合。
    // 显式写出 `undefined` 而不是省略:省略会让"这条腿不带它"与"有人忘了接"长得一模一样。
    mcpDisabled: undefined,
    env: {
      ...providerEnv(deps.runtime.env),
      GUGU_HOME: resolveGuguHome(deps.runtime.env),
      ...deps.additionalEnv,
    },
    model: deps.model ?? null,
    autonomy: deps.autonomy ?? null,
    promptBlocks: { platform: GUGU_PLATFORM_BLOCK, ...deps.promptBlocks },
    packages: PRODUCT_CAPABILITY_PACKAGES,
    // 与已连接的集成同一跳:扩展随 buildSessionBundle 进来,这里只是它的前半截。
    extensionSkills: [],
    extensionApps: [],
    extensionServerOrigins: [],
  }
}

/** Identity is optional for session-TUI materialization; only the social bridge depends on it. */
export function buildSessionTuiSessionBundle(input: {
  bootstrap: BuildSessionBootstrapBundleDeps
  identity: SessionTuiSessionIdentityBundleDeps | null
}): Promise<SessionCapabilityBundle> {
  return input.identity
    ? buildSessionBundle({ ...input.bootstrap, ...input.identity })
    : Promise.resolve(buildSessionBootstrapBundle(input.bootstrap))
}

/**
 * 已连接的集成 → 这条会话的 MCP server,**一个收口**。
 *
 * ❌ 别再回到「每个 buildSessionBundle 调用点各接一次」:那样接了 claude、codex,opencode 就漏了,
 * 而漏掉的症状是静默的(agent 只是少一组工具),只能靠人一家一家试出来。owner 2026-09-15:
 * 「怎么就非得让我一个一个测,没有一个通的,这是个架构问题那」。
 *
 * 它挂在**咕咕自己那台桥的同一跳**上:任何一家拿得到 `gugu`,就同样拿得到已连接的集成。
 * 宿主在启动时注册一次;没注册(单测、无 app 环境)就是空数组。
 */
/**
 * 一条会话上的每台 MCP server 必须在**三个维度上**都分得开,否则它会被悄悄吃掉一台。
 *
 * 三条判据不是同一件事的三种写法,它们各自对应一条真出过事的路:
 *
 * · **地址**(`url`)—— 2026-09-15:两家集成共用一台桥宿主,grant 只换 bearer 不换 URL,
 *   于是 `linear` 和 `notion` 的地址一模一样,Claude Code 按地址去重,只连第一台,
 *   `notion` 静默消失(不报错、不留日志,模型只是少一组工具)。
 * · **名字**(`name`)—— 各家配置文件是按名字作键的(claude 的 `.mcp.json`、codex 的
 *   `mcp_servers.<key>`),重名等于后写的覆盖先写的;codex-acp 甚至有一个按名字去重的开关。
 * · **派生的环境变量后缀** —— URL 与令牌是经 `name` 归一(非 `[A-Za-z0-9_]` → `_`、转大写)
 *   派生成环境变量名递过去的,所以 `foo-bar` 与 `foo_bar` 是两个名字、却是同一个后缀:
 *   两家的 URL 和令牌会互相覆盖,而且**错配之后照样能连上**(拿着 A 的令牌打 B 的地址)。
 *
 * ⇒ 在收口处一次性拦掉。这三样都只可能因为**代码改动**而撞(新接一家集成、给 server 改名),
 *   ❌ 不是用户能触发的运行期状态,所以响亮失败是对的:谁加的谁当场看见,
 *   而不是让它变成又一条「连了没用」的静默投诉。
 */
/** 一台会话 MCP server 在这三个维度上的值:同一维撞上,就有一台会被静默丢掉。 */
const SESSION_MCP_DIMENSIONS: Array<[string, (server: AcpMcpServer) => string | undefined]> = [
  ['name', (server) => server.name],
  ['derived env suffix', (server) => mcpEnvSuffix(server.name)],
  ['url', (server) => ('url' in server ? server.url : undefined)],
]

/**
 * 资源库那几台里,和已经在包里的(咕咕自己、App、集成、浏览器)或彼此撞上的,留在外面并说出撞了谁 ——
 * ❌ 让下面那道断言把整条会话拦下(App 是后装的,加进资源库的那一刻判不全)。
 */
export function libraryMcpWithoutCollisions(
  library: readonly AcpMcpServer[],
  taken: readonly AcpMcpServer[],
): { kept: AcpMcpServer[]; collided: { name: string; with: string }[] } {
  const seen = SESSION_MCP_DIMENSIONS.map(([, read]) => new Map(
    taken.flatMap((server) => { const value = read(server); return value === undefined ? [] : [[value, server.name] as const] }),
  ))
  const kept: AcpMcpServer[] = []
  const collided: { name: string; with: string }[] = []
  for (const server of library) {
    const owner = SESSION_MCP_DIMENSIONS
      .map(([, read], index) => { const value = read(server); return value === undefined ? undefined : seen[index]!.get(value) })
      .find((name) => name !== undefined)
    if (owner !== undefined) {
      collided.push({ name: server.name, with: owner })
      continue
    }
    kept.push(server)
    SESSION_MCP_DIMENSIONS.forEach(([, read], index) => { const value = read(server); if (value !== undefined) seen[index]!.set(value, server.name) })
  }
  return { kept, collided }
}

export function assertSessionMcpServersAreDistinguishable(
  servers: readonly AcpMcpServer[],
): void {
  for (const [label, read] of SESSION_MCP_DIMENSIONS) {
    const seen = new Map<string, string>()
    for (const server of servers) {
      const value = read(server)
      if (value === undefined) continue
      const owner = seen.get(value)
      if (owner !== undefined) {
        throw new Error(
          `Session MCP servers '${owner}' and '${server.name}' share the same ${label} `
            + `(${value}); one of them would be silently dropped.`,
        )
      }
      seen.set(value, server.name)
    }
  }
}

let sessionIntegrationBridge:
  | ((grantKey: string, subjectId: string) => Promise<AcpMcpServer[]>)
  | null = null

export function setSessionIntegrationBridge(
  bridge: ((grantKey: string, subjectId: string) => Promise<AcpMcpServer[]>) | null,
): void {
  sessionIntegrationBridge = bridge
}

/**
 * #7191 这条会话的浏览器工具(agent 操作会话页右侧的浏览器页签,见 browser-agent-mcp.ts)。
 * 宿主装上;没装(咕咕 server、测试)= 不带。只给本机会话:参数里的会话编号从卡上认出来,认不出就不带。
 */
let sessionBrowserBridge:
  | ((session: { grantKey: string; sessionId: string; subjectId: string; personalAssistant?: true }) => Promise<AcpMcpServer[]>)
  | null = null

export function setSessionBrowserBridge(
  bridge: ((session: { grantKey: string; sessionId: string; subjectId: string; personalAssistant?: true }) => Promise<AcpMcpServer[]>) | null,
): void {
  sessionBrowserBridge = bridge
}

/**
 * #6387 What installed extensions give every session — their MCP programs (and skills).
 * Set by the host once the task side is up; absent means no extension contributes.
 */
type SessionExtensionBridge = (session: { grantKey: string; subjectId: string; agentId?: string; extensionTools?: 'catalog' }) => Promise<ExtensionSessionMcp>
let sessionExtensionBridge: SessionExtensionBridge | null = null

export function setSessionExtensionBridge(bridge: SessionExtensionBridge | null): void {
  sessionExtensionBridge = bridge
}

/**
 * 资源库 → MCP(owner 10-18):这条会话新建时带上的那几台,已去掉这一家自己就有的同名那台、这条腿收不了的。
 * 与资源库里连上的服务同一层(`owner: 'integration'`):咕咕投递、可以在 `/mcp` 里为这条会话关掉;
 * ❌ 记成 `'user'` —— 那一层是「各家自己会读」的,Claude 会跳过它,`sessionUserServers: 'inherit'` 的几家会丢掉。
 * `settle`:包建好以后报回哪几台真送进去了、哪几台和咕咕自己的撞了 —— `/mcp` 面板读的是这份事实,❌ 读「勾了」。
 */
type SessionLibraryMcpBridge = (sessionId: string) => Promise<{
  servers: readonly CanonicalMcpServer[]
  settle: (outcome: { delivered: string[]; collided: { name: string; with: string }[] }) => void
}>

let sessionLibraryMcpBridge: SessionLibraryMcpBridge | null = null

export function setSessionLibraryMcpBridge(bridge: SessionLibraryMcpBridge | null): void {
  sessionLibraryMcpBridge = bridge
}

/**
 * #7210 资源库里连上的官方命令行(钉钉 dws、企业微信 wecom-cli)带的 skills —— 与 App 的 skills 走同一条路进会话。
 * 宿主注册;没注册 = 没有。读不出来只让这些 skills 缺席,❌ 把会话拖死。
 */
let sessionIntegrationSkillBridge: (() => Promise<ExtensionSkill[]>) | null = null

export function setSessionIntegrationSkillBridge(bridge: (() => Promise<ExtensionSkill[]>) | null): void {
  sessionIntegrationSkillBridge = bridge
}

/** Host-owned search; availability is read after the platform injector has finished. */
let sessionWebSearchBridge: ((sessionId: string) => import('./mcp/gugu-web-search-tool').SessionWebSearch) | null = null

export function setSessionWebSearchBridge(bridge: typeof sessionWebSearchBridge): void {
  sessionWebSearchBridge = bridge
}

export async function buildSessionBundle(
  deps: BuildSessionBundleDeps,
): Promise<SessionCapabilityBundle> {
  const searchSessionId = sessionpageSessionOfGrantKey(deps.socialBridgeDeps.grantKey)
  const socialBridge = await buildSocialBridge(
    deps.runtime,
    deps.agentUserId,
    deps.threadRootId,
    {
      ...deps.socialBridgeDeps,
      ...(sessionWebSearchBridge && searchSessionId ? { webSearch: sessionWebSearchBridge(searchSessionId) } : {}),
    },
  )
  const integrations = sessionIntegrationBridge
    ? await sessionIntegrationBridge(deps.socialBridgeDeps.grantKey, deps.agentUserId)
    : []
  // 会话编号就是扩展页面在 listAgents 里看到的 agentId:程序凭它知道是谁在调用,由咕咕交代、❌ agent 自报。
  // 终端腿不带 sessionKey,会话编号从它的卡(`taskpage:<会话>`)上认。
  const agentId = deps.sessionKey?.trim() || sessionpageSessionOfGrantKey(deps.socialBridgeDeps.grantKey) || undefined
  const extensions = sessionExtensionBridge
    ? await sessionExtensionBridge({ grantKey: deps.socialBridgeDeps.grantKey, subjectId: deps.agentUserId, ...(agentId ? { agentId } : {}), ...(deps.extensionTools ? { extensionTools: deps.extensionTools } : {}) })
    : { servers: [], skills: [], apps: [], origins: [] }
  const integrationSkills = sessionIntegrationSkillBridge ? await sessionIntegrationSkillBridge() : []
  const browserSessionId = sessionpageSessionOfGrantKey(deps.socialBridgeDeps.grantKey)
  const browser = sessionBrowserBridge && browserSessionId
    ? await sessionBrowserBridge({ grantKey: deps.socialBridgeDeps.grantKey, sessionId: browserSessionId, subjectId: deps.agentUserId, ...(deps.socialBridgeDeps.personalAssistant ? { personalAssistant: true } : {}) })
    : []
  const bootstrap = buildSessionBootstrapBundle(deps)
  const taken = [...bootstrap.mcpServers, ...socialBridge, ...integrations, ...browser, ...extensions.servers]
  // 密钥(env 值、Authorization)与用户自己的那批同一种转换:换成 GUGU_SESSION_MCP_ENV_* 引用,值随 env 走。
  const picked = sessionLibraryMcpBridge && agentId ? await sessionLibraryMcpBridge(agentId) : null
  const library = picked ? canonicalMcpServersToSessionServers(picked.servers) : { servers: [], env: {} }
  // 人在资源库里默认启用的,和 App 一样直接摆在模型的工具表上(`alwaysLoad`),❌ 藏在各家自己的延迟加载后面。
  const { kept, collided } = libraryMcpWithoutCollisions(
    library.servers.map((server) => ({ ...server, alwaysLoad: true, owner: 'integration' as const, library: true as const })),
    taken,
  )
  picked?.settle({ delivered: kept.map((server) => server.name), collided })
  const mcpServers = [...taken, ...kept]
  assertSessionMcpServersAreDistinguishable(mcpServers)
  return {
    ...bootstrap,
    env: { ...bootstrap.env, ...library.env },
    extensionSkills: [...extensions.skills, ...integrationSkills],
    extensionApps: extensions.apps,
    extensionServerOrigins: extensions.origins,
    mcpServers,
    // ⚠️ 这一行就是断过的那一跳。bootstrap 服务 pty 腿、恒为 `undefined`,
    //    ACP 腿的关闭集合必须在这里接回来;`[]` 原样递,❌ 不归一成 undefined。
    mcpDisabled: deps.mcpDisabled,
  }
}

/**
 * #6387 What installed extensions put into this session — the `/mcp` panel's record of it,
 * written when the session starts (the session keeps that version even if the extension changes).
 */
export function sessionExtensionDelivery(bundle: SessionCapabilityBundle): {
  servers: { name: string; extensionId: string }[]
  skills: { name: string; extensionId: string }[]
} {
  return {
    servers: bundle.extensionServerOrigins.map((origin) => ({ ...origin })),
    skills: bundle.extensionSkills.map((skill) => ({ name: skill.name, extensionId: skill.extensionId })),
  }
}

export function renderSessionPromptBlocks(promptBlocks: SessionPromptBlocks): string {
  return (
    (promptBlocks.platform ?? '') +
    (promptBlocks.identity ?? '')
  )
}

// 旧 pendingSessionPromptBlocks(把 session 级块前置进首条消息的机制残骸)已删:所有 surface 的
// session 级块只走 session-open 系统通道;#4191 首轮注入取证证实消息体零前置且该函数零消费者。

export function hasPromptBlocks(promptBlocks: SessionPromptBlocks): boolean {
  return Boolean(promptBlocks.platform || promptBlocks.identity)
}

function envOverride(env: NodeJS.ProcessEnv, key: string): string | undefined {
  return env[key]?.trim() || process.env[key]?.trim() || undefined
}

/** Preserve the catalog and GUGU_ACP_* selection semantics while keeping wire translation in loaders. */
export function buildAcpModelCapability(input: {
  dialect: ModelConfigDialect | null
  engineId: string
  model?: string | null
  env: NodeJS.ProcessEnv
  /** Relay + session token when this run is on platform quota; absent for BYOK/default. */
  platformAccess?: {
    relayUrl: string
    token: string
    contextWindow?: number | null
    /** The platform model's accepted reasoning levels (directory, #6447); null = the directory has none. */
    reasoningEfforts?: readonly string[] | null
    /** The issue response's `callable_routes` (#6921); empty / absent = none. */
    callableRoutes?: PlatformCallableRoutes
  } | null
  /** Every Gugu model this session may switch to; used to populate the harness's own picker. */
  platformModels?: readonly {
    id: string
    displayName: string
    contextWindow?: number | null
    reasoningEfforts?: readonly string[] | null
  }[]
  /**
   * composer 为这条会话选的**起始**推理档。缺席 = 没选,那就别往下发任何档位键 ——
   * 「没选」和「选了某一档」必须是两件事,否则引擎自己的默认档永远没机会生效。
   */
  reasoningEffort?: string | null
}): SessionModelCapability | null {
  if (input.dialect === null) return null
  const platformModel = platformModelForDialect(input.dialect, input.engineId)
  const { platformAccess } = input
  return platformModel.declare({
    explicitModel: input.model?.trim() || undefined,
    // composer 为这条会话选的起始档;没选 = undefined(各家自己决定要不要叠调试开关)。
    requestedEffort: input.reasoningEffort?.trim() || undefined,
    envOverride: (key) => envOverride(input.env, key),
    // Every OpenAI-surface dialect addresses the relay's /v1 root; only the way each is told
    // about it differs (config flags / a config document / plain env vars).
    platformProvider: platformAccess
      ? { baseUrl: `${platformAccess.relayUrl.replace(/\/$/, '')}/v1`, apiKey: platformAccess.token }
      : undefined,
    platformAccess,
    platformModels: input.platformModels,
    // Only meaningful on a platform session: on BYOK the harness is pointed at the vendor under the
    // model's own name, which it already knows the window for. Every dialect gets it — the window is
    // a property of the model, not of one harness.
    contextWindow: platformAccess?.contextWindow ?? undefined,
    callableRoutes: platformAccess?.callableRoutes ?? {},
    protocolEnv: (relayUrl, contextWindow) => {
      const protocol = platformProtocolForEngine(platformModelOwner(input.dialect!).metadata.id)
      if (!protocol || !platformAccess) throw new Error(`${input.dialect}: no wire protocol to point at the relay`)
      return platformModelAccessEnv(protocol, relayUrl, platformAccess.token, contextWindow)
    },
  })
}

/** 声明了这个方言的那一家。方言是引擎级属性,一家一个、一个只属于一家(声明在各家 `platform.ts`)。 */
function platformModelOwner(dialect: ModelConfigDialect) {
  const owner = pluginRegistry.getAll().find((plugin) => {
    const platform = plugin.capabilities.sessionBundle.platform
    return platform.kind === 'supported' && platform.dialect === dialect
  })
  if (!owner) throw new Error(`${dialect}: no plugin declares this model config injection strategy`)
  return owner
}

function platformModelForDialect(dialect: ModelConfigDialect, engineId = '(unknown)') {
  const platformModel = platformModelOwner(dialect).behavior.sessionBundle?.platformModel
  if (!platformModel) {
    throw new Error(`engine ${engineId}: unknown model config injection strategy ${JSON.stringify(dialect)}`)
  }
  return platformModel
}

const MCP_ENV_PROMPT_UNITS = new Set<CapabilityUnit>(['mcp', 'env', 'promptBlocks'])
function loadReport(
  loader: CapabilityLoader,
  bundle: SessionCapabilityBundle,
  identity: { adapterId: string; surface: HarnessSessionSurface } = {
    adapterId: loader.id,
    surface: 'acp',
  },
): Materialization['report'] {
  const loaded: CapabilityUnit[] = ['mcp', 'env']
  const degraded: Materialization['report']['degraded'] = []
  if (bundle.model) {
    if (loader.supports.has('model')) loaded.push('model')
    else degraded.push({ unit: 'model', reason: `${loader.id} does not support model` })
  }
  if (bundle.autonomy) {
    if (loader.supports.has('autonomy')) loaded.push('autonomy')
    else degraded.push({ unit: 'autonomy', reason: `${loader.id} does not support autonomy` })
  }
  if (hasPromptBlocks(bundle.promptBlocks)) {
    if (loader.supports.has('promptBlocks')) loaded.push('promptBlocks')
    else degraded.push({ unit: 'promptBlocks', reason: `${loader.id} does not support promptBlocks` })
  }
  if (bundle.packages.length > 0) {
    if (loader.supports.has('packages')) loaded.push('packages')
    else degraded.push({ unit: 'packages', reason: `${loader.id} does not support packages` })
  }
  return { ...identity, loaded, degraded, discoveredCommands: [] }
}

export { positiveWindow }

/**
 * Turn a model capability into the args/env one harness actually accepts.
 *
 * Exported for callers outside the ACP loaders — the session page spawns native ptys and
 * still has to pin the same model the same way, and a second implementation of this
 * mapping is how the two paths drift into disagreeing about which model ran.
 */
export function materializeModelCapability(
  model: SessionModelCapability | null,
): Pick<Materialization, 'extraArgs' | 'spawnEnv' | 'settingsOverride'> {
  return model ? platformModelForDialect(model.dialect).load(model) : {}
}

/**
 * ACP 协议线上的 MCP server：HTTP 与 stdio 两种 transport 都可进入 `session/new`。
 *
 * 两个主力适配器都实测吃它（读它们自己 `initialize` 的自报）：
 * `@agentclientprotocol/claude-agent-acp@0.66.0` → `mcpCapabilities {http:true, sse:true}`；
 * `@zed-industries/codex-acp@0.16.0`（本仓钉的版本）→ `{http:true, sse:false, acp:false}`。
 *
 * `alwaysLoad` 不在协议里，所以宿主这一层一律不写它；条目上的 `_meta` 是协议留给各家的扩展位，
 * 由这一家自己的物化器填它认的原生开关（CodeBuddy 的 `defer_loading`），宿主原样带过去。
 * 需要 `alwaysLoad` 的 claude 走 `_meta` 那条 SDK 通道。
 */
export type AcpProtocolMcpServer = (
  | {
      type: 'http'
      name: string
      url: string
      headers: { name: string; value: string }[]
    }
  | {
      type: 'stdio'
      name: string
      command: string
      args: string[]
      env: { name: string; value: string }[]
    }
) & { _meta?: Record<string, unknown> }

function toProtocolMcpServer(
  server: AcpMcpServer,
  sourceEnv: Readonly<Record<string, string | undefined>> = {},
): AcpProtocolMcpServer {
  if (server.transport === 'stdio') {
    return {
      type: 'stdio',
      name: server.name,
      command: server.command,
      args: [...(server.args ?? [])],
      // Resolve references only at the trusted ACP request boundary. The session declaration
      // and persisted materialization carry names; the actual values stay in the child env.
      env: Object.entries(server.env ?? {}).map(([name, ref]) => {
        const value = sourceEnv[ref]
        if (value === undefined) throw new Error(`MCP '${server.name}' requires env '${ref}'`)
        return { name, value }
      }),
    }
  }
  return {
    type: 'http',
    name: server.name,
    url: server.url,
    headers: server.headers.map((header) => {
      const reference = header.value.match(/^\$\{([A-Za-z0-9_]+)\}$/)?.[1]
      return reference && sourceEnv[reference] !== undefined
        ? { ...header, value: sourceEnv[reference] as string }
        : { ...header }
    }),
  }
}

function mcpAuthorizationEnv(name: string): string {
  return `GUGU_SESSION_MCP_AUTH_${name.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}`
}

function toCoreSessionBundle(bundle: SessionCapabilityBundle): CoreSessionCapabilityBundle {
  const env: Record<string, string | undefined> = { ...bundle.env }
  const mcpServers = bundle.mcpServers.map((server) => {
    if (server.transport === 'stdio') {
      return {
        name: server.name,
        transport: 'stdio' as const,
        command: server.command,
        ...(server.args ? { args: [...server.args] } : {}),
        ...(server.env ? { env: { ...server.env } } : {}),
        ...(server.cwd ? { cwd: server.cwd } : {}),
        ...(server.alwaysLoad ? { alwaysLoad: true } : {}),
        ...(server.owner ? { owner: server.owner } : {}),
        ...(server.library ? { library: true as const } : {}),
      }
    }
    const unsupportedHeaders = server.headers.filter(
      (header) => header.name.toLowerCase() !== 'authorization',
    )
    if (unsupportedHeaders.length > 0) {
      throw new Error(
        `Session MCP '${server.name}' has unsupported headers: ${unsupportedHeaders.map((header) => header.name).join(', ')}`,
      )
    }
    const authorization = server.headers.find(
      (header) => header.name.toLowerCase() === 'authorization',
    )
    const reference = authorization?.value.match(/^\$\{([A-Za-z0-9_]+)\}$/)?.[1]
    const authorizationEnv = authorization
      ? (reference ?? mcpAuthorizationEnv(server.name))
      : undefined
    if (authorization && !reference && authorizationEnv) env[authorizationEnv] = authorization.value
    return {
      name: server.name,
      transport: 'http' as const,
      url: server.url,
      ...(authorizationEnv ? { authorizationEnv } : {}),
      ...(server.alwaysLoad ? { alwaysLoad: true } : {}),
      ...(server.owner ? { owner: server.owner } : {}),
      ...(server.library ? { library: true as const } : {}),
    }
  })
  return {
    ...(bundle.sessionKey ? { sessionKey: bundle.sessionKey } : {}),
    mcpServers,
    env,
    model: bundle.model,
    autonomy: bundle.autonomy,
    // ⚠️ 这一行不能省:这个函数是 electron 侧 bundle → core 侧 bundle 的**唯一**转换点,
    //    漏掉哪一格,那一格就到不了物化器 —— 而两边的类型各自都是对的,tsc 一声不吭。
    mcpDisabled: bundle.mcpDisabled,
    promptBlocks: bundle.promptBlocks,
    packages: bundle.packages,
    extensionSkills: bundle.extensionSkills,
  }
}

function fromCoreMaterialization(
  materialization: CoreSessionMaterialization,
): Materialization {
  const loaded = Object.entries(materialization.report.units)
    .filter(([, unit]) => unit.status === 'loaded')
    .map(([unit]) => unit as CapabilityUnit)
  const degraded: CapabilityLoadReport['degraded'] = []
  for (const [unit, value] of Object.entries(materialization.report.units)) {
    if (value.status === 'degraded') {
      degraded.push({ unit: unit as CapabilityUnit, reason: value.reason.reason })
    }
  }
  return {
    ...(materialization.argsAppend.length > 0
      ? { extraArgs: [...materialization.argsAppend] }
      : {}),
    ...(materialization.threadConfig
      ? { threadConfig: { ...materialization.threadConfig } }
      : {}),
    ...(materialization.threadStart
      ? { threadStart: { ...materialization.threadStart } }
      : {}),
    ...(materialization.skillRoots ? { skillRoots: [...materialization.skillRoots] } : {}),
    ...(materialization.sessionCreatePatch
      ? { sessionCreatePatch: { ...materialization.sessionCreatePatch } }
      : {}),
    spawnEnv: { ...materialization.env },
    ...(materialization.acp
      ? {
          sessionNewPatch: {
            mcpServers: materialization.acp.mcpServers as AcpProtocolMcpServer[],
            ...(materialization.acp.meta ? { meta: materialization.acp.meta } : {}),
          },
        }
      : {}),
    ...(materialization.prompt
      ? {
          sessionPrompt: materialization.prompt.value,
          sessionOpenPromptBlocks: materialization.prompt.delivered,
          ...(materialization.prompt.carrier
            ? { sessionPromptCarrier: materialization.prompt.carrier }
            : {}),
        }
      : {}),
    configMerges: materialization.configMerges,
    artifacts: materialization.artifacts,
    tomlOverlays: materialization.tomlOverlays,
    jsonOverlays: materialization.jsonOverlays,
    symlinks: materialization.symlinks,
    directorySymlinkOverlays: materialization.directorySymlinkOverlays,
    ...(materialization.retiredArtifacts
      ? { retiredArtifacts: materialization.retiredArtifacts }
      : {}),
    report: {
      adapterId: materialization.report.adapterId,
      surface: materialization.report.surface,
      loaded,
      degraded,
      discoveredCommands: [...materialization.report.discoveredCommands],
    },
  }
}

/**
 * 这条腿上,这一家的模型是不是由**它自己的物化器**写进配置文件。
 *
 * 是的话宿主就不再按方言把模型拍成环境变量/argv —— 一维两条路时赢的是环境变量那条,
 * 而它带不动模型的能力声明(kimi 的 `support_efforts` 只存在于 `[models.*]` 里),
 * 于是界面上那排推理档位成了画上去的、还没有任何一处报错。判据:
 * `tests/unit/desktop/electron/configFileModelSingleChannel.test.ts`。
 *
 * ⚠️ **按腿判**。一条腿声明了不代表另一条腿也是(kimi 现在正是终端腿 config-file、
 *    协议腿仍是宿主的 env)——扁平的 `some` 会让强的那条腿替弱的那条背书。
 */
export function providerDeliversModelViaConfigFile(
  providerId: string,
  surface: HarnessSessionSurface,
): boolean {
  const descriptor = pluginRegistry.get(providerId)?.capabilities.sessionBundle
  if (!descriptor?.surfaces.includes(surface)) return false
  const delivery = resolveUnitDelivery(descriptor.units.model, surface)
  if (delivery.kind !== 'native') return false
  // 这个谓词问的是「模型这一维是不是经**咕咕写的一份文件**送达」——
  // 调用方据此决定要不要把模型能力放进会话包(`sessionBundleModelFor`)。
  // ⚠️ 所以它不能只认 `'config-file'` 这一个字面值:同样是"经文件送达"的还有
  //    `'system-config-overlay'`(读用户/管理员那份 → 写咕咕 run 目录 → 用厂商路径变量指过去)。
  //    qwen 的终端腿就是后者:选中的那条走环境变量,而**整组可切模型**只有文件表达得了。
  //    少认这一个 channel 的后果是静默的:会话包里 `model` 是 null,物化器那一段成了死代码,
  //    单测照样全绿(夹具自己造 `bundle.model`),而产品上「/model 只有一行」看不出任何原因。
  return delivery.channel === 'config-file' || delivery.channel === 'system-config-overlay'
}

/**
 * 用户自己的 MCP Server 要不要进这一家的会话包。
 *
 * 判据来自 descriptor 的 `capabilities.mcp.sessionUserServers`,❌ 不按 providerId 分叉:
 * 一旦这层出现 `if (providerId === 'codex')`,下一家接进来时没人知道该往哪个分支加。
 *
 * 缺省 `'restate'` = 2026-09-07 之前所有家的行为。改一家之前必须有实测证据说明
 * 「它的会话通道与用户配置合并」——猜错的方向是**用户的 MCP Server 在那条会话上凭空消失**,
 * 而这是个静默症状(工具表里少几台,没有任何报错)。
 */
export function providerRestatesUserMcpServers(providerId: string): boolean {
  const mcp = pluginRegistry.get(providerId)?.capabilities.mcp
  if (mcp?.kind !== 'supported') return true
  return (mcp.sessionUserServers ?? 'restate') === 'restate'
}

/**
 * 会话包该带哪些用户 MCP Server —— `'inherit'` 的那几家一台都不带,所以**连读都不读**:
 * 读出来也是扔掉,而它就在会话启动的等待路径上(10-17 A/B:同一步里的平台模型握着活票时是 0 ms,
 * 这次读一慢,整段等待就全是它 —— 一度试过让 codex / opencode 的 CLI 来列,0.1 s / 0.5 s 全落在启动上)。
 *
 * ⚠️ `servers` 与 `env` 必须**成对**丢弃:`env` 里装的正是这些 server 的 env 引用值,
 *    只丢一半会留下一串永远没人读的 `GUGU_SESSION_MCP_ENV_*` 进子进程环境。
 */
export async function sessionBundleUserMcpFor(
  providerId: string,
  readConfigured: () => Promise<readonly CanonicalMcpServer[]>,
): Promise<{ servers: AcpMcpServer[]; env: Record<string, string> }> {
  if (!providerRestatesUserMcpServers(providerId)) return { servers: [], env: {} }
  return canonicalMcpServersToSessionServers(await readConfigured())
}

export function providerUsesSessionProcessConfig(providerId: string): boolean {
  const descriptor = pluginRegistry.get(providerId)?.capabilities.sessionBundle
  return descriptor?.units.mcp.kind === 'native'
    && descriptor.units.mcp.channel === 'process-config'
    && descriptor.units.model.kind === 'native'
    && descriptor.units.model.channel === 'process-config'
    && descriptor.units.promptBlocks.kind === 'native'
    && descriptor.units.promptBlocks.channel === 'process-config'
}

/**
 * descriptor 声明了任一 native 单元或 extension 载荷 ⇒ 这个 provider 有自己的专用 materializer
 * （registry 注册时对「声明 surface 却无 behavior」已经 fail loud，所以这里判的是 descriptor 特征本身）。
 */
function declaresProviderMaterializedDelivery(descriptor: SessionBundleDescriptor): boolean {
  // ⚠️ 这是**路由**判据(「这家有没有自己的物化器」),不是投递声明 —— 所以用 `…Anywhere`。
  //    ❌ 别写成扁平的 `unit.kind === 'native'`:按腿声明的格子会被判成假,而 oh-my-pi 把最后
  //    一格扁平 native 改成按腿之后就一格都不剩 ⇒ 终端腿当场失去物化器、会话起不来(CI 抓到)。
  return Object.values(descriptor.units).some((unit) => unitDeliveryIsNativeAnywhere(unit))
    || descriptor.extension.kind !== 'none'
}

export function providerUsesSessionTuiSessionBundle(providerId: string): boolean {
  const descriptor = pluginRegistry.get(providerId)?.capabilities.sessionBundle
  if (!descriptor?.surfaces.includes('tui')) return false
  return declaresProviderMaterializedDelivery(descriptor)
}

/**
 * acp surface 的三态判定，全部从 descriptor 推导（同一事实只声明一次，没有第二张路由表）：
 *
 * - 未声明 `acp` surface ⇒ **throw**：这是编程错误（比如把只有 tui 的 provider 路由到
 *   task ACP），不是「还没接通道」——静默返回 false 会把它降级成一条没人消费的协议投递。
 * - 声明了 `acp` 且 descriptor 带专用 materializer 特征 ⇒ true：provider 专用适配器。
 * - 声明了 `acp` 而无专用 materializer ⇒ false：走 ACP 协议通道（`session/new` 的规范
 *   `mcpServers` + 首轮 hidden context）——一个正当的交付终点，不是待清理状态。
 */
export function providerUsesSessionAcpSessionAdapter(providerId: string): boolean {
  const descriptor = pluginRegistry.get(providerId)?.capabilities.sessionBundle
  if (!descriptor?.surfaces.includes('acp')) {
    throw new Error(
      `Provider '${providerId}' does not declare the acp session surface. Declare its acp delivery in packages/session-plugins/src/agents/impl/${providerId}/index.ts.`,
    )
  }
  return declaresProviderMaterializedDelivery(descriptor)
}

// @@@surface-block (#3577) — L2：**按 surface 渲染**的会话级块。
//
// 「你打印的东西算不算回答」的真值随 surface 变，所以它结构上不可能住在一个对每个 surface 逐字节相同的
// 编译期常量里 —— 那正是 #3577 的病灶（#3478 那段无条件断言在当面聊天时是假的，于是 agent 被告知
// 「你说的不算数，必须调工具」）。修法不是删掉那句话，是把它放到真值不变的那一层。
//
// 分层判据只有一条：**这个事实的真值在哪一层不变？**
//   L1 产品常量           对每个 surface、每一轮都真
//   L2 本块               对本 session 的每一轮都真，但随 surface 变
//   L3 每一轮的投递信封   随轮变
//
// ❌ 无 default 分支：未声明的 surface 在 spawn 前 fail loud，与本节点既有的 adapter 穷举纪律同形。
// Session-agent creation is a session-page concern. Keep this rule out of the global platform block:
// session_* is deliberately absent from Gugu social/chat-driven ACP sessions. The explicit
// distinction matters because several harnesses expose their own Task/Agent worker and the generic
// platform routing rule otherwise classifies "start an agent" as ordinary work.
const SESSION_SPAWN_ROUTING_RULE = `You are on the Gugu platform. Creating a Gugu session agent is a platform
operation, not local work. Asked to create, start, spawn or make a Gugu agent/session/child — "start an
agent", "起一个 agent", "创建一个小弟" — default to \`session_spawn\`. Harness-native \`Task\`, \`Agent\`,
\`subagent\` or \`spawn_agent\` stay available when the request explicitly asks for an internal worker; such a
worker is not a session agent — invisible, unable to receive Gugu session messages, dead when your turn ends
— so do not substitute one for the other, never report one as a Gugu agent/session/child, and if you cannot
start a requested Gugu session, say so and say why.
The returned \`session_id\` is the stable product address.
On a turn a person typed straight into this panel, when you create or materially change a file for them to
inspect, call \`session_open_in_tab\` immediately after writing it instead of only reporting its path.`

function guguSessionSurfaceBody(surface: HarnessSessionSurface): string {
  switch (surface) {
    // The shape is said here, not in session_spawn's description (#4378 had it there): a tool definition that differs
    // per session is a model prefix no other session shares (摩擦单 F54).
    case 'tui':
    case 'app-server':
      return `A person can type straight into this terminal session: a pty session running the harness TUI.`
    case 'acp':
      return `A person can type straight into this session panel: a chat UI (acp) session in the structured panel.`
  }
  // 穷举保证由这一行给出：新增 surface 而没在上面补分支时，这里的赋值编译不过。
  const unreachable: never = surface
  const declared: string = unreachable
  throw new Error(
    `Gugu session surface '${declared}' has no self-description block. Add it in `
    + `apps/desktop/electron/product-platform-prompt.ts; a session must not start without one.`,
  )
}

/**
 * @@@tool-naming-line (#6192) — 这条会话的 harness 把咕咕工具叫什么,**只从** adapter 的能力声明
 * `capabilities.mcp.toolNames` 渲染;平台块只说 canonical 名。它对本会话每一轮都真、随 harness 变,
 * 所以与 surface 自述同属 L2。
 * ❌ 别回到平台块里那张「Pi/Claude/Codex」清单:清单漏掉的那一家(qwen),模型按裸名去找就落空。
 * `unmeasured` 不写这一行 —— 那一家的模型只拿到平台块的通用规则,欠账留在声明里。
 */
function guguToolNamingLine(
  providerId: string,
  surface: HarnessSessionSurface,
  carriesGuguMcp: boolean,
): string {
  // 这条会话根本没拿到咕咕那台 server(协议通道被闸成空、session-only 以外的腿)⇒ 不写这一行:
  // 告诉模型「你的 harness 这样命名咕咕工具」而工具不存在,是一句假话。
  if (!carriesGuguMcp) return ''
  const provider = pluginRegistry.get(providerId)
  if (!provider) throw new Error(`Unknown agent plugin '${providerId}'`)
  const mcp = provider.capabilities.mcp
  if (mcp.kind !== 'supported') return ''
  // 形态按**腿**读(Antigravity 两条腿是两个程序,工具进模型的方式不同);`app-server` 腿的模型面
  // 就是它背后那个协议进程的,与 acp 同读。
  const names = mcpToolNamesOn(mcp.toolNames, surface === 'tui' ? 'tui' : 'acp')
  switch (names.kind) {
    case 'listed':
      return `Your harness lists each 咕咕 tool as \`${names.prefix}<tool>\` (e.g. \`${names.prefix}message_send\`); follow that tool definition's invocation form.\n`
    case 'proxied':
      return `Your harness does not list 咕咕 tools one by one: call them through its \`${names.proxyTool}\` tool, naming the tool \`${names.prefix}<tool>\` (e.g. \`${names.prefix}message_send\`).\n`
    case 'namespaced':
      // Codex advertises the native name or an exec declaration, depending on its model tool mode.
      return `Your harness exposes 咕咕 tools under \`${names.namespace}\`; follow each tool definition's advertised invocation form.\n`
    case 'server-proxied':
      // server 名就是咕咕那台 server 注册时用的名字 —— 与写进配置的键同一个常量,❌ 别另写一个字面量。
      return `Your harness does not list 咕咕 tools one by one: call them through its \`${names.proxyTool}\` tool with \`${names.serverArg}\` set to \`${GUGU_MCP_SERVER_NAME}\` and \`${names.toolArg}\` set to the bare tool name (e.g. \`message_send\`).\n`
    case 'unmeasured':
      return ''
  }
}

/**
 * #7191 这条会话带着浏览器工具(`gugu-browser`)时,告诉 agent 用它们操作网页。
 * ❌ 不说:agent 默认会自己另起 Playwright / Chrome —— 抢焦点、人看不到过程、没有人的登录。Codex 自己也栽过相邻的一半:应用内浏览器在、控制工具没递到 agent 手上(openai/codex#39562)。
 */
const SESSION_BROWSER_RULE = `
To work with a web page (open, read, click, type, screenshot), use the \`browser_*\` tools of the \`gugu-browser\` MCP
server: they drive the browser tab in this session's pane, which the person watches live and which has their logins.
Do not launch your own browser, Playwright or Chrome for that. If a tool says the person took over the tab, stop and
tell them what you did; do not retry.`

/** #7199 咕咕 server(云电脑)上:浏览器是这台机器上的 Chrome,人在和你的聊天里看着、能接管(cloud/cloud-browser.ts)。 */
const CLOUD_BROWSER_RULE = `
To work with a web page (open, read, click, type, screenshot), use the \`browser_*\` tools of the \`gugu-browser\` MCP
server: they drive your own browser, which the person watches live in their chat with you and can take over; it
keeps the logins they made there. When you talk about it, call it your browser: do not tell the person which machine or
server it runs on. Do not launch another browser, Playwright or Chrome for that. When a page needs
the person's login, call \`browser_request_login\` (they type it into a password vault, you never see it); never ask
for a password in chat. When a step needs the person (CAPTCHA, SMS or 2FA code, a payment confirmation), call
\`browser_request_takeover\`. If a tool says the person took over or stopped the browser, stop and tell them what you
did; do not retry.`

export function guguSessionSurfaceBlock(
  surface: HarnessSessionSurface,
  providerId: string,
  carriesGuguMcp: boolean,
  carriesBrowser = false,
): string {
  return `<gugu_session_surface>
${guguSessionSurfaceBody(surface)}
${guguToolNamingLine(providerId, surface, carriesGuguMcp)}${SESSION_SPAWN_ROUTING_RULE}${carriesBrowser ? (process.env.GUGU_SERVER_MODE === '1' ? CLOUD_BROWSER_RULE : SESSION_BROWSER_RULE) : ''}
</gugu_session_surface>
`
}

// ⚠️ 这段住在这里而不是 product-platform-prompt.ts，理由是**模块边界**，不是就近：
// 那个文件被 e2e spec 直接 import，而它在 dev 上是一个零 import 的叶子。给它加上
// `@gugu/session-core/agents/plugins` 这条边，会把 session-wire 子树拉进 e2e 的 tsc 程序，
// 在那里 TypeScript 6.0.3 会崩在 packages/session-wire/src/live/replica/replica.ts 上
// （`Debug Failure. No error for last overload signature`，无任何诊断）。
// 本文件本来就 import 了 HarnessSessionSurface，也正是 surface 被穷举声明与物化的地方。
/**
 * @@@surface-block (#3577) — L2：surface 自述块接在 platform 常量之后。
 *
 * 这里是 surface **第一次被穷举声明**的地方（五个 loader 各自给出 `ctx.surface`），所以也是这个
 * 随 surface 变的事实唯一该被物化的地方。❌ 不把它交给 `buildSessionBundle` 的调用点：那会多出
 * 五处可以各自填错的参数，而这里的取值已经由路由谓词决定、无从填错。
 */
function withSurfaceSelfDescription(
  bundle: SessionCapabilityBundle,
  surface: HarnessSessionSurface,
  providerId: string,
): SessionCapabilityBundle {
  const platform = bundle.promptBlocks.platform
  // surface 自述块**随平台块走**：两者同属会话自述，因此共享同一条生命周期规则——
  // 这一次物化不投平台块（resume：session-open 时已经投过），就同样不投它，否则 resume 会重复一段自述。
  if (!platform) return bundle
  const nativeSkills = mountsExtensionSkillsNatively(pluginRegistry.get(providerId)?.capabilities.sessionBundle?.extension)
  const apps = guguAppsBlock(bundle.extensionApps, nativeSkills ? [] : bundle.extensionSkills)
  return {
    ...bundle,
    promptBlocks: { ...bundle.promptBlocks, platform: `${platform}${guguSessionSurfaceBlock(surface, providerId, bundle.mcpServers.some((server) => server.owner === 'gugu'), bundle.mcpServers.some((server) => server.name === 'gugu-browser'))}${apps}` },
  }
}

/** #7317 What `<gugu_apps>` says while Computer Use is on (off: nothing, no token). */
export const COMPUTER_USE_LINE = 'Computer Use is on: to operate the apps of a computer (open one, see its window, click, type), use device_actions with group computer, then device_call; not osascript, AppleScript or browser tools.'

/** 上下文工程第二批 P3 (owner 10-07 chose (c), D-27): one App line is at most this many characters… */
export const GUGU_APPS_LINE_MAX_CHARS = 120
/** …and the App lines together at most this many `estimatePromptTokens` units; past it, one line counts the rest. */
export const GUGU_APPS_LINES_TOKEN_BUDGET = 300

function appLine(app: ExtensionCatalogApp): string {
  const line = [...`- ${app.name} (${app.extensionId})${app.description ? `: ${firstSentence(app.description)}` : ''}`]
  return line.length <= GUGU_APPS_LINE_MAX_CHARS ? line.join('') : `${line.slice(0, GUGU_APPS_LINE_MAX_CHARS - 1).join('')}…`
}

const moreAppsLine = (count: number) => `- …and ${count} more App${count === 1 ? '' : 's'}; catalog_list names them all.`

/** The App lines, in catalog order, as many as the budget holds; the ones left out are counted, and catalog_list still lists them. */
function appLines(apps: readonly ExtensionCatalogApp[]): string[] {
  const lines = apps.map(appLine)
  for (let shown = lines.length; shown >= 0; shown -= 1) {
    const kept = shown === lines.length ? lines : [...lines.slice(0, shown), moreAppsLine(lines.length - shown)]
    if (estimatePromptTokens(kept.join('\n')) <= GUGU_APPS_LINES_TOKEN_BUDGET) return kept
  }
  return [moreAppsLine(lines.length)]
}

/**
 * 10-19 The block's last lines: this list is the session's opening, and an App can come after it (installed later, switched
 * back on) or be only in the market — app_search finds them all (named here, so no catalog_list first to find it). Said here, beside the Apps it is about, with an
 * example and the reason: the bare sentence was read and not acted on three times — in the platform block's tool paragraph
 * twice, here once (mac1 A/B, Codex, 「一起玩海龟汤吧」): the agent hosts 海龟汤 itself and never thought to look; with the
 * example alone it looked one time in two, with why the App does it better 3/3. The example is another game, so 海龟汤 still
 * measures whether it carries over. 「用日历 App 记一下」 with the App installed mid-session went to the device's calendar in
 * both arms until the line named Apps and «a tool of your own» too. Installing and versions: an agent once rewrote an App's
 * installed manifest and page with its shell to "switch versions" (版本管理车道 10-19) — app_install is the one way. Only where to look, ❌ 「X was just installed」 (owner: pull, not push).
 */
export const GUGU_APPS_SEARCH_LINE = [
  'An App not listed here may have been installed since, be switched off or be only in the market.',
  'Before you answer a message that names an App (「记账 App」) or a game, look it up with catalog_call app_search { query } — even when a tool of your own could do it (a device\'s calendar, hosting the game yourself): the person asked for the App, and a game\'s App keeps the game for everyone in the chat.',
  'Installing an App or changing its version is app_install; switching one on is your owner\'s, on its 「App」 page. Never edit an App\'s installed files.',
  '> (from Wei) 来一局狼人杀',
  'catalog_call app_search { query: "狼人杀" } → an App row → use its tools, or do what its next says',
].join('\n')

/**
 * `<gugu_apps>`: what the Apps installed in 咕咕 give this session, as facts.
 * - The Apps whose tools are in the catalog (上下文工程第二批 P3): their name and what they do — the first sentence of the
 *   manifest's description — so an agent knows, before any catalog_list, that a capability is in there. Before this, web
 *   search and library docs went 0/12 through the catalog (measured 2026-10-07).
 *   The heading says once, for every App, that they run with catalog_call, so a line can spend its 120 characters on
 *   the tools themselves (群文件夹: names and parameters, 10-12).
 * - #6387 App skills, for a harness with no plugin folder to mount them in: the same two facts a native skill list shows
 *   (name, when to use it) plus where SKILL.md is, read in place.
 * Rides the platform block, so it follows the same lifecycle (not repeated on resume).
 * 集体记忆对账第 13 条：写给 agent 的散文叫 App（#6874 把「扩展」改名 App，guide 和工具说明早就这么叫）；
 * 存储层的标识（gugu-ext://、.guguext、信封的 route="extension"）不在改名范围里。
 */
export function guguAppsBlock(apps: readonly ExtensionCatalogApp[], skills: readonly ExtensionSkill[]): string {
  if (apps.length === 0 && skills.length === 0) return ''
  const parts: string[] = []
  // Computer Use stays on the device API path, independently of App tool disclosure.
  if (apps.some((app) => app.computerUse)) parts.push(COMPUTER_USE_LINE)
  const catalogApps = apps.filter((app) => !app.computerUse)
  if (catalogApps.length > 0) {
    parts.push(['Apps available in this session (use their listed tools, or catalog_list / catalog_call):', ...appLines(catalogApps)].join('\n'))
  }
  // Standing behavior is not an App summary: keep the complete authorized rule.
  for (const app of apps) {
    if (app.agentInstructions) {
      parts.push(`Standing instructions from App ${app.extensionId} (apply while its tools remain available; user instructions take precedence):\n${app.agentInstructions}`)
    }
  }
  if (skills.length > 0) {
    const lines = skills.map((skill) => `- ${skill.name} (App ${skill.extensionId}): ${skill.description}\n  ${join(skill.dir, 'SKILL.md')}`)
    parts.push(['Skills from Apps installed in 咕咕. When a task matches one, read its SKILL.md first and follow it.', ...lines].join('\n'))
  }
  parts.push(GUGU_APPS_SEARCH_LINE)
  return `<gugu_apps>
${parts.join('\n')}
</gugu_apps>
`
}

/**
 * adapter 的 `acp.mcpServers` 只带得动**名字与地址**——凭据的值按设计不进 materialization
 * (materialization 会被落盘、被写进取证报告)。宿主这边手里才有那份带 `Authorization` header
 * 的真 server,所以在这里按名字对回去。
 *
 * ❌ 对不上不许静默丢:ACP 的 `session/new` 是 gugu MCP 在那两条腿上的**唯一**通道,丢一个
 * 就等于那个会话的 agent 从此不会说话,而且一声不吭。宁可 spawn 前就炸。
 */
function attachAcpMcpCredentials(
  materialization: Materialization,
  bundle: SessionCapabilityBundle,
): Materialization {
  const declared = materialization.sessionNewPatch?.mcpServers
  if (!declared?.length) return materialization
  const byName = new Map(bundle.mcpServers.map((server) => [server.name, server]))
  const resolved = declared.map((server) => {
    const source = byName.get(server.name)
    if (!source) {
      throw new Error(
        `Session adapter routed MCP server '${server.name}' onto the ACP channel, but the session bundle has no such server. Declare it in buildSessionBundle before routing the session.`,
      )
    }
    // 凭据由宿主按名字对回;物化器给的 `_meta`(这一家的原生 per-server 开关)原样保留。
    return {
      ...toProtocolMcpServer(source, bundle.env),
      ...(server._meta ? { _meta: { ...server._meta } } : {}),
    }
  })
  return {
    ...materialization,
    sessionNewPatch: { ...materialization.sessionNewPatch, mcpServers: resolved },
  }
}

function providerCapabilities(
  providerId: string,
  ctx: SessionMaterializationContext,
  bundleWithoutSurface: SessionCapabilityBundle,
): Materialization {
  const bundle = withSurfaceSelfDescription(bundleWithoutSurface, ctx.surface, providerId)
  const provider = pluginRegistry.get(providerId)
  const behavior = provider?.behavior.sessionBundle
  // 同一事实只声明一次：materializer 从唯一 registry 的 behavior 取，这里没有 per-provider 分支。
  // descriptor 无专用 materializer 特征的 provider 到不了这里（路由谓词把它送去协议通道）；
  // 到了却取不到实现体 = 编程错误，spawn 前 fail loud 并点名要补的 impl 文件。
  if (!provider || !behavior || !declaresProviderMaterializedDelivery(provider.capabilities.sessionBundle)) {
    throw new Error(
      `Provider '${providerId}' selects provider-adapter but has no session-bundle materializer. Implement it in packages/session-plugins/src/agents/impl/${providerId}/session-bundle.ts and register it in packages/session-plugins/src/agents/impl/${providerId}/index.ts.`,
    )
  }
  const mapped = attachAcpMcpCredentials(
    fromCoreMaterialization(behavior.materialize(
      ctx,
      toCoreSessionBundle(
        ctx.surface === 'app-server'
          ? { ...bundle, promptBlocks: { platform: bundle.promptBlocks.platform, identity: bundle.promptBlocks.identity } }
          : bundle,
      ),
    )),
    bundle,
  )
  if (ctx.surface !== 'app-server') return mapped
  // app-server 的 system-prompt native channel 是 thread-open 的 developerInstructions。
  // platform + identity 是 session-stable，threadBootstrap 是 message-local history，不能冻结进 thread。
  return {
    ...mapped,
    developerInstructions: mapped.sessionPrompt,
    sessionPrompt: undefined,
  }
}

/** 这一格在 acp 腿上是否声明了 native(同形 support-tier 的 nativeOn;探针只读,漏写不炸)。 */
function unitNativeOnSessionAcp(unit: SessionBundleDescriptor['units'][keyof SessionBundleDescriptor['units']] | undefined): boolean {
  if (!unit) return false
  if (unit.kind === 'native') return true
  if (unit.kind !== 'per-surface') return false
  return unit.surfaces['acp']?.kind === 'native'
}

export function loadSessionAcpCapabilities(
  providerId: string,
  bundle: SessionCapabilityBundle,
  ctx: {
    cwd: string
    lifecycle: SessionMaterializationContext['lifecycle']
    // ⚠️ 与 lifecycle 不是一回事，见 `SessionMaterializationContext` 里那段抬头。
    isResuming?: boolean
  },
): Materialization {
  if (providerUsesSessionAcpSessionAdapter(providerId)) {
    return providerCapabilities(providerId, { surface: 'acp', ...ctx }, bundle)
  }
  // 能力协商(spec session-injection):`session/new` 的 `mcpServers` 也是**按家声明的能力**,
  // 不是人人可收的规范参数 —— droid 实测:http 型条目(规范形状,带不带 env/headers 都一样)会让
  // 它的内进程 exit 1、session/new 报 -32603,会话根本起不来(#4482 droid 旁注;5 变体判别脚本
  // 与读数见 mac1 /tmp/droid-probe.mjs)。未声明 units.mcp 在 acp 腿 native 的家,这份载荷
  // fail closed 到「不注入」——agent 因此能收消息但没有咕咕工具可回,这是如实的欠账
  // (进集成档要先把 units 接通),❌ 不是把未声明的通道盲推过去赌它兼容。
  // `_meta.systemPrompt` 保持原样:它是咕咕自己的 _meta 约定,实测不消费方仅忽略(copilot 0/6、
  // droid 判别 OK),从未致命。
  const descriptor = pluginRegistry.get(providerId)?.capabilities.sessionBundle
  const gated = unitNativeOnSessionAcp(descriptor?.units.mcp)
    ? bundle
    : { ...bundle, mcpServers: [] }
  return guguAcpCapabilityLoader.load(withSurfaceSelfDescription(gated, 'acp', providerId), {
    adapterId: providerId,
    surface: 'acp',
  })
}

export function loadClaudeTuiCapabilities(
  bundle: SessionCapabilityBundle,
  ctx: {
    cwd: string
    lifecycle: SessionMaterializationContext['lifecycle']
    // ⚠️ 与 lifecycle 不是一回事，见 `SessionMaterializationContext` 里那段抬头。
    isResuming?: boolean
  },
): Materialization {
  return providerCapabilities('claude', { surface: 'tui', ...ctx }, bundle)
}

export function loadCodexAppServerCapabilities(
  bundle: SessionCapabilityBundle,
  ctx: {
    cwd: string
    lifecycle: SessionMaterializationContext['lifecycle']
    // ⚠️ 与 lifecycle 不是一回事，见 `SessionMaterializationContext` 里那段抬头。
    isResuming?: boolean
  },
): Materialization {
  return providerCapabilities('codex', { surface: 'app-server', ...ctx }, bundle)
}

export function loadSessionTuiCapabilities(
  providerId: string,
  bundle: SessionCapabilityBundle,
  ctx: {
    cwd: string
    lifecycle: SessionMaterializationContext['lifecycle']
    // ⚠️ 与 lifecycle 不是一回事，见 `SessionMaterializationContext` 里那段抬头。
    isResuming?: boolean
  },
): Materialization {
  if (!providerUsesSessionTuiSessionBundle(providerId)) {
    throw new Error(
      `Provider '${providerId}' has no direct TUI session adapter. Declare its tui delivery in packages/session-plugins/src/agents/impl/${providerId}/index.ts.`,
    )
  }
  return providerCapabilities(providerId, { surface: 'tui', ...ctx }, bundle)
}

/** 会话页 GUI ACP：跨 provider 的 prompt 块走 task runtime 首轮 hidden context。 */
export const guguAcpCapabilityLoader: CapabilityLoader = {
  id: 'gugu-acp',
  supports: MCP_ENV_PROMPT_UNITS,
  load(bundle, identity) {
    return {
      sessionNewPatch: {
        mcpServers: bundle.mcpServers.map((server) => toProtocolMcpServer(server, bundle.env)),
      },
      sessionPrompt: renderSessionPromptBlocks(bundle.promptBlocks) || undefined,
      report: loadReport(guguAcpCapabilityLoader, bundle, identity),
    }
  },
}
