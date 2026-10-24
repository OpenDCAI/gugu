// @@@sessionpage TASKPAGE-FUSION — a module-boundary HOOK the gugu host registers so a session-page codex
// session gets a gugu-provided MCP server (the gugu MCP send tool + that agent's gugu identity) injected
// at session/new. The session backend owns the hook POINT; the gugu host owns what it returns (built with gugu's own
// Supabase token / server path — none of which the session backend imports). Default = no hook installed → sessions
// start with no injected MCP (unchanged behavior). Invoked at the main-process ACP start interceptor
// (runtime-process/host.ts withSessionIdPersistence) so the built servers ride the start input to the
// worker's buildNewSessionRequest.
import type { McpServer } from '@agentclientprotocol/sdk';
import type { GuguPermissionMode } from '@gugu/session-core/acp';
import type { SessionPlatformModel } from '@main/core/sessions/platform-model-selection';
import type { SessionExtensionDelivery } from '@shared/core/sessions/sessions';

/** The slice of the ACP start input the injector needs to decide what (if anything) to inject. */
export interface EmdashSessionStartInfo {
  /** Runtime key. For a side-chat fork this is the non-persistent view id. */
  sessionId: string;
  /** Persisted conversation that owns identity/model authority for a runtime-only view. */
  sourceSessionId?: string;
  projectId: string;
  workspaceId: string;
  providerId: string;
  cwd: string;
  lifecycle: 'fresh' | 'fork' | 'resume';
  /**
   * @@@2503 composer 在建这条会话时选的模型来源(平台模型 / harness 自家模型 / 从没决策过)。
   *
   * 由会话页后端这一侧从自己的 kv 读出来递过去 —— 咕咕宿主够不着这张表(两边分开打包)。三态原样传递,
   * 怎么解释归宿主:它才知道这个引擎的这个界面能不能注入。
   */
  platformModel?: SessionPlatformModel;
  /**
   * spec session-graph:起这条会话的一方**显式**给的名字。宿主据此给它在咕咕通讯录里的显示名
   * (spec agent-provisioning「命名即寻址名」);缺席 = 没人显式命名过,宿主回落到自增约定。
   *
   * 与 `platformModel` 同一条理由走这里:它是创建时记下的一条持久事实,而宿主够不着会话页后端这张表。
   * ❌ 宿主不能改读 `title` 自己判断 —— 到那一层「显式给的」与「从首轮推出来的」已经同形了。
   */
  agentDisplayName?: string;
  /**
   * composer 为这条会话选的**起始**推理档(缺席 = 没选)。
   *
   * ⚠️ 与 `platformModel` / `agentDisplayName` 不同,它**不是**「会话上记着的持久事实」,
   * 不走 `readSessionInjectionFacts` —— 它和 `permissionMode` 同类,是本次启动**当场**
   * 的选择。混进 facts 会让它跟着会话被缓存:用户改了档,却还按开会话时那一档跑。
   *
   * 宿主按各家方言把它落成 spawn 参数(kimi:`KIMI_MODEL_THINKING_EFFORT`)。
   * ⚠️ 这条边界是会话页后端的桥,**没有编译期保护**(那个模块句柄是 any) ——
   * 字段名写错不会报错,❌ 只改一端。
   */
  reasoningEffort?: string | null;
  /**
   * 这条会话**已解析**的咕咕权限档（四档，从严到松 plan < read-only < edit < full-access）。
   *
   * 为什么要递给宿主：档位有两条落地路，宿主只管得着其中一条。
   *  · **ACP 自报档位** —— agent 在 `session/new` 里报 `availableModes`，运行时 `session/set_mode`
   *    选中。全 36 家里只有 codex / claude / opencode 三家有映射表，且 opencode 这张表**没有
   *    full-access 那一格**（它的完全访问根本不是一个 mode，是 permission 规则）。
   *  · **会话包 `units.autonomy`** —— 由这里递过去，在 spawn 时物化成各家自己的通道
   *    （opencode 系写 `permission` 块、qwen/copilot 走 argv）。上一条盖不住的格子由它兜。
   *
   * ❌ 别在这里回落成布尔：布尔装不下四档，`false` 既可能是只读也可能是可改工作区
   *    （@@@permission-three-modes 记了这个塌缩造成的真实事故）。
   */
  permissionMode?: GuguPermissionMode;
  /** Startup user-turn provenance; chat-page turns are wrapped as route=chat envelopes. */
  startupOrigin?: 'chat-page' | 'session-page';
  initialMessageId?: string;
  initialMessageText?: string;
  /** gugu-dev#181: the chat whose composer dispatched this task — its first turn lands there as a task card. */
  taskChatId?: string;
  /** Provider session recorded on the conversation row; `null` = never started (first spawn / restart). */
  providerSessionId?: string | null;
  /**
   * 用户在 `/mcp` 里为这条会话**关掉**的那几台 MCP server(spec `mcp-session-toggle`)。
   *
   * 与 `platformModel` / `agentDisplayName` 同类:会话上记着的持久事实,由
   * `readSessionInjectionFacts` **一次读出**递过来。
   * ⚠️ `[]` 与缺席不同:`[]` = 决定过、一台没关;缺席 = 从没碰过。❌ 任何一层都不许归一。
   */
  mcpDisabledServers?: readonly string[];
}

/** Returns the MCP servers to inject for this session (empty = inject nothing). May throw (fail-loud). */
export type EmdashSessionCapabilityInjection = {
  /** Trusted assistant-only native maintenance; never accepted from a renderer start payload. */
  assistantContextMaintenance?: { memoryDir: string };
  mcpServers: McpServer[];
  /**
   * #6387 What installed extensions put into this session (programs and skills, each with its
   * extension). Recorded on the conversation once the start succeeds, for the `/mcp` panel.
   */
  extensionDelivery?: SessionExtensionDelivery;
  /** Trusted provider-process environment emitted by the selected adapter. */
  spawnEnv?: Record<string, string>;
  /** Trusted provider-process arguments emitted by the selected adapter. */
  spawnArgs?: string[];
  /** Trusted provider-native session metadata emitted by the selected adapter. */
  sessionMeta?: Record<string, unknown>;
  /** 会话级系统提示词及其载体。见 {@link SessionPromptDelivery}。 */
  sessionPrompt?: SessionPromptDelivery;
  /** Optional replacement for the renderer's bare startup queue after trusted envelope construction. */
  initialQueue?: Array<{ text: string; hiddenContext?: string }>;
  /** The provider adapter already included the selected platform model in its process config. */
  platformConfigured?: boolean;
  /** The platform model the adapter's process config pins (canonical id); present iff `platformConfigured`. */
  platformModel?: string;
  /** Non-secret platform access generation paired with this adapter instance. */
  platformAccessSessionId?: string;
};

/**
 * 会话级系统提示词的**一次**投递 —— 载荷与载体捆在一起。
 *
 * ⚠️ `carrier` **必填**,不是为了严谨,是为了堵一个静默失效的形状:
 *    如果它是可选的位置参数/可选字段,任何一处接线漏传都会**默认回落到系统位**,
 *    于是没有系统位的那家(它正是需要 `'session-context'` 的那家)一个字都收不到,
 *    而且从头到尾没有任何一处报错。捆成一个对象、carrier 必填 ⇒ 编译器强制每个产出方
 *    把「走哪根管子」说出口。
 *
 * ⚠️ 也**不许**拆成两个并排字段:同一段字节只去一个地方。两个字段会长出
 *    「两边都发了」和「两边都没发」两种没人报错的状态。
 *
 * 语义见 behavior `agent-context-injection` 的 ② 与 ③。
 */
export type SessionPromptDelivery = {
  value: string;
  carrier: 'system' | 'session-context';
};

export type EmdashMcpInjector = (
  info: EmdashSessionStartInfo
) => Promise<EmdashSessionCapabilityInjection>;

let injector: EmdashMcpInjector | null = null;

export function setEmdashMcpInjector(fn: EmdashMcpInjector | null): void {
  injector = fn;
}

export function getEmdashMcpInjector(): EmdashMcpInjector | null {
  return injector;
}
