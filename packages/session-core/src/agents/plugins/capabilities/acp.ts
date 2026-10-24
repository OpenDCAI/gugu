import type { Readable, Writable } from 'node:stream';
import type {
  AvailableCommand,
  CancelNotification,
  Client,
  CloseSessionRequest,
  CloseSessionResponse,
  ForkSessionRequest,
  ForkSessionResponse,
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
} from '@agentclientprotocol/sdk';
import { definePluginCapability } from '@gugu/session-shared/plugins';
import type { SerializedError } from '@gugu/session-shared';
import z from 'zod';
import type { AcpPlatformInjection } from '../../../acp/api/runtime-contract';
import type { NormalizedEvent } from '../../../acp/reducer/normalized-event';
import type { SessionPromptReceipt } from '../../../acp/session-protocol';
import type { PermissionSubject, AcpPermissionOption } from '../../../acp/models/permissions';

export type LiveSettingDimension = 'model' | 'permission' | 'effort';
export type LiveSettingChannel =
  | 'acp-config-option'
  | 'acp-mode'
  | 'provider-thread-settings'
  | 'per-prompt'
  | 'reload-session'
  | 'unsupported';

/**
 * A provider's confirmation and recovery contract for one mutable session setting.
 *
 * This is deliberately data, not provider logic. The runtime uses the same fields for every
 * adapter; protocol names and request translation stay behind AcpAgentApi.
 */
export interface LiveSettingCapability {
  channel: LiveSettingChannel;
  ack: 'ack' | 'ack-read-back' | 'pending-next-turn' | 'none';
  busy: 'queue-next-turn' | 'reject';
  reloadRequired: boolean;
  recovery: 'none' | 'runtime-restart' | 'unsupported';
  /**
   * 启动期档位对不上时,**允许降档启动**,还是响亮失败。缺省(不写)= 允许。
   *
   * ⚠️ 它**不是**「这一维只能在启动时设」—— 那是它原来的名字(`startupOnly`)骗人的地方,
   * 而一张自相矛盾的声明表(`channel: 'acp-config-option'` 说热,`startupOnly` 说只能启动时设)
   * 正是「没人回头核对的声明」那类事故的温床。⇒ 2026-09-13 按它**唯一的读者**改名。
   *
   * 唯一读者:`session-manager.applyConfiguredPermissionMode`(`!== false`)。它管三处 ——
   * 该家一个档都不报、档位只能落到更严的一档、`setMode` 失败 —— 在用户选的是阶梯顶端时
   * 记一条 warn 照常开会话,而不是让会话起不来。
   *
   * ⇒ 与「这一维能不能热改」无关(那是 `channel`)。❌ 别因为某家的 channel 是热的就删掉它:
   * 删掉会把上面三处 warn 变成 throw,那是**另一个命题**,要它自己的读数。
   */
  allowStartupDowngrade?: boolean;
  /**
   * 这一维写进 provider 时用的 config option id —— **只给「收这个 id、却不在 `configOptions` 里报它」的家**。
   *
   * 平常 id 取自活会话自报的那一组(`transcript.config.modelOptions.configId`),这里不写。
   * 实例:copilot 1.0.82 走自定义 provider(BYOK)时,`session/new` 只报 `mode` / `allow_all`,
   * 一条 `model` 都不报;而 `session/set_config_option {configId:'model'}` 照收,
   * 下一轮送出去的 `model` 就是新值(2026-09-22 mac1 本地记录端点实测,#6182)。
   * ⇒ 没有这一格,「能热切」这件事在咕咕里表达不出来。
   */
  configId?: string;
}

/**
 * 三维**各自**声明。某一维缺席 = 那一维没人量过 ⇒ 没有活通道(cell 响亮拒;权限维照
 * `applyConfiguredPermissionMode` 的「未声明」规则启动)。
 *
 * ⚠️ 缺席不是省略:按维度分开,是为了让「量过模型那一维」不必顺手替另外两维编一个声明 ——
 * 权限维一旦声明,启动时就会走 mode 阶梯(copilot 报的是 agent/plan/autopilot),那是另一个命题。
 */
export interface LiveSettingsCapability {
  model?: LiveSettingCapability;
  permission?: LiveSettingCapability;
  effort?: LiveSettingCapability;
}

const unsupportedLiveSetting: LiveSettingCapability = {
  channel: 'unsupported',
  ack: 'none',
  busy: 'reject',
  reloadRequired: false,
  recovery: 'unsupported',
};

/** Explicit opt-in value for providers that have measured no safe live channel. */
export const UNSUPPORTED_LIVE_SETTINGS: LiveSettingsCapability = {
  model: unsupportedLiveSetting,
  permission: unsupportedLiveSetting,
  effort: unsupportedLiveSetting,
};

const liveSettingSchema = z.object({
  channel: z.enum([
    'acp-config-option',
    'acp-mode',
    'provider-thread-settings',
    'per-prompt',
    'reload-session',
    'unsupported',
  ]),
  ack: z.enum(['ack', 'ack-read-back', 'pending-next-turn', 'none']),
  busy: z.enum(['queue-next-turn', 'reject']),
  reloadRequired: z.boolean(),
  recovery: z.enum(['none', 'runtime-restart', 'unsupported']),
  allowStartupDowngrade: z.boolean().optional(),
  configId: z.string().min(1).optional(),
});
const startupSchema = z.object({ noticeKey: z.string().min(1) });

export const liveSettingsCapabilitySchema = z.object({
  model: liveSettingSchema.optional(),
  permission: liveSettingSchema.optional(),
  effort: liveSettingSchema.optional(),
});

export type AcpSpawnContext = {
  /** Absolute path to the worktree / task directory. */
  cwd: string;
  /** Environment variables to pass to the spawned process. */
  env: Record<string, string>;
  /** Absolute path to the resolved host CLI binary (mirrors prompt's CommandContext.cli). */
  cli: string;
  /** Main-process-issued platform credentials. Present only on the private ACP worker path. */
  platform?: AcpPlatformInjection;
  /**
   * 这条会话的**能力注入 env**(物化器产出的那一份)。
   *
   * ⚠️ 它与上面的 `env` 不是一回事:`env` 是这台 harness 的常驻运行环境,
   * 这一份是**这条会话**当场物化出来的。宿主最后会把它叠在 spawn env 的**最上面**
   * (`plugin-host.buildAcpSpawn`),所以任何 `buildSpawn` 自己也在写的键都会被它顶掉。
   *
   * ⇒ 递进来是为了让 `buildSpawn` 能**读**其中几个由物化器决定的事实,
   * 再把它们合进自己独占产出的那份文档 —— 而不是让物化器去复制一份 `buildSpawn` 的输出。
   * 实例:codex 的 `CODEX_CONFIG` 由 `buildSpawn` 独占产出(平台那一格),
   * 而「这条会话关掉哪几台 MCP」由物化器决定 ⇒ 物化器只递名字,合并在这里做。
   * ❌ 反过来做(物化器直接写 `CODEX_CONFIG`)会把平台那份整个顶掉。
   */
  capabilityEnv?: Readonly<Record<string, string>>;
  /**
   * Arguments emitted by the session capability materializer for this session.
   * The host passes these only to the provider's `buildSpawn`, which puts them on its adapter
   * entrypoint: Gugu's own adapter for codex, the vendor binary itself for a native ACP provider
   * whose materializer emits acp argv (copilot). A materializer emits only flags that
   * entrypoint accepts; providers must not infer capability policy from the ambient environment.
   */
  capabilityArgs?: readonly string[];
  /**
   * 宿主按这一家的 `IAcpBehavior.bridge` 声明解析好的桥入口(`AgentRunContext.acpAdapterEntry`,#6394)。
   * 声明了 `bridge` 的家,宿主**一定**给;插件 ❌ 自己再 `require.resolve` / 读环境变量找桥。
   * 没有桥的家(CLI 自己就讲 ACP)不读它。
   */
  adapterEntry?: string;
};

/**
 * 这一家的 ACP 桥从哪来 —— 只声明,由宿主**唯一一处**解析成入口(#6394):
 *
 * - `package`:随包的 npm 包(咕咕维护的构建 `@gugu-acp/*`,按别名装在 `alias` 下)。
 *   `pairWith` 给出时,宿主按用户这份 CLI 的版本从配对表(`@gugu-acp/compat`)选版本,
 *   随包那份不合适就下载配对的那份;不给则总用随包那份。
 * - `app-runtime`:咕咕自己写、随应用一起构建的桥(`dist-electron/runtime/<file>`)。
 *
 * 不声明 = 没有桥:CLI 自己讲 ACP(`createNativeAcpBehavior` 那些家)。
 */
export type AcpBridgeSource =
  | { kind: 'package'; alias: string; entry: string; pairWith?: 'claude' }
  | { kind: 'app-runtime'; file: string };

export type AcpSpawnResult = {
  command: string;
  args: string[];
  env?: Record<string, string>;
  executable?: string;
};

/** Stdio of a process the APP has already spawned and owns. */
export interface AcpProcessIo {
  stdin: Writable;
  stdout: Readable;
}

/**
 * Narrow agent surface the manager calls. ClientSideConnection satisfies this
 * structurally — only the methods the session backend actually uses are required here.
 */
export interface AcpAgentApi {
  initialize(params: InitializeRequest): Promise<InitializeResponse>;
  newSession(params: NewSessionRequest): Promise<NewSessionResponse & { availableCommands?: Extract<NormalizedEvent, { kind: 'commands' }>['commands'] }>;
  /** Optional — only available when the agent advertises the `loadSession` capability. */
  loadSession?(params: LoadSessionRequest): Promise<LoadSessionResponse & { availableCommands?: Extract<NormalizedEvent, { kind: 'commands' }>['commands'] }>;
  /** Optional experimental ACP surface advertised through `sessionCapabilities.fork`. */
  unstable_forkSession?(params: ForkSessionRequest): Promise<ForkSessionResponse & { availableCommands?: Extract<NormalizedEvent, { kind: 'commands' }>['commands'] }>;
  /** Dispatch/acceptance only. Foreground completion arrives independently as a domain event. */
  prompt(params: PromptRequest, dispatch?: {
    requestId: string;
    message: Extract<NormalizedEvent, { kind: 'message' }>;
  }): Promise<SessionPromptReceipt>;
  /** Admission through the negotiated steering extension; completion remains on the event stream. */
  steer?(params: PromptRequest, dispatch?: Parameters<AcpAgentApi['prompt']>[1]): Promise<'injected' | 'promptRequired'>;
  /** Providers that cannot accept concurrent input can interrupt at their next tool boundary. */
  interruptForMessage?(params: { sessionId: string }): Promise<void>;
  cancel(params: CancelNotification): Promise<void>;
  /** Optional — only available when the agent advertises `sessionCapabilities.list`. */
  listSessions?(params: ListSessionsRequest): Promise<ListSessionsResponse>;
  /**
   * ACP 扩展请求(`_` 前缀的厂商方法)。ClientSideConnection 原生就有;咕咕用它发 claude
   * 适配器的 `_session/async_task/stop`(停一个后台子智能体,#5117)。
   */
  extMethod?(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Optional — only available when the agent advertises the `setSessionConfigOption` capability. */
  setSessionConfigOption?(
    params: SetSessionConfigOptionRequest
  ): Promise<SetSessionConfigOptionResponse>;
  /** Optional — only available when the agent advertises the `session.setMode` capability. */
  setSessionMode?(params: SetSessionModeRequest): Promise<SetSessionModeResponse>;
  /**
   * Unified live-setting execution boundary. Provider adapters may implement this when a setting
   * is not represented by one of the standard ACP methods (for example Codex thread settings).
   */
  applyLiveSetting?(params: {
    providerSessionId: string;
    dimension: LiveSettingDimension;
    value: string;
    channel: LiveSettingChannel;
    configId?: string;
  }): Promise<{
    status: 'applied' | 'pending_next_turn';
    effectiveValue?: string;
    configOptions?: readonly SessionConfigOption[] | null;
  }>;
  /** Optional — only available when the agent advertises the `session.close` capability. */
  closeSession?(params: CloseSessionRequest): Promise<CloseSessionResponse | void>;
}

/** Permission facts decoded once at transport ingress; subject retains the complete native context. */
export type AcpPermissionParams = {
  sessionId: string;
  toolCall?: Extract<NormalizedEvent, { kind: 'tool_update' }>;
  options: AcpPermissionOption[];
  title?: string;
  description?: string | null;
  subject?: PermissionSubject | null;
  _meta?: Record<string, unknown> | null;
};

export type AcpClient = Omit<Client, 'requestPermission' | 'sessionUpdate'> & {
  /** Domain facts synthesized by a transport; never wrapped in a wire tool notification. */
  /** trace is opaque diagnostic data; it is never used to project session state. */
  sessionEvent(params: { sessionId: string; event: NormalizedEvent; trace?: unknown }): void;
  requestPermission(params: AcpPermissionParams): RequestPermissionResponse | Promise<RequestPermissionResponse>;
};

export type AcpClientFactory = (agent: AcpAgentApi) => AcpClient;

/** `IAcpBehavior.discoverCommands` 的入参 —— 宿主(运行时,Node 侧)递进来,插件自己不碰 `node:fs`。 */
export interface AcpCommandDiscoveryContext {
  cwd: string;
  /** 与启动这一家时同一份 env(含 configRootEnv),目录约定要跟着它挪。 */
  env: Readonly<Record<string, string>>;
  /** 用户 OS home(绝对路径)—— env 里没有覆盖时的默认根。 */
  homeDir: string;
  /** 只读、绝对路径。不存在 ⇒ `[]` / `null`,❌ 不抛。 */
  fs: {
    listDirs(dir: string): Promise<string[]>;
    listFiles(dir: string): Promise<string[]>;
    readText(file: string): Promise<string | null>;
  };
}

/** `IAcpBehavior.prepareSession` 的入参 —— env 与启动这一家时同一份。 */
export interface AcpSessionPrepareContext {
  cwd: string;
  env: Readonly<Record<string, string>>;
  homeDir: string;
}

/** `IAcpBehavior.onTurnEnded` 的入参。 */
export interface AcpTurnEndContext {
  /** 这一家的会话 id。 */
  providerSessionId: string;
  cwd: string;
  env: Readonly<Record<string, string>>;
  homeDir: string;
  /** 这是本次连续「钩子要求继续」里的第几轮(从 1 起;用户或别处发来新一轮就归 1)。 */
  executionNum: number;
}

/** `IAcpBehavior.forkSessionInStorage` 的入参 —— env 与启动这一家时同一份,存档位置要跟着它挪。 */
export interface AcpStorageForkContext {
  sourceProviderSessionId: string;
  cwd: string;
  env: Readonly<Record<string, string>>;
  homeDir: string;
}

export interface IAcpBehavior {
  explainError?(cause: SerializedError): string | undefined;
  /**
   * 这一家**调得到、却不经 ACP 报**的命令 —— 由咕咕按它自己的目录约定扫出来,合进「/」面板。
   *
   * owner 2026-09-06(#5136)定的 skill 模型是「用户自己装,咕咕只负责 invoke」,而 invoke 的入口
   * 就是「/」面板 —— 面板今天只认 `available_commands_update`。有的家把用户 skill 读进了系统提示,
   * 却不在命令表里报(Antigravity ACP 1.2.1 实测:放 3 个 skill,系统提示里 3 个都在,命令表只有
   * `plan`/`logout`),用户就既看不见也点不到自己的 skill。
   *
   * 语义:补充,不是替换。宿主把它与这一家自己报的命令表合并,**同名以这一家报的为准**;
   * 结果晚到时用合并后的表再推一次。❌ 不许在这里列咕咕自己注进去的东西 —— 那不是「用户的」。
   * 失败只记日志、不挡会话:少几条命令不该让一条会话起不来。
   */
  discoverCommands?(ctx: AcpCommandDiscoveryContext): Promise<AvailableCommand[]>;
  /**
   * 这一家的 agent **读不到**、却是用户写给它的规则文件(GEMINI.md / AGENTS.md / rules 目录)——
   * 咕咕按这一家**官方文档**写的位置读出来,拼成一段文字,随会话级背景(③ session-context)进第一轮。
   * 返回 `null` = 没有规则。❌ 不许在这里放咕咕自己的内容(那走 promptBlocks)。
   * 用于服务本身不读规则的家(Antigravity ACP 1.2.1:8 个位置放标记,进模型请求 0 处,2026-09-24)。
   */
  readRules?(ctx: AcpCommandDiscoveryContext): Promise<string | null>;
  /**
   * 进程起来**之前**跑一次,让这一家在咕咕托管的配置根里就位它自己读不到的东西
   * (Antigravity:把 `skills.json` 另加的 skill 目录链进它真在读的 `config/skills/`)。
   * ❌ 不许写用户自己的配置根。失败只记日志、不挡会话。
   */
  prepareSession?(ctx: AcpSessionPrepareContext): Promise<unknown>;
  /**
   * 每一轮**正常结束**(`end_turn`、之后没有别的回合接上)时由运行时调一次。返回 `continueWith`
   * ⇒ 运行时把它当下一条消息发进去,让 agent 接着干;`null` ⇒ 就此停下。
   *
   * 用于替这一家补上它**文档里有、服务里没接**的回合结束钩子(Antigravity `Stop`:文档写「循环停下时」
   * 可 `continue`,ACP 1.2.1 只在会话结束时跑、且忽略 continue)。失败只记日志、不挡会话。
   */
  onTurnEnded?(ctx: AcpTurnEndContext): Promise<{ continueWith: string } | null>;
  /**
   * 这一家**拟了**会话名(不是咕咕多花的调用),却不经 `session_info_update` 推,只在 `session/list`
   * 里给(opencode 家:title agent 在首条消息后拟一次,ACP 腿不转发 `session.updated`)。
   * 声明了它,运行时就在每轮结束读一次 `session/list`,把这里认下的名按推来的同一条路进会话状态。
   * 入参是列表里这条会话的 title;返回 null = 还不是名字(拟名之前的占位)。
   */
  sessionTitleFromList?(title: string): string | null;
  /**
   * 这一家把**失败的回合报成正常结束**时,认出它的信号。认出来 ⇒ 这一轮按失败结算
   * (界面「回合失败」那一行,原话进详情),❌ 不当成 agent 的一句回复、❌ 不发「干完了」。
   *
   * 用于 Antigravity ACP 1.2.1:SDK 抛错一律被改写成一条 `agent_message_chunk`
   * (「Agent execution error: …」「Usage Limit Reached …」等)+ `end_turn`;执行器在回合开头就失败的,
   * 连这句都没有,只在 stderr 留一行「Agent run failed: …」(2026-09-24 实测)。
   */
  turnFailure?: {
    /**
     * 进程 stderr 的一行 ⇒ 失败说明;不是 ⇒ null。这一家的报错本身就说明是凭据不能用(MiMo 的
     * `Invalid API Key`)时带 `signInRequired`,界面才给得出「去登录」这一步。
     * 只在这一轮**一个字都没出**时才算失败:stderr 这一路认的是「什么都没说就结束」的那一种,
     * 出过字的回合照它自己的结局(复核 93;cell.ts `providerStderrFailure`)。
     */
    fromStderrLine?(line: string): string | { message: string; signInRequired: true } | null;
    /** 这一家自己写进回复的一整块文字 ⇒ 失败说明;不是 ⇒ null。 */
    fromAgentMessage?(text: string): string | null;
  };
  /**
   * 分叉由**宿主在这一家自己的会话存档上**做:复制出一份新 id 的存档,返回那个 id,运行时随后照常
   * `session/load` 它(持久分叉与运行时分叉都走这一条,优先于 `session/fork`)。
   *
   * 用于协议里的 `session/fork` 没实现、但存档可以被安全复制的家(Antigravity ACP 1.2.1:
   * `session/fork` 回 `{}` 不给 id;而复制存档并改写其中的会话 id 后 `session/load` + 下一轮,
   * 模型收到的上下文带着来源会话的全部历史,2026-09-24 实测)。
   * ⚠️ 必须不动来源那一份 —— 来源会话可能正开着。失败就抛,分叉整体失败,❌ 不退回别的路。
   */
  forkSessionInStorage?(ctx: AcpStorageForkContext): Promise<{ providerSessionId: string }>;
  /**
   * Resolve a runtime fork into a provider session that the new ACP adapter can load.
   * The runtime manager owns the control flow; providers own the transport-specific fork.
   */
  resolveForkSource?(input: {
    sourceProviderSessionId: string;
    sourceSession: {
      id: string;
      title: string;
      providerId: string;
      providerSessionEndpoint?: string;
    };
    host: {
      cwd: string;
      workspaceId: string;
    };
    /**
     * The live source ACP connection, when the parent runs on the ACP leg. The runtime resolves this
     * from the parent's own session record; providers must fail loud when their non-HTTP fork path
     * needs it but it is unavailable.
     */
    sourceConnection?: {
      supportsForkSession: boolean;
      agent: Pick<AcpAgentApi, 'unstable_forkSession'>;
    };
  }): Promise<{ loadProviderSessionId: string }>;

  /**
   * 这一家的分叉**不走 ACP 的 `session/fork`**,而是走 `session/new` + 这一份 `_meta`。
   * 返回 `undefined`(缺省)= 照旧用 `session/fork`。
   * Runtime forks using this hook are created in a fresh adapter process. The metadata resumes
   * the parent's durable transcript and asks the provider to mint a child session id.
   *
   * Claude uses this hook because `session/fork` in `claude-agent-acp` 0.75.1 is a **storage-level** action:
   * 它只在 project 目录里分出一条、返回那个 id,**不建立也不登记 live 会话**
   * (响应里连 `modes`/`models` 都没有了,0.38.0 是有的)⇒ 直接拿它 `session/prompt`
   * 必答 `Session not found`。要用得再 `session/load` 一次 —— 而那会在盘上留下一份
   * transcript,正是运行时分叉不能留的东西(#4230:外部 fork 捕获会把它捞回会话列表)。
   *
   * ⇒ 改走 Claude Agent SDK 自己那条(`sdk.d.ts`):
   *   `resume: <源 sessionId>` 载入历史 + `forkSession: true` 分叉成新 id。
   * 而 `_meta.claudeCode.options` 是**整体展开**进 SDK 的透传口(从前的 `strictMcpConfig` 那格实测过:
   * 适配器 dist 里那个名字命中 0 次,照样生效)。
   *
   * The adapter returns the child id minted by `system/init`; the runtime registers it on the
   * child connection. A source id response is rejected before registration so a fork cannot
   * overwrite its parent.
   *
   * ⭐ 记一笔为什么会绕这么远:仓里对 claude 的 `fork: 'supported'` 举证写的是
   * **CLI** 的 `claude --resume <src> --fork-session --session-id <new>` —— 那句是真的,
   * 而**「某一个方法坏了」≠「这件事做不到」**。我们先前差点据此把整个功能关掉。
   */
  forkViaNewSessionMeta?(sourceProviderSessionId: string): Record<string, unknown> | undefined;

  /**
   * 模型目录探针那一条 `session/new` 带的 `_meta`:让这一家开一条**不装用户 MCP** 的会话。
   * 不声明 = 照常开(这一家的 `session/new` 会把用户的 MCP 全起一遍 —— 那是探针的副作用,不是它要的)。
   *
   * 为什么要有它:ACP 规范里模型清单只有 `session/new` 一个出口,而 `session/new` 在多数家那里是一条
   * **真会话**,用户配的每一台 MCP 都会起来(10-17 mac1 账本:claude 探一次就起了用户级、插件、
   * 连在项目里 `/mcp` 关掉的那台;探针的 cwd 是临时目录,项目里的关闭名单管不到它)。
   */
  catalogProbeSessionMeta?: Record<string, unknown>;

  /**
   * Pure description of how to spawn the agent adapter process.
   * The APP spawns it and retains the ChildProcess handle for graceful cleanup.
   */
  /** 这一家的 ACP 桥从哪来(见 {@link AcpBridgeSource});不声明 = CLI 自己讲 ACP。 */
  bridge?: AcpBridgeSource;
  buildSpawn(ctx: AcpSpawnContext): AcpSpawnResult;

  /**
   * Wrap an app-owned process's stdio into an ACP client connection.
   * The plugin owns adapter/SDK wiring; the app owns the process lifecycle.
   */
  connect(io: AcpProcessIo, toClient: AcpClientFactory): AcpAgentApi;

}

/**
 * Describes whether a provider supports the Agent Client Protocol (ACP) transport.
 * Defaults to `{ kind: 'none' }` so existing plugins need not declare it.
 */
export const acpCapability = definePluginCapability<IAcpBehavior>()(
  'acp',
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('none'),
      /** Non-ACP surfaces can still declare that a setting requires an explicit restart. */
      /** Omission is preserved as undeclared so runtime can fail loudly. */
      liveSettings: liveSettingsCapabilitySchema.optional(),
      /** Which product dimension the stable ACP `session/new.modes` represents. */
      sessionModes: z.enum(['permission', 'none']).optional(),
      startup: startupSchema.optional(),
    }),
    z.object({
      kind: z.literal('supported'),
      /** Provider-native session capacity; process ownership remains a runtime rule. */
      maxSessionsPerProcess: z.number().int().positive().optional(),
      /** Explicit live-setting contract; omission remains an undeclared capability. */
      liveSettings: liveSettingsCapabilitySchema.optional(),
      /** Stable ACP `session/new.modes` defaults to the permission dimension when omitted. */
      sessionModes: z.enum(['permission', 'none']).optional(),
      startup: startupSchema.optional(),
    }),
  ]),
  { kind: 'none' },
  {
    requiresBehavior: (descriptor) => descriptor.kind === 'supported',
  }
);
