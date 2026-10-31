import type { AcpPermissionParams } from '@gugu/session-core/agents/plugins';
import type {
  RequestPermissionResponse,
  SessionConfigOption,
  SessionModeState,
  SetSessionConfigOptionRequest,
  SetSessionModeRequest,
} from '@agentclientprotocol/sdk';
import type {
  LiveSettingCapability,
  LiveSettingDimension,
  LiveSettingsCapability,
} from '@gugu/session-core/agents/plugins';
import type {
  AcpCancelTurnError,
  AcpPermissionRequest,
  AdapterExit,
  AcpRuntimeError,
  AcpSendPromptError,
  AcpSetModeOptionError,
  AcpSetModelOptionError,
  AcpStopBackgroundTaskError,
  InvalidStateError,
  NormalizedEvent,
  PromptDraft,
  PromptDraftUpdate,
  PromptInput,
  QueuedPrompt,
  QueuedPromptEdit,
  SessionConfigState,
  SessionState,
  SessionUsage,
  SessionPromptReceipt,
  StopReason,
  ToolCallItem,
  ToolNode,
  TranscriptTurn,
  TranscriptTurnOutcome,
  TranscriptTurnTrigger,
} from '@gugu/session-core/acp';
import {
  providerRejectedMissingSession,
  AcpTranscriptParser,
  acpErr,
  classifyProviderPermissionMode,
  createToolCallItem,
  makeToolId,
  permissionWaitKind,
  runningBackgroundCommands,
  SESSION_PLAN_ID,
} from '@gugu/session-core/acp';
import type { Result } from '@gugu/session-shared';
import { ok, toSerializedError } from '@gugu/session-shared';
import { invokesCommand } from '@gugu/session-core/acp/commands';
import { classifyTurnFailure, refusedTurnOutcome } from './turn-failure';
import {
  type Command,
  type DomainEvent,
  type Effect,
  mergeTypedPrompts,
  queuedPromptMergeKind,
  SessionMachine,
  type SessionMachineContext,
} from '../machine/machine';
import type {
  DetachedPromptResult,
  LiveSettingApplyResult,
  SessionCellDeps,
  SessionPromptResult,
  TurnEnvelope,
} from './cell-deps';
import { PermissionBroker, selectAutoApproveOption } from './permission-broker';
import { RawAcpLog, type RawAcpEvent } from './raw-log';
import { acceptPromptMessage, settleAcceptedRequests, type PromptRequest, type PromptResult } from './prompt-request';
import { prepareNativePrompt, type NativePromptPreparation } from './prompt-preparation';
import { canYieldRepliedAssistant, replyItems } from '@gugu/session-core/session-record/reply-process';

export interface AcpChatHistory {
  committed: TranscriptTurn[];
  active: TranscriptTurn | null;
}

type ConfigDimension = 'model' | 'effort';

export class SessionCell {
  readonly machine: SessionMachine;
  readonly transcript: AcpTranscriptParser;
  readonly rawLog: RawAcpLog;
  private readonly permissions = new PermissionBroker();
  /**
   * 这条会话此刻是不是完全访问档 —— `session/request_permission` 该不该由咕咕当场作答的**唯一**判据。
   *
   * 出生值是用户开会话时选的档;用户在会话里改档、且 provider 接下了,就换成新档。
   * ⚠️ 启动期的降档(`applyConfiguredPermissionMode` 落到 provider 能表达的最近一档)**不改它**:
   * 那只说明这家的原生档位表里没有「完全访问」,用户选的仍是完全访问,
   * 这时作答这一步正是咕咕替它兑现这一档的地方。
   */
  private autoApprovePermissions: boolean;
  private _acpSessionId: string;
  private _agent: SessionCellDeps['agent'];
  private acceptsImagePrompts: boolean;
  private supportsSteering: boolean;
  private _supportsLoadSession = false;
  private lastRunningAgentCount = 0;
  /** #7342 最后一次上下文读数到达那一刻会话自报的模型 —— 读数归它,换了模型就不归了(上限随模型变)。 */
  private usageModelIdAtReport: string | null = null;
  /** harness 报的这条会话记录的路径(`transcript_path` 事件);还没报 = null。 */
  private reportedTranscriptPath: string | null = null;
  private lastRunningCommandTaskIds: readonly string[] = [];
  /**
   * 还活着的子智能体会话:**界面可能拿来指认它的每一个 id** → 要投递取消的那个会话号(#5117)。
   *
   * 为什么要这张表:取消一个子智能体走的是规范的 `session/cancel`,收件人是**子会话**;
   * 而停一条后台命令走的是扩展方法 `_session/async_task/stop`。两条路不通用(见
   * `cancelSubagent` 上那段),所以停之前必须先认出「这个 id 是哪一种」。
   *
   * ⚠️ 同一个子智能体在界面上可能被两种 id 指认 —— 派它出去的那次调用(`toolCallId`)与
   * 它自己的会话号 —— 两个都登记,❌ 别只记一个:记漏哪一个,那条路径就会掉进后台命令那支,
   * 拿到 `{stopped:false}`,用户看到的是「按了没反应」。
   */
  private readonly liveSubagentSessions = new Map<string, string>();
  private readonly cancellableSubagents = new Set<string>();
  private effectQueue: Effect[] = [];
  private interpretingEffects = false;
  private draft: PromptDraft | null = null;
  private draftRev = 0;
  /**
   * ③ 的待发状态 —— 发出去一次就清空。见 `SessionCellDeps.sessionContext`。
   *
   * ⚠️ 挂在**第一次真正发出去的那一轮**上,而不是「initialQueue 的第 0 条」:
   *    队列可能为空(导入/续跑),那时它该跟着用户真正打出的第一句话走。
   */
  private pendingSessionContext: string | null = null;
  /**
   * #6387 扩展送来的「附带」—— 不叫醒 agent,随**下一轮真正发出去的那一句**一起进去,发完即清。
   * 按键存:同键新的替换旧的(Map 先删再设,顺序也跟着变新)。与上面那格不同,它**进转录**:
   * 用户要看得见 agent 收到了什么(behavior tab-extensions「来自「扩展名」」)。
   */
  private pendingTurnContext = new Map<string, string>();
  private replayingHistory = false;
  private lastReplayedSessionContext: string | null = null;
  private replayHistoryUnknown = false;
  /** #980 见 `useRecordedDeliveries`。`undefined` = 这次以重放为准。 */
  private recordedDeliveryIds: ReadonlySet<string> | null | undefined = undefined;
  /** 这一轮的 cancel 是我们为插话发的 ⇒ 结算成 `interrupted_for_message`,而不是「你停止了这一轮」。 */
  private interruptedForMessage = false;
  /** A replied assistant turn yields at its next tool boundary to this queued input (#566). */
  private yieldingRepliedAssistant: string | null = null;
  /** Native steering acknowledges admission, not consumption. Keep uncertain inputs until a
   * subsequent tool call or a completed turn proves the provider moved past their admission. */
  private pendingNativeSteers: Array<{ prompt: QueuedPrompt; toolsAtAdmission: ReadonlySet<string> }> = [];
  private returnedNativeSteerIds: string[] = [];
  private queuedSteeringScheduled = false;
  private queuedSteeringInFlight = false;
  private blockedQueuedSteer: QueuedPrompt | null = null;
  private interruptedQueuedHead: string | null = null;
  private queuedTurnFence = false;
  /** Cancellation/teardown retires native admissions started before that boundary, even after ready/resume. */
  private nativeAdmissionGeneration = 0;
  /** Cancellation would also withdraw inputs already admitted by the native adapter. */
  private nativeInputAfterStart = false;
  /** 这一轮被这一家以「正常结束」掩盖的失败(见 `acp.turnFailure`)。 */
  private providerTurnFailure: string | null = null;
  /**
   * stderr 那一行认出的失败(`acp.turnFailure.fromStderrLine`)。两家的 stderr 失败说的都是「什么都没说就结束」
   * 那一种(Antigravity 执行器开头就挂、MiMo 的错误被 ACP 腿吞掉),所以只在这一轮一个字都没出时才算(复核 93)。
   */
  private providerStderrFailure: string | null = null;
  /** 那一家自己的报错说明是凭据不能用(见 `acp.turnFailure.fromStderrLine`)。 */
  private providerTurnSignIn = false;
  /** 这一轮来要票、咕咕没签出来的原因码(见 `noteCredentialRefusal`)。 */
  private credentialRefusal: string | null = null;
  private turnHadAgentOutput = false;
  /** Live settings and prompt admission share this barrier. */
  private readonly liveSettings: LiveSettingsCapability | undefined;
  private settingsTail: Promise<void> = Promise.resolve();
  private settingsInFlight = 0;
  private settingsBlockedReason: string | null = null;
  /**
   * 刚落定的那一轮**还能不能被改口** —— 只由 `classifyTurnFailure` 在 prompt 边界上打开,
   * 任何一次新的落定都把它收回(见 `settleTurn`)。理由与守卫写在 `turn-failure.ts` 上:
   * provider 真说过话的那一条是 final,❌ 不许被「进程没了」抹掉。
   */
  private lastFailureProvisional = false;
  /** 宿主要求关掉这条会话(stop / 删除 / 换运行时)。之后线断了是我们断的,在飞的那一轮是被停下,不是失败。 */
  private closeRequested = false;
  private preparationRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private preparationRetryDelay = 1500;
  private reverting = false;
  private compacting = false;
  /**
   * 这一轮是不是人亲手发起的(origin manual 的那一句开的工)。投递开的、agent 自己开的(后台跑完的通知等)都不是。
   * 人在**别人开的**一轮里打字 ⇒ 在下一个工具边界插进去,不排到这一轮讲完(见 queueBehindTurn)。
   */
  private workStartedByOwner = false;
  private activeTurnCompletion: Promise<Result<SessionPromptResult, AcpSendPromptError>> | null = null;
  private readonly requests = new Map<string, PromptRequest>();
  /** 发出去的句数(含回放):转录行 id 与回合信封的序号用它,❌ 不是状态。 */
  private promptSequence = 0;
  private dequeueAfterFailure = true;
  private requeuedAfterTokenBoundary = false;
  private resolveActiveTurnCompletion: ((result: Result<SessionPromptResult, AcpSendPromptError>) => void) | null = null;
  private latestTurnEnvelope: TurnEnvelope | null = null;

  constructor(private readonly deps: SessionCellDeps) {
    this._acpSessionId = deps.acpSessionId;
    this.autoApprovePermissions = deps.autoApprovePermissions === true;
    this._agent = deps.agent;
    this.acceptsImagePrompts = deps.acceptsImagePrompts === true;
    this.supportsSteering = deps.supportsSteering === true;
    this.liveSettings = deps.liveSettings;
    this.pendingSessionContext = deps.sessionContext?.trim() || null;
    this.machine = new SessionMachine(deps.sessionId);
    this.transcript = new AcpTranscriptParser({ sessionId: deps.sessionId, newTurnReference: () => `source:${crypto.randomUUID()}` });
    this.rawLog = new RawAcpLog({
      sessionId: deps.sessionId,
      providerId: deps.providerId,
      acpSessionId: deps.acpSessionId,
      createdAt: new Date().toISOString(),
    });
  }

  get sessionId(): string {
    return this.deps.sessionId;
  }

  get acpSessionId(): string {
    return this._acpSessionId;
  }

  /** The last immutable envelope admitted to a provider turn. */
  get turnEnvelope(): TurnEnvelope | null {
    return this.latestTurnEnvelope ? structuredClone(this.latestTurnEnvelope) : null;
  }

  /** A failed/unconfirmed setting blocks the next prompt until it is explicitly resolved. */
  get liveSettingBlock(): string | null {
    return this.settingsBlockedReason;
  }

  setAcpSessionId(providerSessionId: string): void {
    this._acpSessionId = providerSessionId;
    this.rawLog.setAcpSessionId(providerSessionId);
  }

  setAgent(agent: NonNullable<SessionCellDeps['agent']>): void {
    this._agent = agent;
  }

  setAcceptsImagePrompts(acceptsImagePrompts: boolean): void {
    if (this.acceptsImagePrompts === acceptsImagePrompts) return;
    this.acceptsImagePrompts = acceptsImagePrompts;
    this.deps.callbacks?.onSessionStateChanged?.();
  }

  setSupportsSteering(supportsSteering: boolean): void {
    this.supportsSteering = supportsSteering;
  }

  /** 适配器 initialize 时声明的 `loadSession`:停掉之后能不能按原 provider session 接回来(闲置回收只回收能接回来的)。 */
  setSupportsLoadSession(supportsLoadSession: boolean): void {
    this._supportsLoadSession = supportsLoadSession;
  }

  get supportsLoadSession(): boolean {
    return this._supportsLoadSession;
  }

  /** A dispatched prompt is owned before a state-reporting provider says running. */
  get hasInFlightPrompt(): boolean {
    return this.activeTurnCompletion !== null;
  }

  private get agent(): NonNullable<SessionCellDeps['agent']> {
    if (!this._agent) {
      throw new Error(`SessionCell ${this.sessionId} has no ACP agent while starting`);
    }
    return this._agent;
  }

  get sessionState(): SessionState {
    const state = this.machine.sessionState(this.transcript.activeTurn?.id ?? null);
    return this.reverting ? { ...state, canSubmit: false } : state;
  }

  get promptDraft(): PromptDraft | null {
    return this.draft ? structuredClone(this.draft) : null;
  }

  get config(): SessionConfigState {
    // 转录里推不出「这家收不收图」——那是连接期 initialize 报的,所以在这里合进去。
    return { ...this.transcript.config, acceptsImagePrompts: this.acceptsImagePrompts };
  }

  get usage(): SessionUsage | null {
    return this.transcript.usage;
  }

  get isCompacting(): boolean { return this.compacting; }

  get idleCompactionState(): { idle: boolean; contextTokens: number | null; revision: number } {
    return {
      idle: !this.compacting && !this.reverting && !this.closeRequested
        && this.machine.phase.kind === 'ready' && !this.activeTurnCompletion
        && !this.machine.queuedPrompts.length && !this.machine.pendingPermissions.length
        && !this.settingsInFlight && !this.settingsBlockedReason
        && !this.machine.backgroundAgentCount && !this.lastRunningCommandTaskIds.length
        && this.config.availableCommands.some(command => command.name.replace(/^\//, '') === 'compact'),
      contextTokens: this.usage?.contextUsed ?? null,
      revision: this.promptSequence,
    };
  }

  /** Reserve the normal machine lane atomically, but do not manufacture a user message. */
  async compactIfIdle(): Promise<Result<{ compacted: boolean }, AcpSendPromptError>> {
    if (!this.idleCompactionState.idle) return ok({ compacted: false });
    this.compacting = true;
    this.openTurnCompletion();
    const cycle = this.activeTurnCompletion!;
    this.applyEvent({ type: 'WorkStarted' });
    const request = { sessionId: this.acpSessionId, prompt: [{ type: 'text' as const, text: '/compact' }] };
    try {
      if (this.closeRequested || this.machine.queuedPrompts.length) {
        this.endWork({ kind: 'done', reason: 'end_turn' }, { dequeueQueuedPrompt: false });
        return ok({ compacted: false });
      }
      this.rawLog.record({ kind: 'prompt', sessionId: this.acpSessionId, content: request.prompt });
      // The receipt is admission only; the command's foreground cycle is its boundary.
      await this.agent.prompt(request);
      const settled = await cycle;
      return settled.success ? ok({ compacted: true }) : settled;
    } catch (error) {
      const cause = toSerializedError(error);
      this.rawLog.record({ kind: 'prompt_result', sessionId: this.acpSessionId, stopReason: null, error: cause });
      this.endWork({ kind: 'error', reason: 'prompt_failed', detail: cause.message }, { dequeueQueuedPrompt: false });
      return acpErr.promptFailed(cause);
    } finally {
      this.compacting = false;
      this.releaseQueueAfterEdit();
      this.deps.callbacks?.onSessionStateChanged?.();
    }
  }

  /** `usage` 那份读数是在哪个模型下报的(见 `usageModelIdAtReport`);还没有读数时是 null。 */
  get usageModelId(): string | null {
    return this.transcript.usage ? this.usageModelIdAtReport : null;
  }

  get transcriptPath(): string | null {
    return this.reportedTranscriptPath;
  }

  history(): AcpChatHistory {
    return {
      committed: structuredClone([...this.transcript.history]),
      active: this.transcript.activeTurn ? structuredClone(this.transcript.activeTurn) : null,
    };
  }

  exportParsedTranscript(): string {
    const history = this.history();
    return JSON.stringify(
      {
        meta: {
          sessionId: this.sessionId,
          providerId: this.deps.providerId,
          acpSessionId: this.acpSessionId,
          exportedAt: new Date().toISOString(),
        },
        committed: history.committed,
        active: history.active,
      },
      null,
      2
    );
  }

  recordRaw(event: RawAcpEvent): void {
    this.rawLog.record(event);
  }

  exportRawLog(): string {
    return this.rawLog.exportJson();
  }

  beginReplay(at = Date.now()): void {
    this.replayHistoryUnknown = false;
    this.recordedDeliveryIds = undefined;
    this.transcript.setTurnIndexBase(0);
    this.replayingHistory = true;
    this.promptSequence += 1;
    this.applyEvent({ type: 'ReplayStarted' });
    this.transcript.beginReplay(at);
    this.lastRunningAgentCount = 0;
    this.lastRunningCommandTaskIds = [];
  }

  endReplay(at = Date.now(), outcome?: TranscriptTurnOutcome): void {
    this.replayingHistory = false;
    // 历史里最近一次送过的会话级背景与这次要送的一字不差 ⇒ agent 手上已经有了,❌ 不再追加一份
    // (每次重开都追加会让同一段 ~20KB 在历史里越堆越多)。内容变了(规则改过、平台块升级)才送新的。
    if (
      this.pendingSessionContext
      && this.lastReplayedSessionContext?.trim() === this.pendingSessionContext.trim()
    ) {
      this.pendingSessionContext = null;
    }
    this.lastReplayedSessionContext = null;
    const previousRunningAgentCount = this.lastRunningAgentCount;
    this.transcript.endReplay(at, outcome);
    this.reconcileReplayedQueue();
    this.dispatchAgentsChangedIfNeeded(previousRunningAgentCount);
    this.applyEvent({ type: 'ReplayEnded', status: outcome?.kind === 'error' ? 'error' : 'complete' });
    this.emitTranscriptChanged();
  }

  markReplayHistoryUnknown(): void {
    this.replayHistoryUnknown = true;
  }

  /**
   * #980 这次接回没让 agent 重放:agent 收到过哪些投递,改由宿主从 agent 自己的记录里读出来交到这里
   * (补投去重从前靠重放)。`null` = 宿主读不出来 —— 与重放失败同一个处理:补投照旧,标「可能已收到」。
   */
  useRecordedDeliveries(ids: readonly string[] | null): void {
    this.recordedDeliveryIds = ids ? new Set(ids) : null;
  }

  /** #980 没有重放把回合序号顶上去:从宿主给的序号接着数,❌ 与库里上一次运行的同名回合撞号。 */
  continueTurnIndexAt(base: number): void {
    this.transcript.setTurnIndexBase(base);
  }

  private reconcileReplayedQueue(): void {
    const queued = this.machine.queuedPrompts.filter((prompt) => prompt.origin === 'communication');
    const hasCanonicalReplay = this.deps.providerId === 'claude'
      || this.deps.providerId === 'codex' || this.deps.historyRecovery?.canonicalReplay === true;
    const recorded = this.recordedDeliveryIds;
    const historyUnknown = this.replayHistoryUnknown || recorded === null;
    if (!queued.length || (!hasCanonicalReplay && !historyUnknown)) return;
    const recover = this.deps.recoverDelivery;
    if (!recover) throw new Error('SessionCell: delivery recovery requires the core envelope owner');
    const inputs = [...this.transcript.history, ...(this.transcript.activeTurn ? [this.transcript.activeTurn] : [])]
      .flatMap((turn) => turn.items.flatMap((item) => item.kind === 'message' && item.role === 'user' ? [item.text] : []));
    for (const prompt of queued) {
      const text = recover(prompt.text, inputs, historyUnknown, recorded ?? undefined);
      if (text === prompt.text) continue;
      const result = text === null ? this.removeQueuedPrompt(prompt.id) : this.editQueuedPrompt(prompt.id, {
        text, origin: prompt.origin, hiddenContext: prompt.hiddenContext,
        attachments: prompt.attachments, coalesceKey: prompt.coalesceKey,
      });
      if (!result.success) throw new Error(`Cannot reconcile recovered delivery: ${result.error.type}`);
    }
  }

  /**
   * #7223 重放没发生(load 失败、这一次改走 `session/new`):关上重放窗口,但会话**还在起**。
   * ❌ 走 endReplay:那会把机器推进 ready 并当场抽干队列,启动途中排进来的话就发往那个不存在的旧会话,
   * 之后新会话的 SessionReady 又被当成「不在 starting」丢掉。会话级背景也没送出去过,留着随首轮走。
   */
  abandonReplay(at = Date.now()): void {
    this.replayingHistory = false;
    this.lastReplayedSessionContext = null;
    const previousRunningAgentCount = this.lastRunningAgentCount;
    this.transcript.endReplay(at);
    this.dispatchAgentsChangedIfNeeded(previousRunningAgentCount);
    this.applyEvent({ type: 'ReplayAbandoned' });
    this.emitTranscriptChanged();
  }

  applySessionReady(meta?: {
    modes?: SessionModeState | null;
    configOptions?: readonly SessionConfigOption[] | null;
    availableCommands?: Extract<NormalizedEvent, { kind: 'commands' }>['commands'];
  }): void {
    this.applyEvent({ type: 'SessionReady' });
    this.seedTranscriptMeta(meta);
  }

  applySessionLoaded(meta?: {
    modes?: SessionModeState | null;
    configOptions?: readonly SessionConfigOption[] | null;
    availableCommands?: Extract<NormalizedEvent, { kind: 'commands' }>['commands'];
  }): void {
    this.applyEvent({ type: 'SessionLoaded' });
    this.seedTranscriptMeta(meta);
  }

  applySessionMeta(meta: {
    modes?: SessionModeState | null;
    configOptions?: readonly SessionConfigOption[] | null;
    availableCommands?: Extract<NormalizedEvent, { kind: 'commands' }>['commands'];
  }): void {
    this.seedTranscriptMeta(meta);
  }

  /**
   * 追加一段会话级背景(例如 provider 自己的规则文件)。挂到**下一轮真正发出去的那一句**前面,
   * 与 ③ 的会话级背景走同一个槽、同一个消费点 —— ❌ 不单独起一轮,❌ 不进转录。会话起来之前挂上的,
   * 与 ③ 一起随首轮进去。
   * ⚠️ 只放会话期内不变的背景。会变的事实(例如 agent 的名字,#6490)❌ 走这里一次性推:推完就再不纠正,
   * 推不到终端会话 —— 那种事实不进上下文,agent 要用时自己用工具现查。
   */
  appendSessionContext(text: string): void {
    const next = text.trim();
    if (!next) return;
    this.pendingSessionContext = this.pendingSessionContext ? `${this.pendingSessionContext}\n\n${next}` : next;
  }

  /** #6387 挂一段「附带」到下一轮;同键替换。见 `pendingTurnContext`。 */
  setTurnContext(key: string, text: string): void {
    this.pendingTurnContext.delete(key);
    this.pendingTurnContext.set(key, text);
  }

  /** 取走全部「附带」合成一段(多段走宿主注入的信封合并属主,与排队批同一个)。 */
  private takeTurnContext(): string | null {
    const texts = [...this.pendingTurnContext.values()];
    this.pendingTurnContext.clear();
    if (texts.length === 0) return null;
    if (texts.length === 1) return texts[0];
    const merge = this.deps.mergeEnvelopes;
    if (!merge) {
      throw new Error(
        'SessionCell: cannot merge turn context envelopes without the host-injected '
        + 'mergeEnvelopes owner (core mergeDeliveryEnvelopes)',
      );
    }
    return merge(texts);
  }

  push(event: NormalizedEvent): void {
    if (event.kind === 'ignored') return;
    if (event.kind === 'terminal_snapshots') {
      this.transcript.pushEvent(event);
      return; // Materialization consumes a snapshot; it cannot notify its own producer.
    }
    if (event.kind === 'agent_state') {
      this.onAgentState(event);
      this.scheduleQueuedSteering();
      return;
    }
    if (event.kind === 'transcript_path') {
      if (event.path === this.reportedTranscriptPath) return;
      this.reportedTranscriptPath = event.path;
      this.deps.callbacks?.onSessionStateChanged?.();
      return;
    }
    if (event.kind === 'interrupted_for_message') {
      if (this.machine.phase.kind === 'working') {
        this.nativeAdmissionGeneration += 1;
        this.interruptedForMessage = true;
        this.applyEvent({ type: 'CancellationRequested' });
      }
      return;
    }
    if (event.kind === 'prompt_result') {
      this.applyReceiptMetadata(event.requestId, event._meta);
      const request = this.requests.get(event.requestId);
      const dequeueAfterFailure = this.dequeueAfterFailure;
      if (event.error) this.deps.logger.error('SessionCell: prompt failed', { sessionId: this.sessionId, requestId: event.requestId, cause: event.error });
      if (request?.prompt.origin === 'communication' && event.error && isInvalidToken(event.error)) {
        // A refused token needs the next foreground/token boundary, not another immediate steer.
        const { queueTiming: _timing, ...retry } = request.prompt;
        const queued = this.dispatch({ type: 'QueuePrompt', prompt: retry });
        if (queued.success && !request.steered) this.requeuedAfterTokenBoundary = true;
      }
      if (event.error && request && !request.steered && request.cycle === this.activeTurnCompletion
        && this.machine.phase.kind === 'ready') {
        const classified = classifyTurnFailure({ at: 'prompt', cause: event.error,
          platformCredentials: this.deps.platformCredentials, closeRequested: this.closeRequested,
          credentialRefusal: this.credentialRefusal });
        this.rawLog.record({ kind: 'prompt_result', sessionId: this.acpSessionId, stopReason: null, error: event.error });
        this.endWork(classified.outcome, { dequeueQueuedPrompt: this.dequeueAfterFailure });
      }
      if (event.error && request && !request.dispatched) {
        request.completion.resolve(acpErr.promptFailed(event.error));
        this.requests.delete(event.requestId);
        if (dequeueAfterFailure) this.releaseDispatch();
      }
      return;
    }
    if (!this.replayingHistory && event.kind === 'message' && event.role === 'user') {
      // Multiple inserted user messages can belong to the same foreground cycle.
      if (this.transcript.activeTurn && this.activeTurnCompletion) event = { ...event, steering: true };
    }
    // 会话级背景(③)是第一轮里**单独的一个文本块**;回放历史时这一家把它当用户的话原样放回来
    // (Antigravity ACP 1.2.1 `session/load` 实测)。那不是用户说的 ⇒ 回放里丢掉,❌ 不画进转录。
    if (this.replayingHistory && isReplayedSessionContext(event)) {
      this.lastReplayedSessionContext = (event as { text: string }).text;
      return;
    }
    if (
      this.deps.sessionModes === 'none'
      && (event.kind === 'modes_state' || event.kind === 'mode_selected')
    ) {
      return;
    }

    if (!this.replayingHistory && this.takeProviderFailureMessage(event)) return;
    if (!this.replayingHistory && this.credentialRefusal && event.kind === 'message' && event.role === 'assistant') {
      this.deps.logger.info('SessionCell: harness text after a gugu credential refusal kept out of the transcript', {
        sessionId: this.sessionId,
        providerId: this.deps.providerId,
        refusal: this.credentialRefusal,
        text: event.text,
      });
      return;
    }
    this.trackSubagentSession(event);
    if (!this.replayingHistory && event.kind === 'tool_call') {
      this.pendingNativeSteers = this.pendingNativeSteers.filter(
        (entry) => entry.toolsAtAdmission.has(event.toolCallId)
      );
    }
    if (event.kind === 'message' ? event.role === 'assistant' : this.isTranscriptEvent(event)) {
      this.turnHadAgentOutput = true;
    }

    // 不自报状态的家:请求已答复之后到的内容只能是上一段的尾巴(#6191)。自报的家开工会先报 running。
    const updatesExistingEntity = this.transcript.hasEntity(event);
    if (!updatesExistingEntity && this.isIdleAgentTranscriptEvent(event) && this.activeTurnCompletion === null) {
      this.pushTurnTail(event);
      return;
    }

    if (!updatesExistingEntity && this.isTranscriptEvent(event) && !this.canAcceptTranscriptEvent()) {
      this.deps.logger.warn('SessionCell: dropping transcript update outside active turn', {
        sessionId: this.sessionId,
        phase: this.machine.phase.kind,
      });
      return;
    }

    // 什么都没在跑时,开着的轮只可能是懒开的(后台命令「跑完了」那一行):notice 归进去,一起落定。
    // 没有请求在飞也是事实:自报状态的家发出一句到它报 running 之间,别把那一组提前收口。
    const nothingRunning = this.machine.phase.kind === 'ready' && this.activeTurnCompletion === null;
    const standaloneNotice =
      event.kind === 'session_notice' && (this.transcript.activeTurn === null || nothingRunning);
    const previousRunningAgentCount = this.lastRunningAgentCount;
    // 读数归属取**到达这一刻**的模型:热切之后、下一份读数到之前,手里那份仍是旧模型量的。
    if (event.kind === 'usage') this.usageModelIdAtReport = this.transcript.config.modelOptions?.selected ?? null;
    this.transcript.pushEvent(event);
    // A notice outside a model turn is already a complete historical event.
    // Commit it now; closing the session must not depend on another user prompt.
    if (standaloneNotice) this.transcript.endTurn();
    this.dispatchAgentsChangedIfNeeded(previousRunningAgentCount);
    this.emitTranscriptChanged();
    // 请求先到、流里这一行后到(#7139):这一行缺的照待批的那条请求补一次，规则同 requestPermission。
    if (event.kind === 'tool_call') {
      this.fillToolCall(this.machine.pendingPermissions.find((request) => request.toolCall?.toolCallId === event.toolCallId)?.toolCall ?? null);
    }
    if (event.kind === 'tool_call' || event.kind === 'tool_update') this.scheduleQueuedSteering();
  }

  /** Wait for the native message’s cycle; queued/steered inputs return admission. */
  async prompt(
    input: PromptInput,
    opts?: { steerIfBusy?: boolean },
  ): Promise<Result<SessionPromptResult, AcpSendPromptError>> {
    const now = Date.now();
    const draftRev = this.draftRev;
    return this.sendPromptInternal({
      id: crypto.randomUUID(),
      ...input,
      createdAt: now,
      updatedAt: now,
    }, {
      ...opts,
      // Native admission can arrive after the next draft sync; consume only this revision.
      onAdmission: (result) => { if (result.success && this.draftRev === draftRev) this.clearDraft(); },
    });
  }

  /** Start a prompt without making the caller wait for the provider turn to finish. */
  promptDetached(
    input: PromptInput,
    opts?: { steerIfBusy?: boolean; overtakeQueue?: boolean },
  ): DetachedPromptResult {
    let admitted = false;
    let resolveAdmission!: (result: Result<{ queued: boolean; steered?: boolean }, AcpSendPromptError>) => void;
    const admission = new Promise<Result<{ queued: boolean; steered?: boolean }, AcpSendPromptError>>((resolve) => {
      resolveAdmission = resolve;
    });
    const completion = this.sendPromptInternal({
      id: crypto.randomUUID(),
      ...input,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }, {
      ...(opts?.steerIfBusy ? { steerIfBusy: true } : {}),
      ...(opts?.overtakeQueue ? { overtakeQueue: true } : {}),
      onAdmission: (result) => {
        admitted = true;
        resolveAdmission(result);
      },
    }).then((result) => {
      if (!admitted) {
        resolveAdmission(result.success ? ok({ queued: result.data.queued }) : result);
      }
      return result;
    }, (error: unknown) => {
      if (!admitted) {
        resolveAdmission(acpErr.promptFailed(toSerializedError(error)));
      }
      throw error;
    });
    return { admission, completion };
  }

  queuePrompt(input: PromptInput): Result<void, InvalidStateError> {
    if (this.closeRequested) return acpErr.invalidState('Session is closing; resume it after teardown');
    if (this.reverting) return acpErr.invalidState('Conversation revert is in progress.');
    const now = Date.now();
    const result = this.dispatchFor<InvalidStateError>(
      {
        type: 'QueuePrompt',
        prompt: {
          id: crypto.randomUUID(),
          ...input,
          queueDispatching: undefined,
          createdAt: now,
          updatedAt: now,
        },
      },
      ['invalid_state']
    );
    if (!result.success) return result;
    this.clearDraft();
    return ok();
  }

  /**
   * 产品的排队入口(#6762):composer 在跑时回车、扩展在跑时递话、聊天面还没挂上会话时发的那一句,都落这里。
   * 与发送**同一个**准入,只是不等回合 —— 到达这一刻由状态机判:有一轮在飞 / 还没就绪 / 设置在途 ⇒ 进队列,
   * 由那条边界抽干;空闲 ⇒ 当场开一轮。`session/load` 重放中也扣着(与它从前的原样入队一致),由重放结束抽干。
   *
   * ❌ 原样 `queuePrompt`:调用方读到的「在跑」可能已经过时 —— 一轮刚讲完;或聊天面还没挂上会话、宿主已把
   * 它的启动队列转成纯排队(`forward-live`)。落在空闲会话上的队列,再没有任何边界会来抽干它(#4660)。
   * 开出来的那一轮怎么结束由 cell 自己结算、上屏(与 `prompt()` 同一条路),这里只交回受理结果。
   */
  async queueBehindTurn(input: PromptInput): Promise<Result<{ queued: boolean }, InvalidStateError>> {
    const draftRev = this.draftRev;
    if (this.reverting) return acpErr.invalidState('Conversation revert is in progress.');
    if (this.machine.phase.kind === 'replaying') {
      const queued = this.queuePrompt(input);
      return queued.success ? ok({ queued: true }) : queued;
    }
    // 2026-10-28 主人撞到:agent 自己开的一轮(处理群消息)跑了几分钟,主人打的话一直「排队」。
    // 人在别人开的一轮里打字 ⇒ 下一个工具边界插进去,越过排着的投递;人自己开的那一轮照旧排到讲完。
    const ownerOvertakes = isOwnerOrigin(input.origin)
      && this.machine.phase.kind === 'working'
      && !this.workStartedByOwner
      && (this.supportsSteering || this.agent.interruptForMessage !== undefined);
    const { admission, completion } = this.promptDetached(input, ownerOvertakes ? { steerIfBusy: true, overtakeQueue: true } : undefined);
    completion.catch((error: unknown) => {
      this.deps.logger.error('SessionCell: queued prompt settlement threw', {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    const admitted = await admission;
    if (!admitted.success) {
      // 不带 steerIfBusy 的准入只会以「会话此刻收不了」拒绝;别的类型说明准入本身坏了 ⇒ 响亮抛出。
      if (admitted.error.type === 'invalid_state') return { success: false, error: admitted.error };
      throw new Error(`SessionCell: queued prompt admission failed with ${admitted.error.type}`);
    }
    if (this.draftRev === draftRev) this.clearDraft();
    return ok({ queued: admitted.data.queued });
  }

  setPromptDraft(update: PromptDraftUpdate): Result<void, never> {
    if (update.rev <= this.draftRev) return ok();
    this.draftRev = update.rev;

    if (update.input === null) {
      if (this.draft !== null) {
        this.draft = null;
        this.deps.callbacks?.onDraftChanged?.();
      }
      return ok();
    }

    this.draft = { ...update.input, rev: update.rev, updatedAt: Date.now() };
    this.deps.callbacks?.onDraftChanged?.();
    return ok();
  }

  editQueuedPrompt(id: string, input: PromptInput, queueEdit?: QueuedPromptEdit | null): Result<void, InvalidStateError> {
    if (this.reverting) return acpErr.invalidState('Conversation revert is in progress.');
    const result = this.dispatchFor<InvalidStateError>(
      {
        type: 'EditQueuedPrompt',
        id,
        input,
        updatedAt: Date.now(),
        ...(queueEdit !== undefined ? { queueEdit } : {}),
      },
      ['invalid_state']
    );
    if (!result.success) return result;
    if (queueEdit === null) this.releaseQueueAfterEdit();
    this.scheduleQueuedSteering();
    return ok();
  }

  private releaseQueueAfterEdit(): void {
    if (this.machine.phase.kind === 'ready' && this.settingsInFlight === 0
      && this.settingsBlockedReason === null && this.machine.pendingPermissions.length === 0) {
      this.applyEvent({ type: 'AdmissionReady' });
    }
  }

  removeQueuedPrompt(id: string): Result<void, InvalidStateError> {
    const wasEditing = this.machine.queuedPrompts.some((prompt) => prompt.id === id && prompt.queueEdit);
    const result = this.dispatchFor<InvalidStateError>({ type: 'RemoveQueuedPrompt', id }, [
      'invalid_state',
    ]);
    if (!result.success) return result;
    if (wasEditing) this.releaseQueueAfterEdit();
    this.scheduleQueuedSteering();
    return ok();
  }

  reorderQueue(ids: readonly string[]): Result<void, InvalidStateError> {
    const result = this.dispatchFor<InvalidStateError>({ type: 'ReorderQueue', ids }, [
      'invalid_state',
    ]);
    if (!result.success) return result;
    this.scheduleQueuedSteering();
    return ok();
  }

  /**
   * 排队提示的「立即发送」(#6574):这一条出队,交给忙时插话那条腿 —— 与投递同一个 `sendPromptInternal(…,
   * { steerIfBusy })`,这家怎么插(原生 steering / 并发 prompt / 工具边界打断)都在那条腿里。能不能插,由调用方
   * 按声明的注入档位判(`declaredInjectionTiming`)。
   *
   * 出队与交给那条腿在同一段同步代码里,两步之间回合不会结束。没有在飞的那一轮(正在取消 / 已讲完)⇒ 只挪到
   * 队首,由下一次出队带走 —— ❌ 直接交给那条腿:取消中它会排到队尾,空闲时它会绕过设置生效的闸开新一轮。
   * 失败原样交回调用方,❌ 放回队列(#4660:并发 prompt 那条腿的失败可能在模型读到之后)。
   * ⚠️ 不走 `prompt()`:那条路成功后会清掉 composer 草稿,也就是人正在打的下一句。
   */
  async steerQueuedPrompt(id: string): Promise<Result<void, AcpSendPromptError>> {
    const queued = this.machine.queuedPrompts;
    const prompt = queued.find((candidate) => candidate.id === id);
    if (!prompt) return ok();
    if (prompt.queueEdit) return acpErr.invalidState('Finish editing the queued message before sending it');
    if (this.machine.phase.kind !== 'working') {
      return this.reorderQueue([
        id,
        ...queued.filter((candidate) => candidate.id !== id).map((candidate) => candidate.id),
      ]);
    }
    const removed = this.dispatchFor<InvalidStateError>({ type: 'RemoveQueuedPrompt', id }, [
      'invalid_state',
    ]);
    if (!removed.success) return removed;
    // fromQueue:转录里这一行沿用队列里的稳定 id,与刚才那条排队条目是同一条。
    const sent = await this.sendPromptInternal(prompt, { steerIfBusy: true, fromQueue: true });
    return sent.success ? ok() : sent;
  }

  async cancel(): Promise<Result<void, AcpCancelTurnError>> {
    const dispatchResult = this.dispatchFor<AcpCancelTurnError>({ type: 'Cancel' }, [
      'invalid_state',
    ]);
    if (!dispatchResult.success) return dispatchResult;
    this.nativeAdmissionGeneration += 1;
    try {
      await this.agent.cancel({ sessionId: this.acpSessionId });
      return ok();
    } catch (e) {
      return acpErr.cancelFailed(toSerializedError(e));
    }
  }

  /** Cancel only the addressed child, and only when its runtime advertises that capability.
   * Providers without individual cancellation retain an explicit error; the parent is never a substitute target.
   */
  async cancelSubagent(
    subagentSessionId: string
  ): Promise<Result<void, AcpStopBackgroundTaskError>> {
    if (!this.cancellableSubagents.has(subagentSessionId)) return acpErr.invalidState(
      `subagent ${subagentSessionId} does not advertise individual cancellation`
    );
    try {
      await this.agent.cancel({ sessionId: subagentSessionId });
      return ok();
    } catch (error) { return acpErr.stopTaskFailed(toSerializedError(error)); }
  }

  /** Hold prompt admission until the host has persisted the reverted history. */
  finishHistoryRevert(): void {
    this.reverting = false;
    this.deps.callbacks?.onSessionStateChanged?.();
  }

  async revertSession(anchor: string): Promise<Result<{ providerSessionId: string }, AcpSendPromptError>> {
    if (this.reverting || this.machine.isWorking || this.activeTurnCompletion
      || this.machine.queuedPrompts.length || this.settingsInFlight
      || this.lastRunningAgentCount || this.lastRunningCommandTaskIds.length) {
      return acpErr.sessionBusy('Wait for the current work and queued messages to finish before reverting.');
    }
    if (this.machine.phase.kind !== 'ready') return acpErr.invalidState('Wait for the session to become ready before reverting.');
    if (!this.agent.extMethod) return acpErr.invalidState('This agent does not support conversation revert.');
    this.reverting = true;
    this.deps.callbacks?.onSessionStateChanged?.();
    try {
      const result = await this.agent.extMethod('_session/revert', { sessionId: this.acpSessionId, before: anchor });
      if (result.sessionId !== this.acpSessionId) throw new Error('Revert changed the provider session ID.');
      this.transcript.revertBefore(anchor);
      this.emitTranscriptChanged();
      return ok({ providerSessionId: this.acpSessionId });
    } catch (error) {
      this.reverting = false;
      this.deps.callbacks?.onSessionStateChanged?.();
      return acpErr.promptFailed(toSerializedError(error));
    }
  }

  /**
   * 停掉这一会话里的**一个后台任务**(后台命令),❌ 不动这一轮,也❌ 不管子智能体(#5117)。
   *
   * 停成了供应商会来 `async_task_state_update state:'stopped'`,转录/登记册按那条落定;
   * 这里只报「送到了没有」。适配器没有这个方法(非 claude)时 ACP 回 method-not-found
   * ⇒ 落 stopTaskFailed,❌ 不装成功。
   *
   * 调用前该看 `async_task_spawned.canStop`:子智能体派生的任务那一格是 `false`,
   * 拿这个方法去停它只会拿到 `{stopped:false}` —— 那种要走 `cancelSubagent`。
   */
  async stopBackgroundTask(taskId: string): Promise<Result<void, AcpStopBackgroundTaskError>> {
    /**
     * 先认它是不是一个子智能体会话:是就走规范的 `session/cancel` 打那个子会话。
     *
     * ❌ 别让界面来做这个判断 —— 界面知道的是「这一行该不该有停止按钮」
     * (`canCancel` / `canStop`),不该知道背后是两套机制。表是空的(没谈成会话能力)时
     * 这里天然落回下面那支,也就是老行为。
     */
    const subagentSessionId = this.liveSubagentSessions.get(taskId);
    if (subagentSessionId) return this.cancelSubagent(subagentSessionId);

    if (!this.agent.extMethod) {
      return acpErr.invalidState('agent connection has no extension methods');
    }
    try {
      const response = await this.agent.extMethod('_session/async_task/stop', {
        sessionId: this.acpSessionId,
        asyncTaskId: taskId,
      });
      if (response.stopped !== true) {
        return acpErr.invalidState(`background task ${taskId} is not live`);
      }
      return ok();
    } catch (e) {
      return acpErr.stopTaskFailed(toSerializedError(e));
    }
  }

  async closeSession(): Promise<void> {
    this.nativeAdmissionGeneration += 1;
    this.closeRequested = true;
    this.returnPendingNativeSteers();
    if (!this.agent.closeSession) return;
    try {
      await this.agent.closeSession({ sessionId: this.acpSessionId });
    } catch (error) {
      // ACP does not require providers to implement session/close. Once the provider
      // explicitly reports that unsupported method, the host-owned connection scope
      // remains the authoritative teardown path. Other close errors stay fail-loud.
      if (isUnsupportedSessionClose(error) || providerRejectedMissingSession(error)) return;
      // 没关成,会话照旧在管(stop 可重试):之后的失败照实分类。
      this.closeRequested = false;
      throw error;
    }
  }

  private returnPendingNativeSteers(): void {
    const pending = this.pendingNativeSteers;
    this.pendingNativeSteers = [];
    // The inbox cursor already advanced on admission. Only this queue can replay these inputs.
    // If the provider consumed one without a later tool/completion, replay once: prefer duplicates
    // to silently losing an accepted message. Assistant text alone is not a consumption receipt.
    for (const { prompt } of pending) {
      const { coalesceKey: _key, ...retained } = prompt;
      const result = this.dispatch({ type: 'QueuePrompt', prompt: retained, retainIdentity: true });
      if (!result.success) throw new Error(`Cannot retain admitted steering: ${result.error.type}`);
    }
    if (pending.length) {
      // Late receipts during close must follow earlier returned inputs. They are already admitted,
      // so neither same-key replacement nor a newer still-reserved head may erase/reorder them.
      const ids = new Set(this.machine.queuedPrompts.map(prompt => prompt.id));
      this.returnedNativeSteerIds = [...new Set([
        ...this.returnedNativeSteerIds.filter(id => ids.has(id)), ...pending.map(({ prompt }) => prompt.id),
      ])];
      this.applyEvent({ type: 'QueueReordered', ids: [...this.returnedNativeSteerIds,
        ...this.machine.queuedPrompts.map(prompt => prompt.id).filter(id => !this.returnedNativeSteerIds.includes(id))] });
    }
  }

  resolvePermission(requestId: string, optionId: string): Result<void, InvalidStateError> {
    if (!this.machine.pendingPermissions.some((p) => p.requestId === requestId)) {
      return acpErr.invalidState(`No resolver for requestId '${requestId}'`);
    }
    const dispatchResult = this.dispatchFor<InvalidStateError>(
      { type: 'ResolvePermission', requestId, optionId },
      ['invalid_state']
    );
    if (!dispatchResult.success) return dispatchResult;
    this.rawLog.record({
      kind: 'permission_resolved',
      sessionId: this.acpSessionId,
      requestId,
      optionId,
    });
    this.permissions.settle(requestId, optionId);
    return ok();
  }

  requestPermission(params: AcpPermissionParams): Promise<RequestPermissionResponse> {
    const requestId = crypto.randomUUID();
    const { subject, toolCall: fromRequest } = params;
    this.fillToolCall(fromRequest ? {
      ...fromRequest, rawInput: fromRequest.rawInput ?? undefined,
      outputText: fromRequest.outputText ?? undefined, toolName: fromRequest.toolName ?? undefined,
    } : null);
    const request: AcpPermissionRequest = {
      requestId,
      title: params.title ?? fromRequest?.title ?? '',
      ...(params.description !== undefined ? { description: params.description } : {}),
      ...(subject !== undefined ? { subject: structuredClone(subject) } : {}),
      ...(params._meta !== undefined ? { _meta: structuredClone(params._meta) } : {}),
      ...(fromRequest ? { toolCall: this.buildPermissionToolCall(requestId, fromRequest) } : {}),
      options: params.options.map(({ optionId, name, kind }) => ({ optionId, name, kind })),
    };
    this.rawLog.record({
      kind: 'permission_request',
      sessionId: params.sessionId,
      request: params,
    });
    // 完全访问档:当场作答,不进待决 ⇒ 不产出「等批准」状态,回合照常跑到真正的终结边沿。
    // 只按标准 option kind 选,❌ 不按家族分支;选不出 allow ⇒ selectAutoApproveOption 抛错,
    // 这条 JSON-RPC 以错误返回给 agent,同时留一行 error —— ❌ 不退回挂着等人点。
    // 完全访问只替人点批准;同一条通道上的提问与计划审批(见 permissionWaitKind)交给人答。
    if (this.autoApprovePermissions && permissionWaitKind(request) === 'approval') {
      try {
        const option = selectAutoApproveOption(request);
        this.rawLog.record({
          kind: 'permission_resolved',
          sessionId: this.acpSessionId,
          requestId,
          optionId: option.optionId,
        });
        this.deps.logger.info('SessionCell: permission auto-approved by full-access session', {
          sessionId: this.deps.sessionId,
          providerId: this.deps.providerId,
          toolCallId: params.toolCall?.toolCallId,
          optionKind: option.kind,
        });
        return Promise.resolve({ outcome: { outcome: 'selected', optionId: option.optionId } });
      } catch (error) {
        this.deps.logger.error('SessionCell: full-access session could not auto-approve permission', {
          sessionId: this.deps.sessionId,
          providerId: this.deps.providerId,
          toolCallId: params.toolCall?.toolCallId,
          error: toSerializedError(error),
        });
        return Promise.reject(error);
      }
    }
    this.applyEvent({ type: 'PermissionRequested', request });
    return this.permissions.request(request);
  }

  async setMode(
    modeId: string,
    opts?: { startupOnly?: boolean },
  ): Promise<Result<LiveSettingApplyResult, AcpSetModeOptionError>> {
    const configId = this.transcript.config.modeOptions?.configId ?? null;
    return this.enqueueSetting(
      'permission',
      modeId,
      configId,
      opts?.startupOnly === true,
      (error) => acpErr.setModeFailed(error),
    );
  }

  async setConfigOption(
    dimension: ConfigDimension,
    value: string,
    opts?: { startupOnly?: boolean },
  ): Promise<Result<LiveSettingApplyResult, AcpSetModelOptionError>> {
    const configId = this.configIdForDimension(dimension);
    return this.enqueueSetting(
      dimension,
      value,
      configId,
      opts?.startupOnly === true,
      (error) => acpErr.setConfigFailed(error),
    );
  }

  private enqueueSetting<E extends AcpSetModeOptionError | AcpSetModelOptionError>(
    dimension: LiveSettingDimension,
    value: string,
    configId: string | null,
    startupOnly: boolean,
    fail: (cause: ReturnType<typeof toSerializedError>) => Result<never, E>,
  ): Promise<Result<LiveSettingApplyResult, E>> {
    if (this.reverting) return Promise.resolve(fail({ name: 'HistoryRevertInProgress', message: 'Conversation revert is in progress.' }));
    const capability = this.liveSettings?.[dimension];
    if (!capability) {
      return Promise.resolve(fail({
        name: 'LiveSettingUndeclared',
        message: `Provider '${this.deps.providerId}' did not declare a live ${dimension} setting`,
      }));
    }
    const turnToWait = this.activeTurnCompletion;
    if (turnToWait && !startupOnly && capability.busy === 'reject') {
      return Promise.resolve(fail({
        name: 'LiveSettingBusy',
        message: `Cannot change ${dimension} while the current turn is in flight`,
      }));
    }
    const run = async (): Promise<Result<LiveSettingApplyResult, E>> => {
      // `queue-next-turn` means the provider accepts the update while a turn is active and
      // applies it to the next turn. `reject` already returned above, so waiting here would
      // silently turn the provider's queued capability into the old end-of-turn behavior.
      const channel = startupOnly
        ? this.startupChannel(dimension, configId)
        : dimension === 'permission' && !configId && capability.channel === 'acp-config-option'
          ? 'acp-mode'
          : capability.channel;
      const hasConfigTarget = dimension === 'permission' || configId !== null;
      if (
        hasConfigTarget
        && (startupOnly || (channel !== 'reload-session' && channel !== 'unsupported' && channel !== 'per-prompt'))
      ) {
        const validation = dimension === 'permission'
          ? this.dispatchFor<AcpSetModeOptionError>({ type: 'SetMode', modeId: value }, [
              'invalid_state',
              'set_mode_failed',
            ])
          : this.dispatchFor<AcpSetModelOptionError>(
              { type: 'SetConfigOption', configId: configId ?? '', value },
              ['invalid_state', 'set_config_failed'],
            );
        if (!validation.success) return validation as unknown as Result<LiveSettingApplyResult, E>;
      }
      const result = await this.applyLiveSetting(dimension, value, configId, capability, startupOnly, fail);
      if (!result.success) {
        const causeMessage = 'cause' in result.error ? result.error.cause?.message : undefined;
        this.settingsBlockedReason = causeMessage ?? result.error.message ?? `Unable to apply ${dimension}`;
        return result;
      }
      // 用户在会话里改了档 ⇒ 作答判据跟着换(见 autoApprovePermissions)。
      // 启动期那一发(startupOnly)是在兑现开会话时的档,不改判据。
      // 放权只认 provider 确认生效(`applied`);收权在 provider 接下(含 `pending_next_turn`)那一刻
      // 就生效 —— 咕咕替用户作答的范围永远不宽于用户最新的选择。
      if (dimension === 'permission' && !startupOnly && result.data.status !== 'restart_required') {
        const modeId = result.data.status === 'applied' ? result.data.effectiveValue : result.data.requestedValue;
        const fullAccess =
          classifyProviderPermissionMode(modeId, this.deps.permissionModeMap) === 'full-access';
        if (result.data.status === 'applied' || !fullAccess) this.autoApprovePermissions = fullAccess;
      }
      if (result.data.status !== 'applied') {
        this.settingsBlockedReason =
          `Setting '${dimension}' was not confirmed (${result.data.status}); next turn is paused`;
      } else {
        this.settingsBlockedReason = null;
      }
      return result;
    };

    if (startupOnly) return run();
    this.settingsInFlight += 1;
    const operation = this.settingsTail.then(run, run);
    const settled = operation.then(
      (result) => {
        this.finishSetting();
        return result;
      },
      (error: unknown) => {
        this.finishSetting();
        throw error;
      },
    );
    this.settingsTail = settled.then(() => undefined, () => undefined);
    return settled;
  }

  private finishSetting(): void {
    this.settingsInFlight = Math.max(0, this.settingsInFlight - 1);
    if (this.settingsInFlight !== 0 || this.settingsBlockedReason) return;
    if (this.machine.phase.kind === 'ready') this.applyEvent({ type: 'AdmissionReady' });
  }

  private async applyLiveSetting<E extends AcpSetModeOptionError | AcpSetModelOptionError>(
    dimension: LiveSettingDimension,
    value: string,
    configId: string | null,
    capability: LiveSettingCapability,
    startupOnly: boolean,
    fail: (cause: ReturnType<typeof toSerializedError>) => Result<never, E>,
  ): Promise<Result<LiveSettingApplyResult, E>> {
    const channel = startupOnly
      ? this.startupChannel(dimension, configId)
      : dimension === 'permission' && !configId && capability.channel === 'acp-config-option'
        ? 'acp-mode'
        : capability.channel;
    if (!startupOnly && channel === 'unsupported') {
      return fail({ name: 'LiveSettingUnsupported', message: `No live setting channel for ${dimension}` });
    }
    if (!startupOnly && channel === 'reload-session') {
      return ok({ status: 'restart_required', requestedValue: value, channel });
    }
    if (!startupOnly && channel === 'per-prompt') {
      return fail({ name: 'LiveSettingUnsupported', message: `Per-prompt ${dimension} is not a safe live channel` });
    }

    const agent = this.agent;
    try {
      if (agent.applyLiveSetting && !startupOnly) {
        const response = await agent.applyLiveSetting({
          providerSessionId: this.acpSessionId,
          dimension,
          value,
          channel,
          ...(configId ? { configId } : {}),
        });
        if (response.status === 'pending_next_turn') {
          return ok({ status: 'pending_next_turn', requestedValue: value, channel });
        }
        return this.confirmSettingResponse(dimension, value, configId, capability, response, fail, channel);
      }

      if ((channel === 'acp-config-option' || channel === 'provider-thread-settings') && !configId) {
        return fail({
          name: 'LiveSettingExecutorMissing',
          message: `Agent connection does not expose ${dimension} configuration`,
        });
      }
      if (channel === 'acp-config-option' || channel === 'provider-thread-settings') {
        if (!agent.setSessionConfigOption) {
          // Compatibility for unannotated ACP test/legacy adapters: a permission setting may use
          // the stable mode RPC when the unstable config setter is absent. Explicit provider
          // contracts use `ack-read-back` and must fail instead of silently changing channels.
          if (dimension === 'permission' && (capability.ack === 'ack' || startupOnly) && agent.setSessionMode) {
            await agent.setSessionMode({
              sessionId: this.acpSessionId,
              modeId: value,
            } satisfies SetSessionModeRequest);
            return ok({ status: 'applied', effectiveValue: value, channel: 'acp-mode' });
          }
          return fail({
            name: 'LiveSettingExecutorMissing',
            message: `Agent connection does not support setSessionConfigOption for ${dimension}`,
          });
        }
        const request = {
          sessionId: this.acpSessionId,
          configId: configId!,
          value,
        } satisfies SetSessionConfigOptionRequest;
        this.rawLog.record({ kind: 'session_config_option_request', sessionId: this.acpSessionId, request });
        const response = await agent.setSessionConfigOption(request);
        this.rawLog.record({
          kind: 'session_config_option_response',
          sessionId: this.acpSessionId,
          response,
        });
        return this.confirmSettingResponse(dimension, value, configId, capability, response, fail, channel);
      }
      if (channel !== 'acp-mode' || !agent.setSessionMode) {
        return fail({ name: 'LiveSettingExecutorMissing', message: `No executor for ${dimension}` });
      }
      await agent.setSessionMode({ sessionId: this.acpSessionId, modeId: value } satisfies SetSessionModeRequest);
      // `ack`: the success response is the confirmation. A provider that sends no current_mode_update after it
      // (hermes) would otherwise leave the picker on the mode the session started in.
      if (capability.ack === 'ack') {
        this.transcript.pushEvent({ kind: 'mode_selected', modeId: value });
        this.emitTranscriptChanged();
      }
      return ok({ status: 'applied', effectiveValue: value, channel });
    } catch (error) {
      return fail(toSerializedError(error));
    }
  }

  private confirmSettingResponse<E extends AcpSetModeOptionError | AcpSetModelOptionError>(
    dimension: LiveSettingDimension,
    value: string,
    configId: string | null,
    capability: LiveSettingCapability,
    response: {
      status?: 'applied' | 'pending_next_turn';
      effectiveValue?: string;
      configOptions?: readonly SessionConfigOption[] | null;
    },
    fail: (cause: ReturnType<typeof toSerializedError>) => Result<never, E>,
    channel: LiveSettingCapability['channel'],
  ): Result<LiveSettingApplyResult, E> {
    if (response.status === 'pending_next_turn') {
      return ok({ status: 'pending_next_turn', requestedValue: value, channel });
    }
    const readBack = configId
      ? response.configOptions?.find((option) => option.id === configId)
      : undefined;
    const readBackValue = (readBack as unknown as { currentValue?: string } | undefined)?.currentValue;
    if (capability.ack === 'ack-read-back' && readBackValue === undefined && response.effectiveValue === undefined) {
      // 声明了会回读，却一个读数都没给 ⇒ 我们**不知道**这条会话现在跑的是什么。这一条保留：
      // 它挡的是「把下一轮发给一个身份不明的会话」，而不是拼写对不对（见 wasSubstituted 抬头）。
      return fail({
        name: 'LiveSettingReadBackMissing',
        message: `Provider did not confirm ${dimension}='${value}' (read-back was 'missing')`,
      });
    }
    const effectiveValue = response.effectiveValue ?? readBackValue ?? value;
    if (dimension !== 'model' && capability.ack === 'ack-read-back' && effectiveValue !== value) {
      return fail({
        name: 'LiveSettingReadBackMismatch',
        message: `Provider did not confirm ${dimension}='${value}' (read-back was '${effectiveValue}')`,
      });
    }
    if (response.configOptions !== undefined) {
      this.seedTranscriptMeta({ configOptions: response.configOptions });
    } else if (response.effectiveValue !== undefined || capability.ack === 'ack') {
      this.seedSyntheticConfigSelection(dimension, configId, response.effectiveValue ?? value);
    }
    return ok({
      status: 'applied',
      effectiveValue,
      channel,
      ...(dimension === 'model' && this.wasSubstituted(readBack, value, effectiveValue)
        ? { substituted: value }
        : {}),
    });
  }

  /**
   * 「provider 本可以照办，却停在了别处」——只有这一种情况需要告诉用户。
   *
   * ⚠️ 这里**不再**拿「我发出去的字 === 我读回来的字」当判据（那是本函数原先的写法，
   * 它把一次成功判成了失败，一条生产会话因此整条打不开，见 spec `session-settings-authority`）。
   * 理由是那条判据在用一件**咕咕说了不算的事**——标识符的拼写——去证明一件它真正关心的事：
   * 界面显示的值是不是实际在跑的值。拼写归 provider 所有，而 provider 会改、也会把简称
   * 翻成正式写法（claude 的 ACP 适配器源码原话：「Use the canonical option value so downstream
   * code always receives the model ID rather than the caller-supplied alias」）。
   * 实测 claude 2.1.266 + adapter 0.75.1：设 `opus` 成功，回读 `opus[1m]`；设 `claude-sonnet-5`
   * 成功，回读 `sonnet`；而真的用不了的值（`claude-opus-4-8`）是**抛错**，不是静默回读别的。
   *
   * ⇒ 判据换成 provider 自己的目录：我们请求的那一项它到底**有没有**。
   *   - 目录里没有 ⇒ 它把我们给的写法解析成了正式写法，跑的就是我们要的东西 ⇒ 安静跟上。
   *   - 目录里有、它却停在别处 ⇒ 这是一次**替换**，用户选的和实际在跑的不是一个东西 ⇒ 留痕。
   * 读不到目录（provider 不报 configOptions）时不猜，按「没发生替换」处理：`ack` 语义已经
   * 在上面把该记的记了，这里再编一条痕迹只会是噪音。
   */
  private wasSubstituted(
    readBack: SessionConfigOption | undefined,
    requested: string,
    effectiveValue: string,
  ): boolean {
    if (effectiveValue === requested) return false;
    const option = readBack as unknown as
      | { options?: readonly { value?: string; options?: readonly { value?: string }[] }[] }
      | undefined;
    if (!option?.options) return false;
    const offered = option.options.flatMap((entry) =>
      entry.options ? entry.options.map((nested) => nested.value) : [entry.value],
    );
    return offered.includes(requested);
  }

  private startupChannel(dimension: LiveSettingDimension, configId: string | null): LiveSettingCapability['channel'] {
    if (dimension === 'permission' && !configId) return 'acp-mode';
    return 'acp-config-option';
  }

  private async sendQueuedPromptAfterSettings(
    prompt: QueuedPrompt,
  ): Promise<Result<SessionPromptResult, AcpSendPromptError>> {
    if (!this.settingsInFlight && !this.settingsBlockedReason) {
      return this.sendPromptInternal(prompt, { fromQueue: true, skipAdmission: true });
    }
    await this.settingsTail;
    if (this.settingsBlockedReason) {
      // The machine dequeued this prompt at the turn boundary before the setting result arrived.
      // Put it back so an explicit retry can send it after the setting is resolved; this is the
      // one failure class where retaining the queued prompt is part of the contract.
      this.dispatch({ type: 'QueuePrompt', prompt });
      this.deps.logger.error('SessionCell: queued prompt held because live setting was not confirmed', {
        sessionId: this.sessionId,
        reason: this.settingsBlockedReason,
        promptId: prompt.id,
      });
      return acpErr.invalidState(this.settingsBlockedReason);
    }
    return this.sendPromptInternal(prompt, { fromQueue: true, skipAdmission: true });
  }

  private openTurnCompletion(): void {
    if (this.activeTurnCompletion) return;
    this.activeTurnCompletion = new Promise<Result<SessionPromptResult, AcpSendPromptError>>((resolve) => {
      this.resolveActiveTurnCompletion = resolve;
    });
  }

  private closeTurnCompletion(result: Result<SessionPromptResult, AcpSendPromptError> = ok({ queued: false })): void {
    this.interruptedForMessage = false;
    this.yieldingRepliedAssistant = null;
    this.nativeInputAfterStart = false;
    this.providerTurnFailure = null;
    this.providerStderrFailure = null;
    this.providerTurnSignIn = false;
    this.credentialRefusal = null;
    this.turnHadAgentOutput = false;
    const resolve = this.resolveActiveTurnCompletion;
    this.dequeueAfterFailure = true;
    this.requeuedAfterTokenBoundary = false;
    this.resolveActiveTurnCompletion = null;
    this.activeTurnCompletion = null;
    resolve?.(result);
  }

  private makeTurnEnvelope(): TurnEnvelope {
    const config = this.transcript.config;
    return {
      sessionId: this.sessionId,
      turnSequence: this.promptSequence,
      model: config.modelOptions?.selected ?? null,
      permissionMode: config.modeOptions?.selected ?? null,
      effort: config.efforts?.selected ?? null,
      providerSessionId: this.acpSessionId,
      requestId: crypto.randomUUID(),
    };
  }

  private releaseDispatch(): void {
    // Closing keeps the queue for the closing side to decide (#743), like WorkEnded in endWork.
    if (this.closeRequested) return;
    if (this.machine.phase.kind === 'ready' && this.settingsInFlight === 0 && !this.settingsBlockedReason) {
      // The drain sends the next queued batch; its failure is reported as endWork reports it.
      try { this.applyEvent({ type: 'AdmissionReady' }); } catch (error) {
        this.deps.logger.error('SessionCell: queued dispatch failed', { sessionId: this.sessionId, error });
      }
    }
  }

  /** agent 停下:转录里开着的那一组按结局收口,状态回到 ready(抽干队列)。 */
  private endWork(outcome: TranscriptTurnOutcome, opts?: { dequeueQueuedPrompt?: boolean; foreground?: TranscriptTurn['foreground']; result?: Result<SessionPromptResult, AcpSendPromptError> }): boolean {
    if (outcome.kind === 'cancelled' || outcome.kind === 'error') this.nativeAdmissionGeneration += 1;
    const working = this.machine.isWorking;
    if (!working && this.transcript.activeTurn === null) {
      settleAcceptedRequests(this.requests, this.transcript);
      this.closeTurnCompletion();
      return false;
    }
    if (outcome.kind !== 'cancelled' || outcome.reason === 'interrupted_for_message') {
      this.pendingNativeSteers = [];
    }
    // 任何一次落定都先把「可改口」收回:只有紧接着的 prompt-边界分类会再把它打开。
    // ❌ 不许让上一次的暂定状态活过这一次 —— 那就又变回一个时间窗了。
    this.lastFailureProvisional = false;
    const previousRunningAgentCount = this.lastRunningAgentCount;
    this.transcript.settleTurn(outcome, Date.now(), opts?.foreground);
    settleAcceptedRequests(this.requests, this.transcript);
    this.dispatchAgentsChangedIfNeeded(previousRunningAgentCount);
    this.emitTranscriptChanged();
    // Detach this exact cycle before a queue drain can create its successor.
    const resolve = this.resolveActiveTurnCompletion;
    this.resolveActiveTurnCompletion = null;
    this.closeTurnCompletion();
    this.queuedTurnFence = false;
    try {
      // 正在关:这时出队的那一句只会被 `sendPromptInternal` 以「Session is closing」拒掉,而出队已经把它从队列里拿走了
      // ⇒ 人排的话凭空没了(2026-10-28 07:34:06)。关的时候不出队,队列原样留给关闭那一侧决定去留。
      // A turn that ended before running still records its outcome (machine: WorkEnded in ready).
      if (working || this.machine.phase.kind === 'ready') this.applyEvent({ type: 'WorkEnded', outcome: machineOutcome(outcome),
        ...((opts?.dequeueQueuedPrompt === false || this.context().dispatchPending || this.closeRequested) ? { dequeueQueuedPrompt: false } : {}) });
      // Commands can finish without ever reporting running. Their explicit completion releases
      // the same lane; WorkEnded in ready records the outcome but does not itself drain it.
      if (!working && opts?.dequeueQueuedPrompt !== false) this.releaseDispatch();
      resolve?.(opts?.result ?? (outcome.kind === 'error'
        ? acpErr.promptFailed({ name: 'ForegroundError', message: outcome.detail ?? outcome.reason ?? 'Foreground failed' })
        : ok({ queued: false })));
    } catch (error) {
      this.deps.logger.error('SessionCell: queued dispatch failed', { sessionId: this.sessionId, error });
      resolve?.(acpErr.promptFailed(toSerializedError(error)));
    }
    return true;
  }

  /**
   * agent 报的状态(`state_update`):在不在干活只听这个,谁开的工都一样(#7087)。
   * ❌ 别再猜「它停了」:静默定时器(2026-09-06 把消息切碎)和「带 cost 的 usage」都是猜,它自己会报。
   */
  private onAgentState(event: Extract<NormalizedEvent, { kind: 'agent_state' }>): void {
    // A replayed idle is that native cycle's boundary; it never takes the replaying runtime into work.
    if (this.replayingHistory) {
      if (event.state === 'idle') this.transcript.endTurn();
      return;
    }
    if (event.state === 'unknown') return;
    if (event.state !== 'idle') {
      if (this.machine.phase.kind === 'ready') {
        // 没有一句在飞,agent 自己开了工(后台跑完的通知、子任务回来):不是人开的。
        if (!this.activeTurnCompletion) this.workStartedByOwner = false;
        this.openTurnCompletion();
        this.applyEvent({ type: 'WorkStarted' });
      }
      return;
    }
    const cycle = this.activeTurnCompletion;
    const finish = () => {
      if (this.activeTurnCompletion !== cycle) return;
      const anchor = (event._meta?.guguRevert as { before?: unknown } | undefined)?.before;
      if (typeof anchor === 'string' && anchor) this.transcript.setActiveRevertAnchor(anchor);
      this.rawLog.record({ kind: 'prompt_result', sessionId: this.acpSessionId,
        stopReason: event.stopReason, ...(event.error ? { error: toSerializedError(Object.assign(new Error(event.error.message), event.error)) } : {}) });
      if (event.error || event.stopReason === 'error') {
        if (this.requeuedAfterTokenBoundary) {
          this.endWork({ kind: 'done', reason: 'end_turn' }, { foreground: event, dequeueQueuedPrompt: false,
            result: ok({ queued: true, requeuedAfterTokenBoundary: true }) });
          return;
        }
        const classified = classifyTurnFailure({ at: 'prompt',
          cause: toSerializedError(event.error ? Object.assign(new Error(event.error.message), event.error) : new Error('Foreground ended with an error')),
          platformCredentials: this.deps.platformCredentials, closeRequested: this.closeRequested,
          credentialRefusal: this.credentialRefusal });
        this.deps.logger.error('SessionCell: prompt failed', { sessionId: this.sessionId, providerId: this.deps.providerId, acpSessionId: this.acpSessionId, cause: event.error });
        if (this.endWork(classified.outcome, { foreground: event, dequeueQueuedPrompt: this.dequeueAfterFailure })) this.lastFailureProvisional = classified.provisional;
      } else {
        const reason = event.stopReason;
        this.endWork(reason === 'end_turn' || reason === 'cancelled' || reason === 'refusal'
          || reason === 'max_tokens' || reason === 'max_turn_requests'
          ? this.settledOutcome(reason) : { kind: 'done', reason: 'cycle_end' }, { foreground: event });
      }
    };
    // Some providers report a swallowed failure on stderr, independently of their result pipe.
    if (event.stopReason === 'end_turn' && this.deps.turnFailure?.watchesStderr
      && !this.turnHadAgentOutput && !this.providerTurnFailure && !this.providerStderrFailure) {
      void new Promise(resolve => setTimeout(resolve, STDERR_FAILURE_GRACE_MS)).then(finish);
    } else finish();
  }

  private applyReceiptMetadata(requestId: string, meta: SessionPromptReceipt['_meta']): void {
    const request = this.requests.get(requestId);
    const anchor = (meta?.guguRevert as { before?: unknown } | undefined)?.before;
    if (request && typeof anchor === 'string' && anchor) {
      this.transcript.setRevertAnchor(request.messageId, anchor);
      this.emitTranscriptChanged();
    }
  }

  /**
   * 适配器进程没了。
   *
   * ⚠️ 这里此前把这一轮结算成裸 `{kind:'error', reason:'prompt_failed'}` —— 与「上游网关拒了」
   * **逐字同一句话**,而两者的下一步动作完全不同(重开引擎 vs 查网关/配额/凭据),
   * 用户在产品面分不出来(#4875 ②)。而 `exitCode`/`signal`/stderr 尾巴在连接层本来就是齐的,
   * 只是当年的回调签名把它们截断了。⇒ 现在整条事实带进来,分类交给唯一那个分类器。
   */
  processClosed(exit: AdapterExit, opts?: { abnormal?: boolean }): void {
    this.nativeAdmissionGeneration += 1;
    const abnormal = opts?.abnormal !== false;
    // 这一轮的 reason 是从哪条路来的 —— 三条路的分岔就在下面,而它们在产品面长得**一模一样**
    // (都是一行「回合失败」)。不记这一行,下次问「为什么它说的是 A 不是 B」就只能靠猜。
    this.deps.logger.info('SessionCell: process closed', {
      sessionId: this.sessionId,
      abnormal,
      exitCode: exit.exitCode,
      signal: exit.signal,
      working: this.machine.isWorking,
      transcriptTurn: this.transcript.activeTurn !== null,
      lastFailureProvisional: this.lastFailureProvisional,
      lastCommittedOutcome: this.transcript.history.at(-1)?.outcome?.kind ?? null,
      lastCommittedReason:
        (this.transcript.history.at(-1)?.outcome as { reason?: string } | undefined)?.reason ?? null,
    });
    if (abnormal) {
      // A provider exit during an active turn is an abnormal terminal boundary. Settle the
      // transcript before closing the machine so the failed turn and queued prompts remain visible.
      if (this.machine.isWorking || this.transcript.activeTurn) {
        this.endWork(
          classifyTurnFailure({ at: 'process-exit', exit }).outcome,
          { dequeueQueuedPrompt: false },
        );
      } else {
        // ⚠️ **这一支才是常态,别把它当边角料。** 连接塌掉的顺序是:stdout 先 EOF ⇒ SDK 把在飞的
        // `session/prompt` 用一句 `ACP connection closed` 拒掉 ⇒ 我们据此把那一轮落成
        // `prompt_failed` ⇒ **毫秒之后**才轮到进程的 exit 事件。于是等我们知道"引擎死了、
        // 退出码是多少"的时候,那一轮已经落定了 —— 真机实测(mac1 2026-09-20,回合中途 kill -9)
        // 就是这个时序:屏幕上留下的是「这条指令没能送达」,而指令其实送达了。
        // ⇒ 同一件事在更外一层边界上被重新认识,改口(守卫见 reducer 的 `turn_outcome_superseded`)。
        // ⚠️ **只改口那条暂定的。** provider 真说过话的那一条(网关 4xx、适配器拒收)
        // 是 final —— 它带着上游 message 与 request id,而那正是 #5858 要救的东西;
        // 「失败一轮 → 用户关掉会话 → 引擎退出」是最常见的收尾路径之一,
        // 早一版的时间窗守卫会在那里把它抹掉,连 #4875 ② 一起退回去。
        if (this.lastFailureProvisional) {
          this.lastFailureProvisional = false;
          const prior = this.transcript.history.at(-1)?.outcome;
          this.transcript.supersedeLastTurnOutcome(
            classifyTurnFailure({
              at: 'process-exit',
              exit,
              ...(prior?.kind === 'error' && prior.detail ? { priorDetail: prior.detail } : {}),
            }).outcome,
          );
          this.emitTranscriptChanged();
          // 改口到底落没落地 —— ❌ 不靠「我调过那个方法了」当读数。
          this.deps.logger.info('SessionCell: turn outcome superseded', {
            sessionId: this.sessionId,
            nowReason:
              (this.transcript.history.at(-1)?.outcome as { reason?: string } | undefined)?.reason
              ?? null,
            nowDetail:
              (this.transcript.history.at(-1)?.outcome as { detail?: string } | undefined)?.detail
              ?? null,
          });
        }
      }
    }
    for (const request of this.requests.values()) request.completion.resolve(acpErr.promptFailed({ name: 'ConnectionClosed', message: 'ACP process closed' }));
    this.requests.clear();
    this.applyEvent({ type: 'ProcessClosed', exit, abnormal });
  }

  dispose(): void {
    this.nativeAdmissionGeneration += 1;
    if (this.activeTurnCompletion || this.transcript.activeTurn) {
      this.endWork(this.closeRequested ? { kind: 'cancelled', reason: 'cancelled' }
        : classifyTurnFailure({ at: 'connection-lost', failure: null }).outcome,
      { dequeueQueuedPrompt: false });
    }
    for (const request of this.requests.values()) request.completion.resolve(acpErr.promptFailed({ name: 'ConnectionClosed', message: 'ACP session closed' }));
    this.requests.clear();
    this.permissions.drain(this.machine.pendingPermissions);
  }

  private dispatch(command: Command): Result<Effect[], AcpRuntimeError> {
    const result = this.machine.dispatch(command, this.context());
    if (!result.success) return result;
    this.interpretEffects(result.data);
    return result;
  }

  private dispatchFor<E extends AcpRuntimeError>(
    command: Command,
    expected: readonly E['type'][]
  ): Result<Effect[], E> {
    const result = this.dispatch(command);
    if (result.success) return result;
    if (expected.includes(result.error.type as E['type'])) return result as Result<Effect[], E>;
    throw new Error(`Unexpected ACP dispatch error '${result.error.type}'`);
  }

  private applyEvent(event: DomainEvent): void {
    if (event.type === 'AdmissionReady' && this.context().dispatchPending) return;
    this.interpretEffects(this.machine.apply(event));
  }

  private interpretEffects(effects: Effect[]): void {
    this.effectQueue.push(...effects);
    if (this.interpretingEffects) return;

    this.interpretingEffects = true;
    let stateChanged = false;
    try {
      while (this.effectQueue.length > 0) {
        const effect = this.effectQueue.shift()!;
        switch (effect.type) {
          case 'state':
          case 'permissionRequest':
            stateChanged = true;
            break;
          case 'permissionResolved':
            stateChanged = true;
            if (effect.cancelled) this.permissions.cancel(effect.requestId);
            break;
          case 'closed':
            this.deps.callbacks?.onClosed?.(effect.exitCode);
            break;
          case 'agentEvent':
            this.deps.callbacks?.onAgentEvent?.(effect.phase);
            break;
          case 'settleAgents':
            this.settleRunningAgents(effect.scope, effect.status);
            break;
          case 'sendPrompt': {
            const outgoing = this.composeQueuedBatch(effect.sources);
            void this.sendQueuedPromptAfterSettings(outgoing).then((result) => {
              // 出队发送必须**真的开轮**。`queued: true` 说明 decide 又把它排了回去 —— 而排回去的
              // 是**合并后的那一段**、只带队首一个 id:N 条各自可编辑的条目会静默塌成一条,另外
              // 那几个 id 凭空消失。所以它与 provider 拒绝走同一条路:按 sources 原样放回队首。
              // ⚠️ 当前宿主回调下构造不出这个时序(没有可触发的重入点),这一格是防静默丢失的闸,
              // 不是有读数的路径 —— 它红不了,别把它当判据。
              if (!result.success || (result.data.queued && !result.data.requeuedAfterTokenBoundary)) {
                // 失败**不回队列**(#4660)。可见性已经有了,不需要队列兼职当错误显示器:
                // 这一批的正文在**发出去之前**就作为 user 消息进了 transcript(见 sendPromptInternal),
                // 而失败会把那一轮结算成 `{kind:'error', reason:'prompt_failed'}` ⇒ 用户看得见
                // 「这条发过、失败了」。旧做法再把它塞回队列,反而让同一批同时显示成「待发」——
                // 那是**假的待发**,而且没有任何事件会再来抽干它(滞留)。
                // ⚠️ 发送方(另一个 agent)侧的可见性仍然缺,那是 #4493 的另一半,不在本次范围内。
                this.deps.logger.error(
                  'SessionCell: queued prompt send failed; not re-queued (turn settles as errored)',
                  {
                    sessionId: this.sessionId,
                    promptIds: effect.sources.map((prompt) => prompt.id),
                    error: result.success
                      ? new Error('queued send was re-queued instead of starting a turn')
                      : result.error,
                  }
                );
              } else if (result.data.requeuedAfterTokenBoundary) {
                this.deps.logger.warn(
                  'SessionCell: queued communication prompt hit provider token boundary; retained for the next turn',
                  { sessionId: this.sessionId, promptIds: effect.sources.map((prompt) => prompt.id) },
                );
              }
            });
            break;
          }
          case 'promptSteered':
            // 标记性 effect:发送由发起这次 dispatch 的 sendPromptInternal 同步接手(与 started 判定
            // 同型),这里不做事 —— 在这儿再发一次就是双投。
            break;
          case 'warn':
            this.deps.logger.warn(`SessionCell: ${effect.message}`, {
              sessionId: this.sessionId,
            });
            break;
        }
      }
    } finally {
      this.interpretingEffects = false;
    }
    if (stateChanged) this.deps.callbacks?.onSessionStateChanged?.();
  }

  /**
   * 把一批一起出队的条目拼成**一条**要发给 provider 的 prompt。
   *
   * machine 只决定「哪些条目一起走」;怎么拼在这里,因为**信封合并的唯一属主住在 core**,
   * 经 cell-deps 注入。typed 那类按空行接(machine 里的纯函数),信封那类交给注入的属主。
   * ⚠️ 没注入而又来了多条信封 ⇒ **响亮失败**,❌ 不退回空行拼接:那等于在这里长出第二个信封属主。
   */
  private composeQueuedBatch(sources: readonly QueuedPrompt[]): QueuedPrompt {
    const [head] = sources;
    if (sources.length === 1) return head;
    if (queuedPromptMergeKind(head) === 'typed') return mergeTypedPrompts(sources);
    const merge = this.deps.mergeEnvelopes;
    if (!merge) {
      throw new Error(
        'SessionCell: cannot merge queued delivery envelopes without the host-injected '
        + 'mergeEnvelopes owner (core mergeDeliveryEnvelopes)',
      );
    }
    return {
      ...head,
      text: merge(sources.map((prompt) => prompt.text)),
      updatedAt: Math.max(...sources.map((prompt) => prompt.updatedAt)),
    };
  }

  /**
   * 收不了并发 prompt 的家的忙时插话(transport interrupt control):插话先进队列,等当前工具调用跑完
   * (没有在跑的就立刻)打断这一轮;回合结束时队列照常出队成下一轮。
   */
  private steerByInterrupt(
    prompt: QueuedPrompt,
    opts?: {
      skipAdmission?: boolean;
      onAdmission?: (result: Result<{ queued: boolean; steered?: boolean }, AcpSendPromptError>) => void;
    },
  ): Result<SessionPromptResult, AcpSendPromptError> {
    // 忙时插话只来自投递(steerIfBusy 只在 detached 投递路上带),队列要求来源显式。
    const queuedPrompt = prompt.origin ? prompt : { ...prompt, origin: 'communication' as const };
    const held = this.dispatchFor<AcpSendPromptError>({ type: 'QueuePrompt', prompt: queuedPrompt }, ['invalid_state']);
    if (!held.success) return held;
    void this.agent.interruptForMessage!({ sessionId: this.acpSessionId }).catch((error: unknown) => {
      this.deps.logger.error('SessionCell: interrupt for message failed', { sessionId: this.sessionId, error });
    });
    // #6387 它在队列里,但不是排到这一轮讲完:下一个工具边界就进去 —— 对调用方这就是「插进去了」。
    const queued = ok({ queued: true, steered: true });
    if (!opts?.skipAdmission) opts?.onAdmission?.(queued);
    return queued;
  }

  /**
   * #7103 这一轮来要票、咕咕没签出来(谁拒绝谁说话):宿主在回绝取票**之前**递进来,所以这一家知道拿不到票之前它已经在这里。
   * 结算时按原因说(`guguReason`);在它之后这一家自己写进回复的那块报错(claude 的「apiKeyHelper is failing」)
   * 不是拒绝方的话,❌ 进转录。`null` = 同一轮里后来签出来了,撤掉。只在回合进行中认,回合结束时清。
   */
  noteCredentialRefusal(code: string | null): void {
    const phase = this.machine.phase.kind;
    if (phase !== 'working' && phase !== 'cancelling') return;
    this.credentialRefusal = code;
  }

  /** 见 `acp.turnFailure.fromStderrLine`:只在回合进行中认;记下,结算时这一轮一个字都没出才算(见 `providerStderrFailure`)。 */
  noteProviderStderrFailure(failure: string | { message: string; signInRequired: true }): void {
    const phase = this.machine.phase.kind;
    if (phase !== 'working' && phase !== 'cancelling') return;
    const message = typeof failure === 'string' ? failure : failure.message;
    if (typeof failure !== 'string') this.providerTurnSignIn = true;
    this.providerStderrFailure = this.providerStderrFailure ? `${this.providerStderrFailure}\n${message}` : message;
  }

  /** 见 `acp.turnFailure.fromAgentMessage`:只在回合进行中认;认出来就记下、这块文字不进转录(它会作为失败详情出现)。 */
  private takeProviderFailureMessage(event: NormalizedEvent): boolean {
    const classify = this.deps.turnFailure?.fromAgentMessage;
    if (!classify || event.kind !== 'message' || event.role !== 'assistant') return false;
    const failure = classify(event.text);
    if (!failure) return false;
    const phase = this.machine.phase.kind;
    if (phase === 'working' || phase === 'cancelling') {
      this.providerTurnFailure = this.providerTurnFailure ? `${this.providerTurnFailure}\n${failure}` : failure;
    }
    return true;
  }

  /** 这一轮怎么结算:为插话停下的、被掩盖的失败,各按实情;其余照 stopReason。 */
  private settledOutcome(stopReason: StopReason): TranscriptTurnOutcome {
    if (stopReason === 'cancelled' && this.interruptedForMessage) {
      return { kind: 'cancelled', reason: 'interrupted_for_message' };
    }
    const refused = this.deps.platformCredentials ? refusedTurnOutcome(this.credentialRefusal) : null;
    if (stopReason === 'end_turn' && refused) return refused;
    const stderrFailure = this.turnHadAgentOutput ? null : this.providerStderrFailure;
    const failure = [this.providerTurnFailure, stderrFailure].filter(Boolean).join('\n');
    if (stopReason === 'end_turn' && failure) {
      return {
        kind: 'error',
        reason: 'prompt_failed',
        detail: failure,
        ...(stderrFailure && this.providerTurnSignIn ? { signInRequired: true } : {}),
      };
    }
    return outcomeFromStopReason(stopReason);
  }

  private async sendPromptInternal(
    prompt: QueuedPrompt,
    opts?: {
      steerIfBusy?: boolean;
      fromQueue?: boolean;
      /** 人在别人开的一轮里打字:像「现在插入」一样越过排着的条目(见 queueBehindTurn)。 */
      overtakeQueue?: boolean;
      skipAdmission?: boolean;
      onAdmission?: (result: Result<{ queued: boolean; steered?: boolean }, AcpSendPromptError>) => void;
    },
  ): Promise<Result<SessionPromptResult, AcpSendPromptError>> {
    if (this.closeRequested) return acpErr.sessionBusy('Session is closing; resume it after teardown');
    if (!opts?.fromQueue) {
      prompt = { ...prompt, queueTiming: opts?.steerIfBusy && prompt.origin === 'communication'
        ? 'next-tool-call' : undefined };
    }
    // A delivery cannot be steered into the native summarization request. Retain its
    // original id/bytes in the ordinary durable queue, which drains at command completion.
    if (this.compacting) {
      const held = this.dispatchFor<AcpSendPromptError>(
        { type: 'QueuePrompt', prompt: { ...prompt, origin: prompt.origin ?? 'typed' } }, ['invalid_state'],
      );
      if (!held.success) return held;
      const result = ok({ queued: true });
      opts?.onAdmission?.(result);
      return result;
    }
    if (this.reverting) return acpErr.sessionBusy('Conversation revert is in progress.');
    if (!opts?.fromQueue && prompt.origin === 'communication' && this.machine.phase.kind === 'working'
      && this.canYieldRepliedAssistant(prompt.text)) {
      // QueuePrompt synchronously saves through the manager callback. The new input must
      // remain outside the provider: native cancel withdraws all of its pending inputs.
      const held = this.dispatchFor<AcpSendPromptError>({ type: 'QueuePrompt', prompt }, ['invalid_state']);
      if (!held.success) return held;
      this.yieldingRepliedAssistant = prompt.text;
      this.yieldRepliedAssistantAtToolBoundary();
      const queued = ok({ queued: true });
      opts?.onAdmission?.(queued);
      return queued;
    }
    // Preserve input order; explicit queue steering (and the owner overtaking someone else's turn) may bypass waiting inputs.
    const steerIfBusy = opts?.steerIfBusy === true
      && (opts.fromQueue === true || opts.overtakeQueue === true || this.machine.queuedPrompts.length === 0);
    // Settings and receipt admission release the same next-input barrier.
    if (
      !opts?.skipAdmission
      && !steerIfBusy
      && this.machine.phase.kind === 'ready'
      && (this.settingsInFlight > 0 || this.settingsBlockedReason !== null)
    ) {
      const held = this.dispatchFor<AcpSendPromptError>(
        { type: 'QueuePrompt', prompt },
        ['invalid_state'],
      );
      if (!held.success) return held;
      const queued = ok({ queued: true });
      if (!opts?.skipAdmission) opts?.onAdmission?.(queued);
      return queued;
    }
    const transcriptBeforePrompt = this.transcript.snapshotState();
    const turnContextBeforePrompt = new Map(this.pendingTurnContext);
    const sessionContextBeforePrompt = this.pendingSessionContext;
    const decision = this.dispatchFor<AcpSendPromptError>(
      {
        type: 'Prompt',
        prompt,
        ...(steerIfBusy ? { steerIfBusy: true } : {}),
      },
      ['invalid_state'],
    );
    if (!decision.success) return decision;
    const started = decision.data.some((effect) => effect.type === 'promptStarted');
    if (started) {
      this.workStartedByOwner = isOwnerOrigin(prompt.origin);
      this.queuedTurnFence = opts?.fromQueue === true
        && (prompt.queueTiming !== 'next-tool-call' || prompt.origin !== 'communication' || !!prompt.attachments?.length);
      this.promptSequence += 1;
    }
    // spec session-injection 的 mid-turn 支:同一条标准 session/prompt 立即发进当前 turn。
    // Concurrent requests report one aggregate request-activity boundary at their transport.
    const steered = decision.data.some((effect) => effect.type === 'promptSteered');
    const nativeSteer = steered && this.supportsSteering;
    if (nativeSteer) this.nativeInputAfterStart = true;
    if (steered && !nativeSteer && this.agent.interruptForMessage) {
      const held = this.steerByInterrupt(prompt, opts);
      if (held.success) this.deps.callbacks?.onPromptSteered?.();
      return held;
    }
    if (!started && !steered) {
      const queued = ok({ queued: true });
      if (!opts?.skipAdmission) opts?.onAdmission?.(queued);
      this.scheduleQueuedSteering();
      return queued;
    }
    // #6387 受理结果说清是「开了一轮」还是「插进了在飞的那一轮」—— 投递方要如实告诉扩展。
    // Admission is the native receipt (v2) or the request-activity dispatch acknowledgement (v1).
    let admitted = false;
    const admit = () => {
      if (admitted) return;
      admitted = true;
      if (!opts?.skipAdmission) opts?.onAdmission?.(ok({ queued: false, ...(steered ? { steered: true } : {}) }));
    };
    if (started && !steered) {
      this.dequeueAfterFailure = !opts?.fromQueue;
      this.openTurnCompletion();
      const envelope = this.makeTurnEnvelope();
      this.latestTurnEnvelope = envelope;
      this.rawLog.record({
        kind: 'turn_envelope',
        sessionId: this.acpSessionId,
        envelope,
      });
    }
    const cycle = this.activeTurnCompletion;
    // Queued inputs keep their stable ID; steering uses its own input ID.
    const messageId = opts?.fromQueue
      ? prompt.id
      : steered
        ? `${this.sessionId}-steer-${prompt.id}-user`
        : `${this.sessionId}-${this.promptSequence}-user`;
    // #6387 扩展的「附带」只随**新开的一轮**进去:插进在飞那一轮的消息(可能是别的 agent / 别的扩展的)
    // ❌ 把它带走 —— 附带承诺的是「不打断、下一轮」。同步取走 —— 并发的下一轮不会再带上它。
    const turnContext = started && !steered ? this.takeTurnContext() : null;
    // A communication prompt that hit the provider's transient token boundary can be
    // admitted again from the target queue. Keep one transcript row for that stable prompt id.
    const alreadyRecorded = this.transcript.history
      .concat(this.transcript.activeTurn ? [this.transcript.activeTurn] : [])
      .some((turn) => turn.items.some((item) =>
        item.kind === 'message'
        && item.role === 'user'
        && (item.id === prompt.id || item.id.includes(prompt.id))
      ));
    const submittedMessage: Extract<NormalizedEvent, { kind: 'message' }> = {
        kind: 'message',
        role: 'user',
        messageId,
        text: prompt.text,
        content: [{ type: 'text', text: prompt.text }],
        contentMode: 'replace',
        attachmentsMode: 'replace',
        ...(steered ? { steering: true } : { trigger: promptTrigger(prompt) }),
        ...(prompt.attachments?.length
          ? {
              attachments: prompt.attachments.flatMap((attachment, index) => attachment.type === 'attachment' ? [{
                id: attachment.id,
                name: attachment.name ?? `image-${index + 1}`,
                mimeType: attachment.mimeType,
              }] : []),
            }
          : {}),
      };
    const recordUserMessage = () => {
      if (alreadyRecorded) return;
      this.push(submittedMessage);
    };
    if (!nativeSteer) recordUserMessage();
    // 原生插话要等 agent 受理(`injected`)才算发出:它回 `promptRequired` 时这句还没进去(#7087)。
    // 转录里画成它自己的一行(来自哪个扩展由信封写明),跟在这一句后面、同属这一轮 ——
    // `steering` 让它不另开一轮(一轮只由人/投递的那一句开),请求里它是一个块(见 turnContextBlocks)。
    if (turnContext) {
      this.transcript.pushEvent({
        kind: 'message',
        role: 'user',
        messageId: `${messageId}-context`,
        text: turnContext,
        steering: true,
      });
      this.emitTranscriptChanged();
    }
    const requestId = started ? this.latestTurnEnvelope!.requestId : crypto.randomUUID();
    const request = { messageId, prompt, steered, cycle, submitted: submittedMessage,
      accepted: false, dispatched: false, completion: Promise.withResolvers<PromptResult>() };
    this.requests.set(requestId, request);
    let prepared: NativePromptPreparation | null = null;
    // Pre-admission refusal: no provider update was received, so this was never a turn. Restore only
    // our tentative projection, before any failed turn can reach durable history.
    const refuse = (error: unknown) => {
      this.requests.delete(requestId);
      this.rawLog.record({ kind: 'prompt_result', sessionId: this.acpSessionId, stopReason: null, error: toSerializedError(error) });
      this.deps.logger.warn('SessionCell: provider refused a prompt before admission', { sessionId: this.sessionId });
      this.transcript.restoreState(transcriptBeforePrompt);
      this.pendingTurnContext = new Map([...turnContextBeforePrompt, ...this.pendingTurnContext]);
      if (sessionContextBeforePrompt && this.pendingSessionContext !== sessionContextBeforePrompt) {
        this.pendingSessionContext = [sessionContextBeforePrompt, this.pendingSessionContext].filter(Boolean).join('\n\n');
      }
      if (started) { this.applyEvent({ type: 'PromptRefused' }); this.closeTurnCompletion(); }
      this.emitTranscriptChanged();
    };
    const releasePreparation = () => prepared?.rejected?.().catch(() => {
      this.deps.logger.warn('Resource change reservation release failed', { sessionId: this.sessionId });
    });
    const confirmPreparation = () => void prepared?.accepted().catch(() => {
      this.deps.logger.warn('Native prompt preparation checkpoint will retry', { sessionId: this.sessionId });
    });
    try {
      try {
        const preparing = prepareNativePrompt(this.sessionId);
        prepared = preparing ? await preparing : null;
      } catch (error) {
        if ((error as { deliveryRejectedBeforeAdmission?: unknown } | null)?.deliveryRejectedBeforeAdmission !== true) throw error;
        refuse(error);
        if (opts?.fromQueue) this.retryPreparedQueue(prompt);
        return acpErr.sessionBusy(error instanceof Error ? error.message : '');
      }
      this.preparationRetryDelay = 1500;
      // 按路径带的图(`local-file`:另一台机器发来的附件、首轮随启动队列带的附件)只在 agent
      // **声明收图片**时才变成图片块 —— 那一句正文里本来就有这件附件的路径 mention,不收图的 agent
      // 照样读得到它。发送的这一刻 agent 已经握过手,这里的判据是它自己报的那一份(#6264)。
      // 上传来的附件(`attachment`)不在此列:它们没有路径兜底,宿主发之前已经按同一判据分过路。
      const resolvedAttachments = await Promise.all(
        (prompt.attachments ?? []).map((attachment) => this.deps.resolveAttachment(attachment))
      );
      // Preserve the runtime's copy in both tentative and native-receipt projections.
      // Model image support controls the wire blocks, not whether people can reopen their image.
      if (prompt.attachments?.length) {
        submittedMessage.attachments = prompt.attachments.flatMap((attachment, index) => {
          const ref = resolvedAttachments[index]?.ref;
          return ref ? [ref] : attachment.type === 'attachment' ? [{ id: attachment.id, name: attachment.name ?? `image-${index + 1}`, mimeType: attachment.mimeType }] : [];
        });
        if (!nativeSteer) recordUserMessage();
      }
      // ③ 只在**第一次真正发出去的那一轮**随行,发完即清。放在最前面:它是这场会话的
      // 常驻背景,该在用户这一句之前被读到。
      // ⚠️ 在 await 之后、构造请求之前取并清空 —— 并发的第二轮不会再带上它。
      const sessionContext = this.pendingSessionContext;
      this.pendingSessionContext = null;
      const contextBlocks = sessionContext
        ? [{ type: 'text' as const, text: sessionContext }]
        : [];
      const attachmentBlocks = resolvedAttachments.filter((_, index) =>
        prompt.attachments?.[index]?.type !== 'local-file' || this.acceptsImagePrompts
      ).map((attachment) => ({
        type: 'image' as const,
        data: attachment.data,
        mimeType: attachment.mimeType,
      }));
      const turnContextBlocks = [prepared?.text, prepared?.beforeText, turnContext]
        .filter((text): text is string => !!text).map(text => ({ type: 'text' as const, text }));
      const textBlocks = prompt.text ? [{ type: 'text' as const, text: prompt.text }] : [];
      const trailingBlocks =
        prompt.origin === undefined && prompt.hiddenContext
          ? [{ type: 'text' as const, text: prompt.hiddenContext }]
          : [];
      // behavior `acp 命令必须是第一个块` —— 三家 harness 都只在 prompt 的**开头**找命令:
      // claude 与 codex 只读 `prompt[0]`,opencode 把所有 text 块拼起来再判首字符。所以只要
      // 这一轮前面还坐着别的块(会话级系统提示词、或用户随手带的一张图),同一句 `/review`
      // 就会静默退化成一句普通的话 —— 用户看见命令芯片、agent 收到的却是散文。
      // ⚠️ 判据用 agent **真的报过**的那份名单,不是「以 / 开头」:后者会把
      // `/Users/foo 这个文件…` 也当成命令(opencode 会把它整轮吞掉)。
      // Routed envelopes are not commands; with no command list their leading '<' otherwise reorders the reply hint.
      const leadsWithCommand =
        prompt.origin !== 'communication'
        && prompt.text !== undefined
        && invokesCommand(prompt.text, this.config.availableCommands);
      const promptRequest = {
        sessionId: this.acpSessionId,
        prompt: leadsWithCommand
          ? [...textBlocks, ...contextBlocks, ...turnContextBlocks, ...attachmentBlocks, ...trailingBlocks]
          : [...contextBlocks, ...turnContextBlocks, ...attachmentBlocks, ...textBlocks, ...trailingBlocks],
      };
      const promptMeta = this.deps.historyRecovery?.promptMeta?.(promptRequest.prompt);
      if (promptMeta) {
        // Bind the exact native bytes to our original prompt, without putting any marker on the wire.
        submittedMessage._meta = promptMeta;
        if (!nativeSteer) this.push({ ...submittedMessage, steering: true, trigger: undefined });
      }
      this.rawLog.record({
        kind: 'prompt',
        sessionId: this.acpSessionId,
        content: promptRequest.prompt,
      });
      if (nativeSteer) {
        let outcome: 'injected' | 'promptRequired';
        try {
          outcome = await this.requestSteering(promptRequest, { requestId, message: submittedMessage });
        } catch (error) {
          // C, as for a prompt receipt: an input the provider never took is refused for a missing session,
          // and an internal error retires the executor (lost -> resume). Other failures stay loud below.
          this.requests.delete(requestId);
          if (providerRejectedMissingSession(error)) {
            await releasePreparation();
            refuse(error);
            return acpErr.sessionNotFound(this.sessionId);
          }
          if (toSerializedError(error).code === -32603) {
            await releasePreparation();
            recordUserMessage();
            this.push({ kind: 'prompt_result', requestId, error: toSerializedError(error) });
            await this.deps.callbacks?.onPromptRejected?.();
            return acpErr.promptFailed(toSerializedError(error));
          }
          throw error;
        }
        this.requests.delete(requestId);
        if (outcome === 'promptRequired') {
          // The agent stopped in the race after decide(). Re-enter the normal prompt path exactly
          // once; it is sent now, or waits in the queue until the agent reports it stopped.
          const retried = await this.sendPromptInternal(prompt, {
            fromQueue: opts?.fromQueue,
            onAdmission: opts?.skipAdmission ? undefined : opts?.onAdmission,
          });
          // 「立即发送」的那句仍在排队 ⇒ 排在队首,与 steerQueuedPrompt 没有在干的活时同一个去处。
          if (opts?.fromQueue && retried.success && retried.data.queued) {
            const rest = this.machine.queuedPrompts.filter((candidate) => candidate.id !== prompt.id);
            const reordered = this.reorderQueue([prompt.id, ...rest.map((candidate) => candidate.id)]);
            if (!reordered.success) return reordered;
          }
          return retried;
        }
        recordUserMessage();
        this.pendingNativeSteers.push({ prompt, toolsAtAdmission: this.runningToolIds() });
        // The adapter has the input before a released human tool creates its next boundary.
        this.deps.callbacks?.onPromptSteered?.();
        // A stop can race the admission receipt; it must retain that accepted input too.
        if (this.closeRequested) this.returnPendingNativeSteers();
        confirmPreparation();
        admit();
        // Admission records this input; the primary ACP stream still owns foreground completion.
        return ok({ queued: false });
      }

      const agent = this.agent;
      // B: a communication prompt must not block the inbox on a native receipt that never comes. The
      // transport cancels it and fails it as prompt_admission_timeout; the procedure owner then stops
      // the session (procedures.promptDetached). v1 has no native receipt, so no deadline, as on dev.
      const watched = started && prompt.origin === 'communication' && opts?.onAdmission !== undefined;
      const receiptOrTimeout = agent.prompt(promptRequest, { requestId, message: submittedMessage,
        ...(watched ? { admissionTimeoutMs: PROMPT_ADMISSION_TIMEOUT_MS } : {}) });
      if (steered) this.deps.callbacks?.onPromptSteered?.();
      // Prepared context is consumed by the model only when its turn completes; a failure, or a cancelled turn
      // that ends without acting on what it carried (#881), releases it for the next turn.
      if (!steered) void request.completion.promise.then(result => result.success
        && this.transcript.entityOwner({ ...submittedMessage, messageId: request.messageId })?.outcome?.kind !== 'cancelled'
        ? confirmPreparation() : releasePreparation());
      const receipt = receiptOrTimeout.then(receipt => {
        if (this._agent !== agent || this.machine.phase.kind === 'closed' || this.machine.phase.kind === 'lost') return ok({ queued: false });
        if (steered) confirmPreparation();
        admit();
        if (receipt.status === 'accepted') {
          acceptPromptMessage(request, receipt.messageId, this.transcript, event => this.push(event), this.deps.providerId);
          this.applyReceiptMetadata(requestId, receipt._meta);
          settleAcceptedRequests(this.requests, this.transcript);
          const owner = this.transcript.entityOwner({ ...submittedMessage, messageId: receipt.messageId });
          if (!opts?.fromQueue || owner?.outcome?.kind !== 'error') this.releaseDispatch();
        } else {
          // Request-activity transports identify their aggregate cycle on dispatch acknowledgement.
          request.dispatched = true;
          void (cycle ?? Promise.resolve(ok({ queued: false }))).then(result => {
            request.completion.resolve(result);
            this.requests.delete(requestId);
            if (result.success && !result.data.queued) this.releaseDispatch();
          });
        }
        return ok({ queued: false });
      }).catch(async (error: unknown) => {
        if (this._agent !== agent) return acpErr.promptFailed(toSerializedError(error));
        if (steered) await releasePreparation();
        // Only a rejection before any provider work is a refusal; after it, the cycle owns the failure.
        const beforeWork = this.machine.phase.kind !== 'working' && this.machine.phase.kind !== 'cancelling';
        // A rejected receipt was never admitted: a missing session is a refusal even while v1 request activity runs.
        if (providerRejectedMissingSession(error)) {
          refuse(error);
          const missing = acpErr.sessionNotFound(this.sessionId);
          request.completion.resolve(missing);
          return missing;
        }
        // C: a JSON-RPC internal error before the receipt is an executor failure. Settle its actual
        // failure without draining the queue, then retire the executor through lost -> resume.
        const retire = beforeWork && toSerializedError(error).code === -32603;
        if (retire) this.dequeueAfterFailure = false;
        this.push({ kind: 'prompt_result', requestId, error: toSerializedError(error) });
        if (retire) await this.deps.callbacks?.onPromptRejected?.();
        return acpErr.promptFailed(toSerializedError(error));
      });
      return steered ? receipt : request.completion.promise;
    } catch (error) {
      await releasePreparation();
      recordUserMessage();
      this.push({ kind: 'prompt_result', requestId, error: toSerializedError(error) });
      return acpErr.promptFailed(toSerializedError(error));
    }
  }

  /**
   * #566 A personal assistant that already sent its reply may yield its trailing turn to the owner's
   * next message — only at a tool boundary with nothing else of the turn still in flight.
   */
  private canYieldRepliedAssistant(text: string): boolean {
    const ownerId = this.deps.assistantOwnerId;
    return ownerId !== undefined && !this.nativeInputAfterStart
      && this.runningToolIds().size === 0 && this.lastRunningAgentCount === 0
      && this.lastRunningCommandTaskIds.length === 0 && this.machine.pendingPermissions.length === 0
      && canYieldRepliedAssistant(this.transcript.activeTurn, text, ownerId);
  }

  private yieldRepliedAssistantAtToolBoundary(): void {
    const text = this.yieldingRepliedAssistant;
    if (!text) return;
    this.yieldingRepliedAssistant = null;
    // A new tool can arrive while QueuePrompt synchronously saves. Abandon yielding,
    // retaining the normal queue; never wait for that tool and then cancel its work.
    if (this.deps.queuedPromptsPersisted?.() !== true || !this.canYieldRepliedAssistant(text)) return;
    // 用户已经自己点了停止(phase 已是 cancelling)⇒ 这一轮是用户停的,❌ 改标成「为插话停下」。
    if (this.machine.phase.kind !== 'working') return;
    this.interruptedForMessage = true;
    void this.cancel().then((result) => {
      if (!result.success) {
        this.deps.logger.warn('SessionCell: interrupt for mid-turn message failed', {
          sessionId: this.sessionId,
          error: result.error,
        });
      }
    });
  }

  /** A refused preparation leaves the queued input in place and retries it with backoff. */
  private retryPreparedQueue(prompt: QueuedPrompt): void {
    this.dispatch({ type: 'QueuePrompt', prompt });
    if (this.preparationRetryTimer) clearTimeout(this.preparationRetryTimer);
    this.preparationRetryTimer = setTimeout(() => {
      this.preparationRetryTimer = undefined;
      if (!this.closeRequested && this.machine.phase.kind === 'ready'
        && this.machine.queuedPrompts.some(row => row.id === prompt.id)) {
        this.releaseQueueAfterEdit();
      }
    }, this.preparationRetryDelay);
    this.preparationRetryDelay = Math.min(this.preparationRetryDelay * 2, 30_000);
  }

  /** Tools of the active turn the provider has not finished; the transcript is their record. */
  private runningToolIds(): Set<string> {
    const turn = this.transcript.activeTurn;
    if (!turn) return new Set();
    return new Set(replyItems(turn).flatMap(item => 'toolCallId' in item && item.status === 'running' ? [item.toolCallId] : []));
  }

  private scheduleQueuedSteering(): void {
    if (this.queuedSteeringScheduled || this.queuedSteeringInFlight || this.replayingHistory) return;
    this.queuedSteeringScheduled = true;
    queueMicrotask(() => {
      this.queuedSteeringScheduled = false;
      void this.steerWaitingQueueHead();
    });
  }

  /** Advance only an explicitly steerable queue prefix. Retain each input until its real receipt. */
  private async steerWaitingQueueHead(): Promise<void> {
    if (this.queuedSteeringInFlight) return;
    this.queuedSteeringInFlight = true;
    try {
      while (!this.closeRequested && !this.replayingHistory && !this.compacting && !this.reverting
        && !this.queuedTurnFence
        && this.machine.phase.kind === 'working' && this.settingsInFlight === 0
        && this.settingsBlockedReason === null && this.machine.pendingPermissions.length === 0) {
        const [head] = this.machine.queuedPrompts;
        if (!head || head === this.blockedQueuedSteer || head.queueTiming !== 'next-tool-call'
          || head.origin !== 'communication' || head.attachments?.length || head.queueEdit || head.queueDispatching) return;
        // Interrupt-only transports already own the next-tool boundary; retain the queue for WorkEnded.
        if (!this.supportsSteering && this.agent.interruptForMessage) {
          if (this.interruptedQueuedHead === head.id) return;
          this.interruptedQueuedHead = head.id;
          await this.agent.interruptForMessage({ sessionId: this.acpSessionId });
          return;
        }
        const reserved = this.dispatchFor<InvalidStateError>({ type: 'ReserveQueuedPrompt', id: head.id }, ['invalid_state']);
        if (!reserved.success) return;
        const admissionGeneration = this.nativeAdmissionGeneration;
        const admission = Promise.withResolvers<Result<{ queued: boolean }, AcpSendPromptError>>();
        const sending = this.sendPromptInternal(head, {
          fromQueue: true, steerIfBusy: true, onAdmission: result => admission.resolve(result),
        });
        void sending.then(result => admission.resolve(result), error => admission.resolve(acpErr.promptFailed(toSerializedError(error))));
        const result = await admission.promise;
        const phaseAfterAdmission = this.sessionState.lifecycle;
        // injected proves admission, not consumption. A receipt from a withdrawn generation
        // cannot remove this input's replay copy, regardless of the cell's current phase.
        const accepted = result.success && !result.data.queued && !this.closeRequested
          && admissionGeneration === this.nativeAdmissionGeneration;
        this.dispatch({ type: 'ReleaseQueuedPrompt', id: head.id, accepted });
        if (!result.success) {
          this.blockedQueuedSteer = this.machine.queuedPrompts.find(prompt => prompt.id === head.id) ?? null;
          this.deps.logger.error('SessionCell: queued steering refused; input retained', {
            sessionId: this.sessionId, promptId: head.id, error: result.error,
          });
          return;
        }
        if (!accepted) return;
        // A normal promptRequired race may have opened a new foreground cycle.
        if (phaseAfterAdmission === 'ready') this.releaseQueueAfterEdit();
      }
    } catch (error) {
      this.deps.logger.error('SessionCell: queued steering failed; input retained', {
        sessionId: this.sessionId, error: toSerializedError(error),
      });
    } finally {
      this.queuedSteeringInFlight = false;
    }
  }

  private requestSteering(
    promptRequest: Parameters<NonNullable<SessionCellDeps['agent']>['prompt']>[0],
    dispatch: Parameters<NonNullable<SessionCellDeps['agent']>['prompt']>[1],
  ): Promise<'injected' | 'promptRequired'> {
    if (!this.agent.steer) throw new Error('ACP initialize negotiated steering, but its transport has no steering control');
    return this.agent.steer(promptRequest, dispatch);
  }

  private seedTranscriptMeta(meta?: {
    modes?: SessionModeState | null;
    configOptions?: readonly SessionConfigOption[] | null;
    availableCommands?: Extract<NormalizedEvent, { kind: 'commands' }>['commands'];
  }): void {
    if (!meta) return;
    if (meta.availableCommands !== undefined) this.push({ kind: 'commands', commands: meta.availableCommands });
    if (meta.configOptions !== undefined) {
      this.transcript.pushEvent({
        kind: 'config',
        options: meta.configOptions ?? [],
      });
    }
    // 稳定版 `modes` 是 unstable `configOptions` 之外的**另一条**档位来源(gemini 只报这条)。
    // reducer 的让位规则保证 config 组(带真 configId)在场时本事件是 no-op,顺序因此不敏感。
    if (this.deps.sessionModes !== 'none' && meta.modes?.availableModes?.length) {
      this.transcript.pushEvent({
        kind: 'modes_state',
        currentModeId: meta.modes.currentModeId ?? null,
        availableModes: meta.modes.availableModes,
      });
    }
    if (this.deps.sessionModes !== 'none' && meta.modes?.currentModeId) {
      this.transcript.pushEvent({
        kind: 'mode_selected',
        modeId: meta.modes.currentModeId,
      });
    }
    if (meta.configOptions !== undefined || meta.modes?.currentModeId || meta.modes?.availableModes?.length) {
      this.emitTranscriptChanged();
    }
  }

  private seedSyntheticConfigSelection(
    dimension: LiveSettingDimension,
    configId: string | null,
    selected: string,
  ): void {
    if (!configId) return;
    const group = dimension === 'model'
      ? this.transcript.config.modelOptions
      : dimension === 'effort'
        ? this.transcript.config.efforts
        : this.transcript.config.modeOptions;
    if (!group) return;
    const category = dimension === 'model' ? 'model' : dimension === 'effort' ? 'thought_level' : 'mode';
    const options = group.available.map((option) => ({ value: option.id, name: option.name }));
    this.seedTranscriptMeta({
      configOptions: [{
        id: configId,
        name: dimension,
        category,
        type: 'select',
        currentValue: selected,
        options,
      } as unknown as SessionConfigOption],
    });
  }

  private dispatchAgentsChangedIfNeeded(previousRunningAgentCount: number): void {
    this.dispatchBackgroundCommandsChangedIfNeeded();
    const nextRunningAgentCount = this.transcript.agents.filter(
      (agent) => outlivesTurn(agent) && agent.status === 'running'
    ).length;
    if (nextRunningAgentCount === previousRunningAgentCount) return;
    this.lastRunningAgentCount = nextRunningAgentCount;
    this.applyEvent({ type: 'AgentsChanged', runningCount: nextRunningAgentCount, dequeueQueuedPrompt: !this.context().dispatchPending });
  }

  /**
   * 后台命令不挂住回合;每次转录变动后重算,供状态说出 park,也交给面板花名册按任务 id 筛(#6582):
   * 只有本进程看着起、还没等到终态的才在这里,上一个进程的(重放里、库里)都不在。
   */
  private dispatchBackgroundCommandsChangedIfNeeded(): void {
    const next = runningBackgroundCommands(this.transcript.history, this.transcript.activeTurn)
      .map((command) => command.backgroundTaskId);
    const previous = this.lastRunningCommandTaskIds;
    if (next.length === previous.length && next.every((id, index) => id === previous[index])) return;
    this.lastRunningCommandTaskIds = next;
    this.applyEvent({ type: 'BackgroundCommandsChanged', taskIds: next });
  }

  private settleRunningAgents(scope: 'turn' | 'all', status: 'completed' | 'failed'): void {
    // 一轮结束只替「活在这一轮里」的子智能体收尾,能比这一轮活得久的由它自己报结局(见 `outlivesTurn`)。
    const runningAgents = this.transcript.agents.filter((agent) => {
      if (agent.status !== 'running') return false;
      return scope === 'all' || !outlivesTurn(agent);
    });

    for (const agent of runningAgents) {
      this.push({
        kind: 'subagent_update',
        agentId: agent.agentId,
        toolCallId: agent.toolCallId,
        status,
      });
    }
  }

  private clearDraft(): void {
    this.draftRev += 1;
    if (this.draft === null) return;
    this.draft = null;
    this.deps.callbacks?.onDraftChanged?.();
  }

  /**
   * 维护 `liveSubagentSessions`(#5117)。
   *
   * ⚠️ 只认**带会话号**的那些:没谈成 `clientCapabilities.subagents` 时,子智能体没有独立
   * 会话,`subagentSessionId` 缺席 ⇒ 这张表是空的,停止一律落回后台任务那支 —— 也就是
   * 谈成之前的老行为,❌ 别在缺席时编一个会话号去走 cancel,那会取消掉**主会话这一轮**。
   */
  private trackSubagentSession(event: NormalizedEvent): void {
    if (event.kind === 'subagent' && event.subagentSessionId) {
      this.liveSubagentSessions.set(event.subagentSessionId, event.subagentSessionId);
      this.liveSubagentSessions.set(event.toolCallId, event.subagentSessionId);
      if (event.canCancel === true) this.cancellableSubagents.add(event.subagentSessionId);
      return;
    }
    if (event.kind === 'subagent_update' && event.subagentSessionId) {
      this.liveSubagentSessions.set(event.toolCallId ?? event.subagentSessionId, event.subagentSessionId);
      if (event.canCancel === true) this.cancellableSubagents.add(event.subagentSessionId);
      else this.cancellableSubagents.delete(event.subagentSessionId);
      return;
    }
    // Agent 那次调用的事件(`agentId` = 会话号,见 reducer `canonicalizeSubagentIdentity`):
    // 它的 toolCallId 是同一个子智能体的别名,界面上可能拿它来指认。
    if (event.kind === 'subagent' && event.agentId) {
      const subagentSessionId = this.liveSubagentSessions.get(event.agentId);
      if (subagentSessionId) this.liveSubagentSessions.set(event.toolCallId, subagentSessionId);
      return;
    }
    if (event.kind === 'subagent_done') {
      this.cancellableSubagents.delete(event.subagentSessionId ?? event.toolCallId);
      // 跑完/被停/失联都从表里撤:再对它调 cancel 只会打到一个已经不在的会话。
      if (event.subagentSessionId) this.liveSubagentSessions.delete(event.subagentSessionId);
      this.liveSubagentSessions.delete(event.toolCallId);
    }
  }

  /**
   * 不自报状态的家:prompt 已答复之后到的 agent 内容是**刚落定那一段的尾巴**(#6191)。
   *
   * 这家没有任何事实能说「它又开工了 / 又停了」—— 在这里置忙,就没有事件能把它放下:会话永远 busy、
   * 停止键常亮、追问全排队(copilot 取消后补来一句「Info: Operation cancelled by user」即此)。
   * ⇒ 这里只记录、归到上一段,❌ 不碰 busy。自报状态的家开工会先报 running,走不到这里。
   */
  private pushTurnTail(event: NormalizedEvent): void {
    this.deps.logger.warn('SessionCell: agent content after its prompt was answered; folded into that turn', {
      sessionId: this.sessionId,
      kind: event.kind,
    });
    const previousRunningAgentCount = this.lastRunningAgentCount;
    this.transcript.pushTail(event);
    this.dispatchAgentsChangedIfNeeded(previousRunningAgentCount);
    this.emitTranscriptChanged();
  }

  private context(): SessionMachineContext {
    return {
      // Acceptance only admits an input. Before the provider reports running the machine is still
      // ready, but that foreground cycle owns the lane until its real completion (including a
      // command that goes straight to idle). A receipt must not drain ordinary queued inputs.
      dispatchPending: this.activeTurnCompletion !== null
        || [...this.requests.values()].some(request => !request.steered && !request.accepted && !request.dispatched),
      modeIds: this.transcript.config.modeOptions?.available.map((mode) => mode.id) ?? [],
      configOptionIds: [
        ...(['model', 'effort'] as const)
          .map((dimension) => this.configIdForDimension(dimension))
          .filter((configId): configId is string => configId !== null),
      ],
    };
  }

  /**
   * 这条会话**有没有**一个可写的 config option 承载这一维 —— 与 `setConfigOption` 发请求用的是同一个取值,
   * 所以「能不能断言」与「断言发到哪」不会分叉(copilot 不报 `model`、却声明了 `configId`,#6196)。
   */
  hasConfigTarget(dimension: ConfigDimension): boolean {
    return this.configIdForDimension(dimension) !== null;
  }

  /**
   * 活会话自报的那一组优先;provider 收却不报的那一维(`LiveSettingCapability.configId`)用声明补上 ——
   * 两处取值共用这一个函数,状态机的「这个 configId 认不认得」与真正发出去的那个 id 因此不会分叉。
   */
  private configIdForDimension(dimension: ConfigDimension): string | null {
    const advertised = dimension === 'model'
      ? this.transcript.config.modelOptions?.configId
      : this.transcript.config.efforts?.configId;
    return advertised ?? this.liveSettings?.[dimension]?.configId ?? null;
  }

  private isTranscriptEvent(event: NormalizedEvent): boolean {
    switch (event.kind) {
      case 'message':
      case 'thinking':
      case 'tool_call':
      case 'tool_update':
      case 'subagent':
      case 'search':
      case 'mcp_tool':
      case 'web_fetch':
      case 'plan':
        return true;
      default:
        return false;
    }
  }

  private isIdleAgentTranscriptEvent(event: NormalizedEvent): boolean {
    return (
      this.machine.phase.kind === 'ready' &&
      this.isTranscriptEvent(event) &&
      !(event.kind === 'message' && event.role === 'user')
    );
  }

  private canAcceptTranscriptEvent(): boolean {
    return (
      this.machine.phase.kind === 'working' ||
      this.machine.phase.kind === 'replaying' ||
      this.machine.phase.kind === 'ready'
    );
  }

  /**
   * 流里那一行缺、请求里有的 rawInput / 正文 / 供应商工具名补进那一行(#7139):有的家只在审批请求里带计划
   * (qwen 的 rawInput.plan、qoder 的正文),流里那一行是空的。已有的不覆盖;走 push,同流里的更新一条路,重开也在。
   * 请求先到时这一行还没有,等它进 push 时照待批的那条请求再补(见 push 末尾)。
   */
  private fillToolCall(source: FillSource | null): void {
    const activeTurn = this.transcript.activeTurn;
    if (!source || !activeTurn) return;
    const existing = findToolCall(activeTurn.items, makeToolId(activeTurn.id, source.toolCallId), source.toolCallId);
    if (!existing) return;
    const patch = {
      ...(isEmptyPayload(existing.rawInput) && source.rawInput !== undefined && { rawInput: source.rawInput }),
      ...(!existing.outputText && source.outputText !== undefined && { outputText: source.outputText }),
      ...(!existing.contentBlocks?.length && !existing.outputText && !existing.images?.length && source.contentBlocks?.length && { contentBlocks: source.contentBlocks }),
      ...(existing.toolName === undefined && source.toolName !== undefined && { toolName: source.toolName }),
    };
    if (Object.keys(patch).length === 0) return;
    const { toolCallId } = source;
    this.push({ kind: 'tool_update', toolCallId, ...patch });
  }

  private buildPermissionToolCall(
    requestId: string,
    fromRequest: ToolUpdateEvent
  ): ToolCallItem {
    const activeTurn = this.transcript.activeTurn;
    const toolCallId = fromRequest.toolCallId ?? requestId;
    if (activeTurn) {
      const id = makeToolId(activeTurn.id, toolCallId);
      const existing = findToolCall(activeTurn.items, id, toolCallId);
      if (existing) return structuredClone(existing);
    }

    return createToolCallItem({
      id: activeTurn ? makeToolId(activeTurn.id, toolCallId) : `permission:${toolCallId}`,
      seq: 0,
      toolCallId,
      title: fromRequest.title ?? 'Permission request',
      ...(fromRequest?.toolName != null ? { toolName: fromRequest.toolName } : {}),
      ...(fromRequest?.outputText != null ? { outputText: fromRequest.outputText } : {}),
      ...(fromRequest?.contentBlocks != null ? { contentBlocks: fromRequest.contentBlocks } : {}),
      toolKind: fromRequest.toolKind ?? null,
      status: 'pending',
      parentToolCallId: undefined,
      // A request naming no call the turn has (a Codex MCP approval) brings what it wants to do as its own rawInput.
      rawInput: fromRequest.rawInput ?? undefined,
      locations: fromRequest.locations ?? [],
    });
  }

  private emitTranscriptChanged(): void {
    this.deps.callbacks?.onTranscriptChanged?.();
  }
}

function isUnsupportedSessionClose(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown };
  if (candidate.code === -32601) return true;
  const message = typeof candidate.message === 'string' ? candidate.message : String(error);
  return /method not found/i.test(message) && /session\/close/.test(message);
}

function isInvalidToken(error: { message?: string; cause?: { message?: string } }): boolean {
  return /\binvalid token\b/i.test(`${error.message ?? ''} ${error.cause?.message ?? ''}`);
}

type ToolUpdateEvent = Extract<NormalizedEvent, { kind: 'tool_update' }>;
/** 补流里那一行的来源:请求解码出的那条更新，或待批请求里的那一行。 */
type FillSource = Pick<ToolCallItem, 'toolCallId' | 'rawInput' | 'outputText' | 'toolName'> & { contentBlocks?: ToolUpdateEvent['contentBlocks'] };

/** 流里那一行的 rawInput 没有内容:缺席、空串,或空对象(qwen 的准备帧就是 `{}`)。 */
function isEmptyPayload(value: string | undefined): boolean {
  const text = value?.trim() ?? '';
  return text === '' || text === '{}';
}

function findToolCall(
  items: Array<ToolNode | { kind: string; id: string }>,
  id: string,
  toolCallId: string
): ToolCallItem | undefined {
  for (const item of items) {
    if (item.kind.endsWith('-tool-call') && 'toolCallId' in item) {
      if (item.id === id || item.toolCallId === toolCallId) return item as ToolCallItem;
      const found = findToolCall((item as ToolCallItem).children ?? [], id, toolCallId);
      if (found) return found;
    } else if (item.kind === 'tool-group' && 'children' in item) {
      const found = findToolCall(item.children as ToolNode[], id, toolCallId);
      if (found) return found;
    }
  }
  return undefined;
}

function machineOutcome(
  outcome: TranscriptTurnOutcome
): { kind: 'stopped'; stopReason: StopReason } | { kind: 'errored' } {
  if (outcome.kind === 'error') return { kind: 'errored' };
  if (outcome.kind === 'cancelled') return { kind: 'stopped', stopReason: 'cancelled' };
  return { kind: 'stopped', stopReason: toStopReason(outcome.reason) };
}

/** dev 已有的接纳看门狗:communication 的原生 receipt 这么久不来 ⇒ 传输层 cancel,以 prompt_admission_timeout 失败。 */
const PROMPT_ADMISSION_TIMEOUT_MS = 60_000;

/** 「一个字都没回就正常结束」时,等 stderr 那行失败说明的最长时间。 */
const STDERR_FAILURE_GRACE_MS = 300;

/**
 * 「主人亲手发的」只有一种:会话页输入框打的(`manual`)。插不插队、这一轮算不算主人开的、`trigger` 记不记 owner
 * 三处都只认这一个判断。`typed` / 缺省是别处原样送进来的正文(开场委派、会话直发),不是主人打的字。
 */
function isOwnerOrigin(origin: QueuedPrompt['origin']): boolean {
  return origin === 'manual';
}

/**
 * 一句 prompt 开的一轮是被什么起的(`TranscriptTurn.trigger`)。主人亲手发的(`isOwnerOrigin`)= owner;
 * 投递按信封认:`route="scheduled"` = 到点的定时任务,其余 = delivery,带上信封里的 `chat=`(几条并成一轮时是多个)。
 * `typed` / 缺省(不带信封、原样送进来的正文)也算 delivery,没有 chatIds。
 * 只读信封头这一层属性,❌ 解析正文;信封的唯一属主在 core,这里不另造第二份格式。
 */
function promptTrigger(prompt: { origin?: QueuedPrompt['origin']; text: string }): TranscriptTurnTrigger {
  if (isOwnerOrigin(prompt.origin)) return { kind: 'owner' };
  if (prompt.origin !== 'communication') return { kind: 'delivery' };
  const heads = prompt.text.match(/<gugu_delivery\s[^>]*>/g) ?? [];
  if (heads.length > 0 && heads.every((head) => /\sroute="scheduled"/.test(head))) return { kind: 'schedule' };
  const chatIds = [...new Set(heads.flatMap((head) => {
    const chat = /\schat="([^"]+)"/.exec(head)?.[1];
    return chat ? [chat] : [];
  }))];
  return { kind: 'delivery', ...(chatIds.length ? { chatIds } : {}) };
}

/** 咕咕自己写进会话级背景的块都以这几个标签开头(平台块 / 身份块 / 用户规则)。 */
const SESSION_CONTEXT_BLOCK = /^\s*<(gugu_platform|agent_identity|user_rules)\b/;

function isReplayedSessionContext(event: NormalizedEvent): boolean {
  return event.kind === 'message' && event.role === 'user' && SESSION_CONTEXT_BLOCK.test(event.text);
}

function outcomeFromStopReason(stopReason: StopReason): TranscriptTurnOutcome {
  if (stopReason === 'cancelled') return { kind: 'cancelled', reason: stopReason };
  return { kind: 'done', reason: stopReason };
}

function toStopReason(reason: TranscriptTurnOutcome['reason']): StopReason {
  switch (reason) {
    case 'interrupted_for_message':
      return 'cancelled';
    case 'cancelled':
    case 'end_turn':
    case 'max_tokens':
    case 'max_turn_requests':
    case 'refusal':
      return reason;
    default:
      return 'end_turn';
  }
}

export { SESSION_PLAN_ID };

/**
 * 这个子智能体能不能比派它的那一轮活得久:后台的,和有自己会话的(结局由它自己的 `subagent_update` /
 * `subagent_state_update` 报 —— ACP v2 的父回合在自己的结果处就结束,子智能体照跑)。
 * 一轮结束不替它们收尾,它们在跑时会话是 park。
 */
function outlivesTurn(agent: { background?: boolean; subagentSessionId?: string }): boolean {
  return agent.background === true || agent.subagentSessionId !== undefined;
}
