import { assistantWorkIntentSchema,type AssistantWorkIntent } from '@gugu/core/shared/assistantWorkIntent';
import { SessionArchivedError } from '@gugu/core/shared/sessionArchival';
import { assistantWorkLedgerContext } from '../../../../sessionpage/assistant-work-ledger';
import { withSessionAttachments, type SessionAttachmentRef } from '@gugu/core/cloud/sessionAttachments';
import { isActivityAction, runActivityAction, type ActivityAction } from '../activity/actions';
import { tabHygiene, type TabHygieneResult } from './tab-hygiene';
import { DEFAULT_SESSION_VIEW } from '@shared/core/sessions/new-session-defaults';
import type { SessionPaneTabsResult } from '@gugu/session-core/session-record/contract';
import { parseConversationLink } from '@gugu/core/shared/ui/guguLink';
import { readCurrentActivitySource } from './session-activity-source';
import { receiveAssistantWorkReport, workReportSchema, type WorkReport } from '../../../../sessionpage/assistant-work';
import { isProjectAgentAction, runProjectAgentAction, type ProjectAgentAction } from '../projects/project-agent-actions';
import { isLibraryAgentAction, runLibraryAgentAction, type LibraryAgentAction } from '../app/user-library';
import { randomUUID } from 'node:crypto';
import { sessionDirectMessageId } from './session-direct-identity';
import { parseGuguLink } from '@gugu/core/shared/ui/guguLink';
import type { SessionSummary } from '@gugu/session-core/acp';
import { and, eq, inArray } from 'drizzle-orm';
import type { MessagePreviewEntry, MessagePreviewProjection } from '@gugu/session-core/session-record/message-preview';
import { readSessionPreview } from '@main/core/session-timeline/preview-rpc';
import {
  parseAgentStatus,
  parseAgentStatusDetail,
  type AgentStatus,
  type AgentStatusDetail,
} from '@gugu/core/shared/agentStatus';
import { readAcpSessionSummaries } from '@main/core/acp/session-summary-reader';
import { resolveSession, resolveWorkspace } from '@main/core/projects/utils';
import { containsMachinePath, isAbsoluteMachinePath, joinMachinePath } from '@main/core/files/path-utils';
import {
  localAgentForSession,
  sessionpageProjectGroupForSession,
} from '@main/core/sessionpage/sessionpage-session-agent';
import { sessionService } from '@main/core/sessions/session-service';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import type { RemoteSessionCaller, AppSpawnAction } from '@gugu/session-core/session-record/contract';
import { appDeviceId } from '@shared/extensions/machine-call';
import { log } from '@main/lib/logger';
import { rememberBirthGroup } from '@main/core/sessions/birth-groups';
import type { BirthGroup } from '@shared/core/sessions/create-session';
import { rememberedProviderOf, resolveSessionProviderSelection, sessionpageLegFor } from '@shared/core/sessions/provider-selection';
import type { NewSessionMemory } from '@shared/core/app-settings';
import { sessionLife } from './session-life';
import { displayStatus } from '@shared/core/sessions/session-life';
import { admitCreationTurns, bindIdentityThenCreate } from './session-life-creation';
import { provisionStartIdentity } from '@main/core/acp/runtime-process/host';
import { unbindSessionAgent } from '@main/core/sessionpage/sessionpage-session-agent';
import { createStageLedger } from '@main/lib/stage-ledger';
import { events } from '@main/lib/events';
import {
  MAX_SESSION_TITLE_LENGTH,
  sessionpageLegOfView,
  type Session,
  type SessionRuntime,
} from '@shared/core/sessions/sessions';
import { normalizeBrowserUrl } from '@shared/browser';
import { fileUrlToMachinePath } from '@shared/preview/remote-page-url';
import { claimedSuffixes, declaredContexts, extensionTabKind, parseExtensionTabKind } from '@shared/extensions/manifest';
import { fileOpenersFor } from '@shared/extensions/file-openers';
import { agentStatusWriter } from '@main/core/agent-status/agent-status-writer';
import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context';
import { killTmuxSession, listTmuxSessionNames, makeTmuxSessionName } from '@main/core/pty/tmux-session-name';
import { makePtySessionId } from '@shared/core/pty/ptySessionId';
import { sessionsAliveInTmux } from '@main/core/sessions/session-process';
import {
  sessionManageTabsChannel,
  sessionManageTabsResultChannel,
  sessionOpenBrowserInPaneChannel,
  sessionCancelBrowserAcquireChannel,
  sessionOpenBrowserInPaneResultChannel,
  sessionOpenExtensionInPaneChannel,
  sessionOpenExtensionInPaneResultChannel,
  sessionOpenFileInPaneChannel,
  sessionOpenFileInPaneResultChannel,
} from '@shared/events/appEvents';
import { encodeTypedId } from '@gugu/core/shared/typedId.mjs';
import {
  buildSessionDirectEnvelope,
  SESSION_MESSAGE_REPLY_TO,
  SESSION_MESSAGE_THEN,
  type SessionMessageThen,
  formatDeliveryTimestamp,
} from '@gugu/core/local/agent/deliveryEnvelope';
import {
  resolveSessionpageSessionIntegration,
  sessionpageAcceptsInboundMessages,
  type AgentProviderId,
} from '@gugu/session-plugins/agents';
import { providerConsumesStartupPrompt } from '@gugu/session-core/agents/plugins';
import { resolveSessionDisplayName } from '@shared/core/sessions/session-display-name';
import type { SessionMessageDelivery } from '@shared/core/sessions/sessions';
import { flushDeferredMessages, sessionIsWorking, storeDeferredMessage } from './session-deferred-messages';
import { childHarnessDefault } from './child-harness-default';
import { platformModelIdFromOption, platformOptionId } from '@shared/platform-model-id';
import { extensionsService } from '../extensions/extensions-root';
import {
  assertLocalHarnessLaunchable,
  listLocalHarnesses,
  listLocalModels,
  listLocalPlatformModels,
  isHarnessModelChoice,
  type SessionTransport,
} from '../agents/session-discovery';
import { getPlugin, listPlugins, toAgentProviderId } from '../agents/plugin-registry';
import { resolveSessionParent, setSessionParent } from './session-family';
import { attachAgentToSession, type InternalSessionRelations } from './attach-agent-to-session';
import { archiveSession } from './archiveSession';
import { recordSessionOutput } from './session-outputs';
import { sessionPlatformModel } from './platform-model-selection';
import type { AgentScheduleAction } from '../automations/agent-schedules';
import { sessionModelFromDecision, type SessionModel } from './session-model-fact';
import {
  recordDeliveredSessionDirectMessage,
  readAcceptedMessage,
  sendMessage,
  SessionDirectDeliveryError,
} from './sendMessage';
import { refuseItself, sessionParentId, sessionSpawnerId, mapSessionRowToSession, storedParent } from './utils';
import {
  REMOTE_PANE_PAGE_NOT_FILE,
  describePageOutsideWorkspace,
  REMOTE_PANE_NO_EXTENSIONS,
  remotePaneQueuedNote,
  describeOutsideWorkspace,
  type RemotePaneRoute,
} from '../session-timeline/remote-pane';
import { UNATTENDED_SESSION_PERMISSION_MODE } from './unattended-session-autonomy';

/**
 * #4320 —— spawn/唤醒链路的分段账本。
 *
 * 这条链路此前一行阶段日志都没有：owner 实测一次 `session_spawn` 的 `tools/call` 走了 69.6s，而
 * `gugu-main.log` 里只有 `sessionpage/provision enqueued` 孤零零一行，它前后各是一段几十秒的空白。
 * **那段空白不是「什么都没发生」，是本层从不开口**（而且这半边默认只落 warn、落的是另一个文件，
 * 见 `stage-ledger.ts` 抬头）—— 归因因此只能靠猜。
 *
 * 预算的取法不是拍脑袋：spec session-graph 写死了 `spawn` **不得阻塞在引擎启动上**（本函数确实是
 * `void startSpawnedSession(...)`），所以工具动作本身只剩本机 DB 往返；跑过 3s 就已经与那条契约
 * 不符，值得当场留下分段。后台启动那段则用 #4181 报 still-running 的同一个 30s 节拍。
 */
const SPAWN_ACTION_BUDGET_MS = 3_000;
const SPAWN_STARTUP_BUDGET_MS = 30_000;

export type SessionCallerContext = {
  sessionId: string;
  projectId: string;
  workspaceId: string;
};

export type SessionAction =
  | { action: 'list_harnesses' }
  | { action: 'list_models'; harness?: string; transport?: SessionRuntime; force?: boolean }
  | {
      action: 'spawn';
      assistant_work?: AssistantWorkIntent;
      prompt: string;
      source_link?: string;
      title?: string;
      /** The `project` parameter, decoded at the host boundary: a project id, or a folder on this machine. */
      project_id?: string;
      project_path?: string;
      parent_session_id?: string | null;
      transport?: SessionRuntime;
      /** Canonical plugin id returned by session_list_harnesses. */
      harness?: string;
      /** A model id returned by session_list_models — `platform:<id>` for a Gugu model, otherwise harness-native. */
      model?: string;
      /** A group of the owner's the child is born in — joined once its identity is minted (birth-groups.ts). */
      chat_id?: string;
    }
  | { action: 'ask_user'; questions: Array<{ question: string; header?: string; options: Array<{ label: string; description?: string }>; multi_select?: boolean }>; source_link?: string }
  | { action: 'children'; session_id?: string }
  | {
      action: 'message';
      delivery_id?: string; delivery_at?: string; // Host-owned durable retry identity; not a model tool argument.
      attachments?: SessionAttachmentRef[];
      work_result?: WorkReport;
      /** Internal account-outbox receipt; one destination only. Never generated again during retry. */
      client_message_id?: string;
      client_message_at?: string;
      /** Bare conversation ids, already decoded from `session:` typed entries at the host boundary. */
      session_ids: string[];
      text: string;
      source_link?: string;
      /**
       * Absent: into the current turn where the harness can take it. `queue`: after this turn, as the next one.
       * `defer`: not now — sent the ordinary way the moment the target next starts working (at once if it already is).
       */
      delivery?: 'queue' | 'defer';
      /** With `queue` / `defer`: a still-waiting message of the same key from the same sender is replaced. */
      key?: string;
      /** The sender's own word on what it does after this message — shown on the envelope, never acted on. */
      then?: SessionMessageThen;
      /** `msg:<uuid>` of a delivery the sender is answering — shown on the envelope, not looked up. */
      reply_to_message_id?: string;
    }
  /** `app_tab` with a path (摩擦单 F122): open the file with that App — the tab must claim it. */
  | { action: 'open_in_tab'; path: string; app_tab?: string; intent: 'preview' | 'pinned' }
  | { action: 'open_in_tab'; url: string; intent: 'preview' | 'pinned' }
  | { action: 'open_in_tab'; app_tab: string; intent: 'preview' | 'pinned' }
  | { action: 'list_tabs' }
  | { action: 'close_tab'; tab_id: string }
  | { action: 'get'; session_id?: string }
  | { action: 'stop'; session_id: string }
  | { action: 'archive'; session_id: string; with_children?: boolean; remove_social_identity?: boolean }
  /** `parent_session_id` null = 不挂在谁下面(根会话)。两个 id 都已在宿主边界解成裸 id。 */
  | { action: 'set_parent'; session_id: string; parent_session_id: string | null }
  /** #7221 schedule_*:给自己排的「已安排」,只作用于发起调用的这条会话(agent-schedules.ts)。 */
  | AgentScheduleAction
  | ProjectAgentAction
  | LibraryAgentAction
  | ActivityAction;

// `SessionModel` 与它的取值规则搬去了 `./session-model-fact` —— 那一格的合同里有一条
// 「平台模型必须报出两个**不同**的字符串」,而它在 e2e 那侧的变异下跑不到(主断言先红)。
// 单独成模块只为让它可判据:那边不依赖 Electron,几毫秒就能把四种取值全判一遍。
export type { SessionModel } from './session-model-fact';

export type SessionSnapshot = {
  assistant_work_target?: {session_id:string;device_id:string};
  session_id: string;
  source_links?: readonly string[];
  spawned_by_session_id: string | null;
  /** 派它的会话在另一台机器上时,那台机器。 */
  spawned_by_device_id?: string;
  parent_session_id: string | null;
  /** 父级的远端祖先暂时够不着,与 session_set_parent 同一条回执。 */
  not_reached?: string[];
  project_id: string;
  title: string;
  provider_id: string;
  /** Panel (acp) or terminal (pty). Reported explicitly so a caller never has to infer the shape from
   *  whether `runtime` happens to be null — an ACP session missing from the runtime looks the same. */
  transport: SessionRuntime;
  /**
   * core 词表的基础态(spec agent-status-vocabulary:idle / working / needs_user / error),`null` = 这条会话还没有状态源;
   * 运行时这一轴压在上面:还在起动是 `starting`,ACP 报 lost 是 `error`。已归档压过一切,是 `archived`。
   */
  status: AgentStatus | 'starting' | 'archived' | null;
  /** #4366 派 agent 的一方不必再做第二次发现步骤就能说出 child 跑在哪个模型上。见 `SessionModel`。 */
  model: SessionModel;
  /** 附属态(spec agent-status-vocabulary):在跑是一轮在飞还是只剩后台,在等你是等批准 / 回答 / 计划 / 对话框。 */
  detail: AgentStatusDetail | null;
  /** 会话页侧栏里置顶了没有(本机任务库 `sessions.is_pinned`,侧栏读的同一列)。 */
  pinned: boolean;
  /** 最近一次交互(`last_interacted_at`,侧栏排序用的同一列);列表按它倒序。 */
  last_active_at: string | null;
  /** ACP live summary. Always null for a pty session, which has no ACP session to summarize. */
  runtime: SessionSummary | null;
  message_route?: SessionMessageRoute;
  /** 近况(session_get 带;session_children 由工具层对返回的那一页逐行走 get):见 `sessionPreview`。 */
  preview?: SessionPreview;
};

type SessionPreview =
  | (Omit<MessagePreviewProjection, 'entries'> & { entries: Array<Omit<MessagePreviewEntry, 'id'>> })
  | { error: { code: string; message: string } };

/**
 * 一条会话的近况:与 working 栏悬浮卡同一份投影(MessagePreview,#6357),`ended` 是最后一轮怎么收的。
 * entries 去掉给界面对位用的 id。读不到这一条的记录就照实说读不到,❌ 让整张列表失败。
 */
async function sessionPreview(sessionId: string): Promise<SessionPreview> {
  const read = await readSessionPreview(sessionId);
  if (!read.ok) return { error: read.error };
  const { entries, ...rest } = read.value;
  return { ...rest, entries: entries.map(({ id: _id, ...entry }) => entry) };
}

/**
 * spawn 回执里那句「跟这条新 child 的对话该落在哪」——机器可读，交到 caller 手上的时刻**正是**它
 * 决定怎么跟 child 说话的那一刻。
 *
 * 它此前只有一种形状（`session_message`，字面量类型：结构上说不出别的话），于是不管这条会话有没有
 * 项目群，回执都把往来钉死在一条不进任何 chat 的点对点管道上——而 child 信封的 arrival 又按同一条
 * 通道回信，父子全部对话就此从群里消失（#4566：owner 真机四个 child 全部私发 parent，群里 exact 0）。
 * 会话自己的 `<gugu_project_context>` 早就说了默认走项目群，但那是散文、这是字段，字段赢。
 *
 * 所以这里有两种形状，由一个事实分派：**这条会话有没有项目群**。
 */
export type SessionMessageRoute =
  /** 有群：对话属于那个群，child 用它自己的 typed session 地址点名。 */
  | { tool: 'message_send'; chat_id: string; to_user_ids: [string] }
  /** 无群（task-home / 无项目）：没有可见的落点，点对点仍是唯一去处。 */
  | { tool: 'session_message'; to: [string] };

type SessionRow = typeof sessions.$inferSelect;

/** The row's transport. `type` is nullable in the schema; pre-ACP rows are pty, same as everywhere else. */
function transportOf(row: SessionRow): SessionRuntime {
  return row.runtime === 'acp' ? 'acp' : 'pty';
}

/**
 * 平台决策在会话**创建时**写一次、删除会话时收回，生命期内不变（`platform-model-selection` 的
 * 唯一两个写入点）。
 */
async function sessionModel(row: SessionRow): Promise<SessionModel> {
  return sessionModelFromDecision(
    await sessionPlatformModel(row.id),
    row.config?.model ?? null,
  );
}

async function projectSessionRows(projectId: string): Promise<SessionRow[]> {
  return db.select().from(sessions).where(eq(sessions.projectId, projectId));
}

/** `session:<id>` 是账号级地址:本机上够得着任一项目里的会话,别的机器上的由宿主转过去。 */
async function allSessionRows(): Promise<SessionRow[]> {
  return db.select().from(sessions);
}

/** 这几个 id 里哪些是这台机器上的会话(含已归档)。 */
export async function localSessionIds(ids: readonly string[]): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(inArray(sessions.id, [...new Set(ids)]));
  return rows.map((row) => row.id);
}

// session_* 工具够得着这台机器上的任一会话,不看是谁 spawn 的。
// 只拒两件:给自己发消息,以及停掉/归档自己(调用方的进程会先于回执结束)。
function assertMessageableTarget(
  rows: SessionRow[],
  callerSessionId: string | null,
  target: SessionRow,
): SessionRow {
  if (target.id === callerSessionId) throw new Error('session cannot message itself');
  if (target.archivedAt) throw new SessionArchivedError();
  // 发起方在别的机器上(null)时它当然不在本机的行里;本机发起方消失了才是错。
  if (callerSessionId !== null && !rows.some((row) => row.id === callerSessionId)) {
    throw new Error('current session no longer exists');
  }
  // #4670 —— 「这条腿收不进消息」是这一格的**静态事实**,不是 live 与否。
  // 所以它和其它地址错误一样在**任何副作用之前**响亮失败(spec delivery-routing:全部目标一次性解析),
  // ❌ 不留到注入口才发现 —— 那会让调用方以为"发出去了、只是对方没在线"。
  // provider 为空 = 这条轴在这一行上**不可评估**(不是"收得进")。它会在下游 `sendMessage` 解析
  // integration 时照常响亮失败,❌ 不在这里编一个答案。
  if (
    target.provider
    && !sessionpageAcceptsInboundMessages(target.provider, target.runtime === 'acp' ? 'acp' : 'tui')
  ) {
    throw new Error(
      `session ${target.id} cannot receive messages: its ${target.provider} ${target.runtime === 'acp' ? 'chat UI' : 'terminal'} `
      + 'leg declares no inbound channel (it can still send). Reach this agent on a leg that declares one, '
      + 'or ask it to message you.',
    );
  }
  return target;
}

/**
 * agent 看见的 `session_id` **就是** conversation id —— 产品只有这一枚会话地址，不再有第二个 id 与它并列
 * 或需要互相翻译。graph channel 用它，宿主行关联也用它；它是主键，因此天然唯一、稳定，且对 agent 可见。
 * ❌ 别再为「产品地址」另起一列：那既造出翻译层，也造出两个 id 不一致时谁说了算的问题。
 */
function resolveSessionRow(rows: SessionRow[], sessionId: string): SessionRow {
  const row = rows.find((candidate) => candidate.id === sessionId);
  if (!row) throw new Error('session not found on this machine — session_peers lists the sessions here (session_peers with device lists another machine\'s), a chat member is reached via message_send.');
  return row;
}

/** 信封 `from` 那两格:发信会话的地址与名字。本机发起方从行上读,别的机器上的发起方由请求带来。 */
type EnvelopeSender = { sessionId: string; title: string | null };

async function localEnvelopeSender(caller: SessionRow): Promise<EnvelopeSender> {
  const identity = await localAgentForSession(caller.id, process.env);
  // The roster identity is the canonical name for unnamed parent sessions; an explicit
  // session_spawn title is the same persisted identity for named children. Do not use
  // `sessions.title` here: a title derived from the first prompt is indistinguishable
  // from a custom title in that column and would put prompt text in the sender pill.
  const title = resolveSessionDisplayName({
    identityName: identity?.name,
    explicitName: caller.config?.agentDisplayName,
  }) ?? providerDisplayName(caller.provider);
  return { sessionId: caller.id, title };
}

/** 别的机器上的发信人:名字后面带上机器名 —— 收信的 agent 与看转录的人都要知道这句话从哪台机器来。 */
function remoteEnvelopeSender(caller: RemoteSessionCaller): EnvelopeSender {
  const name = caller.name?.trim() || providerDisplayName(caller.harness) || null;
  const device = caller.deviceLabel?.trim();
  return { sessionId: caller.sessionId, title: name && device ? `${name} · ${device}` : name ?? device ?? null };
}

/**
 * 身份一时查不到(还在重建 / 这条会话还没挂上身份)时,发信人退回**这一家智能体的名字**。
 * ❌ 不退回空 —— 空的 `from` 会让收信方界面只剩 `session:<uuid>` 可显示,那是内部 id 进了人眼。
 */
function providerDisplayName(providerId: string | null | undefined): string | null {
  if (!providerId) return null;
  try {
    return getPlugin(providerId).metadata.name;
  } catch {
    return null;
  }
}

/**
 * 普通 session-direct 的字节 = [[device-command-runtime]] 那个**跨渠道统一信封**（#4280）。
 *
 * 本域只提供发信 session 的地址（`from_id="session:<id>"`）与它的名字；形状、格子清单以及那句贴着
 * 这一轮的回路提示（`arrival`，取值点名 `session_message`）都归 core 的唯一 producer。本域自己拼壳
 * 的那一版已退役——正是「两个属主」让 agent→agent 渠道一直没有回复指引。
 */
function sessionDirectEnvelope(
  sender: EnvelopeSender,
  messageId: string,
  text: string,
  said: Pick<Extract<SessionAction, { action: 'message' }>, 'then' | 'reply_to_message_id' | 'delivery_at' | 'client_message_at'> = {},
): string {
  return buildSessionDirectEnvelope({
    senderSessionId: sender.sessionId,
    senderTitle: sender.title,
    messageId,
    content: text,
    at: formatDeliveryTimestamp(said.client_message_at ?? said.delivery_at ?? new Date().toISOString()),
    then: said.then,
    inReplyTo: said.reply_to_message_id,
  });
}

/** 这一句投递的字节(由 message id 与原话):发信方的信封。会话发的是上面那个;App 发的由 App 那一侧给。 */
type DeliveryEnvelope = (messageId: string, text: string) => string;

function snapshot(
  row: SessionRow,
  summaries: Record<string, SessionSummary>,
  model: SessionModel,
): SessionSnapshot {
  const transport = transportOf(row);
  const runtime = transport === 'acp' ? (summaries[row.id] ?? null) : null;
  const status = parseAgentStatus(row.agentStatus);
  const remoteSpawner = row.config?.spawnedByRemote;
  return {
    session_id: row.id,
    ...(row.config?.activitySourceLinks ? { source_links: row.config.activitySourceLinks } : {}),
    spawned_by_session_id: sessionSpawnerId(row),
    ...(!row.spawnedBySessionId && remoteSpawner ? { spawned_by_device_id: remoteSpawner.deviceId } : {}),
    parent_session_id: sessionParentId(row),
    project_id: row.projectId,
    title: row.title,
    provider_id: row.provider ?? 'unknown',
    model,
    transport,
    status: sessionStatus(row),
    detail: parseAgentStatusDetail(row.agentStatusDetail, status),
    pinned: row.isPinned === 1,
    last_active_at: row.lastInteractedAt ?? null,
    runtime,
  };
}

/**
 * 列表工具的默认顺序:最近活动在前(侧栏同一列 `last_interacted_at`,侧栏也按解析后的时间比)。从没交互过的排在最后。
 */
function byLastActiveDesc(a: { last_active_at: string | null }, b: { last_active_at: string | null }): number {
  return activeMs(b.last_active_at) - activeMs(a.last_active_at);
}

function activeMs(at: string | null): number {
  const ms = at ? Date.parse(at) : Number.NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * 一条会话在工具里的状态 = 运行时这一轴压过活动这一轴(spec agent-status-writer):
 *  - 运行时:ACP 读 session-life 的投影(displayStatus);终端腿是 spawn 起动门还开着;
 *  - 否则是状态写入者写下的那一句,用 core 的词原样给(侧栏、session_peers、手机读的是同一份)——
 *    两种腿同一个来源,❌ 从 ACP 摘要再推一遍活动,❌ 另起一套词。没有状态源就是 `null`,❌ 猜一个终态。
 * 进程在不在不是一种状态(#6546):停掉、没起的会话照样收得进 `session_message`(发送方按原会话唤醒它),
 * 所以 ❌ 由「没有运行时」推出一个 `closed`。
 */
function sessionStatus(row: SessionRow): SessionSnapshot['status'] {
  // 归档 = 离开会话列表、只在会话历史里(#6720):行照列,状态说它已经收起,❌ 从列表里滤掉。
  if (row.archivedAt) return 'archived';
  // ACP: session-life's projection is the lifecycle axis (contract §3, the one composition point).
  if (transportOf(row) === 'acp') return displayStatus(sessionLife().status(row.id), parseAgentStatus(row.agentStatus));
  if (row.config?.spawnStartupState === 'starting') return 'starting';
  return parseAgentStatus(row.agentStatus);
}

function defaultTitle(prompt: string): string {
  const firstLine = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return (firstLine || 'Child session').slice(0, MAX_SESSION_TITLE_LENGTH);
}

/** Why a session stops: a person, the idle reclaimer, or a restart for new configuration (no stop barrier). */
export type SessionStopReason = 'user-stop' | 'idle-reap' | 'version-switch';

async function stopSessionTransport(target: SessionRow, reason: SessionStopReason = 'user-stop'): Promise<void> {
  if (transportOf(target) === 'acp') {
    // session-life owns the stop: an idle-reap is declined by Life itself when the session is not free.
    await sessionLife().interrupt(target.id, { k: 'interrupt', reason });
    // 状态桥要等下一次摘要推送才看得到这条会话没了;回执 ❌ 抢在它前面读到旧的 working(#6095 的 ACP 面)。
    // 停这一端自己把「被打断」交给写入者(与终端腿 stopSession 同一个写口),桥随后那一次是空操作。
    await agentStatusWriter.settleSessionExited({ sessionId: target.id, projectId: target.projectId });
  } else {
    // 终端挂在这条会话的挂载下:没挂着 ⇒ 本进程里没有这条会话的终端,没有东西可停。
    // ❌ 为了停去挂载:挂载(连已挂载的快路径在内)会广播 session:provisioned,渲染层据此把会话准备起来、
    // 复原标签、按原会话把进程拉起来 —— 停了等于重启(#4377 mac1 实测:停后 0.1 s 内 `--resume` 重生)。
    const mounted = resolveSession(target.projectId, target.id);
    if (mounted?.sessions.ownsSession(target.id)) await mounted.sessions.stopSession(target.id);
    else await stopUnattachedTmuxSession(target);
  }
  // 停在启动途中:起动门随之关上 —— 停掉的会话不是「再等等就好」。
  if (target.config?.spawnStartupState === 'starting') await setSpawnStartupState(target.id, 'ready');
}

/**
 * 没挂载的会话,引擎仍可能在 tmux 里跑:账号进程重启后接回是懒的,还没被叫到的会话宿主手里没有它。
 * 按 tmux 列表(与接回同一个判据)找到就杀,并照常落「被打断」。❌ 当成「没有东西可停」回成功,让 tmux 里的引擎照跑
 * (10-08 三例:e2143d72、9cad5445、38b46f1a)。当前项目设置不能证明旧引擎是否还活着:设置可能已改,项目也可能尚未打开。
 * 与接回和回收扫描一样,只认咕咕自己的 tmux 套接字里的实际会话。
 */
async function stopUnattachedTmuxSession(target: SessionRow): Promise<void> {
  const ctx = new LocalExecutionContext();
  if (!sessionsAliveInTmux(await listTmuxSessionNames(ctx)).has(target.id)) return;
  await killTmuxSession(ctx, makeTmuxSessionName(makePtySessionId(target.projectId, target.id, target.id)));
  await agentStatusWriter.settleSessionExited({ sessionId: target.id, projectId: target.projectId });
}

function withActivitySource(text: string, sourceLink?: string): string {
  if (!sourceLink) return text;
  if (!parseConversationLink(sourceLink)?.messageId) throw new Error('source_link requires a message reference');
  return `来源：[原始需求](${sourceLink})\n\n${text}`;
}

async function rememberActivitySource(sessionId: string, link: string): Promise<void> {
  db.transaction((tx) => {
    const row = tx.select({ config: sessions.config }).from(sessions).where(eq(sessions.id, sessionId)).get();
    if (!row?.config) throw new Error('Activity session is unavailable');
    const links = row.config.activitySourceLinks ?? [];
    if (!links.includes(link)) tx.update(sessions).set({ config: { ...row.config, activitySourceLinks: [...links, link] } }).where(eq(sessions.id, sessionId)).run();
  });
}

async function setSpawnStartupState(
  sessionId: string,
  state: 'starting' | 'ready',
): Promise<void> {
  const [row] = await db
    .select({ config: sessions.config })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!row?.config) throw new Error(`spawned session ${sessionId} has no config`);
  const nextConfig = { ...row.config };
  if (state === 'starting') nextConfig.spawnStartupState = 'starting';
  else delete nextConfig.spawnStartupState;
  await db
    .update(sessions)
    .set({ config: nextConfig })
    .where(eq(sessions.id, sessionId));
}

async function startSpawnedSession(input: {
  /** The child's project — the caller's for a local spawn, the target project's for one sent from another machine. */
  projectId: string;
  session: Session;
  targetWorkspaceId: string;
  targetWorkspacePath: string;
  transport: SessionRuntime;
  initialPrompt?: string;
}): Promise<void> {
  // ACP: the creation turns are the session's first pending rows and session-life starts it. A startup failure is
  // the session's failed state with its stage and cause — the person's session is never archived for it.
  if (input.transport === 'acp') {
    admitCreationTurns(input.session);
    return;
  }
  let transportStarted = false;
  const ledger = createStageLedger({
    scope: 'sessionpage/session-spawn',
    what: 'spawned session startup',
    fields: { sessionId: input.session.id, transport: input.transport },
    budgetMs: SPAWN_STARTUP_BUDGET_MS,
  });
  const mark = (stage: string, extra?: Record<string, unknown>) => ledger.mark(stage, extra);
  try {
    await sessionService.ensureSessionMounted(input.session.id);
    mark('session-mounted');
    const mounted = resolveSession(input.projectId, input.session.id);
    if (!mounted) throw new Error('spawned session workspace is not mounted');
    await mounted.sessions.startSession(
      input.session,
      undefined,
      false,
      input.initialPrompt,
      undefined,
    );
    transportStarted = true;
    mark('transport-started');

    await setSpawnStartupState(input.session.id, 'ready');
    mark('startup-state-ready');
    // A delegation left in the outbox goes out when the session turns live: each leg signals that at its own
    // boundary (spec delivery-routing「session-live 的产地」), so nothing is re-nudged here.
    ledger.settle({ outcome: 'started' });
  } catch (error) {
    ledger.settle({ outcome: 'failed' });
    const [row] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, input.session.id))
      .limit(1);
    if (row && transportStarted) {
      try {
        await stopSessionTransport(row);
      } catch (stopError) {
        log.error('spawn session failed to stop its started transport', {
          sessionId: input.session.id,
          error: stopError instanceof Error ? stopError.message : String(stopError),
        });
      }
    }
    if (row) {
      try {
        await archiveSession(input.projectId, input.session.id, { skipTransportStop: true, removeSocialIdentity: false });
      } catch (cleanupError) {
        log.error('spawn session failed to remove its session', {
          sessionId: input.session.id,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
    }
    log.error('spawned session startup failed after id was returned', {
      sessionId: input.session.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function stopExactSessionpageSession(target: {
  projectId: string;
  sessionId: string;
  reason?: SessionStopReason;
}): Promise<boolean> {
  const rows = await projectSessionRows(target.projectId);
  const session = rows.find((row) =>
    row.id === target.sessionId && row.projectId === target.projectId
  );
  if (!session) return false;
  await stopSessionTransport(session, target.reason);
  return true;
}

async function callerRow(context: SessionCallerContext): Promise<SessionRow> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(
      and(eq(sessions.id, context.sessionId), eq(sessions.projectId, context.projectId))
    )
    .limit(1);
  if (!row) throw new Error('current session no longer exists');
  // No transport gate here on purpose. Being a session-page conversation is what makes these actions
  // meaningful; whether the user is looking at a panel or a terminal is not (spec capability-bundle A2).
  // Callers with no session-page conversation at all are turned away upstream, at the bridge.
  return row;
}

/**
 * 显式 harness 必须是 `session_list_harnesses` 提供过的那一份里的 —— 与用户自己新建 agent 时
 * 能选的完全同一份(`listPlugins()` 的双闸)。
 *
 * ⚠️ 只挡**显式**指定。省略 harness 时继承 caller 自己那家、一律不过这道闸:那家可能已经不在提供
 * 列表里(逃生开关起的会话、能力退化的家),而**已经在跑的会话必须继续派得出活** —— 这正是
 * `plugin-registry.ts` 抬头写的「闸挡的是新建入口,不是查表」。
 */
/**
 * 发起会话所属 agent 配的「子 agent 默认 harness」(child-harness-default.ts);与调用方自己的相同 = 等于没配(就是继承)。
 * 会话还没有 agent 身份 = 没配。
 */
async function callerChildHarnessDefault(callerSessionId: string, callerHarness: string | null): Promise<string | undefined> {
  const identity = await localAgentForSession(callerSessionId, process.env);
  const configured = identity?.gugu_user_id ? await childHarnessDefault(identity.gugu_user_id) : undefined;
  return configured && configured !== callerHarness ? configured : undefined;
}

function assertOfferedHarness(harnessId: string): AgentProviderId {
  const provider = toAgentProviderId(harnessId);
  if (listPlugins().some((plugin) => plugin.metadata.id === harnessId)) return provider;
  throw new Error(
    `harness '${harnessId}' is not offered on this host; pick one from session_list_harnesses`,
  );
}

/**
 * 把 `session_list_models` 返回的一个 id 解释成一次模型选择。
 *
 * `platform:` 前缀是两组的唯一分界,与 composer 下拉、运行模型面板同一套编码 —— 所以 agent
 * 把列表里的 id 原样传回来就够了,不需要第二个参数、也不需要它自己判断这是哪一组。
 *
 * ❌ 平台 id 不在目录里时**不许**降级成 harness 自家模型:那正是「界面说咕咕、实际烧用户 Key」。
 * 平台组整个缺席时把产品自己那句定性原话当作拒绝理由 —— 空目录与「这条腿用不了咕咕模型」
 * 在返回值里长得一样,只有那句话说得清。
 */
export async function resolveSpawnModelSelection(
  provider: AgentProviderId,
  transport: SessionRuntime,
  requestedModel: string | undefined,
): Promise<{ kind: 'gugu'; modelId: string } | { kind: 'harness'; model: string | undefined }> {
  if (!requestedModel) return { kind: 'harness', model: undefined };
  const platformModelId = platformModelIdFromOption(requestedModel);
  // 平台组先问一次。带前缀的只需平台目录；裸 id 只有在撞上平台同名项时，才需要再确认它
  // 是否也是这家 harness 自己明列的模型。这样普通的自家别名仍不因一次 spawn 而触发冷启探测。
  const platform = await listLocalPlatformModels(provider, transport as SessionTransport);

  if (platformModelId) {
    const listed = platform.models.find((model) => model.id === requestedModel);
    // 目录里有、但这个用户的会员档用不了(#7056):当场拒,❌ 起一条签发那一步才失败的会话。
    if (listed?.requires_membership) {
      throw new Error(
        `model '${requestedModel}' needs a Gugu membership; pick a model without requires_membership from session_list_models`,
      );
    }
    if (listed) {
      return { kind: 'gugu', modelId: platformModelId };
    }
    const reason = platform.meta.available ? null : platform.meta.reason;
    throw new Error(
      reason
        ? `model '${requestedModel}' is not available for ${provider} on ${transport} sessions: ${reason}`
        : `model '${requestedModel}' is not in the Gugu model catalog for ${provider} on ${transport} sessions; pick one from session_list_models`,
    );
  }

  // 裸的平台模型名 —— 几乎一定是从 `session_get` / `session_children` / spawn 回执上抄来的:
  // 那三处报的 `model.id` 是**裸**的(#4366 的合同:「`id` 就是它用的模型」),而这里的取值空间是
  // `session_list_models` 那套带前缀的。原样收下的后果是静默的:落成 harness 分支 ⇒ 明确 BYOK
  // ⇒ 一个不存在的 harness 模型,而 claude 对伪造 id 是原样透传、不报错的
  // (`harness-model-catalog.ts` 抬头实测)。⇒ 在这里响亮拦下,并把该传的那个值直接给出来。
  const asPlatformOption = platform.models.find(
    (model) => platformModelIdFromOption(model.id) === requestedModel,
  );
  if (asPlatformOption) {
    // 同一个裸字符串可以同时是 harness 自有模型和平台模型。列表里自有组优先：
    // `session_list_models` 已经把这条路径明确标成 source:'harness'，必须允许它原样回传。
    const catalog = await listLocalModels(provider, { transport: transport as SessionTransport });
    if (isHarnessModelChoice(catalog, requestedModel)) {
      return { kind: 'harness', model: requestedModel };
    }
    throw new Error(
      `'${requestedModel}' is a Gugu-provided model; pass it as '${asPlatformOption.id}' (the id session_list_models returns) — the bare id session_get reports would start a harness/BYOK session instead`,
    );
  }
  return { kind: 'harness', model: requestedModel };
}

/**
 * 点名了 harness、没点模型时,调用方的咕咕平台模型能不能跟过去(#7199)。
 *
 * 点名 harness 是「换一家干活」的决定,不是「改用用户自己的账号」的决定。从前这一步一律记成那家自家模型 ——
 * 云电脑上跑 Pi 的助理派 Claude Code 子 agent,子会话就落到这台机器上没登录的 Claude 账号,第一轮
 * `Authentication required`,而同一位助理不点 harness 时(继承)是好的。
 * 那家(同一会话形态)的平台目录列着同一个模型、且不要会员档,就沿用;否则 null,照旧用那家自己的默认模型。
 * `callerPlatformOptionId` 是 `session_list_models` 那套带 `platform:` 前缀的 id。
 */
async function carriedPlatformModel(
  callerPlatformOptionId: string | null | undefined,
  provider: AgentProviderId,
  transport: SessionRuntime,
): Promise<{ kind: 'gugu'; modelId: string } | null> {
  const modelId = callerPlatformOptionId ? platformModelIdFromOption(callerPlatformOptionId) : null;
  if (!modelId) return null;
  const platform = await listLocalPlatformModels(provider, transport as SessionTransport);
  const listed = platform.models.find((model) => model.id === callerPlatformOptionId);
  return listed && !listed.requires_membership ? { kind: 'gugu', modelId } : null;
}

/**
 * 从一份「新建」界面的模型列表里**点**出来的 id → 这条会话的模型记录。
 * 手机「新建会话」和远端「新建 agent」(#6264,咕咕 server)都走这一处 —— 两条路各写一份的那天就开始分岔。
 *
 * 与 spawn 的差别只有一条:裸 id 在这家**自家那一组**里就是自家模型。spawn 那条「裸 id 撞上平台模型名就拒」
 * 的护栏是给 agent 抄错 id 用的;人是从列表里点的,不经它 —— 否则 codex 自家的 gpt-5.6-terra
 * (平台组恰好也有同名)永远选不上(2026-09-15 矩阵 E 组实撞)。
 *
 * 返回值的 `platformModel` 是三态里的两态:对象 = 平台模型;null = 明确选了自家模型。
 * 没给 id 时返回 undefined(调用方不写记录,回落 agent 级选择)。
 */
export async function resolveCreateModelChoice(
  provider: AgentProviderId,
  transport: SessionRuntime,
  requestedModel: string | null | undefined,
): Promise<{ model: string | null; platformModel: { modelId: string } | null } | undefined> {
  const requested = requestedModel?.trim();
  if (!requested) return undefined;
  if (!requested.startsWith('platform:')) {
    const catalog = await listLocalModels(provider, { transport: transport as SessionTransport });
    if (isHarnessModelChoice(catalog, requested)) return { model: requested, platformModel: null };
  }
  const selection = await resolveSpawnModelSelection(provider, transport, requested);
  return selection.kind === 'gugu'
    ? { model: null, platformModel: { modelId: selection.modelId } }
    : { model: selection.model ?? null, platformModel: null };
}

/**
 * Who spawned a session, and whether it is listed under them — one rule for every spawn (session_spawn here and from
 * another machine, and an App's page an agent works, owner 10-14): the spawner is recorded always (who started it, and
 * 「连同子会话」 follows it). The already-authenticated spawner is the default parent; an explicit parent uses the same
 * ownership/cycle check as set_parent before creation. Project placement and spawn provenance remain separate.
 */
async function spawnedBy(
  by: { localSessionId: string } | { deviceId: string; sessionId: string; agentUserId?: string; name?: string },
  parentId?: string | null,
  childId?: string,
): Promise<{ relations: Omit<InternalSessionRelations, 'spawnedByExtensionId'>; not_reached: string[] }> {
  const spawner = 'localSessionId' in by ? by : { deviceId: by.deviceId, sessionId: by.sessionId };
  const { parent, not_reached } = parentId === undefined
    ? { parent: spawner, not_reached: [] }
    : await resolveSessionParent(childId, parentId);
  return {
    relations: { ...('localSessionId' in by ? { spawnedBySessionId: by.localSessionId } : { spawnedByRemote: by }), ...storedParent(parent) },
    not_reached,
  };
}

async function spawnSession(
  context: SessionCallerContext,
  action: Extract<SessionAction, { action: 'spawn' }>,
  caller: SessionRow,
  signal?: AbortSignal,
): Promise<SessionSnapshot> {
  signal?.throwIfAborted();
  const ledger = createStageLedger({
    scope: 'sessionpage/session-spawn',
    what: 'session spawn action',
    fields: { callerSessionId: context.sessionId },
    budgetMs: SPAWN_ACTION_BUDGET_MS,
  });
  const mark = (stage: string, extra?: Record<string, unknown>) => ledger.mark(stage, extra);
  const prompt = action.prompt.trim();
  if (!prompt) throw new Error('prompt is required');

  if (!caller.workspaceId || caller.workspaceId !== context.workspaceId) {
    throw new Error('current session workspace is not ready');
  }

  // #5665 child 是一条独立会话,这里选的只是它的工作目录:缺省和调用者共用同一份工作副本;点名了项目就落那个
  // 项目的根工作区(与会话页新建会话同一步)。
  const named = namedPlacement(action);
  let projectId = context.projectId;
  let workspaceId = caller.workspaceId;
  if (named) {
    ({ projectId, workspaceId } = await projectRootPlacement(named, `project ${named.project_path ?? named.project_id}`));
  }
  signal?.throwIfAborted();

  // Shape is the caller's unless the agent asked for the other one — the same inheritance the provider,
  // model and autonomy below already follow.
  const transport: SessionRuntime = action.transport ?? transportOf(caller);
  const callerSession = mapSessionRowToSession(caller);
  // #7199 没传 harness:先看发起这个 agent 自己配的「子 agent 默认 harness」,配了且与自己不同就当作点名了它
  // (模型随之按「点名了 harness」那条规则走:平台模型那家也有就跟过去);没配才继承调用方。
  const requestedHarness = action.harness?.trim() || (await callerChildHarnessDefault(caller.id, callerSession.providerId));
  const requestedModel = action.model?.trim() || undefined;
  const provider = requestedHarness
    ? assertOfferedHarness(requestedHarness)
    : callerSession.providerId;
  await assertSpawnableSurface(provider, transport);
  // 选中的模型是哪一组 —— `platform:` 前缀是唯一的分界(与 composer 下拉、运行模型面板同一套编码)。
  // 平台那一条必须在**同一 (harness, transport)** 的目录里,不然就是「界面说咕咕、实际烧用户 Key」那类错账。
  signal?.throwIfAborted();
  // 点名了 harness、没点模型:调用方的平台模型那家也有就跟过去(carriedPlatformModel)。
  const callerPlatform = requestedHarness && !requestedModel ? await sessionPlatformModel(context.sessionId) : null;
  const selection =
    (callerPlatform ? await carriedPlatformModel(platformOptionId(callerPlatform.modelId), provider, transport) : null)
    ?? (await resolveSpawnModelSelection(provider, transport, requestedModel));
  mark('model-selection-resolved', { source: selection.kind });
  signal?.throwIfAborted();

  // 回执里的通道由这一格决定，所以在建出任何东西之前就把它读定：读失败要在这里 fail loud，
  // ❌ 不能在 child 已经建好之后才炸，更不能吞掉错误悄悄退回点对点——那正是本来的 bug。
  // 读的是本机花名册文件，不进云端、不等引擎启动（spec:`spawn` 的返回不得阻塞在引擎启动上）。
  const projectGroup = await sessionpageProjectGroupForSession(context.sessionId, process.env);
  mark('project-group-resolved', {
    // ❌ 别折成一个 hasGroup:false —— 「这条会话本来就没项目」与「压根查不到它的花名册记录」
    // 落地都是退回点对点,但只有前者是对的,归因得能分开(见 SessionpageProjectGroup 的抬头)。
    group: projectGroup.kind === 'group' ? 'yes' : projectGroup.reason,
  });
  signal?.throwIfAborted();

  const { relations, not_reached } = await spawnedBy({ localSessionId: context.sessionId }, action.parent_session_id, action.assistant_work?.child_session_id);
  const row = await createChildSession({
    ledger,
    projectId,
    workspaceId,
    provider,
    transport,
    prompt,
    title: action.title,
    sourceLink: action.source_link,
    assistantWork: action.assistant_work,
    envelope: envelopeOf(await localEnvelopeSender(caller)),
    // 带 chat_id 开的子会话是派出去干活的:任务座位(不发入群提示)。
    ...(action.chat_id ? { birthGroup: { chatId: action.chat_id, asTask: true } } : {}),
    // With no override, preserve the caller's native model. Selecting a model explicitly is a new model
    // decision; naming only a harness keeps the caller's platform model when that harness offers it
    // (carriedPlatformModel), otherwise it is that harness's own default.
    //
    // 选了咕咕平台模型时 `model` 必须留空:模型由网关签发的 token 钉死,再往会话行上写一个
    // harness 自家的模型只能与它矛盾(composer 那侧同一口径 —— 选中平台模型时 harness model 恒为 null)。
    model: selection.kind === 'gugu'
      ? undefined
      : selection.model ?? (requestedHarness ? undefined : callerSession.model),
    platformModel:
      selection.kind === 'gugu'
        ? { modelId: selection.modelId }
        : requestedHarness || requestedModel
          ? null
          : undefined,
    // #4366 「child 照常继承 caller 的模型」是**两条**事实，不是一条。`sessions.model` 只记
    // harness 自家的模型；caller 跑在咕咕平台模型上时那一列**故意是空的**（模型由网关签发的 token
    // 钉死，见 build-create-session-params），说明模型的是那条 per-session 平台决策。只抄前者，等于
    // 对着平台会话抄了个 null：child 回退 agent 级配置，而一个刚 provision 出来的身份没有那份配置
    // —— 落地就是 BYOK，也就是 owner 在军训 case 里看到的「总教官跑 gpt-5.6-luna，派出去的 agent
    // 跑 harness 默认模型」。派生路径共用 attachAgentToSession 那一处继承，这里只说源是谁。
    inheritPlatformModelFrom: context.sessionId,
    relations,
    signal,
  });
  return {
    ...snapshot(row, {}, await sessionModel(row)),
    ...(not_reached.length ? { not_reached } : {}),
    ...(action.assistant_work ? {assistant_work_target:{session_id:row.id,device_id:(await assistantWorkLedgerContext()).deviceId}} : {}),
    // child 是本项目里生出来的，因此和 caller 同属这个群（[[agent-provisioning]] 的入群是它 session
    // start 的一步）。点名了别的项目时 child 入的是那个项目的群，caller 不在里面 ⇒ 只有点对点。
    //
    // 收件人用 child 的 **typed session 地址**，不是它的 user id —— 后者要到它自己 session start 才
    // 铸出来，而 spec 写死 `spawn` 的返回不得阻塞在引擎启动上。`to_user_ids` 收这一形并在**发送
    // 那一刻**解析（#4631 把「收件人怎么写」统一成 typed address，这一格是最后并进来的一个）。
    // ⚠️ 少了这一格这条路由就是错的：群里无寻址的发言**唤不醒**任何人（`agentInboxReader` 的广播分支
    // 要求发信人不是 agent），而 im 那道裸名守卫只在正文点了名字时才响 —— 那就成了「发成功了、没人醒」。
    message_route: projectGroup.kind === 'group' && projectId === context.projectId
      ? {
          tool: 'message_send',
          chat_id: projectGroup.groupChatId,
          to_user_ids: [encodeTypedId('session', row.id)],
        }
      : { tool: 'session_message', to: [encodeTypedId('session', row.id)] },
  };
}

function namedPlacement(action: { project_id?: string; project_path?: string }) {
  if (!action.project_id && !action.project_path) return null;
  return { project_id: action.project_id, project_path: action.project_path };
}

/**
 * 项目 → 它的根工作区,child 就落在那里:与会话页「新建会话」、远端建会话同一步
 * (resolveProjectWorkspace:项目 id,或这台机器上的目录 —— 还不是项目的目录当场登记,不存在就说出来)。
 * 都不给 = 这台机器的隐式主目录项目。
 */
async function projectRootPlacement(
  project: { project_id?: string; project_path?: string },
  what: string,
): Promise<{ projectId: string; workspaceId: string }> {
  const { resolveProjectWorkspace } = await import('../session-timeline/create-session');
  const resolved = await resolveProjectWorkspace({ projectId: project.project_id, projectPath: project.project_path ?? '' });
  if (!resolved.ok) throw new Error(`${what} is not available: ${resolved.error.message}`);
  return { projectId: resolved.value.projectId, workspaceId: resolved.value.repositoryWorkspaceId };
}

/** The registry owns the provider/surface matrix. Resolve it before creating the row so an
 *  undeclared target cannot leave a conversation that can never receive its delegation. */
async function assertSpawnableSurface(provider: AgentProviderId, transport: SessionRuntime): Promise<void> {
  const integration = resolveSessionpageSessionIntegration(
    provider,
    transport === 'acp' ? 'acp' : 'tui',
  );
  if (integration.messageTransport === 'none') {
    throw new Error(
      `provider ${provider} does not support session messages on ${transport} sessions`,
    );
  }
  // 启动那道闸在建行之前当场过一次(与 session_list_harnesses 问的是同一个函数):起不来就同步报原话,
  // ❌ 先给 id、再在异步启动里失败并删掉会话(调用方只能事后撞上 not a session)。
  await assertLocalHarnessLaunchable(provider, transport as SessionTransport);
}

/** A session's first turn as session-direct writes it: the sending session's envelope. */
function envelopeOf(sender: EnvelopeSender): DeliveryEnvelope {
  return (messageId, text) => sessionDirectEnvelope(sender, messageId, text);
}

/**
 * 建 child 的那一段 —— 本机 `session_spawn`、别的机器发来的 spawn(`runRemoteSessionAction`)与 App 的 `spawnAgent`
 * (`spawnSessionForApp`)共用。调用方已经把「在哪建、用哪家哪个模型、谁派的」全部定好并校验过;这里只做建:
 * 会话行 + 挂载 → 首句 → 起引擎。
 */
async function createChildSession(input: {
  /** ACP creation that needs its identity at once (an App spawn): bind it before the row exists. */
  bindIdentityFirst?: boolean;
  ledger: ReturnType<typeof createStageLedger>;
  projectId: string;
  /** child 在哪个工作区里干活。 */
  workspaceId: string;
  provider: AgentProviderId;
  transport: SessionRuntime;
  prompt: string;
  sourceLink?: string;
  assistantWork?: AssistantWorkIntent;
  title?: string;
  /** The first turn's envelope: the sending session's, or the App's. */
  envelope: DeliveryEnvelope;
  model: string | undefined;
  platformModel: { modelId: string } | null | undefined;
  inheritPlatformModelFrom?: string;
  /** The chat it is born in (`chat_id`, an App's `chat`): joined when its identity is minted. */
  birthGroup?: BirthGroup;
  /** Answer once it has started (its identity is written then): an App names the agent by it. */
  awaitStart?: boolean;
  relations: InternalSessionRelations;
  signal?: AbortSignal;
}): Promise<SessionRow> {
  const { ledger, projectId, provider, transport, signal } = input;
  const prompt = withActivitySource(input.prompt, input.sourceLink);
  const mark = (stage: string, extra?: Record<string, unknown>) => ledger.mark(stage, extra);
  const title = input.title?.trim() || undefined;
  // A gugu-spawned child is a chat member, not a session-page session with a person present to answer
  // permission prompts. Its autonomy is therefore decided here, once, before either transport sees it.
  // Keep the session-page composer's durable choice unchanged; only this delegated child is fully automatic.

  const intent=input.assistantWork ? assistantWorkIntentSchema.parse(input.assistantWork) : null;
  const sessionId = intent?.child_session_id ?? randomUUID();
  const messageId = intent?.message_id ?? randomUUID();
  if(intent) {
    const remote=input.relations.spawnedByRemote;
    if(remote ? remote.sessionId!==intent.coordinator.session_id || remote.deviceId!==intent.coordinator.device_id
      : input.relations.spawnedBySessionId!==intent.coordinator.session_id) throw new Error('Assistant work coordinator does not match the spawning session');
    const [existing]=await db.select().from(sessions).where(eq(sessions.id,sessionId));
    if(existing) {
      const sameSender=remote ? existing.config?.spawnedByRemote?.sessionId===remote.sessionId && existing.config.spawnedByRemote.deviceId===remote.deviceId
        : existing.spawnedBySessionId===input.relations.spawnedBySessionId;
      if(!sameSender || existing.projectId!==projectId || existing.workspaceId!==input.workspaceId || existing.provider!==provider
        || transportOf(existing)!==transport || existing.config?.firstUtterance!==prompt) throw new Error('Assistant work seat ID belongs to a different dispatch');
      ledger.settle({sessionId});
      return existing;
    }
  }
  const useProviderInitialPrompt =
    !intent && transport === 'pty' && providerConsumesStartupPrompt(
      getPlugin(provider).capabilities.prompt,
      transport,
    );
  const initialPrompt = useProviderInitialPrompt
    ? input.envelope(messageId, prompt)
    : undefined;
  // ACP startup prompts must enter the ACP cell so the provider turn is represented in the
  // task transcript. Claude ACP used to enqueue this as session-direct and then route it through
  // its rendezvous socket, bypassing the cell entirely (#4949). Keep the startup exception at the
  // declared ACP startup channel; subsequent messages use the same runtime prompt path.
  //
  // ⚠️ Every ACP harness, not only Claude (#6497). The startup queue is admitted when the runtime
  // record is created, so the cell never reads "ready, idle, empty" for a child that has a first
  // utterance. The outbox route used to deliver it only after start resolved; a chat opened during
  // spawn joins that same start, wakes up inside the gap, and the empty-cell guard (#4949) reported
  // a working child as "The engine could not start" (real Electron on dev: 4/4; the guard fired 37 ms
  // before the first turn began).
  const initialQueue = !intent && transport === 'acp'
    ? [{ text: input.envelope(messageId, prompt), origin: 'communication' as const }]
    : undefined;
  signal?.throwIfAborted();
  // Providers whose declared prompt capability consumes the startup prompt (argv/stdin, not
  // `delivery-bridge`) receive the envelope at spawn time. Host-owned transports that declare
  // `startupDelivery: 'delivery-bridge'` — codex's app-server, opencode's serve/attach — have no argv
  // prompt slot and retain the durable startup outbox path below, delivering the first turn over their
  // own channel.
  //
  // 落行放在所有校验之后:任何一道校验抛了都不该留下一条会话。行落下之后当场挂载(挂不上就撤掉这一行再抛)。
  // Born in a chat: its identity joins it when first minted (birth-groups.ts).
  if (input.birthGroup) rememberBirthGroup(sessionId, input.birthGroup);
  const attach = () => attachAgentToSession({
    id: sessionId,
    projectId,
    workspaceId: input.workspaceId,
    provider,
    title: (title || defaultTitle(input.prompt)).slice(0, MAX_SESSION_TITLE_LENGTH),
    // spec session-graph: explicit title is also the addressable agent name.
    agentDisplayName: title,
    // 派活的一方显式起了名 ⇒ harness 自己拟的名不盖它;没起名 ⇒ 首轮兜底,等 harness 起名。
    ...(title ? { titleSource: 'manual' as const } : {}),
    permissionMode: UNATTENDED_SESSION_PERMISSION_MODE,
    model: input.model,
    platformModel: input.platformModel,
    ...(input.inheritPlatformModelFrom ? { inheritPlatformModelFrom: input.inheritPlatformModelFrom } : {}),
    origin: { kind: 'create', firstUtterance: prompt },
    initialPrompt,
    initialQueue,
    ...(initialQueue ? { startupOrigin: 'session-page' as const, initialMessageId: messageId } : {}),
    runtime: transport,
    deferStart: true,
  }, db, input.relations);
  const created = input.bindIdentityFirst && transport === 'acp'
    ? bindIdentityThenCreate(
      async () => {
        const cwd = resolveWorkspace(projectId, input.workspaceId)?.path;
        if (!cwd) throw new Error(`workspace ${input.workspaceId} is unknown`);
        const identity = await provisionStartIdentity({ sessionId, providerId: provider, projectId, cwd }, 'fresh', { agentDisplayName: title || undefined });
        if (!identity) throw new Error(`session ${sessionId} could not be given an identity`);
      },
      attach,
      () => unbindSessionAgent(sessionId, process.env))
    : attach();
  const session = await created.catch((error: unknown) => {
    ledger.settle({ outcome: 'failed' });
    throw error;
  });
  mark('child-session-created', { sessionId });
  try {
    signal?.throwIfAborted();
    if (input.sourceLink) await rememberActivitySource(sessionId, input.sourceLink);
    // ACP startup is session-life's own projection; only other runtimes keep this config flag (until ⑤).
    if (transport !== 'acp') await setSpawnStartupState(sessionId, 'starting');
  } catch (error) {
    await archiveSession(projectId, sessionId, { skipTransportStop: true, removeSocialIdentity: false });
    ledger.settle({ outcome: 'failed' });
    throw error;
  }
  const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  if (!row) throw new Error('spawned session disappeared before startup');
  if(intent) {
    // The coordinator commits this seat's first delivery with its ledger row.
    // Only the account outbox may inject it or start the executor afterwards.
    ledger.settle({sessionId});
    return row;
  }
  if (!initialPrompt && !initialQueue) {
    try {
      signal?.throwIfAborted();
      await sendMessage({
        projectId,
        sessionId,
        clientMessageId: messageId,
        text: input.envelope(messageId, prompt),
        kind: 'session-direct',
        // spawn 契约:child 结构上尚未 live,首消息使用唯一允许的 durable startup outbox 例外。
        queuedStartupDelegation: true,
      });
    } catch (error) {
      await archiveSession(projectId, sessionId, { skipTransportStop: true, removeSocialIdentity: false });
      ledger.settle({ outcome: 'failed' });
      throw error;
    }
  } else {
    // Native argv/stdin delivery replaces the outbox transport, but the child conversation still
    // needs the durable entity row used by the chat/task transcript. Recording it is independent
    // from provider startup, so a failed spawn never erases what the caller sent.
    recordDeliveredSessionDirectMessage(
      { sessionId },
      { id: messageId, text: initialPrompt ?? initialQueue![0]!.text },
    );
  }
  if (!initialPrompt && !initialQueue) mark('delegation-enqueued', { sessionId });
  // Startup runs after the durable child + delegation are visible. Its result is observed by get
  // through the same runtime/PTY sources; this call is intentionally not awaited by the MCP action.
  const mounted = resolveSession(projectId, sessionId);
  if (!mounted) throw new Error('spawned session is not mounted');
  const started = startSpawnedSession({
    projectId,
    session,
    targetWorkspaceId: input.workspaceId,
    targetWorkspacePath: mounted.sessionPath,
    transport,
    initialPrompt,
  });
  if (input.awaitStart) await started;
  ledger.settle({ sessionId });
  return row;
}

/**
 * What the new-session box remembers on this computer (app setting `newSessionMemory`, its one copy — L11 复核 58): the
 * engine picked by hand, what was last started, the shape. The box writes it; main reads the same, never the session a
 * page sits in (真源原则 13).
 */
async function newSessionMemory(): Promise<NewSessionMemory> {
  const { appSettingsService } = await import('@main/core/settings/settings-service');
  // 形态不再由新建框记,也不跟「终端」开关走:新会话一律通用(owner 10-28),与新建框同一条。
  return { ...(await appSettingsService.get('newSessionMemory')), sessionView: DEFAULT_SESSION_VIEW };
}

/**
 * The engine a new session gets when nothing is named: the new-session box's own choice (`resolveSessionProviderSelection`,
 * one function for both), fed the same facts — the memory (`rememberedProviderOf`), the default agent in settings, the
 * agents listed here on the remembered shape's leg and which are installed. Nothing usable here: said, as the box's
 * empty state.
 */
async function newSessionEngine(memory: NewSessionMemory): Promise<AgentProviderId> {
  const [{ agentsController }, { appSettingsService }] = await Promise.all([
    import('@main/core/agents/controller'),
    import('@main/core/settings/settings-service'),
  ]);
  // The box's two reads: the listed agents (their session-page legs) and what is installed (`useEffectiveProvider`).
  const [agents, statuses, defaultAgent] = await Promise.all([
    agentsController.list(),
    agentsController.listAgentInstallationStatus(),
    appSettingsService.get('defaultAgent'),
  ]);
  const leg = sessionpageLegOfView(memory.sessionView);
  const selection = resolveSessionProviderSelection({
    defaultProviderId: (defaultAgent ?? null) as AgentProviderId | null,
    providerOverride: null,
    rememberedProviderId: rememberedProviderOf(memory),
    knownProviderIds: agents.map((agent) => agent.id as AgentProviderId),
    sessionpageProviderIds: agents
      .filter((agent) => sessionpageLegFor(agent.capabilities.sessionpage, leg) !== null)
      .map((agent) => agent.id as AgentProviderId),
    installedProviderIds: statuses.filter((status) => status.status === 'available').map((status) => status.id as AgentProviderId),
    availabilityKnown: true,
  });
  if (!selection.providerId || selection.createDisabled) {
    throw new Error('no agent on this computer can start a session: install one, or pass harness (session_list_harnesses)');
  }
  return selection.providerId;
}

/**
 * The model a spawn names, else — on the engine last started — the one it started with, as the box restores it; a
 * remembered model this computer no longer offers falls back to the engine's own default (the box drops it too).
 */
async function spawnModelSelection(
  provider: AgentProviderId,
  transport: SessionRuntime,
  requestedModel: string | undefined,
  last: NewSessionMemory['lastStarted'],
): Promise<Awaited<ReturnType<typeof resolveSpawnModelSelection>>> {
  const remembered = last ? (last.platformModel ? platformOptionId(last.platformModel) : last.model) : undefined;
  if (requestedModel || !remembered) return await resolveSpawnModelSelection(provider, transport, requestedModel);
  return await resolveSpawnModelSelection(provider, transport, remembered).catch(() => ({ kind: 'harness' as const, model: undefined }));
}

/**
 * `gugu.dispatch(prompt, { to: { new: true }, spawn })`: an App starts a session of its own as the
 * person starts one — where it names (`project`: an id, or a folder here; none: this machine's home project), on what it
 * names (`harness`, `model`, `transport`, the words `session_spawn` takes), else as the person's new session would be
 * (`newSessionEngine`, `newSessionMemory`); born in `chat` when it names one. The one spawn core `session_spawn` uses; the first turn is
 * the App's envelope, and the row records the App (`spawnedByExtensionId`: its `own` agents). `bySession`: the session of
 * the agent that works the App's page (owner 10-14) — recorded as who spawned it, by the rule session_spawn's are.
 */
type AppSessionSpawnInput = AppSpawnAction['spawn'] & {
  extensionId: string;
  extensionName?: string;
  bySession?: string;
  envelope: DeliveryEnvelope;
  prompt: string;
};

export function spawnSessionForApp(input: AppSessionSpawnInput & { device?: undefined }): Promise<SessionRow>;
export function spawnSessionForApp(input: AppSessionSpawnInput): Promise<SessionRow | { agentId: string }>;
export async function spawnSessionForApp(input: AppSessionSpawnInput): Promise<SessionRow | { agentId: string }> {
  if (input.device !== undefined) {
    const deviceId = appDeviceId(input.device);
    const { otherMachines } = await import('./session-family');
    if (!(await otherMachines().isThisDevice(deviceId))) {
      if (!input.extensionName) throw new Error('App spawn needs the installed App name');
      const { title, harness, model, transport, project, chat } = input;
      return await otherMachines().appSpawn({ extensionId: input.extensionId, extensionName: input.extensionName }, deviceId, {
        action: 'spawn', prompt: input.prompt, spawn: { title, harness, model, transport, project, chat },
      });
    }
  }
  const ledger = createStageLedger({
    scope: 'sessionpage/session-spawn',
    what: 'App spawn',
    fields: { extensionId: input.extensionId },
    budgetMs: SPAWN_ACTION_BUDGET_MS,
  });
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error('prompt is required');
  const project = input.project?.trim();
  const { projectId, workspaceId } = await projectRootPlacement(
    project ? (/[/\\~]/.test(project) ? { project_path: project } : { project_id: project }) : {},
    project ? `project ${project}` : 'this machine\'s home project',
  );
  const requestedHarness = input.harness?.trim() || undefined;
  const requestedModel = input.model?.trim() || undefined;
  // A harness named is that one, offered here — as session_spawn takes it; none named is the new-session box's answer.
  const memory = await newSessionMemory();
  const provider = requestedHarness ? assertOfferedHarness(requestedHarness) : await newSessionEngine(memory);
  // The box's shape on that engine's own legs; on the engine it last started, the model it started with.
  const transport: SessionRuntime = input.transport
    ?? (sessionpageLegFor(getPlugin(provider).capabilities.sessionBundle.sessionpage, sessionpageLegOfView(memory.sessionView)) === 'acp' ? 'acp' : 'pty');
  await assertSpawnableSurface(provider, transport);
  const last = !requestedHarness && memory.lastStarted?.provider === provider ? memory.lastStarted : null;
  const selection = await spawnModelSelection(provider, transport, requestedModel, last);
  const row = await createChildSession({
    ledger,
    projectId,
    workspaceId,
    provider,
    transport,
    prompt,
    title: input.title,
    envelope: input.envelope,
    model: selection.kind === 'gugu' ? undefined : selection.model,
    platformModel: selection.kind === 'gugu' ? { modelId: selection.modelId } : requestedHarness || requestedModel || last ? null : undefined,
    ...(input.chat ? { birthGroup: { chatId: input.chat, asTask: false } } : {}),
    awaitStart: true,
    bindIdentityFirst: true,
    relations: {
      ...(input.bySession ? (await spawnedBy({ localSessionId: input.bySession })).relations : { parentSessionId: null }),
      spawnedByExtensionId: input.extensionId,
    },
  });
  return row;
}

/**
 * What this caller may open is the browser pane's own judgement — ❌ 别在这儿另写一套
 * scheme 判断。两套判断迟早分岔，届时 agent 被拒的地址正是用户手输能开的地址。
 *
 * `file:` is allowed on purpose. This same capability already opens read-only files from
 * outside the workspace through `path`; refusing to *render* a local page it can already
 * *read* would be one product contradicting itself. (The extension bridge does keep
 * extensions off `file:` — that rationale is about untrusted third-party HTML in a
 * sandbox and does not transfer to this caller.)
 *
 * Search queries stay off: an agent names a target, it does not type into a search box.
 */
function normalizeOpenInTabUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) throw new Error('url is required');
  const normalized = normalizeBrowserUrl(trimmed, {
    allowFileUrls: true,
    allowSearchQueries: false,
  });
  if (!normalized.ok) {
    throw new Error(`cannot open this url (${normalized.reason}): ${trimmed}`);
  }
  return normalized.url;
}

/**
 * The open and tab-management acknowledgements share their live pane metadata.
 * (`EventDefinition` itself is not exported from the shared events module.)
 */
type PaneOpenAckChannel = typeof sessionOpenFileInPaneResultChannel | typeof sessionManageTabsResultChannel;

/**
 * The caller's own session and its mounted workspace, or a loud reason there is none.
 *
 * Every `open_in_tab` target needs this same answer — even the two that never touch the
 * file system, because the target is "this caller's pane" and a closed session has none.
 */
async function requireCallerWorkspace(context: SessionCallerContext, signal?: AbortSignal) {
  const caller = await callerRow(context);
  signal?.throwIfAborted();
  if (caller.archivedAt) throw new Error('current session is closed');
  if (!caller.workspaceId || caller.workspaceId !== context.workspaceId) {
    throw new Error('current session workspace is not ready');
  }
  const workspace = resolveWorkspace(context.projectId, caller.workspaceId);
  if (!workspace) throw new Error('current session workspace is not mounted');
  return workspace;
}

/**
 * #6264 咕咕 server 没有窗口:`open_in_tab` 不问本机渲染层(那里没有人,只会干等 10 秒超时),而是交给
 * 正看着这条会话的桌面(remote-pane.ts)。只在 server 上装(embedded-boot);桌面上始终是 null,走本机面板。
 */
type RemotePaneOpener = Pick<RemotePaneRoute, 'open'>;
let remotePaneOpener: RemotePaneOpener | null = null;

export function setRemotePaneOpener(opener: RemotePaneOpener | null): void {
  remotePaneOpener = opener;
}

type OpenInTabIntent = 'preview' | 'pinned';
/** 没人看着、已攒下:tab 下次有人打开这条会话时出现。 */
type QueuedOpen = { opened: false; queued: true; intent: OpenInTabIntent; note: string };

/**
 * Ask the resident task renderer to open something and wait for it to say whether it did.
 *
 * ❌ 不能把「事件已发出」当成功 —— 这条纪律三个目标共用，所以样板也共用一份：第三个目标
 * 进来时才发现它已经被抄了两遍，再抄第三遍就是让同一条纪律有三处可以各自失效。
 */
async function requestPaneOpen(
  ackChannel: PaneOpenAckChannel,
  what: string,
  emit: (requestId: string) => void,
  signal?: AbortSignal,
  timeoutMs: number | null = 10_000,
): Promise<SessionPaneTabsResult & { openedWith?: string | null; browserId?: string; created?: boolean }> {
  const requestId = randomUUID();
  return await new Promise<SessionPaneTabsResult & { openedWith?: string | null; browserId?: string; created?: boolean }>((resolve, reject) => {
    let dispose = () => {};
    const finish = (complete: () => void) => {
      if (timer) clearTimeout(timer);
      dispose();
      signal?.removeEventListener('abort', abort);
      complete();
    };
    const abort = () => finish(() => reject(signal?.reason));
    dispose = events.on(ackChannel, (result) => {
      if (result.requestId !== requestId) return;
      finish(() =>
        result.success
          ? resolve({ ...result })
          : reject(new Error(result.error || `renderer could not open the ${what}`)),
      );
    });
    const timer = timeoutMs === null ? null : setTimeout(
      () => finish(() => reject(new Error(`timed out waiting for the session pane to open the ${what}`))),
      timeoutMs,
    );
    timer?.unref?.();
    signal?.addEventListener('abort', abort, { once: true });
    emit(requestId);
  });
}

async function openFileInTab(
  context: SessionCallerContext,
  action: Extract<SessionAction, { action: 'open_in_tab'; path: string }>,
  signal?: AbortSignal,
): Promise<TabHygieneResult & (
  | { opened: true; path: string; opened_with?: string; intent: OpenInTabIntent }
  | (QueuedOpen & { path: string })
)> {
  signal?.throwIfAborted();
  const workspace = await requireCallerWorkspace(context, signal);

  const requestedPath = action.path.trim();
  if (!requestedPath) throw new Error('path is required');
  const absolutePath = isAbsoluteMachinePath(requestedPath)
    ? requestedPath
    : joinMachinePath(workspace.path, requestedPath);
  const stat = await workspace.fileSystem.stat(absolutePath);
  signal?.throwIfAborted();
  if (!stat.success) {
    throw new Error(stat.error.message || `file does not exist: ${requestedPath}`);
  }
  if (stat.data.type !== 'file') throw new Error(`path is not a file: ${requestedPath}`);
  const tabKind = action.app_tab ? claimingTab(action.app_tab.trim(), absolutePath) : undefined;

  if (remotePaneOpener) {
    if (tabKind) throw new Error(REMOTE_PANE_NO_EXTENSIONS);
    // 桌面那一格只读得到会话工作目录里的文件(远端工作区的边界):目录外的当场说清,❌ 推过去再开出一个打不开的 tab。
    if (!containsMachinePath(workspace.path, absolutePath)) throw new Error(describeOutsideWorkspace(workspace.path));
    const outcome = await remotePaneOpener.open(
      context.sessionId,
      { kind: 'file', path: absolutePath },
      action.intent,
      signal
    );
    // 攒着等人来看的也算打开过:人回来时它就在「输出」里(session-outputs.ts)。
    await recordSessionOutput(context.sessionId, { kind: 'file', path: absolutePath });
    return 'queued' in outcome
      ? { opened: false, queued: true, path: absolutePath, intent: action.intent, note: remotePaneQueuedNote(outcome) }
      : { opened: true, path: absolutePath, intent: action.intent, ...tabHygiene(outcome.tabs) };
  }

  // ❌ 宿主不决定「用什么打开这个文件」—— 那是解析层的事,住在 renderer 里,人点和 agent
  // 穿过同一个函数。宿主只验证路径,然后如实转述 renderer 实际开成了什么。在这里再判一次
  // 就是把同一条规则写成两份,今天一致,改一边就分岔。
  const ack = await requestPaneOpen(sessionOpenFileInPaneResultChannel, 'file', (requestId) => {
    events.emit(sessionOpenFileInPaneChannel, {
      requestId,
      projectId: context.projectId,
      sessionId: context.sessionId,
      path: absolutePath,
      external: !containsMachinePath(workspace.path, absolutePath),
      intent: action.intent,
      ...(tabKind ? { tabKind } : {}),
    });
  }, signal);

  await recordSessionOutput(context.sessionId, { kind: 'file', path: absolutePath });
  // Reported, never predicted: an agent that cannot tell a spreadsheet tab from a plain
  // file tab will describe the screen wrongly to the person looking at it.
  return ack.openedWith
    ? { opened: true, path: absolutePath, opened_with: ack.openedWith, intent: action.intent, ...tabHygiene(ack.tabs) }
    : { opened: true, path: absolutePath, intent: action.intent, ...tabHygiene(ack.tabs) };
}

/**
 * An App's `gugu.files.openWith({ session, id })` (真源原则 13): a file of that session's working copy opens in its pane by
 * the resolver a click goes through — or, with `ask`, every App that opens it and the person picks. Reported, not
 * predicted; refused when the person did not pick.
 */
export async function openSessionFileForApp(input: { projectId: string; sessionId: string; path: string; ask: boolean }): Promise<string | null> {
  const ack = await requestPaneOpen(sessionOpenFileInPaneResultChannel, 'file', (requestId) => {
    events.emit(sessionOpenFileInPaneChannel, {
      requestId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      path: input.path,
      external: false,
      intent: 'pinned',
      ...(input.ask ? { ask: true } : {}),
    });
  });
  await recordSessionOutput(input.sessionId, { kind: 'file', path: input.path });
  return ack.openedWith ?? null;
}

/**
 * 摩擦单 F122「Open it with X」: the tab named with a path is installed and claims that file in a session — the same claim the
 * person's own「用哪个打开」lists Apps by (`fileOpenersFor`). One that does not is told what it does claim.
 */
function claimingTab(requestedKind: string, absolutePath: string): string {
  const parsed = parseExtensionTabKind(requestedKind);
  if (!parsed) throw new Error(`app_tab must be "<App id>.<tab name>": ${requestedKind}`);
  const installed = extensionsService().list().extensions.find((entry) => entry.manifest.id === parsed.extensionId);
  if (!installed) throw new Error(`no installed App with id: ${parsed.extensionId}`);
  if (fileOpenersFor(absolutePath, [installed.manifest], 'session').some((opener) => opener.tabKind === requestedKind)) return requestedKind;
  const tab = installed.manifest.contributes.tabs.find((entry) => entry.name === parsed.tabName);
  const claims = tab ? claimedSuffixes(tab, 'session') : [];
  throw new Error(`${requestedKind} does not open this file: in a session it opens ${claims.length > 0 ? claims.join(', ') : 'no files'}`);
}

/**
 * #7191 给会话的 agent 开一个浏览器页签(它要操作网页而这条会话还一个页签都没有时)。
 * 与 `open_in_tab` 走同一条「请会话页打开、等它回话」的路,❌ 另起一条:开在哪、并排规则、
 * 会话页没挂着时先准备它,全都一样。没有窗口的咕咕 server 上没有页签可操作 —— 说出来,❌ 干等超时。
 */
export async function openAgentBrowserPane(
  target: { projectId: string; sessionId: string },
  url: string | undefined,
  signal?: AbortSignal,
  browserId?: string,
): Promise<string> {
  signal?.throwIfAborted();
  if (remotePaneOpener) throw new Error('this computer has no window: the browser tools only work for sessions on a desktop');
  const normalized = !url || url === 'about:blank' ? 'about:blank' : normalizeOpenInTabUrl(url);
  let acquisitionId: string | undefined;
  const ack = await requestPaneOpen(sessionOpenBrowserInPaneResultChannel, 'browser page', (requestId) => {
    acquisitionId = requestId;
    events.emit(sessionOpenBrowserInPaneChannel, {
      requestId,
      projectId: target.projectId,
      sessionId: target.sessionId,
      url: normalized,
      intent: 'pinned',
      acquire: { browserId, createIfMissing: url !== undefined, deadline: Date.now() + 9_000 },
    });
  }, signal).catch((error: unknown) => {
    if (acquisitionId) events.emit(sessionCancelBrowserAcquireChannel, { requestId: acquisitionId });
    throw error;
  });
  if (!ack.browserId) throw new Error('the session pane did not identify the browser tab it restored');
  // 空白页不是产出(会话还没有页签时先开的那一页);只记这一次新开出来的页。
  if (ack.created && normalized !== 'about:blank') await recordSessionOutput(target.sessionId, { kind: 'page', url: normalized });
  return ack.browserId;
}

async function openBrowserInTab(
  context: SessionCallerContext,
  action: Extract<SessionAction, { action: 'open_in_tab'; url: string }>,
  signal?: AbortSignal,
): Promise<TabHygieneResult & ({ opened: true; url: string; intent: OpenInTabIntent } | (QueuedOpen & { url: string }))> {
  signal?.throwIfAborted();
  const workspace = await requireCallerWorkspace(context, signal);

  // A file of a group (`gugu-file://<itemId>`, 摩擦单 F10) is no page to load: the window opens it in its group, where
  // the person is taken — the same as a click on that link in the chat. It goes the browser request's way there, with the
  // place a pill's link points at (`?v=`, `#…`) kept: the App that opens it is taken there too.
  const resource = parseGuguLink(action.url);
  const url = resource ? action.url : normalizeOpenInTabUrl(action.url);
  if (remotePaneOpener) {
    // localhost 的端口由桌面那一格经 SSH 转过去(remote-browser-tab);公网地址直接加载;
    // `file:` 网页由桌面那一格经会话工作区的读文件动词取来渲染 —— 只认工作目录里的文件,先在这里核清楚。
    if (url.startsWith('file:')) await requireRemotePageFile(workspace, url, signal);
    const outcome = await remotePaneOpener.open(context.sessionId, { kind: 'browser', url, ...(resource ? { linkTarget: resource } : {}) }, action.intent, signal);
    if (!resource) await recordSessionOutput(context.sessionId, { kind: 'page', url });
    return 'queued' in outcome
      ? { opened: false, queued: true, url, intent: action.intent, note: remotePaneQueuedNote(outcome) }
      : { opened: true, url, intent: action.intent, ...tabHygiene(outcome.tabs) };
  }
  const ack = await requestPaneOpen(sessionOpenBrowserInPaneResultChannel, 'browser URL', (requestId) => {
    events.emit(sessionOpenBrowserInPaneChannel, {
      requestId,
      projectId: context.projectId,
      sessionId: context.sessionId,
      url,
      ...(resource ? { linkTarget: resource } : {}),
      intent: action.intent,
    });
  }, signal);
  // 群文件夹里的文件开在它的群里,它在那里有自己的位置,❌ 记成这条会话的产出。
  if (!resource) await recordSessionOutput(context.sessionId, { kind: 'page', url });
  return { opened: true, url, intent: action.intent, ...tabHygiene(ack.tabs) };
}

/**
 * #6264 咕咕 server 上 `file:` 网页的前置核对:桌面那一格只取得到会话工作目录里的文件(读文件动词的边界),
 * 目录外的 / 不存在的 / 不是文件的当场说清,❌ 推过去再开出一个打不开的页。
 */
async function requireRemotePageFile(
  workspace: NonNullable<ReturnType<typeof resolveWorkspace>>,
  url: string,
  signal?: AbortSignal
): Promise<void> {
  const path = fileUrlToMachinePath(url);
  if (!path) throw new Error(REMOTE_PANE_PAGE_NOT_FILE);
  if (!containsMachinePath(workspace.path, path)) throw new Error(describePageOutsideWorkspace(workspace.path));
  const stat = await workspace.fileSystem.stat(path);
  signal?.throwIfAborted();
  if (!stat.success || stat.data.type !== 'file') throw new Error(REMOTE_PANE_PAGE_NOT_FILE);
}

async function openExtensionInTab(
  context: SessionCallerContext,
  action: Extract<SessionAction, { action: 'open_in_tab'; app_tab: string }>,
  signal?: AbortSignal,
): Promise<TabHygieneResult & { opened: true; app_tab: string; intent: OpenInTabIntent }> {
  signal?.throwIfAborted();
  // 咕咕 server 没有窗口,扩展在它上面跑不起来:当场说清,❌ 等 10 秒超时。
  if (remotePaneOpener) throw new Error(REMOTE_PANE_NO_EXTENSIONS);
  await requireCallerWorkspace(context, signal);

  // Verified against what is actually installed, the way a path is verified against the
  // real file system. An unchecked kind reaches the pane as an unknown runtime kind and
  // renders an unavailable tab — a tab that opened, so a reported success, showing nothing.
  const requestedKind = action.app_tab.trim();
  if (!requestedKind) throw new Error('app_tab is required');
  const parsed = parseExtensionTabKind(requestedKind);
  if (!parsed) {
    throw new Error(`app_tab must be "<App id>.<tab name>": ${requestedKind}`);
  }
  const installed = extensionsService()
    .list()
    .extensions.find((entry) => entry.manifest.id === parsed.extensionId);
  if (!installed) throw new Error(`no installed App with id: ${parsed.extensionId}`);
  const tab = installed.manifest.contributes.tabs.find((entry) => entry.name === parsed.tabName);
  if (!tab) {
    throw new Error(`App ${parsed.extensionId} contributes no tab named: ${parsed.tabName}`);
  }
  // A tab that opens files has no tab of its own (摩擦单 F95): it opens for a file. Opened bare it would be a page with no
  // file, its App erring on screen, closed again at once — said here instead, with the way to open it (摩擦单 F105).
  const contexts = declaredContexts(tab);
  if (contexts.length > 0) {
    const how = contexts.map((where) =>
      where === 'session' ? 'a file of this session: session_open_in_tab path=<the file>' : "a group's file: session_open_in_tab url=<its gugu-file:// link>",
    );
    throw new Error(`${requestedKind} opens files and has no tab of its own; open the file instead — ${how.join('; ')}`);
  }
  const ack = await requestPaneOpen(sessionOpenExtensionInPaneResultChannel, 'App tab', (requestId) => {
    events.emit(sessionOpenExtensionInPaneChannel, {
      requestId,
      projectId: context.projectId,
      sessionId: context.sessionId,
      tabKind: requestedKind,
      intent: action.intent,
    });
  }, signal);
  return { opened: true, app_tab: requestedKind, intent: action.intent, ...tabHygiene(ack.tabs) };
}

/**
 * #7317 Bring up an App's pages that are one per task (`perSession`) in this task, beside the conversation — when the task's
 * agent first uses the App's program (Computer Use's 「电脑」), the way a browser tab comes up for Browser Use. The same
 * request-and-wait as `open_in_tab`; one already open anywhere in the task stays where it is, and the tab the person is
 * looking at stays in front. Resolves with the tab kinds it brought up.
 */
export async function openTaskPagesOfApp(
  target: { projectId: string; sessionId: string },
  extensionId: string,
  signal?: AbortSignal,
): Promise<string[]> {
  if (remotePaneOpener) throw new Error(REMOTE_PANE_NO_EXTENSIONS);
  const installed = extensionsService()
    .list()
    .extensions.find((entry) => entry.manifest.id === extensionId);
  if (!installed) throw new Error(`no installed App with id: ${extensionId}`);
  const kinds = installed.manifest.contributes.tabs.filter((tab) => tab.perSession).map((tab) => extensionTabKind(extensionId, tab.name));
  for (const tabKind of kinds) {
    await requestPaneOpen(sessionOpenExtensionInPaneResultChannel, 'App tab', (requestId) => {
      events.emit(sessionOpenExtensionInPaneChannel, { requestId, ...target, tabKind, intent: 'pinned', ifAbsent: true });
    }, signal);
  }
  return kinds;
}

/**
 * #6387 Bring an extension tab on screen because the person asked from outside the task
 * page — they clicked the extension's banner or a `gugu://ext/…` link. Navigates to the
 * task and reuses a tab of that kind already open there; resolves once the renderer
 * says the tab is showing, so a caller can hand the tab what the click was about.
 */
export async function revealExtensionTabInSession(target: {
  projectId: string;
  sessionId: string;
  tabKind: string;
  tabId?: string;
}): Promise<void> {
  await requestPaneOpen(sessionOpenExtensionInPaneResultChannel, 'App tab', (requestId) => {
    events.emit(sessionOpenExtensionInPaneChannel, {
      requestId,
      projectId: target.projectId,
      sessionId: target.sessionId,
      tabKind: target.tabKind,
      intent: 'pinned',
      reveal: true,
      ...(target.tabId ? { tabId: target.tabId } : {}),
    });
  });
}

/** Per-recipient verdict for the unified `session_message` — the graph-addressed (`session:`) leg. */
export type SessionDirectRecipientResult = {
  /** Typed recipient address, exactly as the caller may reuse it. */
  to: string;
  /** `deferred`: kept, to be sent when the target next starts working (delivery "defer"). */
  status: 'delivered' | 'deferred' | 'failed';
  message_id?: string;
  error?: { code: string; message: string };
};

/** What the sender asked for: `queue` (read by the ACP adapter) or `defer` (kept until the target starts working). */
type MessagePlan =
  | { queue: SessionMessageDelivery }
  | { defer: { key?: string } }
  | null;

/**
 * The sender's `delivery` / `key`. The key is scoped to its sender (`keyScope`: the sending session, or the App), so
 * one sender's key never replaces another's message.
 */
function messagePlan(
  action: Extract<SessionAction, { action: 'message' }>,
  keyScope: string,
): MessagePlan {
  if (action.delivery !== undefined && action.delivery !== 'queue' && action.delivery !== 'defer') {
    throw new Error(`delivery must be "queue" or "defer" (got ${JSON.stringify(action.delivery)})`);
  }
  if (action.key !== undefined && (typeof action.key !== 'string' || !action.key)) throw new Error('key must be a non-empty string');
  if (action.key !== undefined && action.delivery === undefined) {
    throw new Error('key replaces a message that is still waiting, so it needs { queue: true } or { defer: true }');
  }
  const key = action.key ? `${keyScope}:${action.key}` : undefined;
  if (action.delivery === 'queue') return { queue: { queue: true, ...(key ? { coalesceKey: key } : {}) } };
  if (action.delivery === 'defer') return { defer: key ? { key } : {} };
  return null;
}

/**
 * Everything a message is refused for before anything is sent.
 * 全部目标在任何副作用前一次性解析(spec delivery-routing):地址错误在第一次注入前就响亮失败,不给「一半已投、
 * 一半被拒」留形状。live 与否不是地址错误,逐收件人在注入时独立判。排队靠会话机的队列;终端会话的输入直接进引擎,
 * 咕咕扣不住 —— 与地址错误一样在任何注入之前拒绝。附带不经会话机(它存在咕咕这一侧、按普通发送投出),终端照收。
 */
function checkedMessage(
  action: Extract<SessionAction, { action: 'message' }>,
  keyScope: string,
  rows: SessionRow[],
  callerSessionId: string | null,
): { targets: SessionRow[]; plan: MessagePlan } {
  const plan = messagePlan(action, keyScope);
  if (action.then !== undefined && !SESSION_MESSAGE_THEN.includes(action.then)) {
    throw new Error(`then must be one of ${SESSION_MESSAGE_THEN.map((value) => `"${value}"`).join(', ')} (got ${JSON.stringify(action.then)})`);
  }
  if (action.reply_to_message_id !== undefined && !SESSION_MESSAGE_REPLY_TO.test(action.reply_to_message_id)) {
    throw new Error(`reply_to_message_id must be a msg:<uuid> as a delivery's msg gives it (got ${JSON.stringify(action.reply_to_message_id).slice(0, 80)})`);
  }
  if (action.work_result !== undefined) workReportSchema.parse(action.work_result);
  if (action.client_message_id !== undefined && (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(action.client_message_id)
    || action.session_ids.length !== 1 || !action.client_message_at || !Number.isFinite(Date.parse(action.client_message_at)))) {
    throw new Error('Account outbox delivery requires one recipient, a stable UUID and timestamp');
  }
  const targets = [...new Set(action.session_ids)].map((sessionId) =>
    assertMessageableTarget(rows, callerSessionId, resolveSessionRow(rows, sessionId)),
  );
  const terminal = plan && 'queue' in plan ? targets.filter((target) => transportOf(target) !== 'acp') : [];
  if (terminal.length) {
    throw new Error(
      `${terminal.map((target) => encodeTypedId('session', target.id)).join(', ')} is a terminal session: delivery "queue" `
      + 'is not supported there — its input goes straight into the engine and gugu cannot hold it back. '
      + 'Nothing was sent; send without it, or with { defer: true }.',
    );
  }
  return { targets, plan };
}

async function sendSessionMessage(
  /** 本机发起方的会话 id;发起方在别的机器上时为 null(它不在本机的行里)。 */
  callerSessionId: string | null,
  envelope: DeliveryEnvelope,
  action: Extract<SessionAction, { action: 'message' }>,
  /** Who is sending, for scoping `key`: `session:<id>` or `app:<id>`. */
  keyScope: string,
  rows: SessionRow[],
  signal?: AbortSignal,
): Promise<{ recipients: SessionDirectRecipientResult[] }> {
  signal?.throwIfAborted();
  if (!action.text.trim()) throw new Error('message text is required');
  const report = action.work_result ? workReportSchema.parse(action.work_result) : null;
  const text = withSessionAttachments(withActivitySource(action.text.trim(), action.source_link), action.attachments)
    + (report ? `\n<gugu_work_result>\n${JSON.stringify(report)}\n</gugu_work_result>` : '');
  if (!text) throw new Error('message text is required');
  if (!Array.isArray(action.session_ids) || action.session_ids.length === 0) {
    throw new Error('message requires at least one session target');
  }
  const { targets, plan } = checkedMessage(action, keyScope, rows, callerSessionId);
  const recipients: SessionDirectRecipientResult[] = [];
  for (const target of targets) {
    signal?.throwIfAborted();
    const messageId = action.client_message_id ?? sessionDirectMessageId(keyScope, target.id, action);
    try {
      if (action.source_link) await rememberActivitySource(target.id, action.source_link);
      // Another recipient or source bookkeeping may have yielded since preflight.
      // Check the committed row immediately before storing even a deferred message.
      const current = db.select({ archivedAt: sessions.archivedAt }).from(sessions).where(eq(sessions.id, target.id)).get();
      if (!current) throw new Error(`Session not found: ${target.id}`);
      if (current.archivedAt) throw new SessionArchivedError();
      // 附带:目标已经在运行中就当场按普通发送投出;否则存下来(不叫醒),等它进入运行中那一刻再投(session-deferred-messages.ts)。
      if (plan && 'defer' in plan && !sessionIsWorking(target.id)) {
        storeDeferredMessage({ sessionId: target.id, id: messageId, text: envelope(messageId, text), ...plan.defer });
        recipients.push({ to: encodeTypedId('session', target.id), status: 'deferred', message_id: messageId });
        // 存下之前那一瞬刚进入运行中的,边沿已经过去了:再看一次,在跑就当场冲。
        if (sessionIsWorking(target.id)) void flushDeferredMessages(target.id);
        continue;
      }
      const result = await sendMessage({
        projectId: target.projectId,
        sessionId: target.id,
        clientMessageId: messageId,
        text: envelope(messageId, text),
        kind: 'session-direct',
        ...(signal ? { signal } : {}),
        ...(plan && 'queue' in plan ? { delivery: plan.queue } : {}),
      });
      const admitted = result.status === 'delivered' || (action.client_message_id !== undefined && result.status === 'accepted');
      recipients.push({
        to: encodeTypedId('session', target.id),
        status: admitted ? 'delivered' : 'failed',
        message_id: result.id,
        ...(admitted
          ? {}
          : {
              error: result.status === 'outcome-unknown'
                // 耐久收据停在 dispatching = **仍在飞**,不是失败。塌成 failed 会诱发重发,
                // 所以它有自己的码;调用方要重试得先自己判幂等。
                ? { code: 'SESSION_DIRECT_OUTCOME_UNKNOWN', message: 'delivery is still in flight — the durable receipt has not settled' }
                : result.status === 'queued'
                  ? { code: 'SESSION_DIRECT_QUEUED', message: 'message is durably queued but has not been admitted' }
                  : { code: 'SESSION_DIRECT_DELIVERY_FAILED', message: `delivery ended in status ${result.status}` },
            }),
      });
      if (admitted && report && keyScope.startsWith('session:')) {
        try { receiveAssistantWorkReport(target.id, keyScope.slice('session:'.length), report, result.id); }
        catch (error) { log.error('assistant result received but recovery metadata could not be updated', { sessionId: target.id, error: String(error) }); }
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      // 本工具的合同是「每个收件人各自有一句判决」。所以**一旦有人已经收到,这个调用就不许再抛** ——
      // 抛出去会把已投递的那几个连同它们的 message_id 一起丢掉,调用方无从知道谁收到了。
      // 还没有人收到时照旧抛:那时没有要保护的部分结果,响亮失败更清楚。
      if (error instanceof SessionDirectDeliveryError || error instanceof SessionArchivedError) {
        recipients.push({
          to: encodeTypedId('session', target.id),
          status: 'failed',
          error: { code: error.code, message: error.message },
        });
        continue;
      }
      if (!recipients.some((entry) => entry.status !== 'failed')) throw error;
      recipients.push({
        to: encodeTypedId('session', target.id),
        status: 'failed',
        error: { code: 'SESSION_DIRECT_HOST_ERROR', message: error instanceof Error ? error.message : String(error) },
      });
    }
  }
  return { recipients };
}

/**
 * 不是会话的发信方(这台电脑上的 App:不在 chat 里的 `gugu.dispatch`)告诉一条会话一件事:与
 * `session_message` 的 `session:` 腿同一条投递 —— 收不进就照常唤醒(停过的、被回收的,带着历史接回来)再投。
 * 发起方会话只在 agent 操作 App 页面时有(`from`,它不能发给自己);否则与别的机器上的发起方一样是 null。信封由发信方
 * 那一侧给,这里只管投。送达回 message id,否则带原因抛。
 */
export async function messageSessionFrom(
  envelope: DeliveryEnvelope,
  sessionId: string,
  text: string,
  /** `queue` / `key` exactly as `session_message` takes them; `keyScope` names the sender (`app:<id>`). */
  options: AppMessageOptions,
): Promise<{ id: string; deferred?: true }> {
  const action = appMessage(sessionId, text, options);
  const stored = options.receipt ? readAcceptedMessage(sessionDirectMessageId(options.keyScope, sessionId, action)) : undefined;
  const durableEnvelope: DeliveryEnvelope = stored ? () => stored.content : envelope;
  const { recipients } = await sendSessionMessage(options.from ?? null, durableEnvelope, action, options.keyScope, await allSessionRows());
  const [result] = recipients;
  if (result?.status === 'failed' || !result?.message_id) {
    throw Object.assign(new Error(result?.error?.message ?? `the message to session ${sessionId} was not delivered`), { code: result?.error?.code });
  }
  return { id: result.message_id, ...(result.status === 'deferred' ? { deferred: true as const } : {}) };
}

/** `from`: the session of the agent that works the App's page (owner 10-14) — it is the one telling, so not itself. */
type AppMessageOptions = { delivery?: 'queue' | 'defer'; key?: string; keyScope: string; from?: string; receipt?: { id: string; at: string } };

function appMessage(sessionId: string, text: string, options: AppMessageOptions): Extract<SessionAction, { action: 'message' }> {
  return {
    action: 'message',
    session_ids: [sessionId],
    text,
    ...(options.receipt ? { delivery_id: options.receipt.id, delivery_at: options.receipt.at } : {}),
    ...(options.delivery ? { delivery: options.delivery } : {}),
    ...(options.key !== undefined ? { key: options.key } : {}),
  };
}

export async function runSessionAction(
  context: SessionCallerContext,
  action: SessionAction,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  if (isProjectAgentAction(action)) return runProjectAgentAction(context, action);
  if (isLibraryAgentAction(action)) return runLibraryAgentAction(action);
  if (isActivityAction(action)) return runActivityAction(action);
  const caller = await callerRow(context);
  signal?.throwIfAborted();

  if ((action.action === 'spawn' || action.action === 'message' || action.action === 'ask_user')
    && !action.source_link && transportOf(caller) === 'acp') {
    const source = await readCurrentActivitySource(caller.id);
    signal?.throwIfAborted();
    if (source) action = { ...action, source_link: source };
  }

  if (action.action === 'list_harnesses') {
    const childDefault = await callerChildHarnessDefault(caller.id, caller.provider ?? null);
    return {
      current_harness: caller.provider ?? 'unknown',
      // #7199 session_spawn 不传 harness 时用哪个:配了子 agent 默认就是它,没配就是 current_harness。
      spawn_default_harness: childDefault ?? caller.provider ?? 'unknown',
      harnesses: await listLocalHarnesses(),
    };
  }

  if (action.action === 'list_models') {
    const harness = action.harness?.trim() || caller.provider;
    if (!harness) throw new Error('current session has no harness; pass harness from session_list_harnesses');
    // transport 的默认与 spawn 的默认是**同一条**(继承 caller):这样「查到什么就能 spawn 什么」
    // 在省略参数时也成立。咕咕那一组按 provider × transport 算(qoder 的 acp 腿一个都没有、
    // tui 腿有),两处默认不同就会让 agent 照着一条腿的目录去起另一条腿的会话。
    return listLocalModels(harness, {
      force: action.force === true,
      transport: action.transport ?? transportOf(caller),
    });
  }

  if (action.action === 'spawn') return spawnSession(context, action, caller, signal);
  if (action.action === 'ask_user') {
    if (action.source_link && !parseConversationLink(action.source_link)?.messageId) throw new Error('Invalid question source');
    const { postAgentQuestion } = await import('./agent-question');
    signal?.throwIfAborted();
    return postAgentQuestion({ sessionId: caller.id, projectId: caller.projectId, questions: action.questions, sourceLink: action.source_link });
  }

  if (action.action === 'schedule_create' || action.action === 'schedule_list' || action.action === 'schedule_cancel') {
    // 到点是把交代当一条消息送回来:这条腿收不进消息,排上了也送不到,当场说。
    if (action.action === 'schedule_create') assertMessageableTarget([caller], null, caller);
    // 动态取:已安排那一侧到点要回头用本模块投递,静态互相 import 会成环。
    const { runAgentScheduleAction } = await import('../automations/agent-schedules');
    return runAgentScheduleAction(
      { sessionId: caller.id, projectId: caller.projectId, provider: caller.provider ?? null },
      action,
    );
  }
  if (action.action === 'list_tabs' || action.action === 'close_tab') {
    await requireCallerWorkspace(context, signal);
    const tabId = action.action === 'close_tab' ? action.tab_id : undefined;
    const result = remotePaneOpener
      ? await remotePaneOpener.open(context.sessionId, tabId === undefined ? { kind: 'tabs' } : { kind: 'close-tab', tabId }, 'pinned', signal)
      : await requestPaneOpen(sessionManageTabsResultChannel, 'tabs', (requestId) => {
          events.emit(sessionManageTabsChannel, { requestId, projectId: context.projectId, sessionId: context.sessionId, ...(tabId === undefined ? {} : { tabId }) });
        }, signal, tabId === undefined ? 10_000 : null);
    if (!('tabs' in result) || !result.tabs) throw new Error('This Gugu window did not return live tabs. Update Gugu and retry.');
    return { tabs: result.tabs, tab_count: result.tabs.length, ...('closed' in result ? { closed: result.closed } : {}) };
  }
  if (action.action === 'open_in_tab') {
    if ('url' in action) return openBrowserInTab(context, action, signal);
    return 'path' in action ? openFileInTab(context, action, signal) : openExtensionInTab(context, action, signal);
  }

  // `session:<id>` 够得着这台机器上任一项目里的会话(宿主已把别的机器上的地址转走)。
  const rows = await allSessionRows();
  signal?.throwIfAborted();

  if (action.action === 'message') {
    const sender = await localEnvelopeSender(caller);
    return sendSessionMessage(caller.id, (id, said) => sessionDirectEnvelope(sender, id, said, action), action, `session:${caller.id}`, rows, signal);
  }
  return runTargetAction(caller, action, rows, signal);
}

/**
 * 这条会话的 child = 挂在它下面的(父会话这条边,与侧栏建树同一个 `sessionParentId`;父会话可以在别的机器上)。
 * 派出去但没挂的不算:那是给人用的,`spawned_by_session_id` 只当来历报(owner 10-08)。
 */
function childrenOf(rows: SessionRow[], parentSessionId: string): SessionRow[] {
  return rows.filter((row) => sessionParentId(row) === parentSessionId);
}

async function listChildren(rows: SessionRow[], parentSessionId: string, signal?: AbortSignal): Promise<SessionSnapshot[]> {
  const summaries = await readAcpSessionSummaries();
  signal?.throwIfAborted();
  const children = await Promise.all(
    childrenOf(rows, parentSessionId).map(async (row) => snapshot(row, summaries, await sessionModel(row))),
  );
  return children.sort(byLastActiveDesc);
}

/** 指名一条会话的动作。发起方在别的机器上时 session_id 必须给(children 省略 = 这台上挂在它下面的那些)。 */
async function runTargetAction(
  caller: SessionRow | RemoteSessionCaller,
  action: Extract<SessionAction, { action: 'children' | 'get' | 'stop' | 'archive' | 'set_parent' }>,
  rows: SessionRow[],
  signal?: AbortSignal,
): Promise<unknown> {
  const local = 'projectId' in caller ? caller : null;
  const callerSessionId = 'projectId' in caller ? caller.id : caller.sessionId;

  // 父会话可以在别的机器上(它派来、挂在它下面的 child 在这台):这里只按 id 查,存不存在由发起方那边先问过。
  if (action.action === 'children') return listChildren(rows, action.session_id ?? callerSessionId, signal);

  if (action.session_id === undefined && !(action.action === 'get' && local)) {
    throw new Error(`${action.action} needs session_id`);
  }
  const target = action.session_id === undefined ? local! : resolveSessionRow(rows, action.session_id);
  if (action.action !== 'get' && action.action !== 'set_parent') refuseItself(action.action, target.id, callerSessionId);

  if (action.action === 'set_parent') {
    signal?.throwIfAborted();
    const { parent_session_id, not_reached } = await setSessionParent(target.id, action.parent_session_id);
    return {
      session_id: target.id,
      parent_session_id,
      ...(not_reached.length > 0 ? { not_reached } : {}),
    };
  }

  if (action.action === 'get') {
    const summaries = await readAcpSessionSummaries();
    signal?.throwIfAborted();
    return { ...snapshot(target, summaries, await sessionModel(target)), preview: await sessionPreview(target.id) };
  }

  if (action.action === 'stop') {
    signal?.throwIfAborted();
    await stopSessionTransport(target);
    const { withdrawAll } = await import('../asks');
    withdrawAll(target.id, 'agent-question');
    signal?.throwIfAborted();
    // #6095 —— 回执要是 stop **之后**的状态。两件事让它成立:
    //   ① transport 那一步已经把「被打断」经状态写入者落了库(pty 在 stopSession 里、ACP 在
    //      stopSessionTransport 里),所以这里重读的行不是调用瞬间的旧快照;
    //   ② summaries 要读**真的那一份**。此前这里传 `{}`,于是 ACP 会话 stop 完永远回
    //      `unknown` —— 那不是一个读数,是「我没读」披着读数的皮,而一毫秒后的 `session_get`
    //      会对同一条会话给出另一个答案。
    const [fresh, summaries] = await Promise.all([
      projectSessionRows(target.projectId),
      readAcpSessionSummaries(),
    ]);
    const refreshed = fresh.find((row) => row.id === target.id);
    signal?.throwIfAborted();
    if (!refreshed) throw new Error('session disappeared after stop');
    return snapshot(refreshed, summaries, await sessionModel(refreshed));
  }

  if (action.action === 'archive') {
    // spec session-graph:agent 收起会话只有归档,走人在会话页点的同一个 `archiveSession`(范围 =
    // 确认框里那个「连同子会话」勾选),人能在会话历史里恢复。归档不删 task 也不删工作目录,所以没有
    // 「工作目录不许一个 task 都不剩」那道闸。❌ 给 agent 删除:删除永久、撤不回来,只归人(owner 2026-09-28)。
    signal?.throwIfAborted();
    const withChildren = action.with_children === true;
    const { archived, unreached } = await archiveSession(target.projectId, target.id, { withChildren, removeSocialIdentity: action.remove_social_identity });
    signal?.throwIfAborted();
    if (archived.length === 0) throw new Error('session is already archived');
    return {
      session_id: target.id,
      archived: true,
      with_children: withChildren,
      // 清单是这一次真正收走的行(含别的机器上的),点名的那条在最后。
      children_archived: archived.length - 1,
      // 够不着的机器上由这棵树派出去的 child 原样留着,要说出来。
      ...(unreached.length > 0 ? { not_reached: unreached.map((machine) => machine.detail) } : {}),
    };
  }

  // 不认识的动作名当场拒绝:没有落空的默认分支(此前落空的是 wait,删掉以后不能让归档接手)。
  throw new Error(`${(action as { action: string }).action} is not a session action`);
}

/** 本机发起方在跨机器请求里的自述;机器与 Agent ID 由宿主补。 */
export async function sessionCallerFacts(
  context: SessionCallerContext,
): Promise<Pick<RemoteSessionCaller, 'sessionId' | 'name' | 'harness' | 'childHarness' | 'transport' | 'model' | 'platformModel'>> {
  const caller = await callerRow(context);
  const sender = await localEnvelopeSender(caller);
  const platform = await sessionPlatformModel(caller.id);
  return {
    sessionId: caller.id,
    name: sender.title,
    harness: caller.provider ?? null,
    childHarness: (await callerChildHarnessDefault(caller.id, caller.provider ?? null)) ?? null,
    transport: transportOf(caller),
    model: caller.config?.model ?? null,
    platformModel: platform ? platformOptionId(platform.modelId) : null,
  };
}

/**
 * 别的机器上的会话交给这台执行的 session 动作(owner 2026-09-30 拍板跨机器):与本机工具同一份实现,
 * 凡本机从发起方行上读的都改读请求带来的自述。
 */
export async function runRemoteSessionAction(
  caller: RemoteSessionCaller,
  action: SessionAction | { action: 'locate'; session_ids: string[] },
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  if (isProjectAgentAction(action)) return runProjectAgentAction({}, action);
  if (isLibraryAgentAction(action)) return runLibraryAgentAction(action);
  if (isActivityAction(action)) return runActivityAction(action);


  if (action.action === 'locate') return { session_ids: await localSessionIds(action.session_ids) };

  if (action.action === 'list_harnesses') {
    return {
      current_harness: caller.harness ?? 'unknown',
      spawn_default_harness: caller.childHarness || caller.harness || 'unknown',
      harnesses: await listLocalHarnesses(),
    };
  }

  if (action.action === 'list_models') {
    const harness = action.harness?.trim() || caller.harness;
    if (!harness) throw new Error('the calling session has no harness; pass harness from session_list_harnesses');
    return listLocalModels(harness, { force: action.force === true, transport: action.transport ?? caller.transport });
  }

  if (action.action === 'spawn') return spawnForRemoteCaller(caller, action, signal);
  if (action.action === 'ask_user') throw new Error('session_ask_user asks in the calling agent conversation; it cannot target another machine');

  if (action.action === 'list_tabs' || action.action === 'close_tab') {
    throw new Error('Tab tools only operate on the calling session’s own task; they cannot target another machine.');
  }
  if (action.action === 'open_in_tab') {
    throw new Error('session_open_in_tab opens a tab in the calling session\'s own pane; it has no meaning on another machine');
  }
  if (action.action === 'schedule_create' || action.action === 'schedule_list' || action.action === 'schedule_cancel') {
    throw new Error(`${action.action} works on the machine the calling session runs on; it has no meaning on another machine`);
  }

  const rows = await allSessionRows();
  signal?.throwIfAborted();
  if (action.action === 'message') {
    const sender = remoteEnvelopeSender(caller);
    return sendSessionMessage(null, (id, said) => sessionDirectEnvelope(sender, id, said, action), action, `session:${caller.sessionId}`, rows, signal);
  }
  return runTargetAction(caller, action, rows, signal);
}

async function spawnForRemoteCaller(
  caller: RemoteSessionCaller,
  action: Extract<SessionAction, { action: 'spawn' }>,
  signal?: AbortSignal,
): Promise<SessionSnapshot> {
  const ledger = createStageLedger({
    scope: 'sessionpage/session-spawn',
    what: 'remote session spawn action',
    fields: { callerSessionId: caller.sessionId, callerDeviceId: caller.deviceId },
    budgetMs: SPAWN_ACTION_BUDGET_MS,
  });
  const prompt = action.prompt.trim();
  if (!prompt) throw new Error('prompt is required');
  // 与本机同一条默认(spawnedBy):挂在发起会话下面(它在别的机器上,记在 config 里),点没点名项目都一样。
  const named = namedPlacement(action);

  // 工作目录:点名了项目用那个项目的根工作区;没点名用这台机器的隐式主目录项目 —— 与会话页新建会话同一步
  // (projectRootPlacement)。
  const { projectId, workspaceId } = await projectRootPlacement(
    named ?? {},
    named ? `project ${named.project_path ?? named.project_id} on this machine` : 'this machine\'s home project',
  );
  signal?.throwIfAborted();

  const transport: SessionRuntime = action.transport ?? caller.transport;
  // #7199 没传 harness:先用发起方 agent 配的子 agent 默认(随自述带来,与本机 spawn 同一条规则),没配才继承。
  const configuredHarness = action.harness?.trim() ? undefined : caller.childHarness?.trim() || undefined;
  const requestedHarness = action.harness?.trim() || configuredHarness;
  const inheritedHarness = caller.harness?.trim() || undefined;
  if (!requestedHarness && !inheritedHarness) {
    throw new Error('the calling session has no harness to inherit; pass harness from session_list_harnesses with device');
  }
  // 继承来的 / 配置来的 harness 是另一台机器的事实,这台未必提供 ⇒ 同样过「提供」这道闸,并说清从哪来的。
  const harnessId = requestedHarness ?? inheritedHarness!;
  let provider: AgentProviderId;
  try {
    provider = assertOfferedHarness(harnessId);
  } catch {
    const source = configuredHarness
      ? " (the calling agent's default for sub-agents)"
      : requestedHarness ? '' : ' (inherited from the calling session)';
    throw new Error(
      `harness '${harnessId}'${source} is not offered on this machine; `
      + 'pick one from session_list_harnesses with the same device',
    );
  }
  await assertSpawnableSurface(provider, transport);

  // 模型:显式给了按本机规则解释;没给就继承 —— 平台模型在这台机器的目录里再核一遍(❌ 悄悄落成 BYOK)。
  const requestedModel = action.model?.trim() || undefined;
  const inheritModel = !requestedHarness && !requestedModel;
  const modelToResolve = requestedModel ?? (inheritModel ? caller.platformModel ?? undefined : undefined);
  // 点名了 harness、没点模型:发起方的平台模型这台机器上那家也有就跟过去(carriedPlatformModel)。
  const carried = requestedHarness && !requestedModel
    ? await carriedPlatformModel(caller.platformModel, provider, transport)
    : null;
  const selection = carried ?? (await resolveSpawnModelSelection(provider, transport, modelToResolve));
  signal?.throwIfAborted();

  const { relations, not_reached } = await spawnedBy({
    deviceId: caller.deviceId,
    sessionId: caller.sessionId,
    ...(caller.agentUserId ? { agentUserId: caller.agentUserId } : {}),
    ...(caller.name ? { name: caller.name } : {}),
  }, action.parent_session_id, action.assistant_work?.child_session_id);
  const row = await createChildSession({
    ledger,
    projectId,
    workspaceId,
    provider,
    transport,
    prompt,
    title: action.title,
    sourceLink: action.source_link,
    assistantWork: action.assistant_work,
    envelope: envelopeOf(remoteEnvelopeSender(caller)),
    ...(action.chat_id ? { birthGroup: { chatId: action.chat_id, asTask: true } } : {}),
    model: selection.kind === 'gugu'
      ? undefined
      : selection.model ?? (inheritModel ? caller.model ?? undefined : undefined),
    platformModel: selection.kind === 'gugu' ? { modelId: selection.modelId } : inheritModel && !caller.model ? undefined : null,
    relations,
    signal,
  });
  return {
    ...snapshot(row, {}, await sessionModel(row)),
    ...(not_reached.length ? { not_reached } : {}),
    ...(action.assistant_work ? {assistant_work_target:{session_id:row.id,device_id:(await assistantWorkLedgerContext()).deviceId}} : {}),
    // 发起方与 child 不在同一台机器、也不在同一个项目群里:往来只有点对点这一条。
    message_route: { tool: 'session_message', to: [encodeTypedId('session', row.id)] },
  };
}
