import { isDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import { pluginRegistry, type AgentProviderId } from '@gugu/session-plugins/agents';
import type { GuguPermissionMode } from '@gugu/session-core/acp';
import type { sessions } from '@main/db/schema';
import { taskAgentName } from '@gugu/core/shared/taskAgentName';
import type { LinkedIssue } from '@shared/core/linked-issue';
import type {
  SessionConfig,
  SessionTitleSource,
} from '@shared/core/sessions/session-config';
import type {
  SessionOrigin,
  SessionRuntime,
  InitialQueuePrompt,
} from '@shared/core/sessions/sessions';
import {
  firstUtteranceOf,
  initialAgentStatus,
  initialAgentStatusDetail,
  type SessionCreationFacts,
} from '@shared/core/sessions/initial-agent-status';

type SessionInsert = typeof sessions.$inferInsert;

/** Chat-create persists the user's raw text; delivery XML is transient startup input only. */
export function assertNoDeliveryEnvelopeInPersistedText(value: string | undefined, field: string): void {
  if (value !== undefined && isDeliveryEnvelope(value)) {
    throw new Error(`chat-create ${field} must not persist a delivery envelope`);
  }
}

export type BuildSessionRowInput = {
  id: string;
  projectId: string;
  /** 这条会话在哪个工作区里干活。 */
  workspaceId: string;
  linkedIssue?: LinkedIssue;
  automationRunId?: string;
  title: string;
  provider: AgentProviderId;
  runtime: SessionRuntime;
  /**
   * 这条会话是怎么来的。**分叉与导入必须显式说**;新建可以不写 —— 见下面 firstUtterance 的口径。
   */
  origin?: SessionOrigin;
  /** Durable session permission mode. */
  permissionMode?: GuguPermissionMode;
  model?: string;
  effort?: string;
  /** 资源库 → MCP:新建时带上的那几台(名字)。 */
  libraryMcp?: readonly string[];
  /**
   * 首轮的**投递载荷**(pty 走 initialPrompt,acp 走 initialQueue)。它带着第一句话时,
   * 那就是这一轮的内容;它是空的(首轮改走普通消息投递)时,首轮由 `origin.firstUtterance` 说出来。
   * 两者都空 = 参数错误(见下面的闸)。
   */
  initialPrompt?: string;
  initialQueue?: InitialQueuePrompt[];
  startupOrigin?: 'chat-page' | 'session-page';
  initialMessageId?: string;
  taskChatId?: string;
  /**
   * 起这条会话的一方**显式**给的名字。它同时是这个 agent 在咕咕通讯录里的显示名
   * (spec agent-provisioning「命名即寻址名」)——所以只在真有人说出口时才带,
   * ❌ 不许用 `title` 顶替:标题的两种来源(显式 / 从首轮推出来)在这一层已经同形了。
   */
  agentDisplayName?: string;
  /**
   * 标题的来历(见 `sessionTitleSourceSchema`)。只在调用方**知道**这个标题是显式命名时带 `manual`;
   * 缺席 = 首轮兜底,harness 自己起的名可以盖掉它。
   */
  titleSource?: SessionTitleSource;
  parentSessionId?: string | null;
  /** 父会话在别的机器上(config `parentRemote`);与 parentConversationId 一起由 `storedParent` 给出。 */
  parentRemote?: { deviceId: string; sessionId: string };
  spawnedBySessionId?: string | null;
  /**
   * 起这条会话的扩展 id（#2374 `agents:control`）。发起者**不是一条会话**,所以它与上面
   * 那个字段并列而不是复用 —— 借一条别的会话 id 去满足类型,就等于往会话图里写了个假发起者,
   * 而这个字段存在的全部意义就是防这件事。两个都空 = 人起的。
   */
  spawnedByExtensionId?: string | null;
  /** 由另一台机器上的会话派出来的(config `spawnedByRemote`);本机的两个外键装不下它。 */
  spawnedByRemote?: { deviceId: string; sessionId: string; agentUserId?: string; name?: string };
  /**
   * 这一行落库时是否**已经认领了首次启动**。
   * 落库后立刻自己 spawn 的路径(attachAgentToSession)认领 = 写下 session_id;
   * 把首启交给 hydrateSession 的路径(createSession)留 null —— `sessionId === null`
   * 正是 hydrate 判定「首次启动」的那把尺子,两条路的取值不同不是漂移。
   */
  claimsFirstSpawn: boolean;
  /**
   * spec session-fork-share:要分叉的来源 provider 会话 id。
   * pty 那条在 spawn 时当场用掉(`--resume <src> --fork-session`),不落库;
   * ACP 那条**必须落库** —— 它的首启是懒的(hydrateSession),创建这一刻还没有连接可用。
   */
  forkFromProviderSessionId?: string;
};

function providerSessionIdAtBirth(input: BuildSessionRowInput): string | null {
  if (input.origin?.kind === 'import') return input.origin.providerSessionId;
  if (input.runtime === 'acp') return null;
  return input.claimsFirstSpawn ? input.id : null;
}

/**
 * 会话行只在这里构造 —— 两条创建路径(任务的第一个会话 / 往已有任务里再放一个 agent)
 * 曾经各抄一份,于是 config、出生状态、session_id 三处各自漂移。
 *
 * 闸也在这里:新建不带首轮 **当场抛**。它是第二道 —— 第一道是「够不着」(这个函数不在
 * RPC 面上,attachAgentToSession 已从 sessionController 摘掉)。够不着的东西不必拦,
 * 但内部调用方还是会写错,所以留一道会响的闸。
 */
export function buildSessionRow(input: BuildSessionRowInput): SessionInsert {
  const initialPrompt = input.initialPrompt?.trim();
  const initialQueue = input.initialQueue?.filter((prompt) => prompt.text.trim());
  const resident = input.origin?.kind === 'resident';
  const explicitName = input.agentDisplayName?.trim() || (!resident && input.titleSource === 'manual' ? input.title.trim() : undefined);
  const agentDisplayName = explicitName ? (resident ? explicitName : taskAgentName(explicitName)) : undefined;

  // 一条规则,两种写法。**创建必须有第一轮内容**:
  // - 载荷里带着它(initialPrompt / initialQueue)⇒ 那就是这一轮的内容,不必再声明一遍
  //   —— 让调用方把同一句话写两遍,只会等来两份不一致。
  // - 载荷是空的(首轮走普通消息投递,见 #3713)⇒ 必须显式 `origin.firstUtterance` 说出来。
  // - 两者都没有 ⇒ **参数错误,当场抛**。这就是那个洞:不带首轮的会话在引擎侧什么都不是,
  //   重开时既恢复不了也重来不了(spec session-resume)。
  //
  // ❌ 反方向不成立、也没在用:「载荷空 ⇒ 没有首轮」是错的 —— 那正是 #3684 那次把正在跑的
  // 会话画成 idle 的成因。这里只用「载荷非空 ⇒ 一定有首轮」这一个方向。
  const facts = { origin: input.origin, initialPrompt, initialQueue };
  const isCreate = (input.origin?.kind ?? 'create') === 'create';
  const firstUtterance = firstUtteranceOf(facts);

  if (isCreate && !firstUtterance) {
    throw new Error(
      `[session-resume] 新建会话必须带首轮:session ${input.id} 既没有 firstUtterance,` +
        `载荷里也没有第一句话。分叉用 forkSession、导入用 import、等第一条消息的常驻 agent 用 resident —— ` +
        `豁免是另一个动词,不是空首轮。`
    );
  }

  const config: SessionConfig =
    input.runtime === 'acp'
      ? {
          version: '1',
          type: 'acp',
          ...(input.permissionMode !== undefined && { permissionMode: input.permissionMode }),
          ...(input.model && { model: input.model }),
          ...(input.effort && { effort: input.effort }),
          ...(input.libraryMcp?.length && { libraryMcp: [...input.libraryMcp] }),
          ...(initialQueue?.length && { initialQueue }),
          ...(firstUtterance && { firstUtterance }),
          ...(input.startupOrigin && { startupOrigin: input.startupOrigin }),
          ...(input.initialMessageId && { initialMessageId: input.initialMessageId }),
          ...(input.taskChatId && { taskChatId: input.taskChatId }),
          ...(agentDisplayName && { agentDisplayName }),
          ...(isCreate && { identityNameManaged: true }),
          ...((input.titleSource || agentDisplayName) && { titleSource: input.titleSource ?? 'manual' }),
          ...(input.spawnedByRemote && { spawnedByRemote: input.spawnedByRemote }),
          ...(input.parentRemote && { parentRemote: input.parentRemote }),
          // spec session-fork-share:ACP 分叉把「分叉自谁」和「要分叉哪条 provider 会话」
          // 一起落进 config —— 后者是首启时走 `session/fork` 的输入,拿回独立新 id 才算分叉成功。
          ...(input.origin?.kind === 'fork' && {
            forkedFrom: input.origin.forkedFrom,
            ...(input.forkFromProviderSessionId && {
              forkFromProviderSessionId: input.forkFromProviderSessionId,
            }),
          }),
        }
      : {
          version: '1',
          type: 'pty',
          ...(input.permissionMode !== undefined && { permissionMode: input.permissionMode }),
          ...(input.model && { model: input.model }),
          ...(input.effort && { effort: input.effort }),
          ...(input.libraryMcp?.length && { libraryMcp: [...input.libraryMcp] }),
          ...(initialPrompt && { initialPrompt }),
          ...(firstUtterance && { firstUtterance }),
          ...(input.startupOrigin && { startupOrigin: input.startupOrigin }),
          ...(input.initialMessageId && { initialMessageId: input.initialMessageId }),
          ...(input.taskChatId && { taskChatId: input.taskChatId }),
          ...(agentDisplayName && { agentDisplayName }),
          ...(isCreate && { identityNameManaged: true }),
          ...((input.titleSource || agentDisplayName) && { titleSource: input.titleSource ?? 'manual' }),
          ...(input.spawnedByRemote && { spawnedByRemote: input.spawnedByRemote }),
          ...(input.parentRemote && { parentRemote: input.parentRemote }),
          ...(input.origin?.kind === 'fork' && { forkedFrom: input.origin.forkedFrom }),
        };

  return {
    id: input.id,
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    linkedIssue: input.linkedIssue ?? null,
    automationRunId: input.automationRunId ?? null,
    title: !resident && agentDisplayName ? agentDisplayName : input.title,
    provider: input.provider,
    config,
    providerSessionId: providerSessionIdAtBirth(input),
    runtime: input.runtime,
    ...birthStatusColumns(facts, input.runtime, input.provider),
    parentSessionId: input.parentSessionId ?? null,
    spawnedBySessionId: input.spawnedBySessionId ?? null,
    spawnedByExtensionId: input.spawnedByExtensionId ?? null,
    lastInteractedAt: new Date().toISOString(),
  };
}

/**
 * 出生状态的列值(spec agent-status-writer):与会话行同一笔事务落库,不比会话晚一拍;写入者随后从同一份读数开日志并发布。
 * 会话行只在 `buildSessionRow` 里构造(外部 fork 捕获也走它),所以这一条只在这里用。
 * 没有状态源的终端会话出生即 `null`(#6206)。
 */
function birthStatusColumns(
  facts: SessionCreationFacts,
  runtime: SessionRuntime,
  provider: AgentProviderId,
): Pick<SessionInsert, 'agentStatus' | 'agentStatusDetail' | 'agentStatusSeen'> {
  const status = initialAgentStatus(facts, { runtime, hooksKind: providerHooksKind(provider) });
  return { agentStatus: status, agentStatusDetail: initialAgentStatusDetail(status), agentStatusSeen: 1 };
}

/** 这一家 hooks descriptor 的 kind —— 状态源判据的输入(#6206)。未注册的 provider 建不出会话,❌ 当成有 hooks。 */
function providerHooksKind(provider: AgentProviderId): string {
  const plugin = pluginRegistry.get(provider);
  if (!plugin) throw new Error(`buildSessionRow: unknown agent provider '${provider}'`);
  return plugin.capabilities.hooks.kind;
}
