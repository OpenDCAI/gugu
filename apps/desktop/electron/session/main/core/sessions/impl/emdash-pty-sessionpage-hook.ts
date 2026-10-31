// @@@sessionpage TASKPAGE-FUSION — a module-boundary HOOK the gugu host registers to DIVERT a session-page
// codex PTY conversation onto codex's own app-server control channel. The session backend owns the hook POINT (called
// in LocalSessionProvider right after buildCommand, before the pty spawn); the gugu host owns what it
// returns — it starts a `codex app-server --listen <endpoint>` (+ gugu MCP) with its own Supabase token /
// server paths, none of which the session backend imports, and returns `codex --remote <endpoint> resume <tid>` so the
// visible TUI and the delivery channel are the SAME session (Unix socket or Windows loopback WebSocket).
// Default = no hook installed →
// PTY conversations spawn the original command unchanged. Mirrors emdash-mcp-injector.ts exactly.
import type { GuguPermissionMode } from '@gugu/session-core/acp'

/** The slice of the PTY session-start the hook needs to decide whether/how to divert. */
export interface EmdashPtySessionpageStartInfo {
  sessionId: string;
  providerId: string;
  cwd: string;
  /** The project + task this conversation belongs to. The gugu host mirrors a project as a chat group and
   *  needs the ids to place (and later reap) the agent it provisions; `cwd` is the task WORKTREE path, which
   *  identifies neither. Mirrors what the ACP injector already receives (emdash-mcp-injector.ts). */
  projectId: string;
  sourceSessionId?: string;
  /** spec session-graph: the workspace this session is bound to. Carried for the same reason `projectId`
   *  is — the host's session tools verify that the caller's bound workspace is still the
   *  session's current one, and `cwd` is a path, not an id. The ACP injector already receives it; a PTY start
   *  that omitted it left the host filling in an empty string, which every downstream check then read as
   *  "workspace not ready" — a capability refused for a reason nothing in the product could explain. */
  workspaceId: string;
  /**
   * 这一发是新起引擎,还是接回一个本来就在 tmux 里跑着的引擎(见 `session-process.ts`)。接回时引擎手里已经是它当初
   * 拿到的那一套(能力、平台票、rendezvous 通道),宿主 ❌ 再做新起才做的事。
   */
  start: 'fresh' | 'reattach';
  /** The first user turn when this fresh session uses the provider's delivery-bridge startup channel. */
  initialPrompt?: string;
  /** Provider-native source session requested by a fork spawn. A host that replaces the provider argv
   *  must preserve this semantic explicitly; `baseArgs` is diagnostic context, not a parsing contract. */
  forkFromProviderSessionId?: string;
  /** Provider-native session to resume when this conversation is hydrated after a restart. */
  resumeProviderSessionId?: string;
  /** Whether the session backend built `baseArgs` as a RESUME argv — i.e. those args already carry the provider's
   *  resume flag. ⚠️ Not the same question as `resumeProviderSessionId`: for providers that do not declare
   *  `sessions.resumeNeedsProviderId`, the session backend still resumes (with a flagless `--continue`-style
   *  flag) when it has no provider-native id yet, so this is true while `resumeProviderSessionId` is
   *  undefined. A host that APPENDS a flag which the provider rejects alongside its resume flag must
   *  read this one — deriving it from `resumeProviderSessionId` silently misses exactly that case, and
   *  the failure mode is the engine refusing to start rather than a degraded session. */
  isResuming?: boolean;
  /** Persist the provider-native session id returned by a diverting host before creation completes. */
  onProviderSessionId?: (providerSessionId: string) => Promise<void>;
  /** A diverting host observed the harness naming this session (e.g. codex `thread/name/updated`). */
  onHarnessTitle?: (title: string) => void;
  /** Persist the host-owned control endpoint used to resolve future runtime forks. */
  onProviderSessionEndpoint?: (endpoint: string) => Promise<void>;
  /** The argv the session backend was about to spawn. A host that only needs to ADD a flag (e.g. claude's
   *  `--mcp-config`, so the TUI session gets gugu's tools) appends to these instead of reconstructing the
   *  provider's command — reconstruction drifts the moment the session backend changes a flag. */
  baseCommand: string;
  baseArgs: string[];
  /** The model / reasoning-effort the user picked for this conversation. Already encoded in `baseArgs`,
   *  but a host that REPLACES the argv (codex's session-page divert runs `codex --remote … resume <tid>`)
   *  drops them along with the rest of it, and must re-apply them to whatever it starts instead. Passed
   *  explicitly rather than left to be parsed back out of `baseArgs` — that is the same "reconstruct the
   *  provider's command" this contract exists to avoid, and it drifts the moment a flag changes. */
  model?: string;
  effort?: string;
  /** The composer's permission tier. A diverting host must re-apply it separately because the provider
   *  argv carrying its native flags is replaced wholesale. */
  permissionMode?: GuguPermissionMode;
  /**
   * @@@2503 The composer's platform-model decision for THIS conversation, as recorded at creation.
   *
   * `{ modelId }` — the user picked a Gugu-provided model: the host issues platform quota for it.
   * `null`        — the user picked one of the harness's own models: BYOK, and the host must inject
   *                 nothing, even when the conversation's agent has a platform model configured.
   * `undefined`   — no record at all, i.e. a conversation created before this decision existed. The
   *                 host falls back to the agent-level `model_access`, which is what those sessions
   *                 have always run on.
   *
   * Travels like `model` / `effort` / `permissionMode`: a decision the composer made, which the host
   * cannot recover from the argv it is about to replace.
   */
  platformModel?: { modelId: string } | null;
  /**
   * spec session-graph:起这条会话的一方**显式**给的名字。宿主据此给它在咕咕通讯录里的显示名
   * (spec agent-provisioning「命名即寻址名」);缺席 = 没人显式命名过,宿主回落到自增约定。
   * 与 ACP 那条注入器口径逐字相同 —— 两条 surface 共用同一个 provisioning 边界,事实不能只到一条。
   */
  agentDisplayName?: string;
  /**
   * 用户在 `/mcp` 里为这条会话**关掉**的那几台 MCP server(spec `mcp-session-toggle`)。
   *
   * ⚠️ 它必须走这条 PTY 契约,**不能只走 ACP 那条** —— 产品上 codex 的任务会话正是经
   * 这个 divert 起 `codex app-server` 的。只接 ACP 那一条时,codex 那格的开关静默失效:
   * 界面说关了、工具表纹丝不动,而四门与单测全绿。
   * ⚠️ `[]` 与缺席不同:`[]` = 决定过、一台没关;缺席 = 从没碰过。❌ 任何一层都不许归一。
   */
  mcpDisabledServers?: readonly string[];
  /**
   * #6264 这条会话的 TUI 所在的 tmux 会话名 —— 只在 TUI 跑在 tmux 里(posix)时给。推理不在 TUI 里跑的那几家
   * (codex app-server、opencode serve、droid daemon)据此把后台也放进 tmux,与 TUI 同生、活过宿主进程重启。
   */
  tmuxSessionName?: string;
}

/** Command override to replace the pty argv; null = don't divert (spawn unchanged). May throw (fail-loud). */
export interface EmdashPtyCommandOverride {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /**
   * 这条会话**可以开始收消息**的那一刻(宿主给的事实,❌ 不是延时)。缺席 = 没有额外的门,照旧按 PTY
   * 输出活动判启动期。用于首句走 local-session 的家(`providerStartupTurnViaLocalSession`):门开之前
   * 写进 pty 的一切都先等着,见 `setPtyStartupGate`。
   */
  startupGate?: Promise<void>;
}

export type EmdashPtySessionpageHook = (
  info: EmdashPtySessionpageStartInfo
) => Promise<EmdashPtyCommandOverride | null>;

let hook: EmdashPtySessionpageHook | null = null;

export function setEmdashPtySessionpageHook(fn: EmdashPtySessionpageHook | null): void {
  hook = fn;
}

export function getEmdashPtySessionpageHook(): EmdashPtySessionpageHook | null {
  return hook;
}

/**
 * 对话页首轮的**信封解析口** —— PTY 腿上 `emdash-mcp-injector` 的孪生(#4653)。
 *
 * 对话页「新建 Agent」的第一句话是**一条真的咕咕消息**,不是「会话的启动参数」。所以在 pty 起来
 * 之前,宿主必须先做完这四件事,顺序不可换:
 *   1. 把这个会话的 gugu 身份与 owner↔agent 私聊开好(私聊是这条消息的容器);
 *   2. 按 exact `messageId` 把它**落进云端那条 DM**(幂等写)—— 聊天页那个正常气泡就是它;
 *   3. 给 agent 标记已读,免得收件箱把同一条再投递一遍(那会变成两轮);
 *   4. 返回同一份 route=chat 投递信封,由 provider 自己的 argv/stdin 启动槽送进模型。
 *
 * ⇒ 三件事一次成立:模型收到了、聊天页有气泡、回复落回那条 DM。
 *
 * ❌ 这里**不是**「等 TUI 起来再把字打进 pty」:那是 #4494 的根子、#4500 §三 维度 2 的档 4,
 *    owner 连说两遍拒绝,spec session-injection 也写死「禁止写 pty」。
 * ⚠️ 装了钩子的宿主必须 fail loud:解析不出信封就抛,❌ 不许悄悄退回裸文本 —— 退回去的那一轮
 *    会以「不是消息」的身份进模型,而用户在聊天页看到的仍是一条消息,两边就此分叉。
 */
export interface EmdashPtyChatStartupRequest {
  sessionId: string;
  providerId: string;
  projectId: string;
  workspaceId: string;
  cwd: string;
  /** spec agent-provisioning:显式命名过就用那个名字开户(与 pty hook 同一口径)。 */
  agentDisplayName?: string;
  /** 这条消息在云端的 exact id —— 渲染进程铸的那一个,落库与已读标记都用它。 */
  messageId: string;
  /** 用户真打的那句话(未裹信封)。 */
  text: string;
  /** gugu-dev#181:派这件任务的那个对话 —— 首句落成那里的一张任务卡,而不是 agent 私聊里的一条消息。 */
  taskChatId?: string;
}

/** Returns the route=chat envelope to hand the provider's startup slot. May throw (fail-loud). */
export type EmdashPtyChatStartupEnvelope = (
  request: EmdashPtyChatStartupRequest
) => Promise<string>;

let chatStartupEnvelope: EmdashPtyChatStartupEnvelope | null = null;

export function setEmdashPtyChatStartupEnvelope(
  fn: EmdashPtyChatStartupEnvelope | null
): void {
  chatStartupEnvelope = fn;
}

export function getEmdashPtyChatStartupEnvelope(): EmdashPtyChatStartupEnvelope | null {
  return chatStartupEnvelope;
}

/** Teardown notifier — completion means the host proved the tracked app-server process tree terminal. */
export type EmdashPtySessionpageTeardown = (sessionId: string) => Promise<void>;

let teardown: EmdashPtySessionpageTeardown | null = null;

export function setEmdashPtySessionpageTeardown(fn: EmdashPtySessionpageTeardown | null): void {
  teardown = fn;
}

export function notifyGuguPtySessionpageEnded(sessionId: string): Promise<void> {
  return teardown?.(sessionId) ?? Promise.resolve();
}
