import type { AcpPermissionParams } from '@gugu/session-core/agents/plugins';
import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import type {
  AvailableCommand,
  Client,
  CreateTerminalRequest,
  CreateTerminalResponse,
  ForkSessionRequest,
  LoadSessionRequest,
  NewSessionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SessionUpdate,
} from '@agentclientprotocol/sdk';
import type {
  AcpCancelTurnError,
  AdapterExit,
  AcpStopBackgroundTaskError,
  AcpChangeQueuePromptOrderError,
  AcpDeleteQueuedPromptError,
  AcpEditQueuedPromptError,
  AcpExportRawLogError,
  AcpExportTranscriptError,
  AcpQueuePromptError,
  AcpResolvePermissionError,
  AcpSendPromptError,
  AcpSetModeOptionError,
  AcpSetModelOptionError,
  AcpSetPromptDraftError,
  AcpStartProgress,
  AcpStartSessionError,
  AcpStartStage,
  AcpSteerQueuedPromptError,
  AcpStopSessionError,
  AgentState,
  InvalidStateError,
  SetConfigFailedError,
  NormalizedEvent,
  SessionPlans,
  PromptDraft,
  PromptDraftUpdate,
  QueuedPrompt,
  QueuedPromptEdit,
  SessionConfigState,
  SessionFailure,
  SessionState,
  SessionSummary,
  SessionUsage,
  TranscriptItem,
  TerminalState,
  TranscriptTurn,
} from '@gugu/session-core/acp';
import {
  acpErr,
  canRepresentPermissionMode,
  classifyProviderPermissionMode,
  isAutoApproveIntent,
  isTopPermissionRung,
  resolvePermissionModeFallback,
  isProviderSessionMissingError,
  resolveSessionPermissionMode,
  platformModelIdFromRuntimeOption,
  runtimeOptionForPlatformModelId,
  RECENT_ACTION_MAX_ENTRIES,
  RECENT_ACTION_WINDOW_MS,
  recentActionName,
} from '@gugu/session-core/acp';
import { resolveUnitDelivery } from '@gugu/session-core/agents/plugins';
import { composeAgentSpawnEnv } from '@gugu/session-core/agents/agent-run-context';
import type { Lease, Result, SerializedError } from '@gugu/session-shared';
import { errorDetail, ok, toSerializedError } from '@gugu/session-shared';
import type { Logger } from '@gugu/session-shared/logger';
import { acquireAsResult } from '@gugu/session-wire/util';
import { buildAgentClient, type InboundRouter } from '../agent-ports/agent-client';
import type { FsPort } from '../agent-ports/fs-port';
import type { AgentTerminalManager } from '../agent-ports/terminal-manager';
import type { TerminalPort } from '../agent-ports/terminal-port';
import type { TerminalLiveRegistry } from './terminal-live-registry';
import {
  isAcpConnectionError,
  makeAcpConnectionKey,
  type AcpConnectionContext,
  type AcpConnectionSource,
  type PooledAcpProcess,
} from '../connection/source';
import { SessionCell, type AcpChatHistory } from '../session/cell';
import { pendingPermissionWaits } from '../session/permission-broker';
import { classifyTurnFailure } from '../session/turn-failure';
import type { LiveSettingApplyResult, SessionCellCallbacks, TurnEnvelope } from '../session/cell-deps';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import type { SessionNoticeCode } from '@gugu/session-core/acp';

/**
 * 启动期的一次降级：会话照常开，但有一件事必须告诉用户
 * （spec `session-always-openable`）。会话 ready 之后落成转录里的一行。
 */
type StartupNotice = {
  code: SessionNoticeCode;
  detail: string;
  effectiveValue?: string;
  previousValue?: string;
};
import {
  createAcpSessionLiveHost,
  createAcpSessionsLiveHost,
  createSessionLiveModels,
  createSessionsListModel,
  publishLiveModelState,
  type AcpSessionLiveHost,
  type AcpSessionsLiveHost,
  type SessionLiveModels,
  type SessionsListModel,
} from '../state/live-models';
import type { AcpRuntimeDeps, AcpStartInput, SendPromptInput } from './types';

type StartupSettingDimension = 'model' | 'effort';

/** 流式正文的显示节拍(毫秒):一拍里的改动合成一次推送。 */
const TRANSCRIPT_TICK_MS = 100;

interface SessionRecordBase {
  input: AcpStartInput;
  cell: SessionCell;
  live: SessionLiveModels;
  /**
   * 这条会话名下的子智能体会话号(#5117)。谈成 `clientCapabilities.subagents` 后,子智能体
   * 的输出**改写了 sessionId** 发在它自己的会话上;这些会话号路由回本会话,进 cell 时裹成
   * `subagent_stream`,❌ 不当成本会话自己的事件(那会把 cell 的 acpSessionId 改成子会话号,
   * 之后 prompt/cancel 全打到一个不存在的会话上)。
  */
  childProviderSessionIds: Set<string>;
  /**
   * 此刻 cell 正在回放 `session/load` 推回来的历史(#5381)。
   *
   * 由 begin/endReplay 的调用方(也就是本类)持有,❌ 不去问状态机的 phase:`endReplay()` 是
   * **先**把状态机切出 replaying、**后**才发 transcript 变更的,那一刻问 phase 会把重放回来的
   * 最后一回合报成刚发生的。
   */
  replaying: boolean;
  /**
   * #6396 会话还在起的时候宿主送来的通知(见 `announce`)。cell 在 ready 之前不收事件,所以先存在这里,
   * 在启动期降级通知的**同一个落点**画出来 —— ❌ 不另找一个时机。
   */
  announcedNotices: StartupNotice[];
  /**
   * #6552 会话还在起的时候用户选的模型 / 强度。启动在 `session/new` 之后本来就要设这两维
   * (新建会话设记录里的值,见 `applyInitialModel` / `applyInitialEffort`);这里有值,那一步设的就是它。
   * 某一维那一步一旦开始,就进 `startupSettingsSealed`,之后再来的选择照活会话处理。
   */
  startupSettings: Partial<Record<StartupSettingDimension, string>>;
  startupSettingsSealed: Set<StartupSettingDimension>;
  /** 启动那一步对上面这些值的应答,交还给等着的那次 `setConfigOption`。 */
  startupSettingOutcomes: Partial<
    Record<StartupSettingDimension, Result<LiveSettingApplyResult, AcpSetModelOptionError>>
  >;
  /**
   * 上一次推给主进程时的已提交回合列表(引用)。长度是水位;逐轮比引用就知道哪几轮被 reducer 改过 ——
   * reducer 改一轮就换掉那一轮的对象,没改的原样保留(#6582)。
   */
  emittedTurns: readonly TranscriptTurn[];
  /**
   * 本条记录以 `live` 推出去、因而确定由它落过盘的回合 id。修订只对这些回合成立:运行时回合 id
   * 每次重开都从 0 重数,重放推回来的那几轮可能根本没落盘(库里已有更早的整段),按 id 去库里找
   * 会命中上一次会话的另一轮(#6191 评审)。
   */
  liveTurnIds: Set<string>;
  /** 回合结束钩子连续要求「继续」的次数(见 `runTurnEndHook`)。 */
  stopHookContinuations?: number;
  /** 这一家自己报的最后一张命令表(见 `IAcpBehavior.discoverCommands`)。未到 = undefined。 */
  providerCommands?: readonly AvailableCommand[];
  /** 宿主按这一家的目录约定补出来的命令;合并时同名让位给 `providerCommands`。 */
  supplementalCommands?: readonly AvailableCommand[];
  queuePersistenceError: unknown | null;
  queuePersistenceFailure: () => Result<never, InvalidStateError> | null;
  /**
   * 流式正文的显示节拍(见 `publishOnTick`):这一拍还没过完 = 计时器在;这一拍里有没发出去的正文 = `transcriptPending`。
   */
  transcriptTick: ReturnType<typeof setTimeout> | null;
  transcriptPending: boolean;
  lastSynced: {
    sessionState?: SessionState;
    config?: SessionConfigState;
    usage?: SessionUsage | null;
    plan?: SessionPlans | null;
    agents?: AgentState[];
    activeTurn?: TranscriptTurn | null;
    draft?: PromptDraft | null;
    terminals?: TerminalState[];
  };
}

type SessionRecord = SessionRecordBase & (
  | { phase: 'starting'; processKey?: string; connectionLease?: Lease<PooledAcpProcess> }
  | { phase: 'ready'; processKey: string; connectionLease: Lease<PooledAcpProcess> }
  | { phase: 'lost'; processKey: string; connectionLease: Lease<PooledAcpProcess>; loss: SessionFailure }
);

type RecentActionState = {
  entries: Array<{ id: string; name: string; atMs: number }>;
  seenToolIds: Set<string>;
  /** The newest tool action ever seen here, kept past the window: `lastActionAt` is that fact, not the window's edge. */
  lastAtMs: number | null;
};

function collectToolNodes(nodes: readonly TranscriptItem[], out: Array<{ id: string; name: string }>): void {
  for (const node of nodes) {
    if (node.kind === 'message' || node.kind === 'thinking' || node.kind === 'compaction' || node.kind === 'context-reset' || node.kind === 'session-notice') continue
    if (node.kind === 'tool-group') {
      collectToolNodes(node.children, out)
      continue
    }
    const name = recentActionName(node)
    if (name) out.push({ id: node.id, name })
    if (node.children) collectToolNodes(node.children, out)
  }
}

export interface HistoryPage {
  turns: TranscriptTurn[];
  nextCursor: number | null;
}

/**
 * @@@system-prompt-channel — 会话级平台自述块是**系统提示词**，只能走系统通道。
 *
 * 它曾经被挂在 `hiddenContext` 上随用户消息一起发出（`sessionPromptPending`）。后果是普通用户消息
 * 在 wire 上变成「用户的话 + 8064 字符系统块」融成的**复合 user turn**：
 *   content[0] = "你能干啥"      content[1] = <gugu_platform>…
 * 于是 ① 任何按「一条消息」读取的地方都认不出它；
 *      ② agent 收到的那段话身份是「用户说的」而不是「系统指令」，它照着里面的话去调工具。
 *
 * `hiddenContext` 本身是正当的——它是**这一条消息自己**的附加上下文（issue context、mention）。
 * 会话级的东西借道它，就是把会话级状态伪装成消息内容。这里让系统提示词回到 `_meta.systemPrompt`，
 * 与 claude 适配器既有的 `{ systemPrompt: { append } }` 同一个信封、同一个键名，❌ 不另发明一个。
 *
 * ❌ 不允许在没有系统通道时"退回"塞进用户消息：那会让「这条会话的 agent 没收到平台块」这件事
 * 以「用户消息里多了 8000 字」的形态存活下去，看着正常、无人报错。
 */
export function sessionOpenMeta(input: AcpStartInput): { _meta?: Record<string, unknown> } {
  // ⚠️ 走用户级载体的那一份(behavior `agent-context-injection` 的 ③)**不进这里**。
  //    同一段字节只去一个地方:进了 `_meta` 又进首轮 = 一场会话里说两遍;两边都不进 = 静默
  //    没送到。路由位就是为了让这件事只有一种可能。
  const platform =
    input.sessionPromptCarrier === 'session-context' ? undefined : input.sessionPrompt?.trim();
  if (!input.sessionMeta && !platform) return {};
  const meta: Record<string, unknown> = { ...(input.sessionMeta ?? {}) };
  if (platform) {
    const existing = meta.systemPrompt;
    const append = isRecord(existing) && typeof existing.append === 'string'
      ? `${existing.append}\n\n${platform}`
      : platform;
    meta.systemPrompt = { ...(isRecord(existing) ? existing : {}), append };
  }
  return { _meta: meta };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 运行时分叉(侧边聊天)不能在 provider 那边留下会话历史。
 *
 * 这不是自造的规矩 —— 两家 provider 都为它备了一等开关,而咕咕只做过一半:
 *   - codex:`thread/fork` 的 `ephemeral: true`(官方 app-server 文档:"create an in-memory fork
 *     without adding it to stored thread listings")—— 早就在传,见
 *     `electron/runtime/codex-app-server-acp.mjs` 的 `session/fork` 分支。
 *   - claude:Agent SDK 的 `persistSession`(官方文档:`false` = "disables session persistence to
 *     disk. Sessions cannot be resumed later",默认 `true`)—— **漏了**,于是每开一次侧边聊天,
 *     就在 `~/.claude/projects/<cwd>/` 里留下一份真 transcript。
 *
 * 后果不止「多一条历史」:那份 transcript 与来源会话有 uuid 谱系重叠,外部 fork 捕获扫描
 * (fork-capture)会把它判成「用户在产品外面 fork 的」,补登记成一条正式会话 —— 运行时分叉就这样
 * 冒回了会话列表(#4230)。让 artifact 根本不存在,那条判断就无从发生,捕获逻辑一行都不用改。
 *
 * claude 的 ACP 适配器是三方包,够不着它内部,所以按 ACP extensibility 规范走 `_meta` 的厂商命名
 * 空间:`claudeCode.options` 正是 claude-agent-acp 读出来后**整体展开**进 SDK options 的那一格。
 * 对不认这个命名空间的 agent 是惰性的(codex 的 shim 只读 `_meta.systemPrompt.append`)。
 *
 * ❌ 别退化成「只对某个 provider 加」:走到这里的每一条都是运行时分叉(`forkFromSessionId` 只有
 * 侧边聊天会给),没有哪一条 ACP 分叉是该留历史的。
 */
export function ephemeralForkMeta(
  meta: Record<string, unknown> | undefined
): Record<string, unknown> {
  const base = meta ?? {};
  const claudeCode = isRecord(base.claudeCode) ? base.claudeCode : {};
  const options = isRecord(claudeCode.options) ? claudeCode.options : {};
  return {
    ...base,
    claudeCode: {
      ...claudeCode,
      options: {
        ...options,
        persistSession: false,
      },
    },
  };
}

/**
 * 把一家自己的分叉 `_meta` 并进基础 `_meta` —— **`claudeCode.options` 要逐键合并**,
 * ❌ 不能整块覆盖:基础那份带着 `persistSession: false`(分叉不落库),
 * 覆盖掉的话分叉会在用户自己的 harness 里留下一条会话,而没有任何地方会报错。
 */
function mergeClaudeOptions(
  base: Record<string, unknown>,
  extra: Record<string, unknown>
): Record<string, unknown> {
  const claudeOf = (meta: Record<string, unknown>): Record<string, unknown> =>
    isRecord(meta.claudeCode) ? meta.claudeCode : {};
  const optionsOf = (meta: Record<string, unknown>): Record<string, unknown> => {
    const claude = claudeOf(meta);
    return isRecord(claude.options) ? claude.options : {};
  };
  const baseOptions = optionsOf(base);
  const extraOptions = optionsOf(extra);
  const baseEnv = isRecord(baseOptions.env) ? baseOptions.env : undefined;
  const extraEnv = isRecord(extraOptions.env) ? extraOptions.env : undefined;
  return {
    ...base,
    ...extra,
    claudeCode: {
      ...claudeOf(base),
      ...claudeOf(extra),
      options: {
        ...baseOptions,
        ...extraOptions,
        ...(baseEnv || extraEnv ? { env: { ...baseEnv, ...extraEnv } } : {}),
      },
    },
  };
}

export class SessionManager implements InboundRouter {
  readonly sessionHost: AcpSessionLiveHost = createAcpSessionLiveHost();
  readonly sessionsHost: AcpSessionsLiveHost = createAcpSessionsLiveHost();
  readonly sessionsList: SessionsListModel = createSessionsListModel(this.sessionsHost);
  private readonly cells = new Map<string, SessionRecord>();
  private readonly recentActions = new Map<string, RecentActionState>();
  private readonly routes = new Map<string, Map<string, string>>();
  private readonly loadingSessions = new Map<string, Set<string>>();
  private readonly startingSessions = new Map<
    string,
    Promise<Result<{ providerSessionId: string }, AcpStartSessionError>>
  >();

  /**
   * 正在重连的会话 → **它当初是怎么丢的**。
   *
   * ⚠️ 这里此前只是一个 `Set<string>`:重连成功后把断开时在飞的那一轮结算成裸
   * `{kind:'error', reason:'prompt_failed'}` —— 用户看到「这条指令没能送达」,
   * 而真相是「适配器没了,这一轮的结局不明」。丢的不是那条指令,是那个引擎。
   * ⇒ 换成 Map,把丢失的原因一起带到结算处(#5858)。
   */
  private readonly reconnectingSessions = new Map<string, SessionFailure | null>();
  /** A lost session may be explicitly reconnected while its dead adapter is still being evicted. */
  private readonly invalidatingProcesses = new Map<string, Promise<void>>();
  /** Terminal transcript retained for the session page after an abnormal provider exit (spec boundary). */
  private readonly closedSessionHistories = new Map<string, TranscriptTurn[]>();
  /** Suppress the cell's close callback while onProcessClosed owns cleanup ordering. */
  private readonly processingProcessClose = new Set<string>();
  /** A deliberate stop must not be reclassified as an abnormal provider failure. */
  private readonly intentionalProcessCloses = new Set<string>();
  /** Starts whose owner stopped them mid-flight: their failure names the step that was abandoned. */
  private readonly abandonedStarts = new Set<string>();
  /**
   * 正在起的会话走到了哪一步(#6183)。启动不设墙钟 ⇒ 这一格让等待看得见(摘要的 `startProgress`),
   * 也是取消 / 失败时「卡在哪一步、等了多久」那句话的唯一来源。
   */
  private readonly startProgress = new Map<string, AcpStartProgress>();

  constructor(
    private readonly deps: AcpRuntimeDeps & { logger: Logger },
    private readonly connections: AcpConnectionSource,
    private readonly terminals: AgentTerminalManager,
    private readonly terminalLiveRegistry: TerminalLiveRegistry,
    private readonly ports: { fs: FsPort; terminals: TerminalPort }
  ) {}

  start(input: AcpStartInput): Promise<Result<{ providerSessionId: string }, AcpStartSessionError>> {
    const starting = this.startingSessions.get(input.sessionId);
    if (starting) return starting;

    const existing = this.cells.get(input.sessionId);
    if (existing && existing.phase !== 'lost') {
      return Promise.resolve(ok({ providerSessionId: existing.cell.acpSessionId }));
    }
    // A reconnect is a caller's start: the renderer's reconnect button, a fresh bootstrap, or the
    // host waking the session for a message delivered to it (a lost session is not live there).
    // Reuse the original start input so provider-native recovery keeps its session id and fork
    // declaration; ordinary prompts never enter this branch.
    const lostRecord = existing?.phase === 'lost' ? existing : undefined;
    const startInput = lostRecord
      ? {
          // The host rebuilds runtime-owned capability and platform credentials for every start.
          // Keep those fresh fields while pinning the provider-native recovery declaration to
          // the session that was actually lost.
          ...input,
          providerId: lostRecord.input.providerId,
          workspaceId: lostRecord.input.workspaceId,
          cwd: lostRecord.input.cwd,
          providerSessionId: lostRecord.input.providerSessionId,
          sourceSessionId: lostRecord.input.sourceSessionId,
          forkFromProviderSessionId: lostRecord.input.forkFromProviderSessionId,
          initialQueue: lostRecord.cell.sessionState.queuedPrompts.length > 0
            ? [...lostRecord.cell.sessionState.queuedPrompts]
            : undefined,
        }
      : input;

    if (lostRecord) {
      // The old cell owns the transcript and loss cause, but its live instance cannot coexist
      // with the new record for the same conversation. Keep the cell for failure restoration;
      // restoreLostRecord recreates the live instance if provider recovery fails.
      lostRecord.live.dispose();
      this.cells.delete(startInput.sessionId);
      this.reconnectingSessions.set(startInput.sessionId, lostRecord.loss ?? null);
    }
    const invalidation = lostRecord
      ? this.invalidatingProcesses.get(lostRecord.processKey)
      : undefined;
    const operation = (invalidation
      ? invalidation.then(() => this.startUncoordinated(startInput))
      : this.startUncoordinated(startInput)
    ).then((result) => {
      if (result.success) {
        if (lostRecord) this.disposeLostRecord(lostRecord);
      } else if (lostRecord) {
        // A failed reconnect must remain an actionable lost state, with its original cause and
        // transcript still available for the next explicit attempt.
        this.restoreLostRecord(lostRecord);
      } else {
        // 等这次启动的人拿到的,与摘要里写的是同一句「卡在哪一步、等了多久」。
        const message = this.settleFailedStart(startInput, result.error);
        if (message !== null) return { ...result, error: { ...result.error, message } };
      }
      return result;
    }, (error: unknown) => {
      if (lostRecord) this.restoreLostRecord(lostRecord);
      else this.settleFailedStart(startInput, acpErr.initializeFailed(toSerializedError(error)).error);
      throw error;
    }).finally(() => {
      this.reconnectingSessions.delete(startInput.sessionId);
      this.abandonedStarts.delete(startInput.sessionId);
      this.startProgress.delete(startInput.sessionId);
    });
    this.startingSessions.set(startInput.sessionId, operation);
    const clear = (): void => {
      if (this.startingSessions.get(startInput.sessionId) === operation) {
        this.startingSessions.delete(startInput.sessionId);
      }
    };
    void operation.then(clear, clear);
    return operation;
  }

  /**
   * 一次启动的**唯一**收口(#6183)。启动期间 `starting` 摘要归这次启动所有,
   * `startUncoordinated` 的各个失败出口都不碰它 —— 由这里一次性换成终态:
   *
   * - 引擎那侧没有这条会话(`provider_session_missing`)⇒ 删掉摘要,那条路有它自己的界面(照首轮重开);
   * - 属主放弃的启动(停止 / 删除)⇒ 与停掉一条已经起来的会话同一个收场:清掉排着的队、删掉摘要(回到没在跑),
   *   ❌ 记成 `lost`。那是有意停下,不是起不来 —— 记成 lost,侧栏会亮红点、会话编排会当它坏了
   *   (behavior session-page「打开速度」:会话建立途中能停,停下与平时停掉一轮一样)。等这次启动的人照样
   *   拿到「在哪一步被取消、等了多久」那一句;
   * - 其它一切 ⇒ `lost` + `start-failed`,带着原样的结构化错误,message 写明
   *   **卡在哪一步、等了多久**。状态投影把 `lost` 读成 error,于是聊天页、会话页、会话编排读到的是
   *   同一句「起不来」。
   *
   * ⚠️ 为什么不能「先删、再写 lost」:两次写是两条推送,状态桥会先对「消失」发 reset
   * (异步落库成 idle),再对 lost 发 error(也异步落库)—— 谁后落地谁赢,会话行与 presence 会分叉。
   */
  private settleFailedStart(input: AcpStartInput, error: AcpStartSessionError): string | null {
    // 引擎那侧没有这条会话(有它自己的界面:照首轮重开);`invalid_state` = 这条会话在启动途中已经被拆掉
    // (并发的 stop / 删除)。两者都不是「起不来」,❌ 给一条已拆掉的会话写回 lost。
    if (error.type === 'provider_session_missing' || error.type === 'invalid_state') {
      this.deleteSessionSummary(input.sessionId);
      return null;
    }
    const abandoned = this.abandonedStarts.has(input.sessionId);
    const message = startFailureMessage(
      error,
      this.startProgress.get(input.sessionId) ?? null,
      abandoned,
      Date.now(),
    );
    if (abandoned) {
      this.deps.logger.info('SessionManager: ACP session start stopped by its owner', {
        sessionId: input.sessionId,
        providerId: input.providerId,
        message,
      });
      this.deps.promptQueueStore?.clear(input.sessionId);
      this.deleteSessionSummary(input.sessionId);
      return message;
    }
    this.deps.logger.error('SessionManager: ACP session could not start', {
      sessionId: input.sessionId,
      providerId: input.providerId,
      message,
      error,
    });
    this.upsertSessionSummary(input, null, {
      lifecycle: 'lost',
      isGenerating: false,
      backgroundAgentCount: 0,
      backgroundCommandCount: 0,
      queuedPromptCount: input.initialQueue?.length ?? 0,
      failure: { kind: 'start-failed', message, error },
    });
    return message;
  }

  /** 启动走到下一步:记下来并重发 `starting` 摘要,让等待看得见。 */
  private markStartStage(input: AcpStartInput, stage: AcpStartStage, executable: string | null): void {
    const now = Date.now();
    const previous = this.startProgress.get(input.sessionId);
    this.startProgress.set(input.sessionId, {
      stage,
      since: now,
      startedAt: previous?.startedAt ?? now,
      executable: executable ?? previous?.executable ?? null,
    });
    const record = this.cells.get(input.sessionId);
    if (record) this.syncRecord(record);
  }

  private async startUncoordinated(
    input: AcpStartInput
  ): Promise<Result<{ providerSessionId: string }, AcpStartSessionError>> {

    try {
      const persistedQueue = this.deps.promptQueueStore?.load(input.sessionId) ?? [];
      if (persistedQueue.length > 0) {
        // The snapshot is the machine's queue across worker lifetimes. It wins over the
        // create-row compatibility payload because it reflects prompts already admitted.
        input = { ...input, initialQueue: [...persistedQueue] };
      }
    } catch (error) {
      this.deps.logger.error('SessionManager: failed to restore prompt queue snapshot', {
        sessionId: input.sessionId,
        error,
      });
      return acpErr.initializeFailed(toSerializedError(error));
    }

    this.upsertSessionSummary(input, null, {
      lifecycle: 'starting',
      isGenerating: false,
      pendingPermissionCount: 0,
      backgroundAgentCount: 0,
      backgroundCommandCount: 0,
      queuedPromptCount: input.initialQueue?.length ?? 0,
    });

    const binding = this.deps.agentHost.resolveAcp(input.providerId);
    if (!binding) {
      return acpErr.providerUnsupported(input.providerId);
    }

    // Every conversation owns its adapter process. Runtime-only forks still use provider metadata
    // (Claude's `resume + forkSession`) to derive a child from the parent's durable transcript,
    // but they never reuse the parent's live connection.
    const isPersistentFork = Boolean(input.forkFromProviderSessionId) && !input.sourceSessionId;
    const forkMeta =
      input.forkFromProviderSessionId && !isPersistentFork
        ? binding.behavior.forkViaNewSessionMeta?.(input.forkFromProviderSessionId)
        : undefined;
    const sourceRecord = input.sourceSessionId
      ? this.cells.get(input.sourceSessionId)
      : undefined;
    const sourceReady = sourceRecord?.phase === 'ready' ? sourceRecord : undefined;
    const hasMatchingSource = Boolean(
      sourceReady
      && sourceReady.input.providerId === input.providerId
      && sourceReady.cell.acpSessionId === input.forkFromProviderSessionId
    );
    const processKey = makeAcpConnectionKey(
      input.providerId,
      input.workspaceId,
      input.sessionId,
    );
    const record: SessionRecord = this.createRecord(input, input.providerSessionId ?? '');
    let initialQueueAdmitted = false;
    if (input.initialQueue?.length) {
      const queueResult = this.queueInitialPrompts(record);
      if (!queueResult.success) {
        this.removeRecord(input.sessionId, false, false, true);
        return queueResult;
      }
      initialQueueAdmitted = true;
    }
    this.syncRecord(record);
    this.discoverSupplementalCommands(record, binding.behavior);
    await this.attachProviderRules(record, binding.behavior);
    if (binding.behavior.prepareSession) {
      await binding.behavior
        .prepareSession({ cwd: input.cwd, env: this.providerEnv(input), homeDir: os.homedir() })
        .catch((error: unknown) => {
          this.deps.logger.warn('SessionManager: provider session preparation failed', {
            sessionId: input.sessionId,
            providerId: input.providerId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
    const acquire = await acquireAsResult(
      this.connections,
      processKey,
      {
        providerId: input.providerId,
        workspaceId: input.workspaceId,
        cwd: input.cwd,
        behavior: binding.behavior,
        runContext: input.runContext,
        platform: input.platform,
        capabilitySpawnEnv: input.capabilitySpawnEnv,
        capabilitySpawnArgs: input.capabilitySpawnArgs,
        buildClient: (_agent, context): Client => buildAgentClient(context, this, this.ports),
        ...(binding.behavior.turnFailure?.fromStderrLine
          ? {
              onStderrLine: (line: string) => {
                const failure = binding.behavior.turnFailure?.fromStderrLine?.(line);
                if (failure) record.cell.noteProviderStderrFailure(failure);
              },
            }
          : {}),
        onStage: (stage, executable) => this.markStartStage(input, stage, executable),
      },
      isAcpConnectionError
    );
    if (!acquire.success) {
      // The adapter may fail before `session/new` (spawn or ACP initialize). Keep the
      // structured provider error at the session boundary so the host log can explain the
      // renderer's generic HANDLER_ERROR.
      this.deps.logger.error('SessionManager: ACP connection acquire failed', {
        sessionId: input.sessionId,
        providerId: input.providerId,
        error: acquire.error,
      });
      this.removeRecord(input.sessionId, false, false, true);
      return acquire;
    }
    this.markStartStage(input, 'opening-session', null);

    const acquired = acquire.data;
    const connection = acquired.value;
    Object.assign(record, { processKey: connection.key, connectionLease: acquired });
    record.cell.setAgent(connection.agent);
    record.cell.setAcceptsImagePrompts(connection.supportsImagePrompt);
    record.cell.setSupportsSteering(connection.supportsSteering);
    record.cell.setReportsState(connection.reportsState);
    record.cell.setSupportsLoadSession(connection.supportsLoadSession);

    try {
      // Provider-specific runtime forks may need a control plane outside ACP. The provider owns
      // that transport and returns only the session id the fresh adapter should load.
      const sourceConnection = sourceRecord
        && sourceReady
        && hasMatchingSource
        ? {
            supportsForkSession: sourceReady.connectionLease.value.supportsForkSession,
            agent: sourceReady.connectionLease.value.agent,
          }
        : undefined;
      const resolveForkSource = binding.behavior.resolveForkSource;
      let resolvedFork: { loadProviderSessionId: string } | undefined;
      if (input.forkFromProviderSessionId && input.sourceSessionId && resolveForkSource) {
        if (!input.forkSourceSession) {
          throw new Error(
            `Provider '${input.providerId}' runtime fork source facts are unavailable for session `
              + `${input.sourceSessionId}`,
          );
        }
        resolvedFork = await resolveForkSource({
          sourceProviderSessionId: input.forkFromProviderSessionId,
          sourceSession: input.forkSourceSession,
          host: { cwd: input.cwd, workspaceId: input.workspaceId },
          ...(sourceConnection ? { sourceConnection } : {}),
        });
      }

      // 这一家的 `session/fork` 不可用、分叉由宿主在它自己的存档上做(见 `forkSessionInStorage`)。
      // 持久分叉与运行时分叉同走这一条:拿到新 id,下面照常 `session/load`。
      const storageFork = binding.behavior.forkSessionInStorage;
      if (input.forkFromProviderSessionId && !resolvedFork && storageFork) {
        const forked = await storageFork({
          sourceProviderSessionId: input.forkFromProviderSessionId,
          cwd: input.cwd,
          env: this.providerEnv(input),
          homeDir: os.homedir(),
        });
        resolvedFork = { loadProviderSessionId: forked.providerSessionId };
      }

      if (input.forkFromProviderSessionId) {
        this.deps.logger.info('session/acp-fork: strategy selected', {
          providerId: input.providerId,
          sessionId: input.sessionId,
          sourceProviderSessionId: input.forkFromProviderSessionId,
          strategy: resolvedFork
            ? 'provider-resolved'
            : isPersistentFork
              ? 'session-fork-persistent'
              : forkMeta
                ? 'new-session-meta'
                : 'session-fork-ephemeral',
        });
      }

      // 持久分叉先把 id 拿到手,随后**原样走 `session/load` 那一支** —— 重开走的也是它,
      // 两条路合一:分叉继承来的历史会照常回放进界面,和 pty 分叉的观感一致。
      //
      // 运行时分叉也携带来源的 provider session id,但它不是一个要 load 的目标:它是
      // `session/new` 的 resume/fork 输入。若先按这个字段走 `session/load`,side chat
      // 会重新绑定到 parent,而下面的 fork metadata 分支永远不可达。分叉身份优先于
      // 这个可选的持久化 session id;持久分叉仍在上面拿到独立 id 后进入 load。
      let loadProviderSessionId = input.forkFromProviderSessionId ? undefined : input.providerSessionId;
      // 重放失败、退回 `session/new` 时的原因。有值 = 这条会话在引擎那侧是**新**的,
      // 转录开头要画一条界告诉用户「往上的内容它没有」(#5381 ④)。
      let contextResetReason: string | null = null;
      // 启动期的降级通知(模型用不了 / 模型被换掉)。**不杀会话** —— 会话照常开,
      // 这些事实在 ready 之后画成转录里的一行(spec `session-always-openable`)。
      const startupNotices: StartupNotice[] = [];
      if (resolvedFork) {
        loadProviderSessionId = resolvedFork.loadProviderSessionId;
      }
      // 收窄成一个局部 const,下面每一处都用它 —— `input.forkFromSessionId` 在类型上仍是可空的,
      // 而"这里一定有值"是 `isPersistentFork` 的定义带来的,不该靠 `!` 去替编译器打包票。
      const persistentForkSource = isPersistentFork && !resolvedFork ? input.forkFromProviderSessionId : undefined;
      if (persistentForkSource) {
        if (!connection.supportsForkSession || !connection.agent.unstable_forkSession) {
          await acquired.release();
          return acpErr.newSessionFailed(
            toSerializedError(
              new Error(`Provider '${input.providerId}' does not support ACP session/fork`)
            )
          );
        }
        try {
          const forked = await connection.agent.unstable_forkSession(
            this.buildForkSessionRequest(input, persistentForkSource, false)
          );
          loadProviderSessionId = forked.sessionId;
          this.deps.logger.info('session/acp-fork: session forked', {
            sessionId: input.sessionId,
            sourceProviderSessionId: persistentForkSource,
            forkedProviderSessionId: forked.sessionId,
            connectionKey: connection.key,
          });
        } catch (e) {
          if (isAuthRequiredError(e)) throw e;
          await acquired.release();
          if (isProviderSessionMissingError(e, { resumingProviderSessionId: persistentForkSource })) {
            return acpErr.providerSessionMissing(toProviderSerializedError(e));
          }
          return acpErr.newSessionFailed(toProviderSerializedError(e));
        }
        if (!loadProviderSessionId) {
          await acquired.release();
          return acpErr.newSessionFailed(
            toSerializedError(new Error('ACP session/fork returned no session id'))
          );
        }
      }

      if (resolvedFork && (!connection.supportsLoadSession || !connection.agent.loadSession)) {
        await acquired.release();
        return acpErr.newSessionFailed(
          toSerializedError(new Error(`Provider '${input.providerId}' cannot load a resolved fork session`)),
        );
      }

      if (input.forkFromProviderSessionId && !forkMeta && !resolvedFork && !isPersistentFork) {
        if (!connection.supportsForkSession || !connection.agent.unstable_forkSession) {
          await acquired.release();
          return acpErr.newSessionFailed(
            toSerializedError(new Error(`Provider '${input.providerId}' does not support ACP session/fork`))
          );
        }
        let response;
        const request = this.buildForkSessionRequest(input, input.forkFromProviderSessionId, true);
        try {
          response = await connection.agent.unstable_forkSession(request);
        } catch (e) {
          if (isAuthRequiredError(e)) throw e;
          await acquired.release();
          if (isProviderSessionMissingError(e, { resumingProviderSessionId: input.forkFromProviderSessionId })) {
            return acpErr.providerSessionMissing(toProviderSerializedError(e));
          }
          return acpErr.newSessionFailed(toProviderSerializedError(e));
        }
        // 分叉产出的**那个 id** 必须留痕:`SessionCell: prompt failed` 只记 `acpSessionId`
        // (真正发出去的那个),两者对不上时**没有任何地方看得出来**。
        // ⚠️ 2026-09-07 实撞的形状:claude 的分叉 prompt 拿到 `Session not found` ——
        //    「适配器给了个没登记的 id」与「我们发的时候用错了 id」在读数上**完全同形**,
        //    而责任一个在上游、一个在咕咕。分不开就没法决定该改哪一边。
        this.deps.logger.info('session/acp-fork: session forked', {
          sessionId: input.sessionId,
          sourceProviderSessionId: input.forkFromProviderSessionId,
          forkedProviderSessionId: response.sessionId,
          connectionKey: connection.key,
        });
        record.cell.setAcpSessionId(response.sessionId);
        // 路由必须在**拿到 sessionId 的那一刻**就登记 —— 见下面 newSession 分支的说明。
        this.registerRoute(connection.key, response.sessionId, input.sessionId);
        record.cell.applySessionMeta({
          modes: response.modes,
          configOptions: response.configOptions,
        });
        const forkModelResult = await this.applyInitialModel(record, input, 'existing-provider-session', response.configOptions);
        if (!forkModelResult.success) {
          this.removeRecord(input.sessionId, false, false, true);
          await acquired.release();
          return forkModelResult;
        }
        if (forkModelResult.data) startupNotices.push(forkModelResult.data);
        const forkEffortResult = await this.applyInitialEffort(record, input);
        if (!forkEffortResult.success) {
          this.removeRecord(input.sessionId, false);
          await acquired.release();
          return forkEffortResult;
        }
        if (forkEffortResult.data) startupNotices.push(forkEffortResult.data);
        await this.applyConfiguredPermissionMode(record, input);
        record.cell.applySessionReady();
        Object.assign(record, { phase: 'ready' });
      } else if (loadProviderSessionId && connection.supportsLoadSession && connection.agent.loadSession) {
        record.cell.setAcpSessionId(loadProviderSessionId);
        this.addLoading(connection.key, input.sessionId);
        this.registerRoute(connection.key, loadProviderSessionId, input.sessionId);
        // #5381 重放窗口开:这期间提交的回合是**重放回来的**,不是刚发生的。窗口由这里开合,
        // ❌ 不去问状态机——`endReplay()` 先切 phase 后发变更,那一刻问 phase 会把最后一回合报错。
        record.replaying = true;
        record.cell.beginReplay();

        try {
          const response = await connection.agent.loadSession(
            this.buildLoadSessionRequest(input, loadProviderSessionId)
          );
          record.cell.applySessionLoaded({
            modes: response.modes,
            configOptions: response.configOptions,
          });
          const modelResult = await this.applyInitialModel(record, input, 'existing-provider-session', response.configOptions);
          if (!modelResult.success) {
            // 只剩 invalid_state 走这里 —— 那是「这条会话已经不在了」这个生命周期事实,
            // 不是配置问题。❌ 不回落到 session/new 重开一条。
            this.removeRecord(input.sessionId, false, false, true);
            await acquired.release();
            return modelResult;
          }
          if (modelResult.data) startupNotices.push(modelResult.data);
          const effortResult = await this.applyInitialEffort(record, input);
          if (!effortResult.success) {
            this.removeRecord(input.sessionId, false);
            await acquired.release();
            return effortResult;
          }
          if (effortResult.data) startupNotices.push(effortResult.data);
          await this.applyConfiguredPermissionMode(record, input);
          if (!initialQueueAdmitted) {
            const queueResult = this.queueInitialPrompts(record);
            if (!queueResult.success) {
              this.removeRecord(input.sessionId, false, false, true);
              await acquired.release();
              return queueResult;
            }
            initialQueueAdmitted = true;
          }
          record.cell.endReplay(
            Date.now(),
            this.reconnectingSessions.has(input.sessionId)
              ? classifyTurnFailure({
                  at: 'connection-lost',
                  failure: this.reconnectingSessions.get(input.sessionId) ?? null,
                }).outcome
              : undefined,
          );
          Object.assign(record, { phase: 'ready' });
        } catch (e) {
          if (isAuthRequiredError(e)) throw e;
          const missing = isProviderSessionMissingError(e, { resumingProviderSessionId: loadProviderSessionId });
          // #7223 建来常驻、一句没聊过的 agent(宿主说的,见 `freshIfProviderSessionMissing`):引擎没有这条 =
          // 它缺的只是一次还没发生的启动 ⇒ 照下面的降级退回 `session/new`,同一张票、同一条 record,
          // 启动途中排进来的话都还在。聊过的(没带这一格)照旧如实报 missing。
          const neverRan = missing && !resolvedFork && input.freshIfProviderSessionMissing === true;
          if (missing && !neverRan) {
            this.removeRecord(input.sessionId, false, false, true);
            await acquired.release();
            return acpErr.providerSessionMissing(toSerializedError(e));
          }
          if (resolvedFork) {
            this.removeRecord(input.sessionId, false, false, true);
            await acquired.release();
            return acpErr.newSessionFailed(toProviderSerializedError(e));
          }
          // 断线重连(lost 记录)也一样:那次续的 id 是 lost 记录钉回来的,没跑完过一轮的接不上就新开。
          if (!neverRan && this.reconnectingSessions.has(input.sessionId)) throw e;
          // ⚠️ 这里**不抛**。dev 的会话模型重做曾把这一处改成 `throw e`,理由是「load 失败绝不是
          // 创建另一条 provider 会话的许可 —— 那会保住产品会话 id 而悄悄换掉它的 provider 历史」。
          // 那条理由成立的前提是**降级只能是静默的**;它不再成立了:
          //   ① 会话页现在自己存着历史(#5381),会话照常打开、用户说过的话照常在屏幕上;
          //   ② 换引擎这件事下面会在转录开头画一条线写明原因 —— 降级看得见,不是悄悄换。
          // 而抛出去的代价是屏幕上只剩「Failed to load chat」加一个**注定失败**的 Retry
          // (#5553 自己量到:provider 那侧确实不在了,点多少次都是同一个失败)。
          // owner 2026-09-13 的裁决:「不可能打不开,打不开是 bug 级别的问题,基本代表产品不可用」
          // ⇒ 「打不开」不是可以拿来换「合同更严格」的一边,它是 P0。❌ 别再改回 throw。
          //
          // ⚠️ **原因必须带上**。这条 warn 是历史丢失唯一的痕迹,而
          // `session-history-replay` 的合同写着「截断与失败都要留下可诊断的痕迹 ——
          // 『少了一截』和『本来就没有』在界面上长得一模一样」。只写「failed」的话,
          // 事后没有任何东西能分开「provider 认不出这条会话」与「进程换了家、找不到 rollout」
          // (2026-09-07 隔离栈实撞:换计费路那一跳 load 失败,日志里查不出为什么)。
          this.deps.logger.warn(
            neverRan
              ? 'SessionManager: provider session missing and the session never ran; starting a new session'
              : 'SessionManager: loadSession failed, starting a new session',
            {
              sessionId: input.sessionId,
              cause: toSerializedError(e),
            }
          );
          // #5381 ④ 日志不是给用户看的。会话页现在自己存着历史 ⇒ 屏幕上照旧是满屏对话,
          // 而 agent 那边一个字都没有 —— 降级到这里为止都还是**静默**的。
          // 把原因带出去,下面在新会话的转录开头画一条界。
          // #7223 那支也画:「没聊过」是宿主按记录推断的,万一是 #5381 之前聊过的老会话,这条界就是如实告知。
          contextResetReason = e instanceof Error ? e.message : String(e);
          // ⚠️ 重放窗口在 cell 那一侧也必须关。上面 `beginReplay()` 把状态机推进了 `replaying`,
          // 成功路径在 try 里 `endReplay()` 关掉它;失败退回 `session/new` 这条路原先谁都没关 ——
          // 于是这条会话此后**一条回合都不记录**:2026-09-13 追 dev 时对照实测,load 成功的会话
          // 发一句话得到 `[["message"]]`,而降级后的会话得到 `[]`,连用户自己刚打的字都没留下,
          // 重启就什么都没有了。它不报错、界面照常能打字,是一处静默失败。
          // ❌ 不要挪进下面的 finally:成功路径已经在 try 里关过一次,再关就是重复触发。
          // #7223 没跑完过一轮的那支关窗但留在 starting(见 `abandonReplay`):排着的话等新 id 到手再发。
          if (neverRan) record.cell.abandonReplay(Date.now());
          else record.cell.endReplay(Date.now());
        } finally {
          this.removeLoading(connection.key, input.sessionId);
          // 重放窗口关。放在 finally:失败路径上也必须关,否则这条 record 之后所有真实回合
          // 都会被标成 replay,主进程按「库里有行就丢弃」的策略把它们全扔掉 —— 历史从此不再增长。
          // catch 里几条出口会先把 record 置空(那条 record 已经被移除),此处照顾到即可。
          if (record) record.replaying = false;
        }
      }

      if (record.phase === 'starting') {
        // Own the startup queue in the runtime from the moment the adapter connection exists.
        // The provider session id is not known yet, but queued prompts do not need an ACP address
        // until SessionReady drains them. This removes the renderer-side handoff window.
        let response;
        // 走 `session/new` 分叉的那一家:把它那份 `_meta` 并进来。
        // ⚠️ 底仍然是 `ephemeralForkMeta(...)` —— 分叉**不落库**这件事对两条路都成立,
        //    只在 fork 这条路上把它漏掉,分叉就会在用户的 harness 里留下一条会话。
        const request = forkMeta
          ? {
              ...this.buildNewSessionRequest(input),
              _meta: mergeClaudeOptions(ephemeralForkMeta(sessionOpenMeta(input)._meta), forkMeta),
            }
          : this.buildNewSessionRequest(input);
        if (forkMeta) {
          const requestMeta = isRecord(request._meta) ? request._meta : undefined;
          const claudeCode = requestMeta && isRecord(requestMeta.claudeCode)
            ? requestMeta.claudeCode
            : undefined;
          const claudeOptions = claudeCode && isRecord(claudeCode.options)
            ? claudeCode.options
            : undefined;
          this.deps.logger.info('session/acp-fork: request metadata', {
            providerId: input.providerId,
            sessionId: input.sessionId,
            resume: typeof claudeOptions?.resume === 'string' ? claudeOptions.resume : null,
            forkSession: claudeOptions?.forkSession === true,
            persistSession: claudeOptions?.persistSession === false,
            connectionKey: connection.key,
          });
        }
        try {
          response = await connection.agent.newSession(request);
        } catch (e) {
          if (isAuthRequiredError(e)) throw e;
          // Keep the provider's original failure beside the generic wire error. The renderer
          // only receives HANDLER_ERROR, so without this record a Claude/Codex startup failure
          // cannot be distinguished from a host transport failure.
          this.deps.logger.error('SessionManager: newSession failed', {
            sessionId: input.sessionId,
            providerId: input.providerId,
            cause: toProviderSerializedError(e),
          });
          this.removeRecord(input.sessionId, false, false, true);
          await acquired.release();
          return acpErr.newSessionFailed(toSerializedError(e));
        }
        if (forkMeta && input.forkFromProviderSessionId && response.sessionId === input.forkFromProviderSessionId) {
          this.removeRecord(input.sessionId, false, false, true);
          await acquired.release();
          return acpErr.newSessionFailed(
            toSerializedError(
              new Error(
                'adapter returned the source session id for a runtime fork — fork-session shim did not '
                  + 'take effect; refusing to register a fork that would overwrite the live parent'
              )
            )
          );
        }
        record.cell.setAcpSessionId(response.sessionId);
        // #5143 —— **拿到 sessionId 的那一刻就登记路由**,不能等模型/档位/初始队列都摆完。
        //
        // agent 完全可以在 `newSession` 一返回就推通知(`claude-agent-acp` 就是这么干的:
        // 响应之后 `setTimeout(0)` 发 `available_commands_update`)。而这条路从前只在函数
        // 末尾登记一次,中间还隔着 `applyInitialModel` 的一次真 RPC 往返 —— 那段时间里
        // `onSessionUpdate` 解不出 conversationId,通知被丢掉,产品面就是「**新建的会话
        // `/` 面板是空的,重开的却是满的**」(`session/load` 一直是调用前就登记的)。
        //
        // ⚠️ 这不是给 claude 打补丁:**中间每一次 await 都是一扇窗**,今天漏的是命令表,
        //    换个推得快的 agent 就是别的东西。codex 那条腿之所以没露馅,只是因为它先
        //    `await` 了一次 `skills/list` 往返、恰好错开了窗口 —— 那是运气,不是设计。
        this.registerRoute(connection.key, response.sessionId, input.sessionId);
        this.deps.logger.info('session/acp-fork: runtime child registered', {
          providerId: input.providerId,
          sessionId: input.sessionId,
          sourceSessionId: input.sourceSessionId,
          sourceProviderSessionId: input.forkFromProviderSessionId,
          childProviderSessionId: response.sessionId,
          connectionKey: connection.key,
        });
        record.cell.recordRaw({
          kind: 'session_new',
          sessionId: response.sessionId,
          request: {
            cwd: request.cwd,
            mcpServerNames: request.mcpServers.map((server) => server.name),
          },
          response: {
            sessionId: response.sessionId,
            modes: response.modes,
            configOptions: response.configOptions,
          },
        });
        record.cell.applySessionMeta({
          modes: response.modes,
          configOptions: response.configOptions,
        });
        const modelResult = await this.applyInitialModel(record, input, 'new-session', response.configOptions);
        if (!modelResult.success) {
          this.removeRecord(input.sessionId, false, false, true);
          await acquired.release();
          return modelResult;
        }
        if (modelResult.data) startupNotices.push(modelResult.data);
        const effortResult = await this.applyInitialEffort(record, input);
        if (!effortResult.success) {
          this.removeRecord(input.sessionId, false);
          await acquired.release();
          return effortResult;
        }
        if (effortResult.data) startupNotices.push(effortResult.data);
        await this.applyConfiguredPermissionMode(record, input);
        if (loadProviderSessionId && !initialQueueAdmitted) {
          const queueResult = this.queueInitialPrompts(record);
          if (!queueResult.success) {
            this.removeRecord(input.sessionId, false, false, true);
            await acquired.release();
            return queueResult;
          }
        }
        record.cell.applySessionReady();
        Object.assign(record, { phase: 'ready' });
        // #5381 ④ 引擎接不上旧会话、这条是新开的 ⇒ 在转录开头画一条界。
        // ⚠️ 放在 `applySessionReady()` **之后**:在那之前 cell 还没进可收事件的状态。
        // 也只在**降级**这条路上画 —— 用户主动新建的会话没有「上面的内容」,画了是噪音。
        if (contextResetReason !== null) {
          record.cell.push({ kind: 'context_reset', reason: contextResetReason });
        }
      }

      if (record.phase !== 'ready') {
        throw new Error(`SessionManager: session ${input.sessionId} did not reach ready phase`);
      }
      // 启动期的降级一律在这里落成转录里的一行 —— **一个落点,覆盖上面每一条分支**。
      // ⚠️ 放在 ready 之后:在那之前 cell 还没进可收事件的状态(同 context_reset 那条)。
      for (const notice of [...startupNotices, ...record.announcedNotices.splice(0)]) {
        this.pushSessionNotice(record, notice);
      }
      this.registerRoute(connection.key, record.cell.acpSessionId, input.sessionId);

      this.syncRecord(record);
      return ok({ providerSessionId: record.cell.acpSessionId });
    } catch (e) {
      if (record) this.removeRecord(record.input.sessionId, false, false, true);
      await acquired.release();
      if (isAuthRequiredError(e)) {
        return acpErr.authRequired(toSerializedError(e));
      }
      return acpErr.initializeFailed(toSerializedError(e));
    }
  }

  async prompt(input: SendPromptInput): Promise<Result<{ queued: boolean }, AcpSendPromptError>> {
    const record = this.cells.get(input.sessionId);
    if (!record) return acpErr.sessionNotFound(input.sessionId);
    if (record.phase === 'lost') {
      return acpErr.invalidState(
        `Session '${input.sessionId}' lost its ACP adapter: ${record.loss.message}; reconnect before sending`
      );
    }
    return await record.cell.prompt(input.prompt, input.steerIfBusy ? { steerIfBusy: true } : undefined);
  }

  /** Internal host path: resolve admission without waiting for the provider turn. */
  promptDetached(input: SendPromptInput): Result<{
    admission: Promise<Result<{ queued: boolean; steered?: boolean }, AcpSendPromptError>>;
    completion: Promise<Result<{ queued: boolean }, AcpSendPromptError>>;
  }, AcpSendPromptError> {
    const record = this.cells.get(input.sessionId);
    if (!record) return acpErr.sessionNotFound(input.sessionId);
    if (record.phase === 'lost') {
      return acpErr.invalidState(
        `Session '${input.sessionId}' lost its ACP adapter: ${record.loss.message}; reconnect before sending`
      );
    }
    const detached = record.cell.promptDetached(input.prompt, input.steerIfBusy ? { steerIfBusy: true } : undefined);
    return ok({
      admission: detached.admission,
      completion: detached.completion,
    });
  }

  async queuePrompt(
    input: SendPromptInput,
    startInput?: AcpStartInput,
  ): Promise<Result<{ queued: boolean }, AcpQueuePromptError>> {
    let record = this.cells.get(input.sessionId);
    if (!record && startInput) {
      if (startInput.sessionId !== input.sessionId) {
        return acpErr.invalidState(
          `Queue prompt session ${input.sessionId} does not match startup session ${startInput.sessionId}`
        );
      }
      const started = this.start(startInput);
      record = this.cells.get(input.sessionId);
      if (!record) {
        const result = await started;
        if (!result.success) {
          return acpErr.invalidState(
            `Cannot queue prompt while session startup failed: ${result.error.message ?? result.error.type}`
          );
        }
        record = this.cells.get(input.sessionId);
      }
    }
    if (!record) {
      const starting = this.startingSessions.get(input.sessionId);
      if (starting) {
        const started = await starting;
        if (!started.success) return acpErr.sessionNotFound(input.sessionId);
        record = this.cells.get(input.sessionId);
      }
    }
    if (!record) return acpErr.sessionNotFound(input.sessionId);
    if (record.phase === 'lost') {
      return acpErr.invalidState(
        `Session '${input.sessionId}' lost its ACP adapter: ${record.loss.message}; reconnect before sending`
      );
    }
    // #6762 排队与发送同一个准入:在不在跑由运行时在到达这一刻判 —— 空闲就当场开一轮,❌ 照调用方
    // 读到的「在跑」原样入队(见 `SessionCell.queueBehindTurn`)。只有真进了队列,它的字节才靠队列快照活着。
    const result = await record.cell.queueBehindTurn(input.prompt);
    if (!result.success) return result;
    if (!result.data.queued) return result;
    return record.queuePersistenceFailure() ?? result;
  }

  editQueuedPrompt(
    sessionId: string,
    id: string,
    input: SendPromptInput['prompt'],
    queueEdit?: QueuedPromptEdit | null
  ): Result<void, AcpEditQueuedPromptError> {
    const record = this.cells.get(sessionId);
    if (!record) return acpErr.sessionNotFound(sessionId);
    const result = record.cell.editQueuedPrompt(id, input, queueEdit);
    if (!result.success) return result;
    return record.queuePersistenceFailure() ?? result;
  }

  removeQueuedPrompt(sessionId: string, id: string): Result<void, AcpDeleteQueuedPromptError> {
    const record = this.cells.get(sessionId);
    if (!record) return acpErr.sessionNotFound(sessionId);
    const result = record.cell.removeQueuedPrompt(id);
    if (!result.success) return result;
    return record.queuePersistenceFailure() ?? result;
  }

  reorderQueue(
    sessionId: string,
    ids: readonly string[]
  ): Result<void, AcpChangeQueuePromptOrderError> {
    const record = this.cells.get(sessionId);
    if (!record) return acpErr.sessionNotFound(sessionId);
    const result = record.cell.reorderQueue(ids);
    if (!result.success) return result;
    return record.queuePersistenceFailure() ?? result;
  }

  /** 排队提示插进在飞的那一轮(#6574,见 SessionCell.steerQueuedPrompt)。 */
  async steerQueuedPrompt(
    sessionId: string,
    id: string
  ): Promise<Result<void, AcpSteerQueuedPromptError>> {
    const record = this.cells.get(sessionId);
    if (!record) return acpErr.sessionNotFound(sessionId);
    if (record.phase === 'lost') {
      return acpErr.invalidState(
        `Session '${sessionId}' lost its ACP adapter: ${record.loss.message}; reconnect before sending`
      );
    }
    const result = await record.cell.steerQueuedPrompt(id);
    if (!result.success) return result;
    return record.queuePersistenceFailure() ?? result;
  }

  async cancel(sessionId: string): Promise<Result<void, AcpCancelTurnError>> {
    const record = this.cells.get(sessionId);
    if (!record) return ok();
    return record.cell.cancel();
  }

  finishHistoryRevert(sessionId: string): void { this.cells.get(sessionId)?.cell.finishHistoryRevert(); }

  async revertSession(sessionId: string, anchor: string) {
    const record = this.cells.get(sessionId);
    if (!record) return acpErr.sessionNotFound(sessionId);
    return record.cell.revertSession(anchor);
  }

  async stopBackgroundTask(
    sessionId: string,
    taskId: string
  ): Promise<Result<void, AcpStopBackgroundTaskError>> {
    const record = this.cells.get(sessionId);
    if (!record) return acpErr.sessionNotFound(sessionId);
    return record.cell.stopBackgroundTask(taskId);
  }

  setPromptDraft(
    sessionId: string,
    draft: PromptDraftUpdate
  ): Result<void, AcpSetPromptDraftError> {
    const record = this.cells.get(sessionId);
    if (!record) return acpErr.sessionNotFound(sessionId);
    return record.cell.setPromptDraft(draft);
  }

  async stop(sessionId: string): Promise<Result<void, AcpStopSessionError>> {
    let record = this.cells.get(sessionId);
    if (!record) {
      // 一次起不来的启动只留下摘要(`lost` + start-failed),没有 record。停止 / 删除这条会话时它也得走,
      // 否则状态投影会一直说 error,会话编排一直当它 lost —— 连会话删了都还在。
      this.deleteSessionSummary(sessionId);
      return ok();
    }
    if (record.phase === 'starting' || !record.connectionLease) {
      const starting = this.startingSessions.get(sessionId);
      if (starting) {
        // 启动只等事实(适配器回话 / 退出),没有时钟 ⇒ 一个卡住的适配器只能由属主放弃。
        // 停止就是放弃:销毁这条连接的 scope ⇒ 适配器收到 SIGTERM、版本探针被 abort ⇒
        // 启动以「退出」这个事实结束,`settleFailedStart` 写明「在哪一步被取消、等了多久」。
        this.abandonedStarts.add(sessionId);
        await this.connections.invalidate(
          makeAcpConnectionKey(record.input.providerId, record.input.workspaceId, sessionId),
        );
        await starting;
      }
      record = this.cells.get(sessionId);
    }
    if (!record || record.phase !== 'ready') return ok();
    this.intentionalProcessCloses.add(record.processKey);
    try {
      await record.cell.closeSession();
      this.deps.promptQueueStore?.clear(sessionId);
      this.removeRecord(sessionId, false, true);
      await record.connectionLease.release();
      return ok();
    } catch (error) {
      return acpErr.stopFailed(toSerializedError(error));
    } finally {
      this.intentionalProcessCloses.delete(record.processKey);
    }
  }

  resolvePermission(
    sessionId: string,
    requestId: string,
    optionId: string
  ): Result<void, AcpResolvePermissionError> {
    const record = this.cells.get(sessionId);
    if (!record) return acpErr.sessionNotFound(sessionId);
    return record.cell.resolvePermission(requestId, optionId);
  }

  /**
   * Assert the model the conversation record names on this session (spec provider-blocker, #5047;
   * spec capability-bundle, #6196). This is the **one** place a start makes the provider run the
   * recorded model; the host hands both halves of the record in:
   *
   * - `input.model` — a harness-native id (the user's own model).
   * - `input.platformModel` — the Gugu platform model this start pinned (canonical id). Its wire
   *   form is taken from the list the live session itself advertises (`gugu-platform/<id>` on
   *   pi / opencode, the bare id where nothing is advertised — copilot), never spelled here.
   *
   * The spawn alone does not decide the model of a session the provider already has: pi and
   * copilot restore the model from their own session memory on `session/load`, whatever the
   * process was spawned with (#6196, measured on mac1). So on an existing provider session the
   * platform model is asserted too. Two cases where there is nothing to assert, both read from
   * declarations/facts rather than from which harness this is:
   * - a brand-new provider session has no memory to override the spawn;
   * - a model dimension declared `reload-session` is, by that declaration, carried by the spawn
   *   on resume (qwen follows its process env) and has no live setter to assert through.
   *
   * A rejected model ends the start — never a warning. But the two ways it can fail carry
   * different evidence, and only one of them proves the session would run the WRONG model:
   *
   * - **The provider exposes no model dimension at all.** On a NEW session that is the #5047
   *   failure: the session would start on whatever the provider defaults to while the product
   *   goes on showing the chosen model, and the only symptom the user gets is a turn that never
   *   answers. On a session the provider ALREADY has (`session/load`, `session/fork`) it proves
   *   nothing: that session carries the model it was created with, so a missing dimension means
   *   "cannot re-assert", not "diverged" — and refusing to reopen it would break a healthy
   *   conversation over a reading that never disagreed with us. Measured both ways on mac1:
   *   claude re-advertises the dimension on load and resumes through this path, while the Gugu
   *   codex bridge never advertises it at all (#5050).
   * - **The provider refuses the id.** That is a live rejection of this exact model, and it
   *   fails the start on every path — the id is no more applicable to an existing session than
   *   to a new one.
   *
   * The provider's own reason travels in the error so the surface can show it verbatim and offer
   * the platform-model exit.
   */
  private async applyInitialModel(
    record: SessionRecord,
    input: AcpStartInput,
    origin: 'new-session' | 'existing-provider-session',
    /** provider 在 `session/new` / `session/load` 应答里报的那份目录,用来说出「现在跑的是什么」。 */
    providerConfigOptions?: readonly SessionConfigOption[] | null
  ): Promise<Result<StartupNotice | null, InvalidStateError | SetConfigFailedError>> {
    record.startupSettingsSealed.add('model');
    const chosen = record.startupSettings.model;
    // 启动期间用户选过 ⇒ 断言他选的那个(渲染层递来的就是线上值,与活会话热切同一份)。
    const target = chosen !== undefined
      ? { kind: 'assert' as const, requested: chosen, wireValue: chosen }
      : this.recordedModelTarget(record, input, origin);
    if (!target) return ok(null);
    if (target.kind === 'already-running') return ok(null);
    const requested = target.requested;
    const hasModelTarget = record.cell.hasConfigTarget('model');
    if (!hasModelTarget && origin === 'new-session') {
      // No setting operation can run without a model dimension. Keep the
      // provider-created session without manufacturing a failed live mutation.
      return ok({
        code: 'model-unavailable',
        detail: `${requested}: Provider '${input.providerId}' does not expose model configuration`,
      });
    }
    if (!hasModelTarget && origin === 'existing-provider-session') {
      // ❌ 不是把失败软化掉:这条路上「维度缺席」根本不是一次失败读数 —— provider 自己那条会话
      //    带着它创建时的模型,咕咕只是没法再断言一次。响亮记一行说清放行的理由,❌ 不复用
      //    「failed to apply initial model」那句(它现在专指真失败)。
      this.deps.logger.warn(
        'SessionManager: provider exposes no model dimension on an existing session; the recorded model cannot be re-asserted, it runs what the provider restored',
        {
          sessionId: input.sessionId,
          providerId: input.providerId,
          model: requested,
        }
      );
      return ok(null);
    }
    // `cell.setConfigOption` 走 dispatchFor,机器给出预期外的错误类型时它是**抛**而不是返回 ——
    // 这里就地收成同一条结构化失败。load/session-new 的恢复边界在上层统一 fail-loud,
    // 不允许把一次恢复失败改写成另一条 provider 会话。
    let result: Result<LiveSettingApplyResult, AcpSetModelOptionError>;
    try {
      result = await record.cell.setConfigOption('model', target.wireValue, { startupOnly: true });
    } catch (error) {
      result = acpErr.setConfigFailed(toSerializedError(error));
    }
    if (chosen !== undefined) record.startupSettingOutcomes.model = result;
    if (result.success) {
      // provider 收下了一个它目录里确实有的 id 却停在别处 ⇒ 用户选的和实际在跑的不是一个东西。
      // ⚠️ 别名被规范化(`opus` → `opus[1m]`)**不在此列** —— 见 cell.ts `wasSubstituted` 抬头。
      const applied = result.data as { substituted?: string; effectiveValue?: string };
      if (applied.substituted) {
        return ok({
          code: 'model-substituted' as const,
          detail: `requested '${applied.substituted}', provider is running '${applied.effectiveValue ?? 'unknown'}'`,
          ...(applied.effectiveValue !== undefined ? { effectiveValue: applied.effectiveValue } : {}),
        });
      }
      return ok(null);
    }
    // invalid_state 是会话**生命周期**的事实(这条会话已经不在了),不是配置问题 —— 原样上抛。
    if (result.error.type !== 'set_config_failed') {
      if (result.error.type === 'invalid_state') return result as Result<never, InvalidStateError>;
    }
    const cause: SerializedError = result.error.cause?.message
      ? result.error.cause
      : { name: result.error.cause?.name ?? result.error.type, message: result.error.message ?? result.error.type };
    const explanation = this.deps.agentHost.resolveAcp(input.providerId)?.behavior.explainError?.(cause);
    const explainedCause = explanation
      ? { ...cause, message: `${cause.message} ${explanation}` }
      : cause;
    // ⚠️ 这里**曾经**是 `return acpErr.initialModelUnappliable(...)`,即「模型落不下去 ⇒ 整条会话
    //    起不来」(#5047)。那条裁决在 owner 2026-09-19 被推翻:「任何 bug 都不应该让会话打不开」。
    //    而它本来想守的不变量是「界面显示的模型 == 实际在跑的模型」—— 那条不变量由**说实话**来守,
    //    不是由杀掉会话来守:会话照常开在 provider 自己的默认模型上,转录里一行说清现在跑的是什么。
    //    spec `session-always-openable` / `session-history-replay`「『打不开』不是一种可接受的降级形态」。
    // ❌ 别再改回 fail —— 这是同一条裁决在本仓的第三个落点(前两个:`session/load` 失败、
    //    `providerSessionState === 'missing'` 时的读库早返回)。
    this.deps.logger.warn('SessionManager: initial model cannot be applied; confirming the provider current model', {
      sessionId: input.sessionId,
      providerId: input.providerId,
      model: target.wireValue,
      origin,
      error: result.error,
    });
    const effective = SessionManager.currentModelValue(providerConfigOptions);
    if (!effective) {
      return acpErr.initialModelUnappliable(input.providerId, requested, explainedCause);
    }
    // The rejected setting blocked prompts in the cell. Confirm a usable model
    // through the same setting authority so the block is cleared by a real ack.
    const confirmed = await record.cell.setConfigOption('model', effective, { startupOnly: true });
    if (!confirmed.success) {
      if (confirmed.error.type === 'invalid_state') return confirmed as Result<never, InvalidStateError>;
      return acpErr.setConfigFailed(confirmed.error.cause ?? {
        name: confirmed.error.type,
        message: confirmed.error.message ?? confirmed.error.type,
      });
    }
    if (confirmed.data.status !== 'applied') {
      return acpErr.setConfigFailed({
        name: 'LiveSettingUnconfirmed',
        message: `Provider has not applied startup model '${effective}' (${confirmed.data.status})`,
      });
    }
    return ok({
      code: 'model-unavailable' as const,
      detail: `${requested}: ${explainedCause.message ?? explainedCause.name}`,
      effectiveValue: confirmed.data.effectiveValue,
    });
  }

  /**
   * 会话记录要这条会话跑的那个模型,以及**这一次**要不要、用什么值去断言它。见 `applyInitialModel` 抬头。
   *
   * `already-running` = 活会话自报的当前值已经就是它(寻址换算后相等),不必再发一次 RPC。
   */
  private recordedModelTarget(
    record: SessionRecord,
    input: AcpStartInput,
    origin: 'new-session' | 'existing-provider-session',
  ): { kind: 'assert'; requested: string; wireValue: string } | { kind: 'already-running' } | null {
    const platformModel = input.platformModel;
    if (platformModel && input.model) {
      // 两半同时在场 = 会话记录自相矛盾(宿主按记录只给一半,见 host 的 `SessionInjectionFacts.model`)。
      // spawn 已经按平台那一半签了凭据、连了网关 ⇒ 自己的那个 id 在这条进程上够不着;断言平台那一半,并响亮记下矛盾。
      this.deps.logger.error('SessionManager: start input names both a platform model and an own model; asserting the platform one the spawn pinned', {
        sessionId: input.sessionId,
        providerId: input.providerId,
        platformModel,
        model: input.model,
      });
    }
    // 自己的模型:只有这一步把它落进会话 —— 新会话与续接一律断言(spawn 不带它)。
    if (!platformModel) {
      return input.model ? { kind: 'assert', requested: input.model, wireValue: input.model } : null;
    }
    // 平台模型:spawn 的注入已经带着它,只有续接一条带会话记忆的 provider 会话时才可能被顶掉。
    if (origin === 'new-session') return null;
    const declared = this.deps.agentHost.get(input.providerId)?.capabilities.acp.liveSettings?.model;
    if (declared?.channel === 'reload-session') return null;
    if (!declared || declared.channel === 'unsupported') {
      // 没有活通道就断言不了 —— 响亮记一行,❌ 不假装断言过。这条会话跑的是 provider 恢复出来的那个。
      this.deps.logger.warn(
        'SessionManager: provider declares no live model setting; the platform model pinned at spawn cannot be re-asserted on the resumed session',
        { sessionId: input.sessionId, providerId: input.providerId, model: platformModel },
      );
      return null;
    }
    const modelOptions = record.cell.config.modelOptions;
    const current = modelOptions?.selected;
    if (current && platformModelIdFromRuntimeOption(current, [platformModel]) === platformModel) {
      return { kind: 'already-running' };
    }
    const advertised = modelOptions?.available.map((option) => option.id) ?? [];
    // 报不出寻址形式就交规范 id:provider 不认会响亮拒,下面那条「说实话」的路径接住 —— ❌ 不在这里拼前缀。
    const wireValue = runtimeOptionForPlatformModelId(platformModel, advertised) ?? platformModel;
    return { kind: 'assert', requested: platformModel, wireValue };
  }

  /**
   * provider 自己报的那个模型值 —— 「现在跑的是什么」这句话的唯一来源,❌ 不猜、❌ 不拿
   * 插件里那张静态表顶替(那张表是给说不上 ACP 的路径用的,活目录读得到时以活目录为准)。
   *
   * 取自 `session/new` / `session/load` 的应答:设置那一步失败时它没被改动过,所以它就是
   * 这条会话此刻真正跑着的那个。读不到就返回 undefined —— 行上退回「引擎的默认模型」这句话,
   * ❌ 不编一个 id 出来。
   */
  private static currentModelValue(
    configOptions: readonly SessionConfigOption[] | null | undefined
  ): string | undefined {
    const option = configOptions?.find((entry) => entry.id === 'model');
    const value = (option as unknown as { currentValue?: unknown } | undefined)?.currentValue;
    return typeof value === 'string' ? value : undefined;
  }

  /**
   * Apply the effort level chosen in the composer before this session existed.
   *
   * Runs after the model is set, never before: the agent re-advertises its thought_level
   * options per model (Claude Code's list is literally described as "Available effort
   * levels for this model"), so setting effort first can target the outgoing model's list.
   *
   * A rejected level must not hold the session: the cell blocks every queued prompt until a
   * setting is confirmed, so a bare warn left the first prompt queued forever with nothing on
   * screen (#6199: codex rejected `ultra` for glm-5.3, zero gateway requests). Same shape as
   * the model: confirm the level the provider reports it is running through the same setting
   * authority (a real ack clears the block) and say so in the transcript. If the provider
   * reports no current level there is nothing true to confirm ⇒ the start fails loud.
   */
  private async applyInitialEffort(
    record: SessionRecord,
    input: AcpStartInput
  ): Promise<Result<StartupNotice | null, InvalidStateError | SetConfigFailedError>> {
    record.startupSettingsSealed.add('effort');
    const chosen = record.startupSettings.effort;
    const effort = chosen ?? input.effort;
    if (!effort) return ok(null);
    if (!record.cell.config.efforts) {
      // The provider reports no effort dimension for this session, so there is no request to
      // send (a startup attempt would fail before reaching it and still hold the cell). The level
      // is not applied; the session runs at the provider's own depth.
      this.deps.logger.warn('SessionManager: provider exposes no effort dimension; initial effort not applied', {
        sessionId: input.sessionId,
        providerId: input.providerId,
        effort,
      });
      return ok(null);
    }
    let result: Result<LiveSettingApplyResult, AcpSetModelOptionError>;
    try {
      result = await record.cell.setConfigOption('effort', effort, { startupOnly: true });
    } catch (error) {
      result = acpErr.setConfigFailed(toSerializedError(error));
    }
    if (chosen !== undefined) record.startupSettingOutcomes.effort = result;
    if (result.success && result.data.status === 'applied') return ok(null);
    if (!result.success && result.error.type === 'invalid_state') {
      return result as Result<never, InvalidStateError>;
    }
    const cause: SerializedError = result.success
      ? { name: 'LiveSettingUnconfirmed', message: `Provider has not applied effort '${effort}' (${result.data.status})` }
      : result.error.cause?.message
        ? result.error.cause
        : { name: result.error.cause?.name ?? result.error.type, message: result.error.message ?? result.error.type };
    // Only a failed setting operation blocks the cell. A failure raised before it ran (no
    // live-setting channel declared, e.g. copilot) holds nothing: ACP has no way to set the level,
    // so it counts only if the spawn already carried it (copilot's `--effort`, #6218); otherwise
    // the session runs at the provider default.
    if (!record.cell.liveSettingBlock) {
      this.deps.logger.warn('SessionManager: failed to apply initial effort', {
        sessionId: input.sessionId,
        providerId: input.providerId,
        effort,
        error: cause,
      });
      return ok(null);
    }
    this.deps.logger.warn('SessionManager: initial effort cannot be applied; confirming the provider current effort', {
      sessionId: input.sessionId,
      providerId: input.providerId,
      effort: effort,
      error: cause,
    });
    const effective = record.cell.config.efforts?.selected ?? undefined;
    if (!effective) return acpErr.setConfigFailed(cause);
    const confirmed = await record.cell.setConfigOption('effort', effective, { startupOnly: true });
    if (!confirmed.success) {
      if (confirmed.error.type === 'invalid_state') return confirmed as Result<never, InvalidStateError>;
      return acpErr.setConfigFailed(confirmed.error.cause ?? {
        name: confirmed.error.type,
        message: confirmed.error.message ?? confirmed.error.type,
      });
    }
    if (confirmed.data.status !== 'applied') {
      return acpErr.setConfigFailed({
        name: 'LiveSettingUnconfirmed',
        message: `Provider has not applied startup effort '${effective}' (${confirmed.data.status})`,
      });
    }
    return ok({
      code: 'effort-unavailable' as const,
      detail: `${effort}: ${cause.message ?? cause.name}`,
      effectiveValue: confirmed.data.effectiveValue ?? effective,
    });
  }

  async setMode(
    sessionId: string,
    modeId: string
  ): Promise<Result<LiveSettingApplyResult, AcpSetModeOptionError>> {
    const record = this.cells.get(sessionId);
    if (!record) return acpErr.sessionNotFound(sessionId);
    return record.cell.setMode(modeId);
  }

  async setConfigOption(
    sessionId: string,
    dimension: 'model' | 'effort',
    value: string
  ): Promise<Result<LiveSettingApplyResult, AcpSetModelOptionError>> {
    const starting = this.startingSessions.get(sessionId);
    const startingRecord = this.cells.get(sessionId);
    if (starting && startingRecord) {
      const chosen = await this.chooseStartupSetting(sessionId, startingRecord, starting, dimension, value);
      if (chosen) return chosen;
    }
    const record = this.cells.get(sessionId);
    if (!record) return acpErr.sessionNotFound(sessionId);
    const result = await record.cell.setConfigOption(dimension, value);
    // provider 收下了这次调用却停在别处 ⇒ 用户选的和实际在跑的不是一个东西。
    // ⚠️ 这条路**也**要说话:回读判据放宽之后(见 cell.ts `wasSubstituted`),活体改模型
    //    被顶掉不再是一次响亮失败,而下拉框会被 provider 目录刷回旧值 —— 用户看到选项自己
    //    弹回去、没有任何解释。落点与启动路径同一个,❌ 不在 renderer 里另写一份。
    if (result.success && result.data.status === 'applied' && result.data.substituted) {
      record.cell.push({
        kind: 'session_notice',
        code: 'model-substituted',
        detail: `requested '${result.data.substituted}', provider is running '${result.data.effectiveValue}'`,
        effectiveValue: result.data.effectiveValue,
      });
    }
    return result;
  }

  /**
   * #6552 会话还在起时来的一次选择。
   *
   * 启动在 `session/new` 之后本来就要设模型 / 强度(新建会话设的是记录里的值)。那一步还没到这一维 ⇒
   * 它设的就是这次选的值:同一步,❌ 不是起完之后再热切一次;排队的消息在那一步之后才出发,
   * 所以第一条消息就跑在选的模型上。等启动落定,把那一步对这个值的应答原样交回去。
   *
   * 那一步已经过了这一维 ⇒ 等启动落定,返回 null,由调用方照活会话去设。
   */
  private async chooseStartupSetting(
    sessionId: string,
    record: SessionRecord,
    starting: Promise<Result<{ providerSessionId: string }, AcpStartSessionError>>,
    dimension: StartupSettingDimension,
    value: string
  ): Promise<Result<LiveSettingApplyResult, AcpSetModelOptionError> | null> {
    if (record.phase !== 'starting' || record.startupSettingsSealed.has(dimension)) {
      await starting.catch(() => undefined);
      return null;
    }
    record.startupSettings[dimension] = value;
    const started = await starting.catch((error: unknown) =>
      acpErr.initializeFailed(toSerializedError(error))
    );
    if (!started.success) {
      return acpErr.invalidState(`Session ${sessionId} did not start; its ${dimension} was not applied`);
    }
    return (
      record.startupSettingOutcomes[dimension]
      ?? acpErr.setConfigFailed({
        name: 'StartupSettingNotApplied',
        message: `The session started without applying ${dimension} '${value}'`,
      })
    );
  }

  isRunning(sessionId: string): boolean {
    return this.cells.has(sessionId);
  }

  turnEnvelope(sessionId: string): TurnEnvelope | null {
    return this.cells.get(sessionId)?.cell.turnEnvelope ?? null;
  }

  getChatHistory(sessionId: string): AcpChatHistory {
    const live = this.cells.get(sessionId);
    if (live) return live.cell.history();
    return {
      committed: structuredClone(this.closedSessionHistories.get(sessionId) ?? []),
      active: null,
    };
  }

  exportParsedTranscript(sessionId: string): Result<string, AcpExportTranscriptError> {
    const record = this.cells.get(sessionId);
    if (!record) return acpErr.sessionNotFound(sessionId);
    return ok(record.cell.exportParsedTranscript());
  }

  exportRawAcpLog(sessionId: string): Result<string, AcpExportRawLogError> {
    const record = this.cells.get(sessionId);
    if (!record) return acpErr.sessionNotFound(sessionId);
    return ok(record.cell.exportRawLog());
  }

  getHistory(sessionId: string, before?: number, limit = 50): HistoryPage {
    const turns = this.getChatHistory(sessionId).committed;
    const filtered = before === undefined ? turns : turns.filter((turn) => turn.seq < before);
    const page = [...filtered].sort((a, b) => b.seq - a.seq).slice(0, limit);
    const nextCursor = page.length === limit ? page.at(-1)!.seq : null;
    return { turns: page.reverse(), nextCursor };
  }

  getSessionState(sessionId: string): SessionState {
    const record = this.cells.get(sessionId);
    if (record) return record.cell.sessionState;
    return closedSessionState();
  }

  getTerminals(sessionId: string): TerminalState[] {
    return this.terminalLiveRegistry.snapshotSession(sessionId);
  }

  getHostTerminals(): TerminalState[] {
    return this.terminals.listAll();
  }

  getLiveModels(sessionId: string): SessionLiveModels | null {
    return this.cells.get(sessionId)?.live ?? null;
  }

  syncTerminals(sessionId: string): void {
    const record = this.cells.get(sessionId);
    if (!record) return;
    const terminals = this.getTerminals(sessionId);
    publishLiveModelState(record.live.states.terminals, terminals, record.lastSynced.terminals);
    record.lastSynced.terminals = terminals;
    this.emitCommittedTurns(record);
  }

  killAllTerminals(): void {
    this.terminals.killAll();
  }

  onSessionUpdate(
    connection: AcpConnectionContext,
    params: SessionNotification,
    event: NormalizedEvent
  ): void {
    const sessionId = this.resolveSessionForProviderSession(connection.key, params.sessionId);
    if (!sessionId) {
      // #5143 的第二半:**根因是登记太晚,而它能藏一整天是因为这里太安静。**
      // 一条本该到达的会话通知被丢掉,产品只留一行 warn ⇒ 症状("命令表是空的")与原因
      // 之间隔着一整条链,只能靠人倒推。路由登记提前之后,走到这里就**不再是正常时序**,
      // 而是一条真的对不上号的通知 ⇒ 按 error 记,并说清丢了什么。
      // ❌ 不抛:这是通知回调,抛出去会带走整条连接 —— 响亮不等于把别的东西也弄死。
      this.deps.logger.error('SessionManager: dropped a session update with no known session', {
        providerSessionId: params.sessionId,
        processKey: connection.key,
        sessionUpdate: (params.update as { sessionUpdate?: string } | undefined)?.sessionUpdate,
      });
      return;
    }

    const record = this.cells.get(sessionId);
    if (!record) return;
    const fromChildSession = record.childProviderSessionIds.has(params.sessionId);
    if (!fromChildSession && record.cell.acpSessionId !== params.sessionId) {
      record.cell.setAcpSessionId(params.sessionId);
      this.registerRoute(connection.key, params.sessionId, sessionId);
    }
    record.cell.recordRaw({
      kind: 'session_update',
      sessionId: params.sessionId,
      update: params.update,
    });
    this.applyRawMeta(record.cell, params.update);
    const scoped = this.terminalLiveRegistry.route(sessionId, connection.key, params.sessionId, event);
    if (!scoped) return;
    event = scoped;
    // 子智能体派生了:它自己的会话号从此路由回本会话(#5117)。路由随本会话一起注销
    // (`unregisterRoutes` 按 conversationId 清)。
    if (event.kind === 'subagent' && event.subagentSessionId) {
      record.childProviderSessionIds.add(event.subagentSessionId);
      this.registerRoute(connection.key, event.subagentSessionId, sessionId);
    }
    let delivered = event;
    if (!fromChildSession && event.kind === 'commands') {
      record.providerCommands = event.commands;
      delivered = { ...event, commands: mergeCommands(event.commands, record.supplementalCommands) };
    }
    record.cell.push(
      fromChildSession
        ? { kind: 'subagent_stream', subagentSessionId: params.sessionId, event }
        : delivered
    );
    this.publishOnTick(record);
  }

  /** 与启动这一家时同一份 env(含托管配置根的 env),插件按它找自己的目录与存档。 */
  private providerEnv(input: AcpStartInput): Record<string, string> {
    return composeAgentSpawnEnv(input.runContext, { hostInjections: [input.capabilitySpawnEnv] });
  }

  /**
   * 见 `IAcpBehavior.onTurnEnded`。只在「正常结束、且没有别的回合接上」时跑;钩子要求继续 ⇒
   * 把 reason 当下一条消息发进去。连续继续的次数记在 record 上,一有别的回合进来就归零。
   */
  private runTurnEndHook(record: SessionRecord): void {
    const { input } = record;
    const hook = this.deps.agentHost.resolveAcp(input.providerId)?.behavior.onTurnEnded;
    const state = record.cell.sessionState;
    if (!hook || state.lastStopReason !== 'end_turn' || state.queuedPrompts.length > 0) return;
    const continued = record.stopHookContinuations ?? 0;
    record.stopHookContinuations = 0;
    void hook({
      providerSessionId: record.cell.acpSessionId,
      cwd: input.cwd,
      env: this.providerEnv(input),
      homeDir: os.homedir(),
      executionNum: continued + 1,
    })
      .then((result) => {
        if (!result?.continueWith || this.cells.get(input.sessionId) !== record) return;
        if (!record.cell.sessionState.canSubmit) return;
        record.stopHookContinuations = continued + 1;
        void record.cell.prompt({ text: result.continueWith, origin: 'communication' });
      })
      .catch((error: unknown) => {
        this.deps.logger.warn('SessionManager: turn-end hook failed', {
          sessionId: input.sessionId,
          providerId: input.providerId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  /**
   * 见 `IAcpBehavior.sessionTitleFromList`。每轮结束读一次 `session/list`:名字是这一家与首轮并行拟的,
   * 第一轮结束时可能还没拟完,下一轮结束再读。认下的名按推来的同一条路(`title` 事件)进会话状态,
   * 之后的优先级(显式命名 > harness 拟的名 > 首轮兜底)由宿主在写标题时判。读失败只记日志。
   */
  private pullListedSessionTitle(record: SessionRecord): void {
    const { input } = record;
    const pick = this.deps.agentHost.resolveAcp(input.providerId)?.behavior.sessionTitleFromList;
    if (!pick || record.phase !== 'ready') return;
    const agent = record.connectionLease.value.agent;
    if (!agent.listSessions) return;
    const providerSessionId = record.cell.acpSessionId;
    void agent
      .listSessions({ cwd: input.cwd })
      .then((page) => {
        const listed = page.sessions.find((session) => session.sessionId === providerSessionId)?.title;
        const title = listed ? pick(listed) : null;
        if (!title || this.cells.get(input.sessionId) !== record) return;
        if (record.cell.transcript.title === title) return;
        record.cell.push({ kind: 'title', title });
      })
      .catch((error: unknown) => {
        this.deps.logger.warn('SessionManager: session/list title read failed', {
          sessionId: input.sessionId,
          providerId: input.providerId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  /**
   * 见 `IAcpBehavior.readRules`。在建连之前读完 ⇒ 一定赶得上第一轮(首轮在 SessionReady 之后才出队)。
   * 读失败只记日志:少了规则不该让会话起不来。
   */
  private async attachProviderRules(
    record: SessionRecord,
    behavior: { readRules?: IAcpBehaviorReadRules }
  ): Promise<void> {
    if (!behavior.readRules) return;
    const { input } = record;
    try {
      const rules = await behavior.readRules({
        cwd: input.cwd,
        env: this.providerEnv(input),
        homeDir: os.homedir(),
        fs: discoveryFs,
      });
      if (rules?.trim()) record.cell.appendSessionContext(rules);
    } catch (error) {
      this.deps.logger.warn('SessionManager: provider rules could not be read', {
        sessionId: input.sessionId,
        providerId: input.providerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 见 `IAcpBehavior.discoverCommands`。与建连并行跑,❌ 不挡会话启动;结果到了就合进命令表 ——
   * 这一家的表若已经到了,就用合并后的表再推一次,否则等它到时在 `onSessionUpdate` 里合。
   */
  private discoverSupplementalCommands(
    record: SessionRecord,
    behavior: { discoverCommands?: IAcpBehaviorDiscover }
  ): void {
    const discover = behavior.discoverCommands;
    if (!discover) return;
    const { input } = record;
    void discover({ cwd: input.cwd, env: this.providerEnv(input), homeDir: os.homedir(), fs: discoveryFs })
      .then((commands) => {
        if (this.cells.get(input.sessionId) !== record || commands.length === 0) return;
        record.supplementalCommands = commands;
        record.cell.push({
          kind: 'commands',
          commands: mergeCommands(record.providerCommands ?? [], commands),
        });
        this.syncRecord(record);
      })
      .catch((error: unknown) => {
        this.deps.logger.warn('SessionManager: supplemental command discovery failed', {
          sessionId: input.sessionId,
          providerId: input.providerId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  onPermissionRequest(
    connection: AcpConnectionContext,
    params: AcpPermissionParams
  ): Promise<RequestPermissionResponse> {
    const sessionId = this.resolveSessionForProviderSession(connection.key, params.sessionId);
    const record = sessionId ? this.cells.get(sessionId) : undefined;
    if (!record) return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    const response = record.cell.requestPermission(params);
    this.syncRecord(record);
    return response;
  }

  onCreateTerminal(
    connection: AcpConnectionContext,
    params: CreateTerminalRequest
  ): Promise<CreateTerminalResponse> {
    const sessionId = this.resolveSessionForProviderSession(connection.key, params.sessionId);
    if (!sessionId) {
      throw new Error(`SessionManager: no session for ACP sessionId ${params.sessionId}`);
    }
    return this.ports.terminals.createTerminal(sessionId, connection.cwd, params, connection.key);
  }

  onProcessClosed(processKey: string, exit: AdapterExit): void {
    const intentional = this.intentionalProcessCloses.has(processKey);
    const removed: string[] = [];
    for (const record of [...this.cells.values()]) {
      if (record.phase !== 'ready' || record.processKey !== processKey) continue;
      const sessionId = record.input.sessionId;
      removed.push(sessionId);
      const active = record.cell.machine.isWorking || record.cell.transcript.activeTurn !== null;
      this.processingProcessClose.add(sessionId);
      record.cell.processClosed(exit, { abnormal: !intentional });
      this.processingProcessClose.delete(sessionId);
      // A prompt failure can settle the turn before the provider's process-close
      // callback arrives. Preserve that errored terminal summary just like an
      // active turn, while intentional stop/delete keeps the normal cleanup path.
      const errored = record.cell.sessionState.lastTurnOutcome === 'errored';
      const queued = record.cell.sessionState.queuedPrompts.length > 0;
      if (!intentional) {
        const failure = record.cell.sessionState.failure;
        if (!failure) {
          throw new Error(`SessionManager: abnormal adapter close produced no failure for ${sessionId}`);
        }
        // The provider session id is minted by session/new and is therefore absent from the
        // original start input. Capture it at the loss boundary so explicit reconnect can use
        // session/load (Claude's transcript --resume path) instead of silently creating a new
        // conversation. Runtime forks retain their fork declaration and may recreate the fork
        // when their provider does not persist ephemeral transcripts.
        record.input = { ...record.input, providerSessionId: record.cell.acpSessionId };
        Object.assign(record, {
          phase: 'lost',
          loss: failure,
        });
        this.deps.logger.error('SessionManager: ACP adapter exited; session is lost', {
          sessionId,
          processKey,
          exitCode: exit.exitCode,
          signal: exit.signal,
          active,
          errored,
          queued,
          failure,
        });
        this.deps.onPlatformSessionClosed?.(
          sessionId,
          record.input.platformAccessSessionId,
        );
      } else {
        this.removeRecord(sessionId, false, true);
      }
    }
    // 每条会话独占一个适配器；名单仍从实际绑定现算并报告，既给故障归因，也让 count!==1
    // 的隔离回归直接出现在日志里。哪条记录被带走只有这里知道 ⇒ 由这里报。
    // ⚠️ 非故意的那一支记 error:它是用户眼里「面板变死」的那一刻(#5388);
    // 故意关(stop / 删会话 / 换模型重开)记 info —— 同样要留痕,但它不是故障。
    const level = intentional ? 'info' : 'error';
    this.deps.logger[level]('session/acp-exit: sessions lost with adapter process', {
      processKey,
      exitCode: exit.exitCode,
      signal: exit.signal,
      intentional,
      removedCount: removed.length,
      removedSessionIds: removed,
    });
    const invalidation = this.connections.invalidate(processKey);
    this.invalidatingProcesses.set(processKey, invalidation);
    void invalidation.finally(() => {
      if (this.invalidatingProcesses.get(processKey) === invalidation) {
        this.invalidatingProcesses.delete(processKey);
      }
    });
  }

  /**
   * 这条会话此刻attach在哪个适配器进程上 —— 连接 key + pid,没有活记录时 null。
   *
   * 只给**会话重载**用:重载 = 停掉再带同一个 sessionId 起来。每个 conversation 的 key
   * 都包含自身 id，因此停止后重新启动必须取得新的 adapter 进程；key 与 pid 一并给出，便于
   * 诊断是否真的建立了新的进程归属。
   */
  adapterProvenance(sessionId: string): { connectionKey: string; pid: number | null } | null {
    const record = this.cells.get(sessionId);
    if (!record || record.phase !== 'ready') return null;
    return { connectionKey: record.processKey, pid: record.connectionLease.value.pid };
  }

  /**
   * #6396 宿主告诉这条会话一件事:
   *   - `notice` —— 在转录里画一行(存进历史、❌ 不进 agent 的上下文),例如它的 agent 登记时名字已被占用
   *     (名字不在 agent 的上下文里,要知道就调 profile_whoami,#6490);
   *   - `turnContext` —— #6387 扩展的「附带」:随下一轮进去、**进转录**、同键替换,见 `SessionCell.setTurnContext`。
   * 会话还在起 ⇒ 附带照挂(随首轮进去),行等 ready 再画。记录在 `start` 被调用的那一拍就建出来了,
   * 所以宿主只要等到 startSession 发出去就能递到。会话不在本 worker 里、或已经丢了 ⇒ `delivered: false`,
   * 由宿主决定怎么办(终端会话本来就不在这里)。
   */
  announce(input: {
    sessionId: string;
    notice?: StartupNotice;
    turnContext?: { key: string; text: string };
    credentialRefusal?: string | null;
  }): { delivered: boolean } {
    const record = this.cells.get(input.sessionId);
    if (!record || record.phase === 'lost') return { delivered: false };
    if (input.turnContext) record.cell.setTurnContext(input.turnContext.key, input.turnContext.text);
    if (input.credentialRefusal !== undefined) record.cell.noteCredentialRefusal(input.credentialRefusal);
    if (input.notice) {
      if (record.phase === 'ready') this.pushSessionNotice(record, input.notice);
      else record.announcedNotices.push(input.notice);
    }
    return { delivered: true };
  }

  private pushSessionNotice(record: SessionRecord, notice: StartupNotice): void {
    record.cell.push({
      kind: 'session_notice',
      code: notice.code,
      detail: notice.detail,
      ...(notice.effectiveValue !== undefined ? { effectiveValue: notice.effectiveValue } : {}),
      ...(notice.previousValue !== undefined ? { previousValue: notice.previousValue } : {}),
    });
  }

  private createRecord(
    input: AcpStartInput,
    acpSessionId: string,
  ): SessionRecord {
    const record = {} as SessionRecord;
    const provider = this.deps.agentHost.get(input.providerId);
    const callbacks: SessionCellCallbacks = {
      onSessionStateChanged: () => this.syncRecord(record),
      onTranscriptChanged: () => {
        this.publishOnTick(record);
        this.emitCommittedTurns(record);
      },
      onDraftChanged: () => this.syncRecord(record),
      onAgentEvent: (phase) => {
        if (phase !== 'stop') return;
        this.runTurnEndHook(record);
        this.pullListedSessionTitle(record);
      },
      onClosed: () => {
        if (this.processingProcessClose.has(input.sessionId)) return;
        this.removeRecord(input.sessionId, true, true);
      },
    };
    const cell = new SessionCell({
      sessionId: input.sessionId,
      projectId: input.projectId,
      providerId: input.providerId,
      acpSessionId,
      ...(input.platformAccessSessionId ? { platformCredentials: true } : {}),
      ...(provider?.capabilities.acp.liveSettings
        ? { liveSettings: provider.capabilities.acp.liveSettings }
        : {}),
      ...(provider?.capabilities.acp.sessionModes
        ? { sessionModes: provider.capabilities.acp.sessionModes }
        : {}),
      ...(provider?.capabilities.acp.kind === 'supported' && provider.capabilities.acp.midTurnSteer
        ? { midTurnSteer: provider.capabilities.acp.midTurnSteer }
        : {}),
      ...(() => {
        const turnFailure = this.deps.agentHost.resolveAcp(input.providerId)?.behavior.turnFailure;
        return turnFailure
          ? {
              turnFailure: {
                ...(turnFailure.fromAgentMessage ? { fromAgentMessage: turnFailure.fromAgentMessage } : {}),
                watchesStderr: Boolean(turnFailure.fromStderrLine),
              },
            }
          : {};
      })(),
      // 完全访问档的 request_permission 由 cell 当场作答 —— 判据与 TUI 推 flag 同一条表达式。
      autoApprovePermissions: isAutoApproveIntent(input),
      ...(provider?.capabilities.autoApprove.kind === 'supported'
        && provider.capabilities.autoApprove.modes
        ? { permissionModeMap: provider.capabilities.autoApprove.modes }
        : {}),
      resolveAttachment: this.deps.resolveAttachment,
      acceptsImagePrompts: false,
      ...(this.deps.mergeEnvelopes ? { mergeEnvelopes: this.deps.mergeEnvelopes } : {}),
      logger: this.deps.logger,
      // ③:没有系统位的家,会话级系统提示词以用户级载体随首轮进去(见 cell-deps 抬头)。
      // ⚠️ 与上面 `sessionOpenMeta` 互斥 —— 路由位决定去哪一边,不会两边都去。
      ...(input.sessionPromptCarrier === 'session-context' && input.sessionPrompt
        ? { sessionContext: input.sessionPrompt }
        : {}),
      callbacks,
    });
    Object.assign(record, {
      input,
      phase: 'starting',
      cell,
      childProviderSessionIds: new Set<string>(),
      replaying: false,
      announcedNotices: [],
      startupSettings: {},
      startupSettingsSealed: new Set<StartupSettingDimension>(),
      startupSettingOutcomes: {},
      emittedTurns: [],
      liveTurnIds: new Set<string>(),
      queuePersistenceError: null,
      queuePersistenceFailure: () => record.queuePersistenceError
        ? acpErr.invalidState(`Prompt queue snapshot failed for session ${input.sessionId}`)
        : null,
      live: createSessionLiveModels(this.sessionHost, input.sessionId, cell.sessionState),
      transcriptTick: null,
      transcriptPending: false,
      lastSynced: {
        sessionState: cell.sessionState,
        config: cell.config,
        usage: cell.usage,
        plan: null,
        agents: [],
        activeTurn: null,
        draft: null,
        terminals: [],
      },
    });
    this.cells.set(input.sessionId, record);
    return record;
  }

  private disposeLostRecord(record: Extract<SessionRecord, { phase: 'lost' }>): void {
    this.closedSessionHistories.set(record.input.sessionId, structuredClone(record.cell.history().committed));
    record.cell.dispose();
    if (this.cells.get(record.input.sessionId) === record) {
      this.cells.delete(record.input.sessionId);
    }
    void record.connectionLease.release();
  }

  private restoreLostRecord(record: Extract<SessionRecord, { phase: 'lost' }>): void {
    record.live = createSessionLiveModels(this.sessionHost, record.input.sessionId, record.cell.sessionState);
    this.cells.set(record.input.sessionId, record);
    this.syncRecord(record);
  }

  private queueInitialPrompts(record: SessionRecord): Result<void, InvalidStateError> {
    for (const prompt of record.input.initialQueue ?? []) {
      const result = record.cell.queuePrompt(prompt);
      if (!result.success) return result;
    }
    return ok();
  }


  private async applyConfiguredPermissionMode(
    record: SessionRecord,
    input: AcpStartInput
  ): Promise<void> {
    const provider = this.deps.agentHost.get(input.providerId);
    if (provider?.capabilities.acp.sessionModes === 'none') return;
    if (provider?.capabilities.autoApprove.kind !== 'supported') return;
    // 只读**权限那一维**的声明:三维各自声明(见 `LiveSettingsCapability`),量过模型那一维的家
    // 不因此就「声明了权限」—— 那一维缺席时仍走下面「未声明」那条规则。
    const permissionSetting = provider.capabilities.acp.liveSettings?.permission;
    // Any permissive fallback below is explicitly startup-only. A live mutation never reaches
    // this method; it is handled by SessionCell's serialized setting authority and must fail when
    // the provider cannot confirm the requested value.
    const allowStartupDowngrade = permissionSetting ? permissionSetting.allowStartupDowngrade !== false : true;
    // 与界面、终端腿同一个函数。生产调用方(runtime-process/host.ts 的启动包装,本机与远端机器都是它)
    // 在下发前就解析出显式档;❌ 「什么都没带就不碰档」—— 那等于把选档交给 harness 自己(#7366)。
    const wanted = resolveSessionPermissionMode(input);
    // 有些 harness 的「完全访问」不是它会自报的 mode,而是**会话包在 spawn 那一刻已兑现的**:
    // opencode 把完全访问写成 permission 规则(`{"*":"allow"}`,由 units.autonomy 落进
    // OPENCODE_CONFIG_CONTENT);grok 更彻底 —— 它的 ACP server 结构上恒为完全访问,从不发
    // `session/request_permission`、`session/new` 里连档位表都不报(P3f 实测,#4658)。这类家的
    // 缺档有两种形状:要么整张 modeOptions 缺席(grok),要么报了但表里没有「完全访问」这一档
    // (opencode 只报 build/plan)。两种都不是错,照旧抛就变成「用户要完全访问 ⇒ 会话起不来」。
    //
    // ⚠️ 放行卡得很死,❌ 不是把 throw 软化掉:
    //  · 只对 `full-access` —— 会话包自治维只能**精确**表达这一档(另一档 approval-required
    //    分不出 plan / read-only / edit),拿它冒充用户选的那一档就是骗人,那些情况必须继续响亮失败。
    //  · 且该家 **acp 腿**的 units.autonomy 确实是 native —— 经 `resolveUnitDelivery` 按腿解析,
    //    ❌ 别扁平读 `.kind`:per-surface 的 `.kind` 既不是 native 也不是 none,扁平读会把
    //    「这条腿 native」误判成不 native(grok 的 autonomy 正是 per-surface,只有 acp 那条 native)。
    const bundleDeliversFullAccess =
      wanted === 'full-access'
      && resolveUnitDelivery(
        provider.capabilities.sessionBundle.units.autonomy,
        'acp'
      ).kind === 'native';
    // 清单漏了 liveSettings 声明 —— 那是**本仓自己的 bug**。这里此前是一句无条件 throw,
    // 于是我们自己的一个清单错误会让用户**一条会话都打不开**。
    //
    // ⚠️ 但这一维不能照模型那条无脑放行:权限档位放行错了方向,会让会话跑在**比用户所选更松**
    // 的档上(claude 的 ACP 适配器默认档实测就是 `bypassPermissions`,全部工具调用自动批准)。
    // ⇒ 沿用本函数下面那条已有的判据,❌ 不另发明一条:**只有当用户要的就是阶梯顶端时**,
    //   「跑在这家自己的默认档上」才不可能比他要的更松 —— 那时照常开会话;更严的档仍然响亮失败,
    //   因为「悄悄给了更多权限」比「这条会话打不开」更坏。
    if (!permissionSetting) {
      if (isTopPermissionRung(wanted)) {
        this.deps.logger.error(
          'SessionManager: provider host omits the live permission setting; session opens on the provider default permission mode',
          { sessionId: input.sessionId, providerId: input.providerId, wanted }
        );
        return;
      }
      const error = new Error(
        `Provider '${input.providerId}' did not declare a live permission setting`,
      );
      error.name = 'LiveSettingUndeclared';
      throw error;
    }
    const options = record.cell.config.modeOptions;
    if (!options) {
      // 该档已在 spawn 那刻由会话包兑现(见上) —— grok 走这条:它一个档位都不报。
      if (bundleDeliversFullAccess) return;
      // 阶梯顶端 ⇒ 无论这家自己默认跑在哪一档,都不可能比用户所选的更松 ⇒ 照常开会话。
      // ❌ 不是把 throw 软化掉:更严的档走到这里仍然失败(见 isTopPermissionRung 抬头)。
      if (allowStartupDowngrade && isTopPermissionRung(wanted)) {
        this.deps.logger.warn('SessionManager: provider exposes no permission modes, starting anyway', {
          sessionId: input.sessionId,
          providerId: input.providerId,
          wanted,
        });
        return;
      }
      throw new Error(
        `Provider '${input.providerId}' did not expose a permission mode for the session`
      );
    }
    // ⚠️ 按三档归类匹配,❌ 别退回「找第一个非破坏性档」:codex 报的
    // [:read-only, :workspace, :danger-full-access] 里,非破坏性的头一个是**只读**,
    // 于是「改文件前问我」会静默变成「根本不能改」。
    // 归类以 harness 自己声明的对应表为准 —— claude 的 `default` 是只读档,按名字猜必错。
    const modeMap = provider.capabilities.autoApprove.modes;
    // ⚠️ 归类之外还要过一道「这个 id 能不能代表这一档」:该家为这一档指名过代表就只认那个
    // id,没指名才许按名字猜着填。少了这道,claude 报的 `auto`(咕咕故意不映射、下拉也不摆)
    // 会被猜成 `edit` 且它排在表**第一个** ⇒ 用户选编辑、启动侧选中 auto;而收得太死又会
    // 挡掉 droid 那种只声明一档、其余留给启发式的家。判据见 canRepresentPermissionMode。
    // 表**完整**(modesExhaustive)时没声明的档 = 这家没有:表外的 id 一档都不代表,❌ 再按名字猜着填。
    // qwen 报的 `auto-edit` 按名字会被猜成编辑,可它对任意路径的写入都放行、比编辑松(#6221 实测);
    // 终端腿(registry 的 withDeclaredPermissionModes)和会话页下拉早就只认表里的档(#6953)。
    const exhaustive = provider.capabilities.autoApprove.modesExhaustive === true;
    const ladder = options.available
      .map((mode) => ({ id: mode.id, rung: classifyProviderPermissionMode(mode.id, modeMap) }))
      .filter((mode) => canRepresentPermissionMode(mode.id, mode.rung, modeMap, exhaustive));
    const exact = ladder.find((mode) => mode.rung === wanted);
    let targetId = exact?.id;
    if (!targetId) {
      // 「档位表里找不到完全访问」是 opencode 这类家的**预期**(它只报 build/plan) ——
      // 与上面 `!options` 同一条放行:该档已在 spawn 那刻由会话包兑现。判据同为
      // `bundleDeliversFullAccess`(经 resolveUnitDelivery 按腿解析),❌ 别在这里另写一份
      // 扁平读 —— 那会漏掉 per-surface 的家,也会与上面那道闸判得不一致。
      // ⚠️ 这一条必须排在降档之前:会话包已经兑现完全访问的家,再去 set 一个凑数的档
      // (opencode 的 build 是可写档、不是完全访问)就是把已经到手的那一档降掉。
      if (bundleDeliversFullAccess) return;
      // 档位对不上**不该毙掉会话**(owner 2026-09-05:「用户既然选择了以 bypass 运行,
      // 我们就不该说启动不起来」)。落到不超过用户所选、且离它最近的那一档 ——
      // 不变量与两个方向的代价见 resolvePermissionModeFallback 抬头。
      const fallback = resolvePermissionModeFallback(
        wanted,
        ladder.map((mode) => mode.id),
        modeMap
      );
      if (!fallback) {
        // 阶梯顶端:一档都挑不出来也照常开 —— 实际落在哪一档都不可能比完全访问更松。
        if (allowStartupDowngrade && isTopPermissionRung(wanted)) {
          this.deps.logger.warn('SessionManager: no representable mode, starting anyway', {
            sessionId: input.sessionId,
            providerId: input.providerId,
            wanted,
            available: options.available.map((mode) => mode.id),
          });
          return;
        }
        // 只剩比用户所选**更松**的档(例:只报 build 的家 + 用户选了规划)。
        // 这一格响亮失败 —— 往松的方向降是另一个方向的事故,不是降级是越权。
        throw new Error(
          `Provider '${input.providerId}' did not expose a permission mode matching '${wanted}'`
            + ` or anything more restrictive`
            + ` (available: ${options.available.map((mode) => mode.id).join(', ') || 'none'})`
        );
      }
      // 降档是产品事实,必须留痕:会话页的档位下拉显示的是实际生效那一档,日志给出为什么。
      if (!allowStartupDowngrade) {
        throw new Error(
          `Provider '${input.providerId}' did not expose permission mode '${wanted}' for live-safe startup`
        );
      }
      this.deps.logger.warn('SessionManager: configured permission mode unavailable, downgraded (startup-only)', {
        sessionId: input.sessionId,
        providerId: input.providerId,
        wanted,
        applied: fallback.mode,
        appliedModeId: fallback.modeId,
        available: options.available.map((mode) => mode.id),
      });
      targetId = fallback.modeId;
    }
    if (targetId === options.selected) return;
    const result = await record.cell.setMode(targetId, { startupOnly: true });
    if (!result.success) {
      // 切档失败之后会话到底停在哪一档,我们没有验证过 —— 拿 `options.selected` 当既成事实
      // 是假设不是读数。但阶梯顶端不需要这个读数:未知的那一档也不可能比完全访问更松,
      // 所以照常开;更严的档下这个未知就是越权风险,仍然响亮失败。
      if (!allowStartupDowngrade || !isTopPermissionRung(wanted)) {
        throw new Error(`Failed to apply configured permission mode '${targetId}'`, {
          cause: result.error,
        });
      }
      this.deps.logger.warn('SessionManager: failed to apply permission mode, starting anyway', {
        sessionId: input.sessionId,
        providerId: input.providerId,
        wanted,
        targetId,
        error: result.error,
      });
    }
  }

  /** Push new turns and in-place revisions to the single durable history writer. */
  private emitCommittedTurns(record: SessionRecord): void {
    record.cell.transcript.pushEvent({ kind: 'terminal_snapshots', terminals: this.getTerminals(record.input.sessionId) });
    const emit = this.deps.onTurnCommitted;
    if (!emit) return;
    // 运行时视图(侧边对话,由运行时分叉实现)不落盘。它的 `conversationId` 是个**视图 id**,
    // 库里根本没有这一行 —— 落盘会直接撞外键。而且它也不需要:上下文就开在主对话那条上,
    // 侧边这条本来就不展示更多历史。同一道闸在 `publishSummary` 里已有先例(运行时视图不进
    // 全局会话摘要),判据都是 `sourceConversationId`。
    if (record.input.sourceSessionId) return;
    const committed = record.cell.transcript.history;
    const emitted = record.emittedTurns;
    // reducer 不原地改数组:已提交列表没换 = 没有新轮、也没有哪一轮被改(流式期间绝大多数事件走这里)。
    if (committed === emitted) return;
    if (committed.length < emitted.length) {
      record.emittedTurns = committed;
      return;
    }
    const push = (source: 'live' | 'replay' | 'revision' | 'backfill', turn: TranscriptTurn): void => {
      emit({
        sessionId: record.input.sessionId,
        providerId: record.input.providerId,
        platformCredentials: Boolean(record.input.platformAccessSessionId),
        source,
        turn: structuredClone(turn),
      });
    };
    // 已推过的轮里,引用换了的就是被改过的那几轮。❌ 不只看最后一轮:后台命令的终态改的是
    // **起它的那一轮**,而那一轮之后往往已经又提交了别的轮(Monitor 每个事件各成一轮)——
    // 只看最后一轮,这次改动就只活在内存里,库里那张卡永远「在跑」(#6582)。
    // reducer 没改的轮原样返回同一个对象,所以这里只会推真正改过的那几轮。
    for (let index = 0; index < emitted.length; index += 1) {
      const turn = committed[index]!;
      if (turn === emitted[index]) continue;
      if (!record.liveTurnIds.has(turn.id)) {
        // 这一轮不是本条记录落的盘 ⇒ 库里哪一行是它无从确定;改错一行等于改写别的历史。
        this.deps.logger.error('SessionManager: revised a turn this session did not persist; stored history left unchanged', {
          sessionId: record.input.sessionId,
          turnId: turn.id,
        });
        continue;
      }
      // 最后一轮的改口(结局、迟到的尾巴)说的是现在;更早那一轮之后已经有别的轮了,它说的是过去 ——
      // 分开标,「登录已失效」这类读现状的消费方才不会被一张旧轮的补丁改回去。
      push(index === committed.length - 1 ? 'revision' : 'backfill', turn);
    }
    const source = record.replaying ? 'replay' : 'live';
    for (let index = emitted.length; index < committed.length; index += 1) {
      if (source === 'live') record.liveTurnIds.add(committed[index]!.id);
      push(source, committed[index]!);
    }
    record.emittedTurns = committed;
  }

  /**
   * 会话通知来了(流式的一块、一行工具输出、用量 / 命令这类附带的):按显示节拍发,每拍最多一次。前一拍里什么都没发生
   * (流刚开始、停顿过后)时这一个改动当场发,首字不等;流持续着,改动攒到拍尾合成一次发出 —— 发的是那一刻的整份状态
   * 对上一次的差,攒多少块都只是一次推送(远程看的人每一次就是一条广播)。一拍过完没有新改动,节拍停下。
   * 不在回合里(`activeTurn` 空了 = 回合刚结束)当场发:最后一段字 ❌ 等到下一拍。状态机的变化(待批、排队、开始 / 停下)
   * 与草稿本来就当场发,顺带把攒着的一起带走。
   */
  private publishOnTick(record: SessionRecord): void {
    if (!record.cell.transcript.activeTurn) return this.syncRecord(record);
    if (record.transcriptTick) {
      record.transcriptPending = true;
      return;
    }
    this.syncRecord(record);
    const tick = () => {
      record.transcriptTick = setTimeout(() => {
        record.transcriptTick = null;
        if (!record.transcriptPending) return;
        this.syncRecord(record);
        tick();
      }, TRANSCRIPT_TICK_MS);
    };
    tick();
  }

  private syncRecord(record: SessionRecord): void {
    record.transcriptPending = false;
    // 记录移除之后 cell 还会回调(被关掉的那一轮这时才落定)。会话已经不归这里管:再写就是给它凭空补回一条摘要,
    // 列表里多出一条「还活着」的会话,带着它最后那一轮的结局 —— 停掉的会话因此被读成 error。
    if (this.cells.get(record.input.sessionId) !== record) return;
    const state = record.cell.sessionState;
    const previousState = record.lastSynced.sessionState;
    if (!sameQueuedPrompts(previousState?.queuedPrompts, state.queuedPrompts)) {
      this.persistQueueSnapshot(record, state.queuedPrompts);
    }
    publishLiveModelState(record.live.states.state, state, record.lastSynced.sessionState);
    record.lastSynced.sessionState = state;

    const config = record.cell.config;
    publishLiveModelState(record.live.states.config, config, record.lastSynced.config);
    record.lastSynced.config = config;

    const usage = record.cell.usage;
    publishLiveModelState(record.live.states.usage, usage, record.lastSynced.usage);
    record.lastSynced.usage = usage;

    const plan = record.cell.transcript.plan ?? null;
    publishLiveModelState(record.live.states.plan, plan, record.lastSynced.plan);
    record.lastSynced.plan = plan;

    const agents = record.cell.transcript.agents;
    const agentSnapshot = [...agents];
    publishLiveModelState(record.live.states.agents, agentSnapshot, record.lastSynced.agents);
    record.lastSynced.agents = agentSnapshot;

    const activeTurn = record.cell.transcript.activeTurn;
    publishLiveModelState(record.live.states.activeTurn, activeTurn, record.lastSynced.activeTurn);
    record.lastSynced.activeTurn = activeTurn;

    const draft = record.cell.promptDraft;
    publishLiveModelState(record.live.states.draft, draft, record.lastSynced.draft);
    record.lastSynced.draft = draft;

    this.syncTerminals(record.input.sessionId);

    this.upsertSessionSummary(record.input, record.cell, state);
  }

  private upsertSessionSummary(
    input: AcpStartInput,
    cell: SessionCell | null,
    state: {
      lifecycle: SessionState['lifecycle'];
      isGenerating: boolean;
      backgroundAgentCount: number;
      backgroundCommandCount: number;
      pendingPermissions?: SessionState['pendingPermissions'];
      queuedPrompts?: SessionState['queuedPrompts'];
      pendingPermissionCount?: number;
      queuedPromptCount?: number;
      failure?: SessionFailure | null;
    }
  ): void {
    // Runtime-only views need a live cell but must not appear in the global conversation summary.
    if (input.sourceSessionId) return;
    const recent = this.recentActionsForSummary(input.sessionId, cell, state.lifecycle);
    const summary: SessionSummary = {
      sessionId: input.sessionId,
      projectId: input.projectId,
      providerId: input.providerId,
      lifecycle: state.lifecycle,
      isGenerating: state.isGenerating,
      lastStopReason: cell?.sessionState.lastStopReason ?? null,
      lastTurnOutcome: cell?.sessionState.lastTurnOutcome ?? 'none',
      pendingPermissionCount: state.pendingPermissionCount ?? state.pendingPermissions?.length ?? 0,
      // 起动 / 起不来的占位摘要没有 cell、也就没有任何待决请求(`pendingPermissionCount: 0`)。
      pendingPermissionWaits: pendingPermissionWaits(state.pendingPermissions ?? []),
      backgroundAgentCount: state.backgroundAgentCount,
      backgroundCommandCount: state.backgroundCommandCount,
      queuedPromptCount: state.queuedPromptCount ?? state.queuedPrompts?.length ?? 0,
      contextTokens: cell?.usage?.contextUsed ?? null,
      contextSize: cell?.usage?.contextSize ?? null,
      contextModelId: cell?.usageModelId ?? null,
      modelId: cell?.config.modelOptions?.selected ?? null,
      rateLimit: cell?.usage?.rateLimit ?? null,
      title: cell?.transcript.title ?? null,
      recentActions: recent.actions,
      lastActionAt: recent.lastActionAt,
      failure: cell?.sessionState.failure ?? state.failure ?? null,
      ...(cell ? { canLoadSession: cell.supportsLoadSession } : {}),
      startProgress: state.lifecycle === 'starting'
        ? this.startProgress.get(input.sessionId) ?? null
        : null,
      updatedAt: Date.now(),
    };
    this.sessionsList.states.list.produce((draft) => {
      draft[input.sessionId] = summary;
    });
  }

  private recentActionsForSummary(
    sessionId: string,
    cell: SessionCell | null,
    lifecycle: SessionState['lifecycle'],
  ): { actions: string[]; lastActionAt: number | null } {
    const state: RecentActionState = this.recentActions.get(sessionId) ?? {
      entries: [],
      seenToolIds: new Set<string>(),
      lastAtMs: null,
    };
    const now = Date.now();
    // Replay has no authentic event time; only live turns may feed this window.
    if (cell && lifecycle !== 'replaying') {
      const current = cell.transcript.activeTurn;
      const tools: Array<{ id: string; name: string }> = [];
      if (current) collectToolNodes(current.items, tools)
      for (const tool of tools) {
        if (state.seenToolIds.has(tool.id)) continue
        state.seenToolIds.add(tool.id);
        state.entries.push({ id: tool.id, name: tool.name, atMs: now });
        state.lastAtMs = now;
      }
    }
    state.entries = state.entries.filter((entry) => now - entry.atMs <= RECENT_ACTION_WINDOW_MS)
    if (state.seenToolIds.size > RECENT_ACTION_MAX_ENTRIES * 4) {
      state.seenToolIds = new Set(state.entries.map((entry) => entry.id))
    }
    if (state.entries.length > RECENT_ACTION_MAX_ENTRIES) {
      state.entries = state.entries.slice(-RECENT_ACTION_MAX_ENTRIES)
    }
    this.recentActions.set(sessionId, state)
    // Same contract as the session record's timeline (contract.ts `lastActionAt`): the newest known action, including
    // ones outside the window. Only `actions` is windowed; readers judge freshness against their own clock.
    return { actions: state.entries.map((entry) => entry.name), lastActionAt: state.lastAtMs };
  }

  private deleteSessionSummary(sessionId: string): void {
    this.recentActions.delete(sessionId)
    this.closedSessionHistories.delete(sessionId)
    this.sessionsList.states.list.produce((draft) => {
      delete draft[sessionId];
    });
  }

  /** `keepSummary`:摘要由调用方收口(启动失败走 `settleFailedStart`),这里不删。 */
  private removeRecord(
    sessionId: string,
    releaseConnection: boolean,
    notifyPlatformClosed = false,
    keepSummary = false,
  ): void {
    const record = this.cells.get(sessionId);
    if (!record) return;
    if (record.transcriptTick) clearTimeout(record.transcriptTick);
    record.cell.dispose();
    if (record.processKey) this.unregisterRoutes(record.processKey, sessionId);
    this.cells.delete(sessionId);
    this.terminals.disposeSession(sessionId);
    this.terminalLiveRegistry.disposeSession(sessionId);
    // #6497 dispose 之前把状态最后发一次 `closed`(与 getSessionState 对不存在的会话给的同一个形状):dispose 本身
    // 只让订阅方重取快照、拿到 NOT_FOUND,不带「停下来时是什么样」—— 停在回合中间时,界面上的 Working / 待批才落得下。
    publishLiveModelState(record.live.states.state, closedSessionState(), record.lastSynced.sessionState);
    record.live.dispose();
    if (!keepSummary) this.deleteSessionSummary(sessionId);
    if (releaseConnection && record.connectionLease) void record.connectionLease.release();
    // @@@4467 只报「这条会话真的结束了」,不替宿主判断它有没有签过平台令牌。
    //
    // 这里从前还要求 `record.input.platform` —— 那是**进程级凭据载荷**,只有 adapter-spawn 方言
    // (codex/opencode 那族)才会带。claude 的平台凭据走会话级 `_meta`,`input.platform` 恒 undefined,
    // 于是它的会话关闭时这条通知从不发出:宿主那份带令牌的 0600 文档留在盘上、结清永不发生
    // (#4467 真机实测:归档后文件仍在、`revoked_at`/`reconciled_at` 双 null)。
    //
    // 根因是**代理判据**:运行时拿「我收到了什么」去猜「宿主握着什么」。它猜不出来,也不该猜 ——
    // 令牌是宿主签的,只有宿主知道。宿主那边本来就按 conversationId 查自己的账本,查不到就是 no-op。
    // ⇒ 运行时只负责如实说「结束了」,要不要结清由宿主决定。
    if (notifyPlatformClosed) {
      this.deps.onPlatformSessionClosed?.(
        sessionId,
        record.input.platformAccessSessionId,
      );
    }
  }

  private resolveSessionForProviderSession(processKey: string, acpSessionId: string): string | null {
    const route = this.routes.get(processKey)?.get(acpSessionId);
    if (route) return route;
    const loading = this.loadingSessions.get(processKey);
    const pending = loading?.values().next().value;
    if (!pending) return null;
    this.registerRoute(processKey, acpSessionId, pending);
    return pending;
  }

  private registerRoute(processKey: string, acpSessionId: string, sessionId: string): void {
    let byProviderSession = this.routes.get(processKey);
    if (!byProviderSession) {
      byProviderSession = new Map();
      this.routes.set(processKey, byProviderSession);
    }
    byProviderSession.set(acpSessionId, sessionId);
  }

  private unregisterRoutes(processKey: string, sessionId: string): void {
    const bySession = this.routes.get(processKey);
    if (!bySession) return;
    for (const [providerSessionId, mappedSessionId] of bySession) {
      if (mappedSessionId === sessionId) bySession.delete(providerSessionId);
    }
    if (bySession.size === 0) this.routes.delete(processKey);
  }

  private addLoading(processKey: string, sessionId: string): void {
    let loading = this.loadingSessions.get(processKey);
    if (!loading) {
      loading = new Set();
      this.loadingSessions.set(processKey, loading);
    }
    loading.add(sessionId);
  }

  private removeLoading(processKey: string, sessionId: string): void {
    const loading = this.loadingSessions.get(processKey);
    if (!loading) return;
    loading.delete(sessionId);
    if (loading.size === 0) this.loadingSessions.delete(processKey);
  }

  private applyRawMeta(cell: SessionCell, update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case 'current_mode_update':
        cell.applySessionMeta({
          modes: {
            currentModeId: update.currentModeId,
            availableModes: cell.config.modeOptions?.available ?? [],
          },
        });
        break;
      case 'config_option_update':
        cell.applySessionMeta({ configOptions: update.configOptions });
        break;
      default:
        break;
    }
  }

  // @@@sessionpage TASKPAGE-FUSION — honor host-injected session MCP servers (previously hardcoded []).
  // The gugu host sets input.mcpServers at the main-process ACP interceptor so a session-page session gets
  // its loopback HTTP Gugu tool surfaces through session/new without exposing the owner credential.
  // @@@2503 平台额度注入信封,与上面的 mcpServers 同源:宿主在主进程 ACP start 拦截处按会话签发,
  // 我们原样挂到 `_meta` 上。没有它(BYOK/默认会话)就一个字段都不加,请求与从前逐字节相同。
  private buildNewSessionRequest(input: AcpStartInput): NewSessionRequest {
    return {
      cwd: input.cwd,
      mcpServers: (input.mcpServers ?? []) as NewSessionRequest['mcpServers'],
      ...sessionOpenMeta(input),
    };
  }

  /**
   * @param ephemeral 运行时分叉(侧边聊天)= `true`,产物不许在用户的 harness 里留痕;
   *                  持久分叉(spec session-fork-share 的 fork)= `false`,产物**就是要**
   *                  落库、要能重开 —— 给它扣上不落库的开关等于造一条重开即消失的会话。
   */
  private buildForkSessionRequest(
    input: AcpStartInput,
    sourceProviderSessionId: string,
    ephemeral: boolean
  ): ForkSessionRequest {
    // ❌ 不用 `...sessionOpenMeta(input)`:没有平台信封时它返回 `{}`,`_meta` 会整个缺席,
    // 不落历史这件事就只在「恰好走了平台额度」的会话上成立。分叉一律带信封。
    const envelope = sessionOpenMeta(input)._meta;
    return {
      cwd: input.cwd,
      sessionId: sourceProviderSessionId,
      mcpServers: (input.mcpServers ?? []) as ForkSessionRequest['mcpServers'],
      // `gugu.ephemeralFork` 是给**咕咕自己的桥**看的(codex 的 `thread/fork` 有 `ephemeral`
      // 这一等开关);claude 那边由 `ephemeralForkMeta` 的 `persistSession` 承载。
      // 两家各有各的名字,所以两个都写 —— ❌ 不许只写一个然后假设对面认得。
      _meta: {
        ...(ephemeral ? ephemeralForkMeta(envelope) : (envelope ?? {})),
        gugu: { ephemeralFork: ephemeral },
      },
    };
  }

  /**
   * 重开一条会话走的是这一条,它**必须同样带上 `_meta`**。
   *
   * 适配器的 loadSession 把 `params._meta` 原样转给它内部的 createSession —— 也就是说重开时那个新起的
   * claude 进程,拿到的中转地址与令牌完全来自这一份信封。漏掉它,重开后的会话就退回用户自己的
   * `~/.claude/settings.json`:界面上这条会话还写着咕咕的模型,请求却打到用户自己的网关,而积分那边
   * 早已按平台会话预留 —— 正是 spec 禁止的「界面写 A、实际跑 B」,且只在**重开**这一步发作,
   * 首轮一切正常,最难被发现。(矩阵 L3-CUI 格真机复验这一条。)
   */
  private buildLoadSessionRequest(input: AcpStartInput, providerSessionId: string): LoadSessionRequest {
    return {
      cwd: input.cwd,
      sessionId: providerSessionId,
      mcpServers: (input.mcpServers ?? []) as LoadSessionRequest['mcpServers'],
      ...sessionOpenMeta(input),
    };
  }

  private persistQueueSnapshot(record: SessionRecord, queuedPrompts: readonly QueuedPrompt[]): void {
    const store = this.deps.promptQueueStore;
    if (!store) return;
    try {
      if (queuedPrompts.length > 0) store.save(record.input.sessionId, queuedPrompts);
      else store.clear(record.input.sessionId);
      record.queuePersistenceError = null;
    } catch (error) {
      record.queuePersistenceError = error;
      this.deps.logger.error('SessionManager: failed to persist prompt queue snapshot', {
        sessionId: record.input.sessionId,
        queuedPromptCount: queuedPrompts.length,
        error,
      });
    }
  }
}

/** 这条会话在运行时里不存在(从没起过,或已被停掉 / 关掉)时的状态。 */
function closedSessionState(): SessionState {
  return {
    lifecycle: 'closed',
    activeTurnId: null,
    pendingPermissions: [],
    lastStopReason: null,
    lastTurnOutcome: 'none',
    queuedPrompts: [],
    backgroundAgentCount: 0,
    backgroundCommandCount: 0,
    backgroundCommandTaskIds: [],
    isGenerating: false,
    canSubmit: false,
    canCancel: false,
    failure: null,
  };
}

function sameQueuedPrompts(
  previous: readonly QueuedPrompt[] | undefined,
  next: readonly QueuedPrompt[],
): boolean {
  if (!previous || previous.length !== next.length) return false;
  return previous.every((prompt, index) => {
    const current = next[index];
    return current
      && prompt.id === current.id
      && prompt.updatedAt === current.updatedAt
      && prompt.text === current.text
      && prompt.origin === current.origin
      && prompt.queueEdit?.draftText === current.queueEdit?.draftText
      && prompt.queueEdit?.originalDraftText === current.queueEdit?.originalDraftText;
  });
}

function isAuthRequiredError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const value = error as { code?: unknown; cause?: unknown };
  if (value.code === -32000) return true;
  return isAuthRequiredError(value.cause);
}

function toProviderSerializedError(error: unknown) {
  if (typeof error === 'object' && error !== null) {
    const value = error as { code?: unknown; name?: unknown; message?: unknown; stack?: unknown };
    if (typeof value.message === 'string') {
      const message =
        typeof value.code === 'number' ? `${value.code}: ${value.message}` : value.message;
      return {
        name: typeof value.name === 'string' ? value.name : 'ProviderError',
        message,
        ...(typeof value.stack === 'string' ? { stack: value.stack } : {}),
      };
    }
  }
  return toSerializedError(error);
}

type IAcpBehaviorDiscover = NonNullable<
  import('@gugu/session-core/agents/plugins').IAcpBehavior['discoverCommands']
>;

/** 合并两张命令表:这一家自己报的排前、同名以它为准;补出来的只补它没有的名字。 */
export function mergeCommands(
  provider: readonly AvailableCommand[],
  supplemental: readonly AvailableCommand[] | undefined
): AvailableCommand[] {
  if (!supplemental?.length) return [...provider];
  const taken = new Set(provider.map((command) => command.name));
  return [...provider, ...supplemental.filter((command) => !taken.has(command.name))];
}

/** `discoverCommands` 的只读文件口:缺席即空,❌ 不抛(少几条命令不该挡会话)。 */
const discoveryFs = {
  async listDirs(dir: string): Promise<string[]> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => entry.name);
    } catch {
      return [];
    }
  },
  async listFiles(dir: string): Promise<string[]> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries.filter((entry) => entry.isFile() || entry.isSymbolicLink()).map((entry) => entry.name);
    } catch {
      return [];
    }
  },
  async readText(file: string): Promise<string | null> {
    try {
      return await readFile(file, 'utf8');
    } catch {
      return null;
    }
  },
};

type IAcpBehaviorReadRules = NonNullable<
  import('@gugu/session-core/agents/plugins').IAcpBehavior['readRules']
>;
const START_STAGE_PHRASE: Record<AcpStartStage, string> = {
  'preparing-adapter': 'preparing the ACP adapter',
  'checking-executable': 'checking the engine executable',
  'starting-engine': 'waiting for the engine to initialize',
  'opening-session': 'opening the engine session',
};

/**
 * 启动失败那一句人话:**卡在哪一步、等了多久**,然后是底层原因
 * (cause 能说的全部 > 错误自己的 message > 错误类型)。取消也是这一句,只是动词换成「取消」。
 */
function startFailureMessage(
  error: AcpStartSessionError,
  progress: AcpStartProgress | null,
  abandoned: boolean,
  now: number,
): string {
  const cause = 'cause' in error ? error.cause : undefined;
  const reason = (cause ? errorDetail(cause) : undefined) ?? error.message ?? error.type;
  if (!progress) return reason;
  const where = START_STAGE_PHRASE[progress.stage]
    + (progress.executable ? ` (${progress.executable})` : '');
  const waited = `${((now - progress.since) / 1000).toFixed(1)}s in this step, `
    + `${((now - progress.startedAt) / 1000).toFixed(1)}s since the start began`;
  return abandoned
    ? `Start cancelled while ${where}, after ${waited}.`
    : `Start failed while ${where}, after ${waited}: ${reason}`;
}
