import type { AgentProviderId } from '@gugu/session-plugins/agents';
import type { ProviderSessionState } from '@gugu/session-core/acp/client';
import type { GuguPermissionMode, PromptInput } from '@gugu/session-core/acp';
import type { UnreachedMachine } from '@gugu/session-core/session-record/contract';
import type { AgentStatus, AgentStatusDetail } from '@shared/core/agents/agentEvents';
import type { LinkedIssue } from '@shared/core/linked-issue';
import type { SessionContextUsage, SessionLibraryMcpFact } from '@shared/core/sessions/session-config';

export const MAX_SESSION_TITLE_LENGTH = 100;

/**
 * **这条会话跑成什么** —— 起哪种进程、走哪条通道的运行时事实。
 *
 * - `'pty'` harness 自己的原生 TUI 跑在伪终端里。
 * - `'acp'` 走 Agent Client Protocol 的结构化会话。
 *
 * ⚠️ **它不是用户选的那个东西** —— 用户选的是 `SessionView`(见下)。今天两者一一对应,
 * 但那是**当下的事实**不是定义:声明了通用视角却没接通的 harness 就是活的反例。
 * ❌ 别再叫它 `SessionRuntime`:`type` 没说清在给哪个维度分类,读的人会以为它就是 composer
 * 里那个选择(#4915)。落库的列叫 `sessions.runtime`,同一个词。
 *
 * 值保持 `pty` / `acp`:在这一层它们是**准确**的(一个真的是伪终端,一个真的是那个协议),
 * 换掉只会让存量数据要重写,换不来任何清晰度。
 */
/** 宿主上一次退出的原因(见 electron/lib/exit-reason.ts):更新 / 重启 / 没正常退出。 */
export type InterruptedBy = 'update' | 'restart' | 'unclean';

export type SessionRuntime = 'pty' | 'acp';

/**
 * **用户选的是哪一种展示**(owner 2026-09-03:「本质上这就是两种不同的展示:一个是编程视角的展示,
 * 一个是通用视角的展示」)。
 *
 * - `'code'` 编程视角:harness 自己的原生 TUI 跑在终端里,你看着它干活。
 * - `'general'` 通用视角:咕咕渲染的结构化聊天面板,你跟它对话。
 *
 * ⚠️ **这是产品层的身份,❌ 不要再用 `pty` / `acp` 去指代它** —— 那两个是运行时事实(起哪种进程、
 * 走哪条腿),拿传输机制当身份会让读代码的人以为这只是「两根管子」。渲染层、composer 状态、
 * 持久偏好、控件、e2e 助手一律说 `SessionView`;只有跨到运行时/落库那一刻才翻译一次(见下)。
 */
export type SessionView = 'code' | 'general';

export const SESSION_VIEWS: readonly SessionView[] = ['code', 'general'];

export function isSessionView(value: unknown): value is SessionView {
  return value === 'code' || value === 'general';
}

/**
 * 展示 ⇄ 运行时。今天一一对应:编程视角跑 pty,通用视角跑 acp ——
 * 一一对应是**当下的事实**,不是定义,所以两个词各留各的位置,翻译只发生在这里。
 */
export function sessionRuntimeOfView(view: SessionView): SessionRuntime {
  return view === 'general' ? 'acp' : 'pty';
}

export function sessionViewOfRuntime(runtime: SessionRuntime): SessionView {
  return runtime === 'acp' ? 'general' : 'code';
}

/**
 * 展示 ⇄ 会话页那条腿。`tui` / `acp` 是 harness 能力声明里那条腿的名字(插件契约,
 * 跨包共用,128 个文件在声明它 ⇒ 值不动)。只在这里互译,❌ 别在调用点再写一遍
 * `x ? 'acp' : 'tui'` —— 那样的三元曾散在五处。
 *
 * 叫「腿」不叫 surface:这个仓的注释一直说「两条腿」。
 */
export type SessionpageLeg = 'tui' | 'acp';

export function sessionpageLegOfView(view: SessionView): SessionpageLeg {
  return view === 'general' ? 'acp' : 'tui';
}

export function sessionViewOfLeg(leg: SessionpageLeg): SessionView {
  return leg === 'acp' ? 'general' : 'code';
}

/** spec session-fork-share: lineage marker — this conversation was forked from another one. */
/** The parent session; its name is the parent's own (read live), never copied here. */
export type SessionForkedFrom = {
  sessionId: string;
};

export type InitialQueuePrompt = {
  text: string;
  hiddenContext?: string;
  origin: NonNullable<PromptInput['origin']>;
};

/**
 * 一条会话是怎么来的 —— **动词**,不是开关(spec session-resume)。
 *
 * 三个动词各自回答同一个问题:重开这条会话时,引擎侧会有东西吗?
 * - `create` 新建:必须带着第一句话。首轮跑完 ⇒ 引擎侧有;没跑完 ⇒ 照这句话重来。
 *   ❌ 没有「这次创建带不带活」的开关 —— 不带首轮的会话根本不该被造出来。
 * - `fork` 分叉:上下文是源会话的,自己不需要第一句话。
 * - `import` 导入:历史本来就在引擎侧,咕咕只是把它认领进来。
 * - `resident` 常驻:云端 `agent.create` 不带首句建出来、等主人第一条消息的 agent(#7199)。没人在等它回答,
 *   它的首轮就是那条消息 —— ❌ 拿占位句冒充首轮(那会让它一出生就「在干活」,云电脑因此永远不闲)。
 *
 * 豁免必须是另一个动词,而不是给 `create` 加一个豁免参数 —— 参数能被下一个调用方随手填,
 * 动词不能。
 */
export type SessionOrigin =
  | {
      kind: 'create';
      /**
       * 这条会话的第一轮内容。空白 = 参数错误,当场抛。
       * 「内容」不等于「文字」:**纯图片也是首轮** —— 今天拖进 composer 的文件(含图片)
       * 就是以转义路径文本进入这个字段的。将来附件若独立成通道,这里要一并承载,
       * ❌ 不能退化成只认打出来的字。
       */
      firstUtterance: string;
    }
  | {
      kind: 'fork';
      forkedFrom: SessionForkedFrom;
    }
  | {
      kind: 'import';
      /** provider 自己的会话 id:第一次启动就 resume 它,而不是开新的。 */
      providerSessionId: string;
    }
  | {
      kind: 'resident';
    };

export type SessionMessage = {
  id: string;
  text: string;
  kind?: 'ordinary' | 'session-direct';
  state?: 'pending' | 'dispatching';
  /** Host-only: this exact message is already claimed by the deferred queue. */
  deferredDispatch?: true;
};

/**
 * How a session-direct message meets a busy ACP session, when the sender asks (an App's `dispatch` to an agent
 * `{ queue: true }`; an agent's `session_message` only ever steers). Absent = the default: into the current turn where the harness can take it. `queue` = after
 * this turn, as the next one (at once when idle); `coalesceKey` = a queued message of the same key is replaced, not
 * added to. Only the ACP adapter reads it — a terminal session is refused before anything is sent.
 */
export type SessionMessageDelivery = { queue: true; coalesceKey?: string; origin?: 'manual'; attachments?: import('@gugu/session-core/acp/client').PromptAttachment[] };

export type PendingRestart = {
  status: 'restart_failed';
  dimension: 'model' | 'permission' | 'effort' | 'mcp';
  targetModel?: string;
  targetModelSource?: 'platform' | 'own';
  error: string;
};

export type Session = {
  id: string;
  projectId: string;
  /** 这条会话在哪个工作区里干活;多条会话可以共享一个。还没挂过工作区的老行没有。 */
  workspaceId?: string;
  /** 新建会话时挑的 issue。 */
  linkedIssue?: LinkedIssue;
  /** 有值 = 这条会话是这次自动化运行建出来的(非交互)。 */
  automationRunId?: string;
  providerId: AgentProviderId;
  title: string;
  /** 建出这条会话的时刻(侧栏「按创建时间」排序用)。乐观期的那一份还没有。 */
  createdAt?: string;
  lastInteractedAt: string | null;
  resume?: boolean;
  /** 咕咕的权限档;缺席(导入的会话)按编辑档(`resolveSessionPermissionMode`)。 */
  permissionMode?: GuguPermissionMode;
  /**
   * The agent-facing session identifier. Null / absent means the conversation has never spawned.
   * For providers that accept a supplied id (most PTY), this is set to conversation.id before
   * first spawn and may later be overwritten by the agent's own native id (e.g. Droid UUID).
   * For ACP, set to the id returned by newSession/loadSession.
   * Resume with this id when sessionId !== conversation.id; treat as fresh otherwise.
   */
  providerSessionId?: string;
  /** Durable disposition of the provider-native session reference above. */
  providerSessionState?: ProviderSessionState;
  pendingRestart?: PendingRestart;
  /** Model to pass to the agent CLI. Absent or empty string means use the CLI default. */
  model?: string;
  /**
   * spec `mcp-session-toggle`:用户为这条会话关掉的那几台 MCP server(harness 的配置键)。
   * ⚠️ `[]` 与缺席**不同**:`[]` = 决定过、一台没关;缺席 = 从没碰过。
   */
  mcpDisabledServers?: string[];
  /** 这条会话被用户显式决定过 MCP 开关 ⇒ 独占适配器进程,且不再回退。 */
  mcpToggleDecided?: boolean;
  /**
   * 这条会话**起进程那一刻被带上**的那几台(事实),与上面那个关闭集合(意图)成对。
   * 缺席 = 老会话,面板退回只用意图算,下一次重开自愈。
   */
  mcpSessionServers?: string[];
  /** #6387 起进程那一刻由扩展交付进来的 MCP 程序与技能(事实);缺席 = 老会话。 */
  mcpSessionExtensions?: SessionExtensionDelivery;
  /** 资源库 → MCP:新建时带上的那几台(名字);两条腿都有。缺席 = 一台都没带。 */
  libraryMcp?: string[];
  /** 资源库那几台这一次起进程时的送达事实(见 session-config 的 `mcpSessionLibrary`)。 */
  mcpSessionLibrary?: SessionLibraryMcpFact;
  /** Reasoning-effort level for that model. Absent means the CLI's own default for it. */
  effort?: string;
  /** #7342 引擎最后一次报的上下文读数,进程停了也留着(通用模式才有)。缺席 = 还没报过。 */
  contextUsage?: SessionContextUsage;
  /** Initial queued prompts to deliver on first ACP spawn. Only present before sessionId is set. */
  initialQueue?: InitialQueuePrompt[];
  /** Stable id for the first startup-delivered user message. */
  initialMessageId?: string;
  /** gugu-dev#181: the chat whose composer dispatched this task — its first turn lands there as a task card. */
  taskChatId?: string;
  /** Ordinary messages waiting for the declared sessionpage transport to accept them. */
  messageOutbox?: SessionMessage[];
  agentStatus?: AgentStatus | null;
  /** spec agent-status「附属态」:只给显示;null / 缺席 = 退回基础态的画法。 */
  agentStatusDetail?: AgentStatusDetail | null;
  agentStatusSeen?: boolean;
  /**
   * 上一轮被宿主的退出打断了(开机收残记下的,下一轮开工清掉):宿主更新 / 重启 / 上一次没正常退出。
   * 只在 `agentStatus` 还是 `error` 时有意义;缺席 = 没有这回事(或老宿主)。
   */
  interruptedBy?: InterruptedBy;
  /** 这条会话跑成什么(`SessionRuntime`)。缺席按 `'pty'` 读 —— 见该类型的说明。 */
  runtime?: SessionRuntime;
  /** spec session-page: pinned conversations gather in the sidebar Pinned section. */
  isPinned?: boolean;
  /** Parent conversation for a locally spawned child session; null/absent means a root session. */
  parentSessionId?: string | null;
  /** Conversation that created this session through the session-management MCP. */
  spawnedBySessionId?: string | null;
  /**
   * 起这条会话的一方**显式**给的名字(spec session-graph 的 `spawn.title`)。它同时是这个 agent
   * 在咕咕通讯录里的显示名(spec agent-provisioning「命名即寻址名」)。缺席 = 没人显式命名过,
   * 显示名回落到「<引擎 label> <序号>」。❌ 不是 `title` 的别名:`title` 会从首轮推出来,它不会。
   */
  agentDisplayName?: string;
  /**
   * The extension that started this one, if an extension did.
   *
   * Survives that extension's uninstall on purpose: the person needs to be able
   * to answer「这条是谁起的」about an agent still running and still spending, and
   * 「已卸载的那个扩展」is a better answer than silence (behavior tab-extensions).
   */
  spawnedByExtensionId?: string | null;
  /**
   * spec session-graph:归档的归属键是这条会话自己。null = 在会话列表里,时间戳 = 已归档。
   * 用户看见的入口写的是「归档任务」(他心智里一个 tab 就是一项任务),动的是这一行。
   */
  archivedAt?: string | null;
  /** spec session-fork-share: set when this conversation is a fork of another one. */
  forkedFrom?: SessionForkedFrom;
  /**
   * spec session-fork-share:ACP 分叉**还没认领首启**时,要分叉的来源 provider 会话 id。
   * 首启时它变成一次 `session/fork`,拿回的独立新 id 写进 `sessionId`,这个字段随之作废。
   * pty 分叉没有它 —— 那条在 spawn 时当场用掉,不落库。
   */
  forkFromProviderSessionId?: string;
  /** Native provider control endpoint recorded by a host-owned session-TUI transport. */
  providerSessionEndpoint?: string;
  /**
   * spec session-runtime-switch:`sessionId` 里那个 id 是引擎自己铸的(而不是咕咕在 spawn 时
   * 用 `--session-id` 交给它的)。今天唯一的来源是「通用模式换到编程模式」那一次搬迁。
   * 续跑时据此决定用哪个 id —— 见 `resolveAgentSessionCommandArgs`。
   */
  providerMintedSessionId?: boolean;
  /**
   * spec session-resume:咕咕记着的那句首轮。引擎侧没有这条会话时,它决定了还有没有出路 ——
   * 有它就能照它重来,没有它(存量空壳)就只剩删掉。界面靠它决定摆哪个动作,
   * ❌ 不摆一个点下去才发现不行的按钮。
   */
  firstUtterance?: string;
  /** Product surface that originated the first startup intent. */
  startupOrigin?: 'chat-page' | 'session-page';
};

/** 一次归档动作收走了哪些行(点名的那一条 + 勾了范围时连带的 spawn 子树),撤销时按这份清单原样放回。 */
export type ArchivedSessionRef = {
  projectId: string;
  sessionId: string;
};

/**
 * 归档的回执。勾了「连同子会话」时子树可以跨机器(owner 2026-10-01「一起收」):`archived` 含别的机器上
 * 收走的行(撤销按行所在的项目走回那台机器),`unreached` 是这次够不着的机器 —— 它们上面的 child 原样留着,要说出来。
 */
export type ArchiveOutcome = { archived: ArchivedSessionRef[]; unreached: UnreachedMachine[] };

/**
 * 改父会话被拒、因为挂上去会成环时,主进程报错原话的开头(agent 的 `session_set_parent` 读到的就是这句)。
 * 侧栏凭它把「成环」与「够不着」分开说:成环可能隔着侧栏看不见的已归档会话,侧栏自己挡不全。
 */
export const SESSION_PARENT_CYCLE = 'that makes a cycle';

export type RenameSessionParams = {
  sessionId: string;
  newTitle: string;
};

/**
 * ❌ 这里**不再有** CreateConversationParams。
 * 「往已有任务里再放一个 agent」的载荷类型跟着它的函数一起留在主进程内部
 * (`@main/core/sessions/attach-agent-to-session` 的 AttachAgentToSessionParams)——
 * 它不在 RPC 面上,渲染端够不着,自然也不需要一份共享类型(spec session-resume)。
 */

/**
 * #6387 What installed extensions put into one session when it started: each MCP program by the
 * name the harness knows it under, each skill by its own name, both with the extension it came from.
 */
export interface SessionExtensionDelivery {
  servers: { name: string; extensionId: string }[];
  skills: { name: string; extensionId: string }[];
}
