import { createNativeRecordReader } from './native-record';
import { ask, withdrawAll } from '../asks';
import { hostAsks, resetAsks, respond as respondAsk, respondQuestion as respondAskQuestion } from '../asks/ask';
import { askSourceSpec } from '../asks/sources';
import { readAgentQuestionRecords, rememberAgentQuestion } from '../sessions/agent-question-store';
import { nativeConversationAliases, nativeConversationUnread } from '../sessions/session-conversation-read';
import { nativeConversationActivity } from '../sessions/session-conversation-activity';
import { deliverAgentQuestionAnswer, restoredAgentQuestion } from '../sessions/agent-question-delivery';
import { and, eq, isNull } from 'drizzle-orm';
import { readProjects } from '@main/core/projects/operations/getProjects';
import { isImplicitSessionHomeProjectId } from '@shared/core/projects/session-home-project';
import { resolveAgentHome } from '@gugu/session-core/agents/plugins/helpers';
import { isVisibleQueuedPrompt } from '@shared/core/sessions/visible-queued-prompt';
import { conversationQueueText } from '@shared/core/sessions/conversation-queue-text';
import type { OpenedOutput, ToolImage } from '@gugu/session-core/acp/client';
import {
  findToolImage,
  type RecordCursor,
  type RecordLineageNode,
  type SessionRecordLocator,
  type SessionTimeline,
  type PendingRequest,
  type Settlement,
  type SessionpageProjectSummary,
  type SessionpageSessionEvent,
  type SessionpageSessionRespondRequest,
  type SessionpageSessionRespondResult,
  type SessionpageSessionCancelResult,
  type SessionpageSessionUpdateRequest,
  type SessionpageSessionUpdateResult,
  type SessionpageSessionSubscribeRequest,
  type SessionpageSessionSummary,
  type SessionpageSessionsListResult,
  type SessionpageSessionOptions,
  type SessionpageSessionsEvent,
  type SessionpageSessionSetOptionRequest,
  type SessionpageSessionReloadModelRequest,
  type SessionpageOpenedFileReadRequest,
  type SessionpageOpenedFileChunk,
  type SessionpageSessionToolImageRequest,
  type TimelineAfterResult,
  type TimelineOlderResult,
  type TimelineSnapshot,
} from '@gugu/session-core/session-record';
import { sessionListDelta } from '@gugu/session-core/session-record/session-list-delta';
import { SessionOptionsError, readSessionOptions, setSessionOption } from './live-options';
import { getPlugin, isValidProviderId } from '@main/core/agents/plugin-registry';
import { sessionParentId, sessionSpawnerId, mapSessionRowToSession } from '@main/core/sessions/utils';
import { agentIdsBySession } from '@main/core/sessionpage/sessionpage-session-agent';
import { db } from '@main/db/client';
import { sessions, projects, type SessionRow } from '@main/db/schema';
import { tapMainEvents } from '@main/lib/events';
import { listSessionSchedules } from '@main/core/automations/repo';
import {
  automationChangedChannel,
  automationRunChangedChannel,
} from '@shared/core/automations/automationEvents';
import {
  schedulesBySession,
  sessionScheduleDigest,
  type SessionSchedule,
} from '@shared/core/automations/session-schedule';
import { log } from '@main/lib/logger';
import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import {
  legacyAgentStatusWord,
  parseAgentStatus,
  parseAgentStatusDetail,
} from '@gugu/core/shared/agentStatus';
import {
  sessionChangedChannel,
  sessionCreatedChannel,
  type AgentStatusChange,
} from '@shared/core/sessions/sessionEvents';
import {
  dropTimelineArchive,
  loadTimelineArchive,
  pruneTimelineArchives,
  saveTimelineArchive,
} from './archive-store';
import { watchSessionState, type SessionStateWatch } from './live-permissions';
import { locateSessionRecord, sessionRecordHarnessForProvider, type SessionRecordLocation } from './locate';
import { hermesRecordedDeliveryIds } from './hermes-delivery-receipts';
import { OpenedFileError, readOpenedFileChunk } from './opened-file';
import { sessionOpenedFile, sessionOutputs } from '../sessions/session-outputs';
import { createStandInTimeline } from './stand-in-timeline';
import { readStartFailure } from './start-failures';
import { knownHarnessConfigRoots } from '@main/core/agent-hooks/harness-config-roots';
import { notStartedSessionOptions } from './not-started-options';
import { readSessionModelMenu, type SessionpageSessionOptionsWithMenu } from './session-model-menu';
import {
  acpSessionLive,
  deliverPermissionDecision,
  deliverQuestionAnswer,
  deliverSessionCancel,
  deliverSessionText,
  ensureAcpSessionLive,
  permissionChannelError,
  prepareQuestionAnswer,
  SessionWriteError,
  type PreparedQuestionAnswer,
  type SessionWriteTarget,
} from './write-bridge';

/**
 * 宿主侧会话时间线服务。
 *
 * 一条会话一个 timeline 实例，**按 conversationId 缓存并引用计数**：桌面渲染层和手机看的是
 * 同一份（同一个 epoch、同一份结算），❌ 不是各开一份各读一遍文件 —— 两份实例意味着两个游标世代，
 * 而「谁先答谁生效」的 CAS 只在同一个实例里成立。没人订阅之后不立刻拆：一次刷新、一次切页
 * 都会把引用降到 0 再升回来，立刻拆 = 每次都整份重读。
 */

const IDLE_DISPOSE_MS = 60_000;

export type SessionTimelineFailure = { code: string; message: string };
export type SessionTimelineResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: SessionTimelineFailure };

function fail<T>(code: string, message: string): SessionTimelineResult<T> {
  return { ok: false, error: { code, message } };
}

/**
 * 造 timeline 的口。实现归 `packages/session-core/src/session-record`（记录源 + timeline），
 * 这一层只负责「谁在看、看的是哪一条、谁答过了」。
 * 显式置 null = fail loud（`timeline_unavailable`），❌ 不返回空时间线冒充「这条会话没内容」。
 */
export type SessionTimelineFactory = (input: {
  locator: SessionRecordLocator;
  conversationId: string;
  /** 记录里认出来的提问宿主能不能代答(#6798);能 ⇒ 提问结算带上整份题目。 */
  answerableQuestions?: boolean;
  readMode?: 'snapshot';
  parentLineage?: readonly RecordLineageNode[];
}) => Promise<SessionTimeline>;

/**
 * 默认实现走**动态 import**：那个 barrel 往下拖 node:fs 与 better-sqlite3，静态引进来
 * 会让每一个只想测服务层记账的用例都替记录源交税（也会把原生模块拖进不需要它的进程）。
 * 真开一份时间线的那一刻才加载。
 */
const defaultTimelineFactory: SessionTimelineFactory = async ({ locator, conversationId: sessionId, answerableQuestions, readMode, parentLineage }) => {
  const { createSessionRecordSource, createSessionTimeline } = await import(
    '@gugu/session-core/session-record'
  );
  // 存档只是捷径:读不出来 / 对不上,`createSessionTimeline` 自己会退回整份重读。
  const archive = readMode === 'snapshot' ? null : await loadTimelineArchive(sessionId);
  return createSessionTimeline(createSessionRecordSource(locator, { readMode, parentLineage }), {
    sessionId,
    archive,
    ...(answerableQuestions ? { answerableQuestions } : {}),
  });
};

let timelineFactory: SessionTimelineFactory | null = defaultTimelineFactory;

export function setSessionTimelineFactory(next: SessionTimelineFactory | null): void {
  timelineFactory = next;
}

type TimelineEntry = {
  conversationId: string;
  timeline: SessionTimeline;
  refs: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /**
   * 活运行时里那条「谁在等人回答、谁在排队」的订阅（只有 ACP 腿有）。
   * `disposed` 是给那场赛跑用的：接上来之前这份 entry 可能已经被拆了。
   */
  pendingWatch: SessionStateWatch | null;
  /** What the live runtime last reported waiting (an ACP session's own approvals); the host's asks are added to it (D-31). */
  runtimeRequests: readonly PendingRequest[];
  nativeActiveTurn?: import('@gugu/session-core/acp/client').TranscriptTurn | null;
  disposed: boolean;
  /**
   * 没有记录可读时的替身(见 stand-in-timeline.ts)。它**不进缓存**:真记录一出现,下一次 acquire
   * 就该开真时间线,而缓存里的替身会把它挡住。用完即拆。
   */
  standIn?: boolean;
};

const entries = new Map<string, TimelineEntry>();
const opening = new Map<string, Promise<TimelineEntry>>();
/** 每次整体重置 +1 —— 用来认出「开到一半、代已经翻篇」的那些 timeline。 */
let resetGeneration = 0;

type ActiveSubscription = {
  conversationId: string;
  stop: () => void;
};

const subscriptions = new Map<string, ActiveSubscription>();

// ─── 会话行 ────────────────────────────────────────────────────────────────

/**
 * 取**整行**（不是手搓投影）：写侧要的是一个真的 `Conversation`。
 * 早先这里只选了列表要显示的那几列，再把它 `as Conversation` 递给注入路径 —— 那是一句
 * 类型上的谎：注入路径哪天多读一个字段，拿到的是 undefined 而类型说它在，静默走错。
 */
function readSessionRows(includeArchived = false, id?: string): Array<{
  session: SessionRow;
  project: SessionpageProjectSummary;
}> {
  return db
    .select({
      session: sessions,
      project: { id: projects.id, name: projects.name, path: projects.path, kind: projects.kind },
    })
    .from(sessions)
    .innerJoin(projects, eq(sessions.projectId, projects.id))
    // 归档的会话不上这张面 —— 与 `getSessions()` 同一条口径:归属键是**会话自己**那一列(spec session-graph)。
    .where(and(includeArchived ? undefined : isNull(sessions.archivedAt), id === undefined ? undefined : eq(sessions.id, id)))
    .all()
    .map(({ session, project }) => ({ session, project: projectSummary(project) }));
}

function readLocalProjects(): SessionpageProjectSummary[] {
  return readProjects().map(({ id, name, path, kind }) => projectSummary({ id, name, path, kind }));
}

/** #609 workspace 带上 kind,手机据此把它的会话列进「任务」;项目照旧只有 id / name / path。 */
function projectSummary({ kind, ...project }: { id: string; name: string; path: string; kind?: 'project' | 'workspace' }): SessionpageProjectSummary {
  return kind === 'workspace' ? { ...project, kind } : project;
}

export function readSessionRow(conversationId: string, options: { includeArchived?: boolean } = {}): SessionRow | null {
  return (
    readSessionRows(options.includeArchived, conversationId).find((row) => row.session.id === conversationId)?.session ??
    null
  );
}

/**
 * 这条会话的终端提问能不能从提问卡回答:终端腿,且这家声明了关掉选择器的取消键(#6798、#7035)。
 * **只在这里判**:能 ⇒ 提问结算带上 `questions`,之后手机画不画表单、写侧收不收都只看有没有 `questions`。
 */
function remoteAnswerFor(row: SessionRow): boolean {
  if (summaryRuntime(row.runtime) !== 'pty' || !row.provider || !isValidProviderId(row.provider)) return false;
  const plugin = getPlugin(row.provider);
  return Boolean(plugin.capabilities.sessionBundle.sessionTuiQuestionAnswer);
}

/**
 * `runtime` 列为空时按 'pty' 读 —— 与 `mapSessionRowToSession` 同一条既有约定
 * （这一列是后加的，存量行为空且它们全是终端腿）。'acp'/'pty' 之外（今天是 'node'）如实报 unknown。
 */
function summaryRuntime(runtime: string | null): SessionpageSessionSummary['runtime'] {
  if (runtime === 'acp') return 'acp';
  if (runtime === 'pty' || runtime === null) return 'pty';
  return 'unknown';
}

/**
 * 这一家有没有咕咕托管的配置根。今天三家都是 `injectionMode: 'runtime'` ⇒ 恒为 null；
 * 声明自相矛盾时 `resolveAgentHome` 会抛 —— 那是**这一家的** descriptor 有问题，
 * 只让这一条会话变成 unsupported，❌ 不许把整张列表带走。
 */
function managedConfigRootFor(providerId: string | null): {
  root: string | null;
  problem: string | null;
} {
  const id = providerId?.trim();
  if (!id) return { root: null, problem: null };
  try {
    const bundle = getPlugin(id).capabilities.sessionBundle;
    const home = resolveAgentHome({
      providerId: id,
      injectionMode: bundle.injectionMode,
      configRoot: bundle.configRoot,
      guguHome: process.env.GUGU_HOME ?? '',
      osHomeDir: process.env.HOME ?? '',
      sourceEnv: process.env,
    });
    return { root: home?.configRoot ?? null, problem: null };
  } catch (error) {
    return { root: null, problem: (error as Error)?.message ?? String(error) };
  }
}

/**
 * 会话所绑订阅连接的配置根解析器(宿主注入,与 `setSessionTimelineFactory` 同一个理由:
 * 真实现拖 electron `app` 与 db,服务层要保持能在任何 node 环境下测)。没注入 ⇒ 只在默认根里找。
 */
export type ConnectionConfigRootResolver = (providerId: string, connectionId: string) => string | null;

let connectionConfigRootOf: ConnectionConfigRootResolver | null = null;

export function setConnectionConfigRootResolver(next: ConnectionConfigRootResolver | null): void {
  connectionConfigRootOf = next;
}

/**
 * 单一目录之前(#26),非原生连接上的会话跑在连接自己的配置根上,记录写在那里;开机时已搬进用户根,
 * 之后的新内容只长在用户根里。所以连接根只排在默认根后面兜底(搬失败的那几条),❌ 排前面 —— 那样读到的是搬家时的旧副本。
 */
function connectionRootFor(row: SessionRow): string | null {
  const connectionId = pinnedConnectionId(row);
  if (!row.provider || !connectionId) return null;
  try {
    return connectionConfigRootOf?.(row.provider, connectionId) ?? null;
  } catch (error) {
    // 解析不出来只让这一条退回默认根,❌ 不许把整张会话列表带走(与 `managedConfigRootFor` 同一条理由)。
    log.warn('sessionTimeline: 连接配置根解析失败,改在默认根里找', { sessionId: row.id, error: String(error) });
    return null;
  }
}

/**
 * 会话绑的连接。绑定是启动时才落的 —— 外部 fork 出来的行(终端里 `/fork`)还没启动过就没有,
 * 而它的记录已经在源会话那条连接的根里了 ⇒ 顺着 `forkedFrom` 找最近一个落了绑定的祖先
 * (与 `resolveHarnessConnection` 继承的是同一条链)。
 */
function pinnedConnectionId(row: SessionRow): string | undefined {
  const seen = new Set<string>();
  let current: SessionRow | null = row;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const pinned = current.config?.subscriptionConnectionId;
    if (pinned) return pinned;
    const parentId: string | undefined = current.config?.forkedFrom?.sessionId;
    current = parentId ? readSessionRow(parentId) : null;
  }
  return undefined;
}

function locateRow(row: SessionRow): SessionRecordLocation {
  const managed = managedConfigRootFor(row.provider);
  if (managed.problem) return { supported: false, reason: managed.problem };
  const legacy = connectionRootFor(row);
  return locateSessionRecord({
    provider: row.provider,
    providerSessionId: row.providerSessionId,
    managedConfigRoot: managed.root,
    // 这一家在本机 hook 里报过的配置目录(包装器在进程里改过的那种)排在默认根之后一起找。
    fallbackConfigRoots: [...(legacy ? [legacy] : []), ...knownHarnessConfigRoots(row.provider)],
  });
}

// ─── timeline 缓存 ──────────────────────────────────────────────────────────

/**
 * 拆之前把折算结果存下来。
 *
 * 放在拆除这一刻是因为它正好是「这条会话这一轮看完了」的时刻:该写的都写完了,
 * 而且此后这份内存状态就没人要了。⚠️ 存档失败不许影响拆除 —— 缓存写不进去是慢,
 * 拆不掉是泄漏。
 */
function archiveBeforeDispose(entry: TimelineEntry): void {
  const archive = entry.timeline.archive?.();
  if (!archive) return;
  void archive
    .then(async (one) => {
      if (!one) return;
      await saveTimelineArchive(entry.conversationId, one);
      await pruneTimelineArchives();
    })
    .catch((error) => {
      log.warn('sessionTimeline: 存档失败(不影响拆除)', {
        conversationId: entry.conversationId,
        error: String(error),
      });
    });
}

function disposeEntry(entry: TimelineEntry): void {
  archiveBeforeDispose(entry);
  entry.disposed = true;
  try {
    entry.pendingWatch?.dispose();
  } catch (error) {
    log.warn('sessionTimeline: pending-permission watch dispose failed', {
      conversationId: entry.conversationId,
      error: String(error),
    });
  }
  entry.pendingWatch = null;
  entry.timeline.dispose();
}

/**
 * 把活运行时里待答的审批接进这条时间线。
 *
 * ⚠️ **不挡住 acquire**：`replica.ready` 等的是 ACP 运行时进程那一头。读侧读的是磁盘上的记录，
 * 与那个进程活得好不好无关 —— 让它去 await，等于一个卡住的运行时进程能把「看会话内容」
 * 一起拖死。接不上就 warn 一句，时间线照常可读，只是没有审批卡（与接这条之前的行为一致）。
 */
function attachPendingRequests(entry: TimelineEntry): void {
  void watchSessionState(entry.conversationId, (requests, queuedPrompts, liveReply, terminals, activeTurn) => {
    if (entry.disposed) return;
    entry.runtimeRequests = requests;
    entry.nativeActiveTurn = activeTurn ?? null;
    syncPending(entry);
    entry.timeline.syncQueuedPrompts(queuedPrompts.filter(isVisibleQueuedPrompt).map(prompt => ({ ...prompt, text: conversationQueueText(prompt.text) })));
    entry.timeline.syncLiveReply(liveReply ?? null);
    entry.timeline.syncTerminals(terminals);
  })
    .then((watch) => {
      if (!watch) return;
      // 接上来之前这份 entry 可能已经被拆了 —— 那就当场把订阅也拆掉，❌ 别留一条没人拆的。
      if (entry.disposed) {
        watch.dispose();
        return;
      }
      entry.pendingWatch = watch;
    })
    .catch((error) => {
      log.warn('sessionTimeline: failed to watch pending permissions', {
        conversationId: entry.conversationId,
        error: String(error),
      });
    });
}

/** Publish the already-owned host requests alongside the runtime queue. */
export function syncAsked(conversationId: string): void {
  const entry = entries.get(conversationId);
  if (entry) syncPending(entry);
}

function syncPending(entry: TimelineEntry): void {
  if (entry.disposed || entry.standIn) return;
  const asked = [...(hostAsks.get(entry.conversationId)?.values() ?? [])].map((ask) => ask.request);
  entry.timeline.syncPendingRequests([...entry.runtimeRequests, ...asked]);
}

/**
 * Process-bound approvals live as long as the host that asked them. One the archive brings back still pending,
 * with no such ask here, was asked by a process that is gone: nobody waits on its answer, so it is over (10-06 A/B: after B
 * restarted, the private chat's band kept 「允许 Claude 1 要装 插件探针 r1」, which nothing would ever take). The archive keeps
 * no `liveItemIds`, so the runtime's next sync cannot withdraw it either. Agent questions instead restore their
 * answer handler from the archived card and use the existing idempotent session outbox.
 */
function restoreAgentQuestions(entry: TimelineEntry, projectId: string): void {
  void import('../asks/human-tool-wait').then(({ restoreHumanToolResults }) => restoreHumanToolResults(entry.conversationId, projectId))
    .catch(error => log.error('Human tool results could not be restored', { conversationId: entry.conversationId, error: String(error) }));
  const saved = new Map(readAgentQuestionRecords(entry.conversationId).map(item => [item.itemId, item]));
  for (const item of entry.timeline.getSnapshot({ limit: 1 }).settlements) {
    if (!saved.has(item.itemId) && restoredAgentQuestion(item)) { rememberAgentQuestion(entry.conversationId, item); saved.set(item.itemId, item); }
  }
  for (const settlement of saved.values()) {
    if (settlement.state === 'cancelled') { entry.timeline.cancelSettlement(settlement.itemId); continue; }
    if (hostAsks.get(entry.conversationId)?.has(settlement.itemId)) continue;
    const restored = restoredAgentQuestion(settlement);
    if (!restored) continue;
    if (restored.answer) {
      entry.timeline.syncPendingRequests([...entry.runtimeRequests, ...[...(hostAsks.get(entry.conversationId)?.values() ?? [])].map(ask => ask.request), restored.request]);
      entry.timeline.settle({ itemId: restored.request.itemId, optionId: settlement.optionId, by: settlement.resolvedBy ?? 'owner' });
    }
    const answer = restored.answer ? Promise.resolve(restored.answer) : ask(entry.conversationId, restored.request,
      { signal: new AbortController().signal });
    deliverAgentQuestionAnswer(entry.conversationId, projectId, restored.request, restored.answerMessageId, answer);
  }
}

function withdrawOrphanHostAsks(entry: TimelineEntry): void {
  const asked = hostAsks.get(entry.conversationId);
  for (const settlement of entry.timeline.getSnapshot({ limit: 1 }).settlements) {
    if (settlement.state !== 'pending' || !settlement.origin) continue;
    const source = askSourceSpec(settlement.origin.source);
    // An archived request can outlive the feature that created its source.
    if (!source || (source.raisedBy === 'host' && !asked?.has(settlement.itemId))) {
      entry.timeline.cancelSettlement(settlement.itemId);
    }
  }
}

function scheduleIdleDispose(entry: TimelineEntry): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    if (entry.refs > 0) return;
    entries.delete(entry.conversationId);
    try {
      disposeEntry(entry);
    } catch (error) {
      log.warn('sessionTimeline: dispose failed', {
        conversationId: entry.conversationId,
        error: String(error),
      });
    }
  }, IDLE_DISPOSE_MS);
  // 空闲拆除不该拖住进程退出。
  entry.idleTimer.unref?.();
}

async function acquire(conversationId: string): Promise<SessionTimelineResult<TimelineEntry>> {
  const row = readSessionRow(conversationId);
  if (!row) return fail('session_not_found', `这台机器上没有会话 ${conversationId}`);
  const cached = entries.get(conversationId);
  if (cached) {
    cached.refs += 1;
    if (cached.idleTimer) {
      clearTimeout(cached.idleTimer);
      cached.idleTimer = null;
    }
    return { ok: true, value: cached };
  }

  const location = locateRow(row);
  if (!location.supported) {
    // 没有记录可读也要打得开(spec session-always-openable):给一个只含第一句话的替身,
    // 为什么、怎么再试由各端按会话摘要画在转录末尾。❌ 回 record_unsupported 让它变成一行点不开的灰字。
    return { ok: true, value: standInEntry(row) };
  }
  if (!timelineFactory) {
    return fail(
      'timeline_unavailable',
      '会话记录源还没有装进宿主（setSessionTimelineFactory 未调用）'
    );
  }

  // 并发的两次 acquire 只开一份实例：两份实例 = 两个 epoch，游标当场作废。
  // ⚠️ 等待那一支同样要把拒绝收敛成 Result —— 让它抛穿过去，第二个调用方拿到的就是一个
  //    异常而不是带 code 的失败，而第一个调用方拿到的是规规矩矩的 `{ok:false}`。
  const inFlight = opening.get(conversationId);
  if (inFlight) {
    try {
      const entry = await inFlight;
      entry.refs += 1;
      return { ok: true, value: entry };
    } catch (error) {
      return openFailure(error);
    }
  }

  const factory = timelineFactory;
  // 开到一半被 reset 掉的那一份不许再登记（否则拆完之后又冒出来一个没人拆的实例）。
  const generation = resetGeneration;
  // 审批只有 ACP 腿有可结算的请求 id；TUI 腿的审批画在终端里，没有通道
  // （`write-bridge` 对它 fail loud）。所以这条订阅只对 ACP 腿开。
  const promise = factory({ locator: location.locator, conversationId, answerableQuestions: remoteAnswerFor(row) }).then((timeline) => {
    if (generation !== resetGeneration) {
      timeline.dispose();
      throw new Error('会话时间线服务在这份记录打开的过程中被重置了');
    }
    const entry: TimelineEntry = {
      conversationId,
      timeline,
      refs: 1,
      idleTimer: null,
      pendingWatch: null,
      runtimeRequests: [],
      disposed: false,
    };
    entries.set(conversationId, entry);
    try { attachInteractive(entry, row); }
    catch (error) { entries.delete(conversationId); timeline.dispose(); throw error; }
    return entry;
  });
  opening.set(conversationId, promise);
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return openFailure(error);
  } finally {
    if (opening.get(conversationId) === promise) opening.delete(conversationId);
  }
}

function attachInteractive(entry: TimelineEntry, row: SessionRow): void {
  restoreAgentQuestions(entry, row.projectId);
  if (summaryRuntime(row.runtime) === 'acp') attachPendingRequests(entry);
  withdrawOrphanHostAsks(entry);
  if (hostAsks.has(row.id)) syncPending(entry);
}

/** 会话行上的建立时间(SQLite `CURRENT_TIMESTAMP`,UTC)→ epoch ms;读不出来 = 不知道。 */
function rowCreatedAt(row: SessionRow): number | null {
  const raw = row.createdAt?.trim();
  if (!raw) return null;
  const at = Date.parse(raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`);
  return Number.isFinite(at) ? at : null;
}

/** 这个人发出去的第一句话:还没投出去的首轮(聊天腿),或者建会话时记下的那句(终端腿)。 */
function firstMessageOf(row: SessionRow): string | null {
  const session = mapSessionRowToSession(row);
  return session.initialQueue?.[0]?.text ?? session.firstUtterance ?? null;
}

function standInEntry(row: SessionRow): TimelineEntry {
  return {
    conversationId: row.id,
    timeline: createStandInTimeline({
      sessionId: row.id,
      firstMessage: firstMessageOf(row),
      createdAt: rowCreatedAt(row),
      recordAvailable: () => {
        const current = readSessionRow(row.id);
        return current !== null && locateRow(current).supported;
      },
    }),
    refs: 1,
    idleTimer: null,
    pendingWatch: null,
    runtimeRequests: [],
    disposed: false,
    standIn: true,
  };
}

function openFailure<T>(error: unknown): SessionTimelineResult<T> {
  // 「记录不在这台机器上」与「记录在但读不动」是两件事：前者用户能自己判断（会话是在别处跑的），
  // 后者是本机故障。合成一个 code 就把这条判断从用户手里拿走了。
  const code =
    (error as Error)?.name === 'SessionRecordNotFoundError' ? 'record_not_found' : 'record_unreadable';
  return fail(code, (error as Error)?.message ?? String(error));
}

function release(entry: TimelineEntry): void {
  entry.refs -= 1;
  if (entry.standIn) {
    if (entry.refs <= 0 && !entry.disposed) {
      entry.disposed = true;
      entry.timeline.dispose();
    }
    return;
  }
  if (entry.refs > 0) return;
  entry.refs = 0;
  scheduleIdleDispose(entry);
}

async function withTimeline<T>(
  conversationId: string,
  use: (timeline: SessionTimeline) => T | Promise<T>
): Promise<SessionTimelineResult<T>> {
  const acquired = await acquire(conversationId);
  if (!acquired.ok) return acquired;
  try {
    return { ok: true, value: await use(acquired.value.timeline) };
  } catch (error) {
    return fail('timeline_failed', (error as Error)?.message ?? String(error));
  } finally {
    release(acquired.value);
  }
}

/**
 * 会话行上的读数过网:新字段 `status` 带基础态 + 附属态,老字段 `agentStatus` 写老版本手机认得的词
 * (spec agent-status-vocabulary)。与 `mapSessionRowToSession` 读的是同一对列、同一个解析。
 */
function statusFieldsOf(row: SessionRow): Pick<SessionpageSessionSummary, 'agentStatus' | 'status'> {
  const status = parseAgentStatus(row.agentStatus);
  return {
    agentStatus: legacyAgentStatusWord(status),
    status: status === null ? null : { status, detail: parseAgentStatusDetail(row.agentStatusDetail, status) },
  };
}

// ─── 对外动作 ──────────────────────────────────────────────────────────────

/**
 * 没有记录可读的会话,摘要里多带两格:是哪一种(还没开起来 / 这一家没接),以及上次起它失败的原因码。
 * 各端据此在转录末尾说清楚、给「再试一次」—— ❌ 把 `unsupportedReason` 那句开发者原文摊给人看。
 */
function notStartedFacts(row: SessionRow): Pick<SessionpageSessionSummary, 'recordState' | 'startFailure'> {
  if (!locateSessionRecord({ provider: row.provider, providerSessionId: 'probe' }).supported) {
    return { recordState: 'harness-unsupported' };
  }
  let failure: string | null = null;
  try {
    failure = readStartFailure(row.id);
  } catch (error) {
    log.warn('sessionTimeline: 读起会话失败原因失败(不影响列表)', { conversationId: row.id, error: String(error) });
  }
  return { recordState: 'not-started', ...(failure ? { startFailure: failure } : {}) };
}

/** 这台机器的会话列表:手机、别的电脑、App 读的都是这一份(会话页路由表 `sessionTimeline.sessionsList`)。 */
export async function listSessions(): Promise<SessionpageSessionsListResult> {
  return sessionList(await agentIdsBySession(process.env));
}

/** Resolve the canonical binding even when its task is archived; a missing task is an orphan, not an offline host. */
export async function sessionOfAgent(agentUserId: string): Promise<{ projectId: string; sessionId: string } | null> {
  const wanted = agentUserId.replace(/^user:/, '');
  if (!wanted) throw new Error('Agent identity is required');
  const bound = [...await agentIdsBySession(process.env)].filter(([, id]) => id === `user:${wanted}`);
  if (bound.length > 1) throw new Error('Agent identity is bound to multiple tasks');
  if (!bound.length) return null;
  const [row] = db.select({ projectId: sessions.projectId, sessionId: sessions.id }).from(sessions).where(eq(sessions.id, bound[0][0])).limit(1).all();
  return row ?? null;
}

/** 同一份列表,同步、不读名录(行上不带 agent):心跳的离线摘要与换版忙不忙只要状态。 */
export function listSessionStates(): SessionpageSessionsListResult {
  return sessionList(null);
}

function sessionList(agents: ReadonlyMap<string, string> | null): SessionpageSessionsListResult {
  const rows = readSessionRows();
  const visibleProjects = readLocalProjects();
  const visibleIds = new Set(visibleProjects.map(project => project.id));
  const projectById = new Map<string, SessionpageProjectSummary>();
  const sessions: SessionpageSessionSummary[] = [];
  const schedules = schedulesBySession(listSessionSchedules());

  for (const { session, project } of rows) {
    if (!visibleIds.has(project.id)) continue;
    projectById.set(project.id, project);
    sessions.push(summaryOf(session, agents, schedules));
  }
  // 还没开过会话的项目也要列:手机新建会话只能挑这里列出的项目,刚在电脑上打开的项目 ❌ 因为没会话就看不见
  // (#6985:在手机上给一台刚加的机器开第一条会话)。只列本机项目,与侧栏同一个口径:隐式的任务工作区不算
  // 一个项目(侧栏也不列它),它只在里面有会话时随会话出现。
  for (const project of visibleProjects) {
    if (isImplicitSessionHomeProjectId(project.id)) continue;
    if (!projectById.has(project.id)) projectById.set(project.id, project);
  }

  return { projects: [...projectById.values()], sessions };
}

/** 一条会话的摘要,与 `listSessions` 同一个投影;建会话时交回发起方,它就不用自己拼一份「不知道」的。 */
export async function sessionSummary(conversationId: string): Promise<SessionpageSessionSummary | null> {
  const [row] = db.select().from(sessions).where(eq(sessions.id, conversationId)).limit(1).all();
  return row ? summaryOf(row, await agentIdsBySession(process.env), schedulesBySession(listSessionSchedules())) : null;
}

/**
 * `agents`:本机名录里「会话 → agent」(`user:<uuid>`),一次读完;null = 这一份不报 agent。
 * `schedules`:整台机器给自己排的定时按会话分好(一次读完),行上那枚定时标记从这里来。
 */
function summaryOf(
  session: SessionRow,
  agents: ReadonlyMap<string, string> | null,
  schedules: ReadonlyMap<string, SessionSchedule[]>
): SessionpageSessionSummary {
  const agentId = agents?.get(session.id);
  const location = locateRow(session);
  return {
    conversationId: session.id,
    projectId: session.projectId,
    title: session.title,
    // `harness` 报的是 provider 自己的 id：三家之外也要看得见是哪一家，
    // 而不是被折叠成一个「不支持」。
    harness: session.provider ?? 'unknown',
    runtime: summaryRuntime(session.runtime),
    ...statusFieldsOf(session),
    lastInteractedAt: session.lastInteractedAt,
    supported: location.supported,
    nativeInputVersion: 1,
    nativeLastMessage: nativeConversationActivity(session.id),
    nativeUnreadKeys: nativeConversationUnread(session.id),
    nativeUnreadAliases: nativeConversationAliases(session.id),
    ...(location.supported ? {} : { unsupportedReason: location.reason, ...notStartedFacts(session) }),
    // 这三项库里早就有,先前没往手机端传 —— 手机上于是既没有置顶区、也认不出未读、
    // 更画不出子 agent 的谱系,而桌面侧栏三样都有。口径与 `sessions/utils.ts`
    // 逐字相同,❌ 不在这里另立一套(两套必然漂移)。
    isPinned: session.isPinned === 1,
    unseen: session.agentStatusSeen !== 1,
    parentConversationId: sessionParentId(session),
    spawnedByConversationId: sessionSpawnerId(session),
    ...(session.config?.activitySourceLinks ? { activitySourceLinks: session.config.activitySourceLinks } : {}),
    ...(agents ? { agent: agentId ? { userId: agentId.slice('user:'.length) } : null } : {}),
    spawnedByExtensionId: session.spawnedByExtensionId ?? null,
    schedule: sessionScheduleDigest(schedules.get(session.id) ?? []),
  };
}

export function snapshot(input: {
  conversationId: string;
  limit?: number;
}): Promise<SessionTimelineResult<TimelineSnapshot>> {
  return withTimeline(input.conversationId, (timeline) =>
    timeline.getSnapshot(input.limit === undefined ? undefined : { limit: input.limit })
  );
}

export function after(input: {
  conversationId: string;
  cursor: RecordCursor;
}): Promise<SessionTimelineResult<TimelineAfterResult>> {
  return withTimeline(input.conversationId, (timeline) => timeline.getAfter(input.cursor));
}

/** 读这条会话此刻可改的选项。 */
/**
 * 这条聊天腿会话**从没开起来过**:没有 provider 会话 id,运行时里也没有它(正在起的那一刻不算 —— 那时
 * 运行时里有一份 `starting`)。建会话时 agent 没起来的就是这种,不论当时有没有记下原因码
 * (装这版之前建的那些没有)。对它 ❌ 走「唤醒」:唤醒不带第一句话。
 */
async function neverStarted(row: SessionRow): Promise<boolean> {
  if (row.providerSessionId?.trim() || row.runtime !== 'acp') return false;
  try {
    return !(await acpSessionLive(row.id));
  } catch {
    return readStartFailure(row.id) !== null;
  }
}

/** 那台机器上这家的模型目录里的显示名;读不到就空(胶囊上退回模型 id)。 */
async function modelNames(provider: string | null): Promise<Map<string, string>> {
  if (!provider) return new Map();
  try {
    const { listLocalModels } = await import('@main/core/agents/session-discovery');
    const catalog = await listLocalModels(provider, { transport: 'acp' });
    return new Map(catalog.models.map((m) => [m.id, m.name]));
  } catch {
    return new Map();
  }
}

/** 会话记录里那一档模型(建会话 / 上次换模型时记下的),没有运行时也报得出来。 */
async function recordedSessionOptions(row: SessionRow) {
  const { sessionPlatformModel } = await import('@main/core/sessions/platform-model-selection');
  const platform = await sessionPlatformModel(row.id).catch(() => undefined);
  return notStartedSessionOptions({
    model: row.config?.model,
    platformModelId: platform?.modelId,
    names: await modelNames(row.provider),
  });
}

/** 聊天腿的 agent 此刻在不在跑;问不到(运行时连不上)按不在跑算 —— 只读,❌ 为了问一句把它拉起来。 */
async function acpRunning(row: SessionRow): Promise<boolean> {
  try {
    return await acpSessionLive(row.id);
  } catch {
    return false;
  }
}

export async function sessionOptions(input: {
  conversationId: string;
}): Promise<SessionTimelineResult<SessionpageSessionOptionsWithMenu>> {
  const row = readSessionRow(input.conversationId);
  if (!row) return fail('session_not_found', '这台机器上没有这条会话');
  if (await neverStarted(row)) return { ok: true, value: await recordedSessionOptions(row) };
  // #980 打开会话不叫醒 agent,手机上也一样(behavior session-page;owner 2026-10-30 取代 09-15「读选项先唤醒」):
  // 手机打开会话就来读这一份,而参数(权限档 / 推理档)住在活运行时里。没在跑就报记录里那一档模型(带模型菜单,换得了),
  // 权限档 / 推理档等它跑起来再报 —— 它们的 id 是各家运行时自己的。改一档是人点的,那一刻再起(`setSessionOptionValue`)。
  if (row.runtime === 'acp' && !(await acpRunning(row))) {
    return { ok: true, value: await withModelMenu(row, await recordedSessionOptions(row)) };
  }
  try {
    return { ok: true, value: await withModelMenu(row, await readSessionOptions(input.conversationId)) };
  } catch (error) {
    return optionsFailure(error);
  }
}

/** 改一项。返回**回读**到的那份，❌ 不把入参当结果。 */
export async function setSessionOptionValue(
  input: SessionpageSessionSetOptionRequest
): Promise<SessionTimelineResult<SessionpageSessionOptionsWithMenu>> {
  const row = readSessionRow(input.conversationId);
  if (!row) return fail('session_not_found', '这台机器上没有这条会话');
  // #980 打开时没叫醒它;改一档是人点的,参数又只有活运行时收得下 ⇒ 这一刻按桌面同一条「唤醒」拉起来。
  // 从没开起来的 ❌:唤醒不带第一句话(见 not-started-options),它只报记下的那一档,本来就没有可改的。
  if (row.runtime === 'acp' && !(await neverStarted(row))) {
    try {
      await ensureAcpSessionLive(row.id);
    } catch (error) {
      if (error instanceof SessionWriteError) return fail(error.code, error.message);
      return fail('session_wake_failed', (error as Error)?.message ?? String(error));
    }
  }
  try {
    return { ok: true, value: await withModelMenu(row, await setSessionOption(input)) };
  } catch (error) {
    return optionsFailure(error);
  }
}

/**
 * 换到另一条计费路上的模型 —— 桌面会话菜单确认「打断并切换」之后走的同一个宿主入口(`reloadEmdashSession`):
 * 先把模型与计费路写进会话记录,再停、再起、续上历史。回的是重开之后回读到的那份选项。
 */
export async function reloadSessionModel(
  input: SessionpageSessionReloadModelRequest
): Promise<SessionTimelineResult<SessionpageSessionOptionsWithMenu>> {
  const row = readSessionRow(input.conversationId);
  if (!row) return fail('session_not_found', '这台机器上没有这条会话');
  try {
    const { reloadEmdashSession } = await import('@main/embedded-boot');
    await reloadEmdashSession({
      sessionId: row.id,
      reason: 'model-switch',
      model: input.model,
      modelSource: input.modelSource,
    });
  } catch (error) {
    return fail('reload_failed', (error as Error)?.message ?? String(error));
  }
  return sessionOptions({ conversationId: row.id });
}

/**
 * 附上手机排菜单要的事实(见 session-model-menu):模型那一档在场时是模型菜单,权限那一档在场时是这家声明的
 * 档位表(#6693:手机从前自带一张只认 Claude 的表,hermes 的 `default` 实为「编辑」却被写成「照常问我」)。
 */
async function withModelMenu(
  row: SessionRow,
  options: SessionpageSessionOptions
): Promise<SessionpageSessionOptionsWithMenu> {
  if (!row.provider) return options;
  const modeMap = options.mode ? declaredModeMap(row.provider) : undefined;
  const modelMenu = options.model ? await readSessionModelMenu(row.id, row.provider) : undefined;
  return { ...options, ...(modelMenu ? { modelMenu } : {}), ...(modeMap ? { modeMap } : {}) };
}

/** 这家声明的权限档表;没声明(或不认识这家)就没有。 */
function declaredModeMap(provider: string) {
  try {
    const autoApprove = getPlugin(provider).capabilities.autoApprove;
    return autoApprove?.kind === 'supported' ? autoApprove.modes : undefined;
  } catch {
    return undefined;
  }
}

function optionsFailure(error: unknown): SessionTimelineResult<never> {
  if (error instanceof SessionOptionsError) return fail(error.code, error.message);
  return fail('options_failed', (error as Error)?.message ?? String(error));
}

/** 往前翻更早的轮（懒加载）。 */
export function older(input: {
  conversationId: string;
  beforeTurnId: string;
  limit?: number;
}): Promise<SessionTimelineResult<TimelineOlderResult>> {
  return withTimeline(input.conversationId, (timeline) =>
    timeline.getOlder(
      input.limit === undefined
        ? { beforeTurnId: input.beforeTurnId }
        : { beforeTurnId: input.beforeTurnId, limit: input.limit }
    )
  );
}

/**
 * 手机取一张工具交回来的图:发给手机的时间线里图只有类型和字数(transport-trim),图本身它滚到了才来这里取。
 * 走的是和 `older` 同一条路(设备 RPC → 会话时间线的口),server 宿主上也是这一份。
 */
export async function toolImage(input: SessionpageSessionToolImageRequest): Promise<SessionTimelineResult<ToolImage>> {
  // 存档装回来的轮里图只剩位置,要由时间线从记录里读回来(#980);没有这个口的(代读时间线)照旧在快照里找。
  const found = await withTimeline(input.conversationId, (timeline) =>
    timeline.toolImage
      ? timeline.toolImage({ itemId: input.itemId, index: input.index })
      : findToolImage(timeline.getSnapshot({ limit: Number.MAX_SAFE_INTEGER }).turns, input.itemId, input.index)
  );
  if (!found.ok) return found;
  return found.value.ok ? { ok: true, value: found.value.image } : fail(found.value.code, found.value.message);
}

/** One page of a session's conversation, oldest turn first. */
export type RecordHistoryPage = { turns: TimelineSnapshot['turns']; hasOlder: boolean };

/**
 * An App's `readAgentHistory` (#7126): one page of what a session said, as its own record has it — the record the
 * session page and the phone read, so an agent in a terminal, or one not open now, is read like an open panel. Its
 * newest `limit` turns, or the `limit` before the turn numbered `beforeSeq` (the cursor a page gave).
 * `no-record`: no record of its own here (its harness's is not one gugu decodes, or it never started) — the stand-in
 * says nothing the session said. `no-such-turn`: `beforeSeq` is no turn of it.
 */
export async function recordHistoryPage(input: {
  conversationId: string;
  limit: number;
  beforeSeq?: number;
}): Promise<SessionTimelineResult<RecordHistoryPage | 'no-record' | 'no-such-turn'>> {
  const acquired = await acquire(input.conversationId);
  if (!acquired.ok) return acquired;
  try {
    if (acquired.value.standIn) return { ok: true, value: 'no-record' };
    const timeline = acquired.value.timeline;
    // Read the moment a turn ended (radar's 「做完了」): the record as written by now, not as far as the tail got.
    await timeline.catchUp();
    if (input.beforeSeq === undefined) {
      const { turns, hasOlder } = timeline.getSnapshot({ limit: input.limit });
      return { ok: true, value: { turns, hasOlder } };
    }
    const at = timeline.getSnapshot({ limit: Number.MAX_SAFE_INTEGER }).turns.find((turn) => turn.seq === input.beforeSeq);
    if (!at) return { ok: true, value: 'no-such-turn' };
    const { turns, hasOlder } = timeline.getOlder({ beforeTurnId: at.id, limit: input.limit });
    return { ok: true, value: { turns, hasOlder } };
  } catch (error) {
    return fail('timeline_failed', (error as Error)?.message ?? String(error));
  } finally {
    release(acquired.value);
  }
}

/**
 * #980 agent 自己的记录里,它收到过的每一条投递的消息编号。接回会话不再让 agent 重放之后,重启补投之前的去重
 * 靠它(从前那份事实来自重放)。`null` = 这里读不出来(没有记录、读失败):调用方照「历史未知」处理,
 * 补投照旧、标「可能已收到」—— ❌ 当成「一条都没收到」。
 */
export async function recordedDeliveryIds(conversationId: string): Promise<string[] | null> {
  const turns = await recordTurns(conversationId);
  if (!turns) return null;
  if (sessionRecordHarnessForProvider(readSessionRow(conversationId)?.provider) === 'hermes') {
    const { withStoredTurns, readStoredTailNow } = await import('../sessions/session-turn-store');
    const stored = await withStoredTurns(conversationId, () => readStoredTailNow(conversationId, Number.MAX_SAFE_INTEGER));
    return hermesRecordedDeliveryIds(turns, stored);
  }
  const ids = new Set<string>();
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.kind !== 'message' || item.role !== 'user') continue;
      for (const segment of readDeliveryEnvelope(item.text)?.segments ?? []) {
        if (segment.facts?.messageId) ids.add(segment.facts.messageId);
      }
    }
  }
  return [...ids];
}

/**
 * #980 这条会话在 agent 自己的记录里的全部回合,读到此刻的文件尾。`null` = 这里读不出来(没有记录、读失败)。
 * 与手机、助理读的是同一份时间线(同一份存档,只读文件新长出来的那一截)。
 */
export async function recordTurns(conversationId: string): Promise<TimelineSnapshot['turns'] | null> {
  const picked = await pickRecordTurns(conversationId, async (turns) => turns, { images: false });
  return picked.ok ? picked.turns : null;
}

type TranscriptTurns = TimelineSnapshot['turns'];

/**
 * #980 从记录的全部回合里挑出一些(`pick`),交回时**带着真图**。
 *
 * 存档装回来的轮里,工具截图只剩类型和字数(`imageRefs`),图要看时才按位置从记录里读回来。要把这几轮抄进库的人
 * 拿到的必须是带图的那份 —— 库里那份没有别处可以再取。读不回来的那张保持只有字数(与「图不在了」同一种降级)。
 * `ok: false` = 这里没有记录可读;`turns: null` = `pick` 说不挑(记录与库岔开了)。
 */
/** Ingestion owns this reader. It cannot populate or dispose the interactive cache. */
async function openIngestionRecord(conversationId: string, includeArchived?: boolean, parentLineage?: readonly RecordLineageNode[], readMode: 'snapshot' | 'live' = 'snapshot'): Promise<SessionTimeline | null> {
  const row = readSessionRow(conversationId, { includeArchived });
  if (!row || !timelineFactory) return null;
  const location = locateRow(row);
  if (!location.supported) return null;
  const generation = resetGeneration;
  const timeline = await timelineFactory({ locator: location.locator, conversationId, ...(readMode === 'snapshot' ? { readMode } : {}), parentLineage });
  if (generation !== resetGeneration) { timeline.dispose(); return null; }
  return timeline;
}

export async function pickRecordTurns(
  conversationId: string,
  pick: (turns: TranscriptTurns) => Promise<TranscriptTurns | null>,
  options: { images: boolean; committedOnly?: boolean; includeArchived?: boolean; afterForkOf?: string } = { images: true },
): Promise<{ ok: true; turns: TranscriptTurns | null; complete: boolean } | { ok: false; reason?: 'diverged' }> {
  const opened: SessionTimeline[] = [];
  let provingParent = !!options.afterForkOf;
  try {
    let parentLineage: readonly RecordLineageNode[] | undefined;
    if (options.afterForkOf) {
      const parent = await openIngestionRecord(options.afterForkOf, true);
      if (!parent) return { ok: false, reason: 'diverged' };
      opened.push(parent);
      parentLineage = parent.getRecordLineage?.() ?? undefined;
      if (!parentLineage?.length) return { ok: false, reason: 'diverged' };
    }
    provingParent = false;
    const timeline = await openIngestionRecord(conversationId, options.includeArchived, parentLineage);
    if (!timeline) return { ok: false };
    opened.push(timeline);
    await timeline.catchUp();
    const all = timeline.getSnapshot({ limit: Number.MAX_SAFE_INTEGER }).turns;
    const prefix = options.committedOnly ? timeline.getSnapshot({ limit: Number.MAX_SAFE_INTEGER, committedOnly: true }).turns : all;
    const complete = prefix.length === all.length;
    const picked = await pick(prefix);
    if (!picked || !options.images) return { ok: true, turns: picked, complete };
    return { ok: true, turns: await Promise.all(picked.map((turn) => withImagesReadBack(timeline, turn))), complete };
  } catch (error) {
    log.warn('[session-timeline] record unreadable', { conversationId, error: (error as Error)?.message ?? String(error) });
    return { ok: false, ...(provingParent || (error as Error)?.name === 'SessionRecordForkDivergedError' ? { reason: 'diverged' as const } : {}) };
  } finally {
    for (const timeline of opened.reverse()) timeline.dispose();
  }
}

/**
 * A terminal reports idle before its buffered record write lands (record-backfill `settling`). Ingestion follows
 * the same live record reader until the last turn carries its outcome: `true` = it settled, `false` = `signal` ended
 * the watch first. A record that cannot be reopened fails loudly.
 */
export async function watchRecordSettled(conversationId: string, signal: AbortSignal): Promise<boolean> {
  const timeline = await openIngestionRecord(conversationId, true, undefined, 'live');
  if (!timeline) throw new Error(`record unavailable for ${conversationId}`);
  let unsubscribe = () => {};
  try {
    return await new Promise<boolean>((resolve) => {
      const check = () => { if (timeline.getSnapshot({ limit: 1 }).turns.at(-1)?.outcome) resolve(true); };
      signal.addEventListener('abort', () => resolve(false), { once: true });
      if (signal.aborted) resolve(false);
      unsubscribe = timeline.subscribe(timeline.getSnapshot({ limit: 1 }).cursor, check);
      // The reader caught up while opening: an outcome that landed after the settling snapshot is already here.
      check();
    });
  } finally {
    unsubscribe();
    timeline.dispose();
  }
}

type ImageNode = { id: string; images?: unknown[]; imageRefs?: unknown[]; children?: ImageNode[] };

async function withImagesReadBack<T extends TranscriptTurns[number]>(timeline: SessionTimeline, turn: T): Promise<T> {
  const readBack = async (node: ImageNode): Promise<ImageNode> => {
    let next = node;
    if (!node.images && node.imageRefs?.length && timeline.toolImage) {
      const found = await Promise.all(node.imageRefs.map((_, index) =>
        timeline.toolImage!({ itemId: node.id, index, maxChars: Number.POSITIVE_INFINITY })));
      if (found.every((one) => one.ok)) {
        const { imageRefs: _refs, ...rest } = node;
        next = { ...rest, images: found.map((one) => (one as Extract<typeof one, { ok: true }>).image) };
      }
    }
    if (next.children?.length) next = { ...next, children: await Promise.all(next.children.map(readBack)) };
    return next;
  };
  const items = await Promise.all(turn.items.map((item) => readBack(item as unknown as ImageNode)));
  return { ...turn, items: items as unknown as T['items'] };
}

/**
 * 手机点开一张附件卡(#7193):读这条会话打开给人看的那份文件的一段(`opened-file.ts`)。只读它真的打开过的 ——
 * 依据是宿主记下的那一份(`session-outputs.ts`),与桌面「输出」同一个源,不分 harness。
 */
export async function readOpenedFile(
  input: SessionpageOpenedFileReadRequest
): Promise<SessionTimelineResult<SessionpageOpenedFileChunk>> {
  try {
    if (!(await sessionOpenedFile(input.conversationId, input.path))) {
      return fail('not_opened', `这条会话没有打开过 ${input.path}`);
    }
    return { ok: true, value: await readOpenedFileChunk(input.path, input.offset, input.length) };
  } catch (error) {
    if (error instanceof OpenedFileError) return fail(error.code, error.message);
    return fail('read_failed', (error as Error)?.message ?? String(error));
  }
}

/** 这条会话给人打开过的文件与网页,最近的在前(桌面「输出」、手机读的都是这一份)。 */
export async function outputs(input: { conversationId: string }): Promise<SessionTimelineResult<OpenedOutput[]>> {
  return { ok: true, value: await sessionOutputs(input.conversationId) };
}

/**
 * 这条会话的运行时说「本进程里还在跑」的后台命令(#6582 那道筛子,手机看会话末尾那一句用;桌面读的是自己 store 里同一格)。
 * 会话不在运行时里 ⇒ `[]`(没有活着的进程,就没有在跑的命令);运行时没报这一格(旧运行时)⇒ `null` = 不筛。
 */
export async function backgroundTasks(input: {
  conversationId: string;
}): Promise<SessionTimelineResult<{ runningCommandTaskIds: string[] | null }>> {
  const row = readSessionRow(input.conversationId);
  if (!row) return fail('session_not_found', `这台机器上没有会话 ${input.conversationId}`);
  try {
    // 用时再 import:它们拖着运行时进程那一串(app scope),只读时间线的路不该替它交税。
    const { readAcpSessionState } = await import('@main/core/acp/session-summary-reader');
    const state = await readAcpSessionState(row.id);
    return { ok: true, value: { runningCommandTaskIds: state ? (state.backgroundCommandTaskIds ? [...state.backgroundCommandTaskIds] : null) : [] } };
  } catch (error) {
    return fail('read_failed', (error as Error)?.message ?? String(error));
  }
}

/**
 * 停一个后台任务:命令报供应商的 asyncTaskId,子智能体报派它的 tool_use id —— 与桌面那一行的停止键同一个调用
 * (`stopBackgroundTask`)。受理即返回,停没停下来看时间线。
 */
export async function stopBackgroundTask(input: {
  conversationId: string;
  stopId: string;
}): Promise<SessionTimelineResult<{ stopped: true }>> {
  const row = readSessionRow(input.conversationId);
  if (!row) return fail('session_not_found', `这台机器上没有会话 ${input.conversationId}`);
  try {
    const { getAcpRuntimeClient } = await import('@main/core/acp/runtime-process/host');
    const client = await getAcpRuntimeClient();
    const result = await client.stopBackgroundTask({ sessionId: row.id, taskId: input.stopId });
    if (!result.success) return fail('stop_failed', String((result.error as { message?: string })?.message ?? result.error));
    return { ok: true, value: { stopped: true } };
  } catch (error) {
    return fail('stop_failed', (error as Error)?.message ?? String(error));
  }
}

/**
 * 订阅。`emit` 是这条传输自己的推送口（设备 RPC 的 broadcast / 桌面的 IPC）。
 * 同一个 subscriptionId 再订阅 = 顶掉前一条（重连时手机会带着同一个 id 回来）。
 */
export async function subscribe(
  input: SessionpageSessionSubscribeRequest,
  emit: (event: SessionpageSessionEvent) => void
): Promise<SessionTimelineResult<{ subscriptionId: string }>> {
  const subscriptionId = input.subscriptionId?.trim();
  if (!subscriptionId) return fail('invalid_subscription', 'subscriptionId 是必填的');

  // 先登记再等时间线:等的那一会儿里线断了 / 退订了,拆的就是这一条,回来时不再接上(❌ 给死掉的线留一条孤儿)。
  unsubscribe(subscriptionId);
  let stopped = false;
  let teardown: (() => void) | null = null;
  const mine = {
    conversationId: input.conversationId,
    stop: () => {
      if (stopped) return;
      stopped = true;
      teardown?.();
    },
  };
  subscriptions.set(subscriptionId, mine);
  const forget = () => { if (subscriptions.get(subscriptionId) === mine) subscriptions.delete(subscriptionId); };

  const acquired = await acquire(input.conversationId);
  if (!acquired.ok) {
    forget();
    return acquired;
  }
  const entry = acquired.value;
  if (stopped) {
    release(entry);
    return fail('unsubscribed', '订阅在建好之前就被退掉了');
  }
  try {
    const unsubscribeTimeline = entry.timeline.subscribe(input.cursor, (result) => {
      if (stopped) return;
      emit({ subscriptionId, result });
    });
    teardown = () => {
      try {
        unsubscribeTimeline();
      } finally {
        release(entry);
      }
    };
  } catch (error) {
    release(entry);
    forget();
    return fail('subscribe_failed', (error as Error)?.message ?? String(error));
  }
  return { ok: true, value: { subscriptionId } };
}

// ─── 整台机器的会话列表订阅 ──────────────────────────────────────────────────

/**
 * 「哪条会话此刻卡在人这儿」的事实源:状态写入者写下之后的那份输出(spec agent-status-writer)。
 *
 * 由宿主在开机时注入 `onAgentStatus` —— ❌ 这里不 import embedded-boot：那个模块 import 的正是本模块
 * （经 device-rpc），直接引会成环。也 ❌ 不自造第二份「事件 → 状态」的推导：仓里已经因为同形拷贝各改各的
 * 踩过一次（#3961，presence 读的一直是没改的那份）。已读也经写入者播出,所以手机列表的未读跟着变。
 */
type SessionStatusFeed = (cb: (change: AgentStatusChange) => void) => () => void;

let sessionStatusFeed: SessionStatusFeed | null = null;

export function setSessionStatusFeed(feed: SessionStatusFeed | null): void {
  sessionStatusFeed = feed;
}

const sessionsSubscriptions = new Map<string, { stop: () => void }>();

/** 状态可能连着跳好几下（working → needs_user）；合并到一帧再推，❌ 一次变化推一份列表。 */
const SESSIONS_PUSH_DEBOUNCE_MS = 200;

/** 列表上看得见、又不经状态写入者的变化:会话增删、这几格元信息,以及会话给自己排的定时。 */
const LISTED_FIELDS = ['title', 'isPinned', 'archivedAt', 'parentSessionId', 'nativeUnreadKeys', 'nativeLastMessage'];
function changesSessionList(channel: string, data: unknown): boolean {
  if (channel === sessionCreatedChannel.name) {
    return true;
  }
  // 行上那枚定时标记:排上、取消、到点、没送到都经这两条(automations-service)。
  if (channel === automationChangedChannel.name || channel === automationRunChangedChannel.name) return true;
  if (channel !== sessionChangedChannel.name) return false;
  const changes = (data as { changes?: Record<string, unknown> } | null)?.changes ?? {};
  return LISTED_FIELDS.some((field) => field in changes);
}

/**
 * 整台机器的会话列表订阅。订上那一刻的整份是订阅的一部分:先算出它,算不出来就把错误照常交回(客户端的退避接住),
 * ❌ 回一个「订上了」再永远不推。算出来了就拿它当底推出去,之后只推变了的行(sessionListDelta)。
 */
export async function subscribeSessions(
  subscriptionId: string,
  emit: (event: SessionpageSessionsEvent) => void
): Promise<SessionTimelineResult<{ subscriptionId: string }>> {
  unsubscribeSessions(subscriptionId);
  if (!sessionStatusFeed) {
    // fail loud：没有事实源就说没有，❌ 不返回一个永远不推的订阅冒充成功 ——
    // 那样手机会一直等一个不会来的提醒，而屏幕上看不出任何异常。
    return fail('status_feed_missing', '宿主没有接入会话状态事实源');
  }

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** 底还没算出来时来的变化:先记下,底推出去之后补一次。 */
  let ready = false;
  let dirty = false;
  /** 这条订阅上一次推出去的那份:增量就是拿它与这一份比出来的。 */
  let last: SessionpageSessionsListResult | null = null;
  /** 一次只算一份,按顺序推:两份交错推出去,后算的先到,客户端就合乱了。 */
  let pushing: Promise<void> = Promise.resolve();
  const push = (): void => {
    timer = null;
    pushing = pushing.then(async () => {
      if (stopped || !last) return;
      let next: SessionpageSessionsListResult;
      try {
        next = await listSessions();
      } catch (error) {
        // 列不出来(名录读坏了)响亮记下,这一份不推;下一次变化再列。❌ 推一份缺行的冒充整份。
        log.error('sessionTimeline: 会话列表推送列不出来', { subscriptionId, error: String(error) });
        return;
      }
      if (stopped) return;
      const delta = sessionListDelta(last, next);
      last = next;
      if (delta) emit({ subscriptionId, ...delta });
    });
  };
  const schedule = (): void => {
    if (!ready) {
      dirty = true;
      return;
    }
    if (stopped || timer) return;
    timer = setTimeout(push, SESSIONS_PUSH_DEBOUNCE_MS);
    timer.unref?.();
  };
  // 先挂上变化来源再算底:算的那一会儿里的变化不会漏(记成 dirty,底推出去后补一次)。
  const stops = [
    sessionStatusFeed(schedule),
    tapMainEvents((channel, data) => {
      if (changesSessionList(channel, data)) schedule();
    }),
  ];
  const mine = {
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      for (const off of stops) off();
    },
  };
  // 先登记再算底:算的那一会儿里线断了 / 退订了,拆的就是这一条,回来时不再推(❌ 给死掉的线留一条孤儿)。
  sessionsSubscriptions.set(subscriptionId, mine);

  try {
    last = await listSessions();
  } catch (error) {
    mine.stop();
    if (sessionsSubscriptions.get(subscriptionId) === mine) sessionsSubscriptions.delete(subscriptionId);
    return fail('sessions_list_failed', `会话列表列不出来: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (stopped) return fail('unsubscribed', '订阅在建好之前就被退掉了');
  emit({ subscriptionId, full: last });
  ready = true;
  if (dirty) schedule();
  return { ok: true, value: { subscriptionId } };
}

export function unsubscribeSessions(subscriptionId: string): void {
  const active = sessionsSubscriptions.get(subscriptionId);
  if (!active) return;
  sessionsSubscriptions.delete(subscriptionId);
  active.stop();
}

export function unsubscribeAllSessions(): void {
  for (const id of [...sessionsSubscriptions.keys()]) unsubscribeSessions(id);
}

export function unsubscribe(subscriptionId: string): void {
  const active = subscriptions.get(subscriptionId);
  if (!active) return;
  subscriptions.delete(subscriptionId);
  active.stop();
}

/** 频道断了：那一头的订阅一个都不再可达 —— 全清，❌ 不留着「以为还有人在看」的引用。 */
export function unsubscribeAll(): void {
  for (const subscriptionId of [...subscriptions.keys()]) unsubscribe(subscriptionId);
}

function writeTargetFrom(row: SessionRow): SessionWriteTarget {
  return mapSessionRowToSession(row);
}

export async function send(
  conversationId: string,
  text: string,
  clientMessageId?: string,
  files?: import('@gugu/session-core/session-record/contract').SessionpageSessionSendRequest['files']
): Promise<SessionTimelineResult<{ accepted: 'started' | 'queued'; clientMessageId?: string }>> {
  if (files !== undefined && !validTurnFiles(files)) return fail('invalid_request', '附件引用无效');
  if (clientMessageId !== undefined && (!clientMessageId.trim() || clientMessageId.length > 256)) return fail('invalid_request', '消息标识无效');
  const row = readSessionRow(conversationId);
  if (!row) return fail('session_not_found', `这台机器上没有会话 ${conversationId}`);
  // provider 为空 = 这一行没记下是哪家引擎；再往下走只会在插件表里抛一句认不出来的话。
  if (!row.provider?.trim()) {
    return fail('provider_unknown', `会话 ${conversationId} 没有记下 provider，投不出去`);
  }
  // 还没开起来的会话(建的时候 agent 没起来,#6264):先按「再试一次」同一条路把它起来 —— 第一句话随之投递 ——
  // 再发这一句。❌ 直接唤醒:唤醒不带第一句,agent 会只看到后来这一句。
  if (await neverStarted(row)) {
    const { startSession } = await import('./create-session');
    const started = await startSession(conversationId);
    if (!started.ok) return fail(started.error.code, started.error.message);
  }
  try {
    const accepted = await deliverSessionText(writeTargetFrom(row), text, clientMessageId, files);
    return { ok: true, value: { ...accepted, ...(clientMessageId ? { clientMessageId } : {}) } };
  } catch (error) {
    if (error instanceof SessionWriteError) return fail(error.code, error.message);
    return fail('send_failed', (error as Error)?.message ?? String(error));
  }
}

/** A turn's attachments as they cross the wire (P3): versions of DM-folder files, nothing else. */
function validTurnFiles(files: unknown): boolean {
  return Array.isArray(files) && files.every((file) => file && typeof file === 'object'
    && typeof file.itemId === 'string' && !!file.itemId && Number.isSafeInteger(file.version) && file.version >= 1
    && typeof file.name === 'string' && !!file.name && typeof file.mimeType === 'string'
    && Number.isSafeInteger(file.sizeBytes) && file.sizeBytes >= 0 && (file.path === undefined || typeof file.path === 'string'));
}

/** 停掉这条会话正在飞的一轮。受理即返回;停没停下来由时间线自己结算(与发送同一口径)。 */
export async function cancel(
  conversationId: string
): Promise<SessionTimelineResult<SessionpageSessionCancelResult>> {
  const row = readSessionRow(conversationId);
  if (!row) return fail('session_not_found', `这台机器上没有会话 ${conversationId}`);
  withdrawAll(conversationId, 'agent-question');
  try {
    return { ok: true, value: await deliverSessionCancel(writeTargetFrom(row)) };
  } catch (error) {
    if (error instanceof SessionWriteError) return fail(error.code, error.message);
    return fail('cancel_failed', (error as Error)?.message ?? String(error));
  }
}

/**
 * 重命名 / 置顶 / 归档 —— 桌面侧栏右键菜单同三条操作,❌ 不另写。顺序:先改名、再置顶、最后归档
 * (归档会把行从列表收起,放最后)。归档先停运行时,停不下来就抛 —— 原话回给手机。
 */
export async function updateSession(
  input: SessionpageSessionUpdateRequest
): Promise<SessionTimelineResult<SessionpageSessionUpdateResult>> {
  const row = readSessionRow(input.conversationId);
  if (!row) return fail('session_not_found', `这台机器上没有会话 ${input.conversationId}`);
  try {
    if (typeof input.title === 'string') {
      if (!input.title.trim()) return fail('title_empty', '名字不能是空的');
      const { renameSession } = await import('@main/core/sessions/renameSession');
      await renameSession(row.id, input.title);
    }
    if (typeof input.pinned === 'boolean') {
      const { setSessionPinned } = await import('@main/core/sessions/setSessionPinned');
      await setSessionPinned(row.id, input.pinned);
    }
    if (input.archived === true) {
      const { archiveSession } = await import('@main/core/sessions/archiveSession');
      await archiveSession(row.projectId, row.id, { removeSocialIdentity: input.removeSocialIdentity });
    }
    const after = db.select().from(sessions).where(eq(sessions.id, row.id)).get();
    return {
      ok: true,
      value: {
        title: after?.title ?? row.title,
        isPinned: (after?.isPinned ?? row.isPinned) === 1,
        archived: !!after?.archivedAt,
      },
    };
  } catch (error) {
    return fail('update_failed', (error as Error)?.message ?? String(error));
  }
}

/**
 * 回答一个审批/提问项。
 *
 * **先 CAS 再投递**：谁先在时间线上把这一项从 pending 抢成 resolved，谁才有资格去动 provider。
 * 反过来（先投递再记账）两个端会各投一次，而 provider 侧只认第一次 —— 第二个人得到的
 * 「成功」是假的。
 *
 * 投递失败要把这一项放回 pending（`releaseSettlement`），让人重答。
 * ❌ 别用 `cancelSettlement` 顶替：那是「provider 侧已了结」，会把一条还能救的显示成已取消。
 *
 * 抢跑失败**不是错误**：它走正常应答、带回那条既有结算（`accepted: false`），
 * 端上据此显示「已在某端回答」。做成错误码的话，端上要显示这句话就得从一个
 * 只有 message 的失败里去猜是谁答的 —— 也正是先前那条错位字符串的来处。
 */
export async function respond(
  input: SessionpageSessionRespondRequest
): Promise<SessionTimelineResult<SessionpageSessionRespondResult>> {
  const row = readSessionRow(input.conversationId);
  if (!row) return fail('session_not_found', `这台机器上没有会话 ${input.conversationId}`);
  const target = writeTargetFrom(row);

  const acquired = await acquire(input.conversationId);
  if (!acquired.ok) return acquired;
  if (acquired.value.standIn) {
    release(acquired.value);
    return fail('session_not_started', '这条会话还没有开出来,没有可回答的请求');
  }
  const { timeline } = acquired.value;
  try {
    if (!('optionId' in input)) {
      const question = settlementOf(timeline, input.itemId);
      if (question?.origin?.source === 'agent-question') return respondAskQuestion(timeline, input, question);
      return await respondQuestion(target, timeline, input);
    }
    // D-31 The host's own ask: settled here, on either kind of session — no runtime to hand it to.
    const current = settlementOf(timeline, input.itemId);
    if (current?.origin?.source === 'agent-question') return fail('answer_invalid', '请提交这道题的完整回答');
    if (current?.origin) {
      const source = askSourceSpec(current.origin.source);
      if (!source) {
        timeline.cancelSettlement(current.itemId);
        const cancelled = settlementOf(timeline, current.itemId);
        if (!cancelled) throw new Error('Cancelled request is missing from the timeline');
        return { ok: true, value: { accepted: false, settlement: cancelled } };
      }
      if (source.raisedBy === 'host') return respondAsk(timeline, input, current);
    }
    // 这条腿上根本没有结算口 ⇒ 抢之前就拒,❌ 抢成 resolved 推出去再放回(#6739)。
    const unavailable = permissionChannelError(target, input.kind);
    if (unavailable) return fail(unavailable.code, unavailable.message);
    const settled = timeline.settle({
      itemId: input.itemId,
      optionId: input.optionId,
      by: input.by,
    });
    if (!settled.ok) {
      return { ok: true, value: { accepted: false, settlement: settled.existing } };
    }
    try {
      await deliverPermissionDecision(target, { itemId: input.itemId, optionId: input.optionId });
    } catch (error) {
      timeline.releaseSettlement(input.itemId);
      if (error instanceof SessionWriteError) return fail(error.code, error.message);
      return fail('respond_failed', (error as Error)?.message ?? String(error));
    }
    return { ok: true, value: { accepted: true, settlement: settled.settlement } };
  } finally {
    release(acquired.value);
  }
}

/**
 * 终端提问(#6798、#7035):核对回答 → 认领 → 写取消键关掉选择器 → 等记录里这道题有了结果 → 把回答当消息发过去。
 * 回答发出去就是受理;agent 接下来怎么做以记录为准,卡片跟着记录走。
 */
async function respondQuestion(
  target: SessionWriteTarget,
  timeline: SessionTimeline,
  input: Exclude<SessionpageSessionRespondRequest, { optionId: string }>
): Promise<SessionTimelineResult<SessionpageSessionRespondResult>> {
  await timeline.catchUp();
  const current = settlementOf(timeline, input.itemId);
  const unavailable = permissionChannelError(target, 'question', current?.questions);
  if (unavailable) return fail(unavailable.code, unavailable.message);
  if (!current?.questions) return fail('question_not_found', '这条会话里没有这道提问');
  let prepared: PreparedQuestionAnswer;
  try {
    prepared = prepareQuestionAnswer(target, current.questions, 'decline' in input ? 'decline' : input.answers);
  } catch (error) {
    if (error instanceof SessionWriteError) return fail(error.code, error.message);
    throw error;
  }
  const settled = timeline.settle({ itemId: input.itemId, optionId: null, by: input.by });
  if (!settled.ok) return { ok: true, value: { accepted: false, settlement: settled.existing } };

  const stillOpen = async () => {
    await timeline.catchUp();
    return timeline.questionOpen(input.itemId);
  };
  const delivered = await deliverQuestionAnswer(target, prepared, { askedAt: current.askedAt, stillOpen });
  if (!delivered.ok) {
    if (delivered.error.code === 'question_gone') {
      // 问出这道题的进程已经不在了:这条永远等不到结果,作废它,❌ 放回可答。
      timeline.releaseSettlement(input.itemId);
      timeline.cancelSettlement(input.itemId);
      return fail(delivered.error.code, delivered.error.message);
    }
    // 其余失败一律放掉认领:选择器还开着 ⇒ 回到可答(再答 = 再按一次取消键,无害);
    // 已经有了结果(终端那头答了,或取消了却没发出回答)⇒ 放掉即「不需要回答了」,原因随错误带回。
    await timeline.catchUp();
    timeline.releaseSettlement(input.itemId);
    return fail(delivered.error.code, delivered.error.message);
  }
  return { ok: true, value: { accepted: true, settlement: settled.settlement } };
}

function settlementOf(timeline: SessionTimeline, itemId: string): Settlement | null {
  return timeline.getSnapshot({ limit: 1 }).settlements.find((s) => s.itemId === itemId) ?? null;
}

/** 测试与收尾用：拆掉所有订阅与缓存实例。 */
export function resetSessionTimelineService(): void {
  resetAsks();
  // 存档跟着一起作废:重置意味着「这一层记的东西可能都不作数了」,
  // 留着一份自称还对得上的存档,下次开会话就会拿它去续一段不存在的历史。
  for (const id of entries.keys()) void dropTimelineArchive(id);
  resetGeneration += 1;
  opening.clear();
  unsubscribeAll();
  for (const entry of [...entries.values()]) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entries.delete(entry.conversationId);
    try {
      disposeEntry(entry);
    } catch {
      // 收尾路径：拆一个实例失败不该拦住拆别的。
    }
  }
}

export async function changeQueue(input: { conversationId: string; action: import('@gugu/session-core/session-record/contract').SessionpageQueueAction }): Promise<SessionTimelineResult<null>> {
  const row = readSessionRow(input.conversationId);
  if (!row) return fail('session_not_found', 'The session is no longer available');
  if (row.runtime !== 'acp') return fail('unsupported_runtime', 'This session does not expose a prompt queue');
  try {
    const { changeConversationQueue } = await import('./conversation-queue');
    await changeConversationQueue(row.id, input.action);
    return { ok: true, value: null };
  } catch (error) {
    return fail('queue_update_failed', error instanceof Error ? error.message : String(error));
  }
}

const nativeRecordReader = createNativeRecordReader({ readSession: readSessionRow, activeTurn: id => entries.get(id)?.nativeActiveTurn, withTimeline });
export const nativeRecord = nativeRecordReader.snapshot;
export const nativeToolImage = nativeRecordReader.image;
export const nativeAttachment = nativeRecordReader.attachment;
