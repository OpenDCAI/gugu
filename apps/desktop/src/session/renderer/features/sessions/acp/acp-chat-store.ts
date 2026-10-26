import type {
  ChatContext,
  ChatAttachment,
  ChatState,
  ChatView,
  PendingPrompt,
  TranscriptTurn,
} from '@gugu/session-chat-ui';
import { connectSession, createChatState, pinTopMode, runningBackgroundTaskIds } from '@gugu/session-chat-ui';
import {
  attachmentRefSchema,
  type AttachmentMimeType,
  type AttachmentRef,
  type HistoryCursor,
  type GuguPermissionMode,
  isDestructivePermissionMode,
  resolveSessionPermissionMode,
  type PromptAttachment,
  type PromptDraft,
  type PromptInput,
  type QueuedPrompt,
  type QueuedPromptEdit,
  toolCallLabel,
} from '@gugu/session-core/acp/client';
import type {
  CommandItem,
  ComposerEffortOption,
  ComposerModelOption,
  ComposerPermissionModeOption,
  ComposerNotice,
  ComposerQueuedPrompt,
} from '@gugu/session-ui/react/components';
import { commandToken } from '@gugu/session-core/acp/commands';
import { permissionWaitKind } from '@gugu/session-core/acp/models/permissions';
import type { LiveSettingResult, PermissionWaitKind } from '@gugu/session-core/acp';
import { errorDetail } from '@gugu/session-shared';
import type { BlobSource } from '@gugu/session-wire';
import { action, computed, makeObservable, observable, runInAction, toJS } from 'mobx';
// TODO(conversations-extraction): Inject task/workspace lookups instead of importing task stores.
import { asProvisioned, getSessionPageStore } from '@renderer/features/sessions/stores/session-selectors';
import { workspaceRegistry } from '@renderer/features/sessions/stores/workspace-registry';
import { AcpLiveSession, asValueSource } from '@renderer/lib/acp/acp-live-session';
import { getAcpRuntimeClient } from '@renderer/lib/acp/runtime-client';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { getAgentConfigRuntimeClient } from '@renderer/lib/agent-config/runtime-client';
import {
  registerSessionCommands,
  unregisterSessionCommands,
} from '@renderer/lib/chat/advertised-command-provider';
import { getSharedChatContext } from '@renderer/lib/chat/shared-chat-context';
import { composeHistoryTurns, sideChatOwnTurns } from './history-composition';
import { toast } from '@renderer/lib/hooks/use-toast';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import type { SessionMessageKey } from '@renderer/localization/messages';
import { failureText } from '../gugu-reason';
import { rpc } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import { sessionHasPriorContext } from '@shared/core/sessions/prior-context';
import { sessionRegistry } from '../stores/session-registry';
import { type AcpLoadError, isTerminalLoadError, resultError, toLoadError } from './acp-load-error';
import { bindSessionTerminalOutputs } from './acp-terminal-output-binding';
import { recordedContextUsage } from './recorded-context-usage';
import { notifyCommittedTurn } from '@renderer/lib/session-output-observers';

/** 宿主那边还没起完(或没起)的生命周期:停着的会话等它离开这几格再重挂。 */
const HOST_NOT_SETTLED: ReadonlySet<string> = new Set(['closed', 'starting', 'replaying']);

/**
 * 一次实时设置改动**留给调用方**的那一件事。
 *
 * `null` = 没有后续动作(已经用 toast 说完了,或者要等下一轮确认)。
 * `applied` = 活会话**确认**生效了 —— 调用方据此让会话记录跟上(#6182:不报当前模型的 harness,
 *   触发器只能读记录;不跟上就是「账本已是新模型、界面仍是旧的」)。
 * `restart-required` = 这一维只能重开会话才换得成 ⇒ 调用方必须把那个**已有的**重启动作摆出来。
 * ⚠️ 它是一个**产品状态**,不是一句错误文案 —— 这正是 #5556 的病根:曾经它只是一句
 *    点不到任何东西的错误提示。
 */
export type LiveSettingOutcome =
  | { kind: 'applied'; effectiveValue: string }
  | { kind: 'restart-required'; requestedValue: string }
  | null;

export interface AgentAffordances {
  isWorking: boolean;
  isBusy: boolean;
  hasPendingPermission: boolean;
  canSubmit: boolean;
  canCancel: boolean;
}

type StoredPromptAttachment = Extract<PromptAttachment, { type: 'attachment' }>;

export type AcpPromptAttachment = {
  ref: StoredPromptAttachment;
  previewUrl?: string;
};

/** 弹窗标题:没做成的那件事(`acpFailure.*`,双语)。 */
type AcpFailureTitle = Extract<SessionMessageKey, `acpFailure.${string}`>;

type PermissionQueueItem = {
  requestId: string;
  toolCallId: string;
  title: string;
  options: Array<{ optionId: string; name: string; kind: string }>;
  waitKind: PermissionWaitKind;
};

export function isVisibleQueuedPrompt(
  prompt: QueuedPrompt,
): prompt is QueuedPrompt & { origin: 'manual' | 'typed' } {
  if (!prompt.origin) {
    throw new Error(`Queued prompt ${prompt.id} has no explicit origin`);
  }
  return prompt.origin !== 'communication';
}

export type { AcpLoadError } from './acp-load-error';

export class AcpChatStore {
  readonly chatContext: ChatContext;
  readonly chatState: ChatState;

  session: AcpLiveSession | null = null;
  historyLoading = true;
  loadError: AcpLoadError | null = null;
  /**
   * #6552 在飞的开场(`_runBootstrap`)数。>0 且还没挂上会话 = 引擎会话在起:这段里模型 / 强度照样能选 ——
   * 选择交给运行时,由启动在 `session/new` 之后设模型/强度那一步采用。计数而不是布尔:重挂 / 重试会在
   * 上一次开场落定前再开一次(见 `reattachAfterHostReload`),先落定的那次不能把「在起」清掉。
   */
  private _bootstrapsInFlight = 0;
  /** #6552 这段里用户选的模型 / 强度(已交给运行时)。会话挂上之后以活会话报的为准,这份清空。 */
  startupChoice: { model?: string; effort?: string } = {};
  messageCount = 0;
  draftText = '';
  queuedEditDraft: { id: string; text: string } | null = null;
  queueEditPending = false;
  private _queueEditTimer: ReturnType<typeof setTimeout> | null = null;
  reverting = false;
  messageEdit: { itemId: string; text: string } | null = null;
  private _preserveComposerDraft = false;
  /**
   * 运行时最近一次报的「本进程里还在跑」的后台任务 id(#6582);`null` = 对面没报这一格(旧运行时)。
   * 只由挂着的活会话的 sessionState 写 —— 读它走 `runningBackgroundTaskIds`。
   */
  private _runtimeBackgroundTaskIds: readonly string[] | null = [];

  private _view: ChatView | null = null;
  private _bootstrapped = false;
  /** 转录已放掉(`releaseTranscript`),下一次上屏时重读。 */
  private _transcriptReleased = false;
  /**
   * #6497 宿主把这条会话停掉了(见 `_onSessionClosedByHost`),下一次发消息要把它重新起来。
   * 只在「停了之后还没重挂」这一段为真;任何一次重新开场(`_runBootstrap`)都把它清掉。
   */
  private _closedByHost = false;
  private _disposed = false;
  private _visualEvidenceOverride = false;
  private _unsubs: Array<() => void> = [];
  private _draftRev = 0;
  private _pendingDraftRev: number | null = null;
  pendingPermissionMode: {
    modeId: string;
    turnId: string;
    requestId: number;
  } | null = null;
  private _permissionModeRequestId = 0;
  private _draftTimer: number | null = null;
  private _lastQueuedPrompts: QueuedPrompt[] = [];
  /**
   * 会话还没连上时排进去的那几句(behavior session-page「打开速度」:发出就要看得见)。运行时排队只回
   * 「排上了没有」、不回它在队列里的编号 ⇒ 这一侧改不了、删不了它们:排队条里先锁着显示,会话一连上就换成
   * 运行时那份真队列。
   */
  private _startupQueued: Array<{ id: string; text: string; origin: 'manual' | 'typed' }> = [];
  /** 会话还没连上时上屏的那几句乐观行(第一条消息、连上之前发的那句):连上那一刻由真的那一轮或队列接手。 */
  private _startupPendingIds = new Set<string>();
  /**
   * 会话还没连上时正在「处理中」的那一句。这段算运行中 ⇒ 输入框是停止键(behavior session-page「打开速度」)。
   * ⚠️ 乐观行本身在 Solid 那一侧,MobX 看不见它的变化 ⇒ 这一格单独记,`affordances` 读它。
   */
  private _startupRunningId: string | null = null;
  /** 新建会话带着的第一条消息的乐观行 id:停下时它留在对话里(会话记录里存着,接着跑会再发),别的撤回输入框。 */
  private _firstPromptId: string | null = null;
  /**
   * 上一次没跑起来、留在屏上的那一句(第一条,或老会话里发的、运行时已经收下的那句)。它还存着:
   * 下次接着跑时运行时会先发它 ⇒ 那时这一句换回「处理中」。
   */
  private _heldStartupPrompt: PendingPrompt | null = null;
  /** 用户在会话建立途中按了停止的那次开场:它随后的「起不来」是他要的,❌ 说成失败。 */
  private _stoppedStartGeneration: number | null = null;
  /** 停止时撤回输入框的那几句:它们随后被运行时拒收,❌ 再弹一次错误、再还一次字。 */
  private _stoppedPromptIds = new Set<string>();
  private _lastActiveTurnId: string | null = null;
  /**
   * 库里那份历史(#5381)。重开一条会话时先画它,**不等引擎起来** —— 从前历史只能等
   * `session/load` 重放送达,于是「打开一条会话」和「把一个 harness 拉起来」被绑成了一件事。
   */
  private _storedHistoryTurns: TranscriptTurn[] = [];
  /** 与 `_storedHistoryTurns` 一一对应:每一行来自引擎的哪一轮(运行时原始 turn id)。引擎改了更早的一轮时据此找到库里那一行。 */
  private _storedOrigins: string[] = [];
  /**
   * 引擎那侧手里这一份:库里非空时是分界之后的回合,库里为空时是开场那一页起的回合。每提交一轮只按改动游标
   * 取新增 / 改过的那几轮并进来(@@@history-change-cursor),❌ 再从分界一页页重取、❌ 再把库从开场那一行重读一遍
   * —— 别的机器上的会话每一字节都经咕咕云中转,10-26 事故里每提交一轮就是 7 MB × 2。
   */
  private _runtimeTurns: TranscriptTurn[] = [];
  /** 引擎的改动游标与回合数(上一次读到的);下一次对账带着游标问。 */
  private _runtimeCursor: HistoryCursor | null = null;
  private _runtimeCount = 0;
  /**
   * 引擎那侧「开场时已有」与「之后新增」的分界:开场时最后一轮的 seq + 1(#5381 评审 #2)。
   * seq 小于它的回合开场前就在引擎里(重放回来的、或面板重挂前聊过的),库里那份已覆盖。
   *
   * ⚠️ 用 seq 不用条数。引擎给的是最后 100 轮的滑动窗口,按条数切,窗口一滑就切错:
   * 重放满 100 轮再聊一轮,切完是空的;重放 80 轮再聊 30 轮,丢掉第 80–89 轮。
   */
  private _runtimeReplayEndSeq = 0;
  /** 库里为空、只翻引擎时,开场那一页第一轮的 seq。往上翻的都在它之前,对账从它取起,中间不断档。 */
  private _runtimeWindowStartSeq = 0;
  /** 开场那一页库里第一行的 seq(库内序号,只增不减);null = 开场时库里为空。 */
  private _storedBaseSeq: number | null = null;
  /** 开场读库那一刻库里最后一行的 seq。比它新的行,就是本次面板期间才落库的回合。 */
  private _storedBootstrapMaxSeq = -1;
  /** 本次面板期间才落库的那些行来自引擎的哪几轮(运行时原始 turn id)—— 引擎那侧据此不再重复出它们。 */
  private _persistedRuntimeTurnIds: ReadonlySet<string> = new Set<string>();
  /**
   * 每次开场 +1。在途的翻页 / 重读库回来时对不上号就丢弃结果 —— 否则重挂之前发出去的请求
   * 会把上一轮的状态写回来(评审 #4)。
   */
  private _historyGeneration = 0;
  /**
   * 用户滚到顶之后一页页翻回来的更早那些回合(#5381),由旧到新。
   *
   * ⚠️ 必须**留在 store 里**,不能只交给视图去 prepend:一轮讲完后的对账
   * (`_refreshHistory`)会拿合成结果重新 seed 一遍,不参与合成的话,用户翻了半天、
   * 发一句话就被打回原点。
   */
  private _olderHistoryTurns: TranscriptTurn[] = [];
  /**
   * 下一页更早历史的游标。`undefined` = 还没定下来从哪儿翻;`null` = 已经到头了。
   *
   * 来源跟着开场那一页走:库里有历史就一直翻库(它是完整的那一份),
   * 库里为空的会话(老会话 / 刚从编程模式切过来的)只有重放这一个来源,就翻引擎。
   */
  private _olderCursor: number | null | undefined = undefined;
  private _olderSource: 'stored' | 'runtime' = 'runtime';
  /** 一次只翻一页 —— `onReachStart` 在到顶期间会反复触发。 */
  private _loadingOlder = false;

  constructor(
    readonly sessionId: string,
    readonly projectId: string,
    readonly runtimeView?: {
      id: string;
      forkFromProviderSessionId: string;
      forkedFromSessionId?: string;
    }
  ) {
    const runtimeSessionId = runtimeView?.id ?? sessionId;
    // 侧边聊天(运行时分叉)跑在来源会话所在的那台机器上:把它的运行时 id 记到那台机器名下,
    // ❌ 落到本机(本机没有那条会话、也没有那个工作目录)(#6264 一套工作台)。
    const sourceMachine = runtimeView ? machineRegistry.machineOf(sessionId) : null;
    if (runtimeView && sourceMachine) machineRegistry.register(sourceMachine, [runtimeView.id]);
    this.chatContext = getSharedChatContext();
    this.chatState = createChatState(this.chatContext, { uri: runtimeSessionId });
    registerSessionCommands(runtimeSessionId, () =>
      this.commands.map((command) => command.name)
    );

    makeObservable<this, '_bootstrapped' | '_bootstrapsInFlight' | '_runtimeBackgroundTaskIds' | '_startupQueued' | '_startupRunningId'>(this, {
      _bootstrapped: observable,
      _startupQueued: observable.ref,
      _startupRunningId: observable,
      _runtimeBackgroundTaskIds: observable.ref,
      runningBackgroundTaskIds: computed,
      session: observable.ref,
      pendingPermissionMode: observable.ref,
      historyLoading: observable,
      loadError: observable,
      _bootstrapsInFlight: observable,
      starting: computed,
      startupChoice: observable.ref,
      messageCount: observable,
      draftText: observable,
      queuedEditDraft: observable.ref,
      queueEditPending: observable,
      queuedPromptEdit: computed,
      beginQueuedPromptEdit: action,
      changeQueuedPromptEdit: action,
      finishQueuedPromptEdit: action,
      reverting: observable,
      messageEdit: observable.ref,
      beginMessageEdit: action,
      changeMessageEdit: action,
      cancelMessageEdit: action,
      canRevertHistory: computed,
      model: computed,
      modelOptions: computed,
      permissionMode: computed,
      permissionModeOptions: computed,
      detachedPermissionTier: computed,
      permissionModeChangeNotice: computed,
      effort: computed,
      effortOptions: computed,
      commands: computed,
      permissionQueue: computed,
      queuedPrompts: computed,
      usage: computed,
      affordances: computed,
      canQueueBeforeSession: computed,
      bootstrap: action,
      releaseTranscript: action,
      isEmpty: computed,
      submitPrompt: action,
      queuePrompt: action,
      stop: action,
      setModel: action,
      setMode: action,
      setEffort: action,
      resolvePermission: action,
      editQueuedPrompt: action,
      deleteQueuedPrompt: action,
      reorderQueuedPrompts: action,
      sendQueuedPromptNow: action,
      setDraftText: action,
      exportTranscript: action,
      retry: action,
      installVisualEvidenceFixture: action,
    });
  }

  get runtimeSessionId(): string {
    return this.runtimeView?.id ?? this.sessionId;
  }

  get starting(): boolean {
    return this._bootstrapsInFlight > 0 && this.session === null;
  }

  get isTransient(): boolean {
    return this.runtimeView !== undefined;
  }

  get model(): string | null {
    if (this.session) return this.session.config.current().modelOptions?.selected ?? null;
    // #6552 还在起 / #7342 停下了:下一次起就用的那个 —— 用户起动这段里选的,否则会话记录里的(与 `_startInput` 同一份)。
    // ❌ 停下时答 null:触发器会退回占位的「模型」,把一个记着的事实画成了不知道。
    return this.startupChoice.model ?? this._sessionRecord()?.model ?? null;
  }

  /**
   * 这条会话的 agent 收不收图片(ACP `initialize` 的 `promptCapabilities.image`)。
   * `null` = 会话还没起来,能力**未知** —— 与「声明了不收」是两件事,分路时按未知处理
   * (见 `imageAttachmentRoute`)。
   */
  get acceptsImagePrompts(): boolean | null {
    const session = this.session;
    return session ? session.config.current().acceptsImagePrompts : null;
  }

  get modelOptions(): Record<string, ComposerModelOption> | null {
    const options = this.session?.config.current().modelOptions;
    if (!options) return null;
    return Object.fromEntries(
      options.available.map((option) => [
        option.id,
        { name: option.name, description: option.description },
      ])
    );
  }

  get permissionMode(): string | null {
    const session = this.session;
    if (!session) return null;
    const activeTurnId = session.sessionState.current().activeTurnId;
    const pending = this.pendingPermissionMode;
    if (pending && pending.turnId === activeTurnId) return pending.modeId;
    return session.config.current().modeOptions?.selected ?? null;
  }

  /**
   * #7342 停下了(没有活会话、也不在起)时,记录里那一档 —— 下一次起就按它设(与 `_startInput` 同一个函数)。
   * 活会话、还在起、侧边聊天(借来源会话的记录)都答 null:前两者有自己的读数或已经发出去的启动参数,
   * 后者那份记录不是它的。
   */
  get detachedPermissionTier(): GuguPermissionMode | null {
    if (this.session || this.starting || this.isTransient) return null;
    const record = this._sessionRecord();
    if (!record) return null;
    return resolveSessionPermissionMode(record);
  }

  get permissionModeChangeNotice(): ComposerNotice | null {
    const session = this.session;
    const pending = this.pendingPermissionMode;
    if (!session || !pending || pending.turnId !== session.sessionState.current().activeTurnId) {
      return null;
    }
    return {
      variant: 'info',
      title: 'Permission mode queued',
      message:
        'The selected permission mode will apply on the next turn. The current turn continues with its existing mode.',
    };
  }

  get permissionModeOptions(): Record<string, ComposerPermissionModeOption> | null {
    const options = this.session?.config.current().modeOptions;
    if (!options) return null;
    return Object.fromEntries(
      options.available.map((option) => [
        option.id,
        {
          name: option.name,
          description: option.description,
          destructive: isDestructivePermissionMode(option.id),
        },
      ])
    );
  }

  get effort(): string | null {
    if (this.session) return this.session.config.current().efforts?.selected ?? null;
    // 同 `model`:还在起、停下了都答下一次起用的那一档。
    return this.startupChoice.effort ?? this._sessionRecord()?.effort ?? null;
  }

  get effortOptions(): Record<string, ComposerEffortOption> | null {
    const options = this.session?.config.current().efforts;
    if (!options) return null;
    return Object.fromEntries(
      options.available.map((option) => [
        option.id,
        { name: option.name, description: option.description },
      ])
    );
  }

  get commands(): CommandItem[] {
    return (this.session?.config.current().availableCommands ?? []).map((command) => ({
      id: command.name,
      name: command.name,
      // 发出去的原文由 ACP 领域规则算:裸名配 `/`,自带 sigil 的(codex 的 `$skill`)原样。
      // 编辑器只负责把这个字符串插进去,❌ 它不许自己拼前缀。
      token: commandToken(command.name),
      description: command.description,
      behavior: 'insert' as const,
      // reducer 早就把 `input.hint` 采下来了(acp/reducer/reducer.ts),这里从前把它丢掉,
      // 于是 `/review-branch` 摆在面板上却不说要跟一个分支名。缺席就是「不吃参数」。
      ...(command.inputHint ? { inputHint: command.inputHint } : {}),
    }));
  }

  get permissionQueue(): PermissionQueueItem[] {
    return (this.session?.sessionState.current().pendingPermissions ?? []).map((request) => ({
      requestId: request.requestId,
      toolCallId: request.toolCall.toolCallId,
      title: toolCallLabel(request.toolCall),
      options: request.options.map((option) => ({
        optionId: option.optionId,
        name: option.name,
        kind: option.kind,
      })),
      waitKind: permissionWaitKind(request),
    }));
  }

  /**
   * 进行中的那一轮里有没有这次工具调用 —— 计划卡画在它身上(#7139),没到之前输入框上那条还得留着。
   * 读会话自己的 activeTurn(mobx),❌ 流的 transcript(Solid):工具行一到，输入框(observer)当场重算。
   */
  hasActiveToolCall(toolCallId: string): boolean {
    const items = this.session?.activeTurn.current()?.items ?? [];
    return items.some((item) => 'toolCallId' in item && item.toolCallId === toolCallId);
  }

  get queuedPrompts(): ComposerQueuedPrompt[] {
    if (!this.session) return this._startupQueued.map((prompt) => ({ ...prompt, locked: true }));
    return this._queuedPromptModels().filter(isVisibleQueuedPrompt).map(
      (prompt) => ({ id: prompt.id, text: prompt.text, origin: prompt.origin })
    );
  }

  get queuedPromptEdit() {
    const prompt = this._queuedPromptModels().find((entry) => entry.queueEdit);
    if (!prompt?.queueEdit) return null;
    return {
      id: prompt.id,
      text: this.queuedEditDraft?.id === prompt.id ? this.queuedEditDraft.text : prompt.queueEdit.draftText,
      originalDraftText: prompt.queueEdit.originalDraftText,
      pending: this.queueEditPending,
    };
  }

  /**
   * behavior session-page「键盘导航」: what ↑ in the composer walks back through.
   *
   * Derived from the committed transcript rather than kept as a side list, so it survives a reload
   * and cannot drift from the messages the session actually shows. Deliberately a method, not a
   * mobx getter: the transcript is solid-js state, and a mobx computed over it would cache against
   * dependencies that never invalidate. It is read once per keypress, so recomputing is fine.
   */
  promptHistory(): string[] {
    const prompts: string[] = [];
    const transcript = this.chatState.transcript.state;
    // The in-flight turn counts, and so does the optimistic prompt that has not become a turn yet:
    // right after sending, "上一条输入" is the one just sent — reading only committed turns would
    // hand back the one before it, which is the single most likely moment for ↑ to be pressed.
    const turns = [
      ...transcript.committedTurns,
      ...(transcript.activeTurnSnapshot ? [transcript.activeTurnSnapshot] : []),
    ];
    for (const turn of turns) {
      for (const item of turn.items) {
        if (item.kind !== 'message' || item.role !== 'user') continue;
        if (item.text.trim()) prompts.push(item.text);
      }
    }
    const pending = this.chatState.session.state.pendingPrompt?.text?.trim();
    // The optimistic prompt becomes a real user message the moment the turn opens, so only add it
    // while the tail does not already say the same thing.
    if (pending && prompts[prompts.length - 1] !== pending) prompts.push(pending);
    return prompts;
  }

  get usage(): {
    contextUsed: number;
    contextSize: number;
    cost?: { amount: number; currency: string } | null;
  } | null {
    const session = this.session;
    const live = session?.usage.current() ?? null;
    // 分叉的侧边聊天借的是来源会话的 id:记录里那份是来源的读数,❌ 拿来当它自己的。
    if (live || this.isTransient) return live;
    // #7342 活会话没有读数(停下了 / 还在起 / 重开后还没跑完一轮):画记录里那份最后读数,归属判据见 recordedContextUsage。
    // 停下时 ❌ 拿记录里的模型去比:那是另一套 id(平台模型不在那一格),作废归写者(换模型时它清掉)。
    const currentModelId = session
      ? (session.config.current().modelOptions?.selected ?? null)
      : (this.startupChoice.model ?? null);
    return recordedContextUsage(this._sessionRecord(), currentModelId);
  }

  /**
   * 面板后台命令花名册的筛子(#6582):运行时说本进程里还在跑的任务 id。没挂着会话 = `[]`
   * (没有活着的进程就没有在跑的命令);`null` = 旧运行时没报这一格,花名册不筛。
   */
  get runningBackgroundTaskIds(): readonly string[] | null {
    return this.session ? this._runtimeBackgroundTaskIds : [];
  }

  private _syncRuntimeBackgroundTaskIds(state: Parameters<typeof runningBackgroundTaskIds>[0]): void {
    const next = runningBackgroundTaskIds(state);
    const previous = this._runtimeBackgroundTaskIds;
    const same = next === previous || (next !== null && previous !== null
      && next.length === previous.length && next.every((id, index) => id === previous[index]));
    if (!same) this._runtimeBackgroundTaskIds = next;
  }

  private revertMessageItem(itemId: string) {
    return this.chatState.transcript.state.committedTurns.flatMap((turn) => turn.items)
      .find((item) => item.kind === 'message' && item.role === 'user' && item.id === itemId);
  }

  get canRevertHistory(): boolean {
    return !!this.session && !this.reverting && !this.affordances.isBusy
      && this.session.sessionState.current().lifecycle === 'ready'
      && !this.affordances.hasPendingPermission && !(this.runningBackgroundTaskIds?.length)
      && !this.session.sessionState.current().queuedPrompts.length;
  }

  canRevertMessage(itemId: string): boolean {
    const item = this.revertMessageItem(itemId);
    return this.canRevertHistory && item?.kind === 'message' && !!item.revertAnchor;
  }

  beginMessageEdit(itemId: string): void {
    const item = this.revertMessageItem(itemId);
    if (!this.canRevertMessage(itemId) || item?.kind !== 'message') return;
    this.messageEdit = { itemId, text: item.text };
  }

  changeMessageEdit(itemId: string, text: string): void {
    if (this.messageEdit?.itemId === itemId && !this.reverting) this.messageEdit = { itemId, text };
  }

  cancelMessageEdit(itemId: string): void {
    if (this.messageEdit?.itemId === itemId && !this.reverting) this.messageEdit = null;
  }

  async sendMessageEdit(itemId: string): Promise<void> {
    const edit = this.messageEdit;
    const item = this.revertMessageItem(itemId);
    if (!edit || edit.itemId !== itemId || !edit.text.trim() || item?.kind !== 'message' || !this.canRevertMessage(itemId)) return;
    // Validate and retain the original immutable image references before truncating history.
    let attachments: AcpPromptAttachment[];
    try {
      attachments = (item.attachments ?? []).map((attachment) => ({ ref: { type: 'attachment', ...attachmentRefSchema.parse(attachment) } }));
    } catch (error) { this._toastError('acpFailure.attachment', error); return; }
    const session = this.session;
    if (!await this.revertMessage(itemId, false) || this.session !== session) return;
    runInAction(() => { this.messageEdit = null; });
    this.submitPrompt(edit.text, attachments, undefined, 'manual', true);
  }

  async revertMessage(itemId: string, restoreDraft = true): Promise<boolean> {
    const item = this.revertMessageItem(itemId);
    const session = this.session;
    if (!session || item?.kind !== 'message' || !item.revertAnchor || !this.canRevertMessage(itemId)) return false;
    const draftBefore = this.draftText;
    const generation = ++this._historyGeneration;
    runInAction(() => { this.reverting = true; });
    try {
      const result = await session.revertSession(item.revertAnchor);
      if (!result.success) { this._toastError('acpFailure.revert', result.error); return false; }
      if (this.session !== session || generation !== this._historyGeneration) return false;
      runInAction(() => {
        this._storedHistoryTurns = [];
        this._storedOrigins = [];
        this._olderHistoryTurns = [];
        this._storedBaseSeq = null;
        this._storedBootstrapMaxSeq = -1;
        this._persistedRuntimeTurnIds = new Set();
        this._runtimeReplayEndSeq = 0;
        this._runtimeWindowStartSeq = 0;
        this._runtimeTurns = [];
        this._olderCursor = undefined;
      });
      const stored = await rpc.sessions.getStoredHistory({ sessionId: this.sessionId, limit: 100 });
      // 库里非空时引擎那一页只用来定分界和改动游标(同开场)。
      const history = await session.getHistory(undefined, stored.turns.length ? 1 : 100);
      if (!history.success) throw history.error;
      if (this.session !== session || generation !== this._historyGeneration) return false;
      runInAction(() => {
        this._storedHistoryTurns = stored.turns;
        this._storedOrigins = stored.originTurnIds;
        this._storedBaseSeq = stored.turns[0]?.seq ?? null;
        this._storedBootstrapMaxSeq = stored.turns.at(-1)?.seq ?? -1;
        this._persistedRuntimeTurnIds = new Set(stored.originTurnIds);
        this._olderCursor = stored.turns.length ? stored.nextCursor : history.data.nextCursor;
        this._olderSource = stored.turns.length ? 'stored' : 'runtime';
        this._runtimeReplayEndSeq = stored.turns.length ? (history.data.turns.at(-1)?.seq ?? -1) + 1 : 0;
        this._runtimeWindowStartSeq = stored.turns.length ? 0 : (history.data.turns[0]?.seq ?? 0);
        this._runtimeTurns = stored.turns.length ? [] : history.data.turns;
        this._runtimeCursor = history.data.cursor;
        this._runtimeCount = history.data.count;
        this.chatState.transcript.history.seed(this._composedHistory());
        this.chatState.transcript.activeTurn.set(null);
        this.chatState.session.setPendingPrompt(null);
        if (restoreDraft && this.draftText === draftBefore) this.setDraftText(item.text);
        this._syncMessageCount();
      });
      return true;
    } catch (error) { this._toastError('acpFailure.revert', error); return false; }
    finally { runInAction(() => { this.reverting = false; }); }
  }

  get affordances(): AgentAffordances {
    const state = this.session?.sessionState.current();
    // #6448:composer 的「在跑」= agent 在干活(发送改排队、立即发送要先打断、乐观消息不插)。只剩后台子代理的
    // park 不是 —— owner 定 park 照收投递,❌ 用 `isGenerating`(它把后台子代理也算进去,打的字会被压到后台跑完)。
    // 后台任务各自在后台面板里停;`isBusy` 保留「这条会话还有东西在跑」的宽口径。
    const agentWorking = state
      ? state.lifecycle === 'working' || state.lifecycle === 'cancelling'
      : false;
    // 会话还在建立、已有一句在「处理中」:这段也是在跑 —— 停止键在,打字照在跑时一样进排队条。
    const startupRunning = !state && this.starting && this._startupRunningId !== null;
    return {
      isWorking: agentWorking || startupRunning,
      isBusy: (state?.isGenerating ?? false) || startupRunning,
      hasPendingPermission: (state?.pendingPermissions.length ?? 0) > 0,
      canSubmit: !this.reverting && !this.messageEdit && (state?.canSubmit ?? this.canQueueBeforeSession),
      canCancel: (state?.canCancel ?? false) || startupRunning,
    };
  }

  /**
   * 这条会话有没有前文 —— 判据不在这里,在 `sessionHasPriorContext`(spec session-graph:
   * 「有没有前文」只有一个属主,三种创建来源同权)。
   *
   * ⚠️ 这里曾经只读 `firstUtterance`,而那是**新建**独有的字段:分叉与导入按设计不写它。
   * 于是一条 fork 出来的会话「没有首轮」被读成了「还没开始」,它的侧边聊天整块画成创建页
   * (#5425 实测)。运行时分叉(侧边聊天)自己也是有前文的:它按构造分叉自一条活着的
   * provider 会话,所以把那个来源 id 一并交给同一个判据回答,❌ 不在这里为 fork 另开一支。
   */
  private get hasPriorContext(): boolean {
    const session = sessionRegistry
      .get(this.sessionId)
      ?.sessions.get(this.sessionId)?.data;
    return sessionHasPriorContext({
      firstUtterance: session?.firstUtterance,
      providerSessionId: session?.providerSessionId,
      // 运行时分叉自己带着来源 provider 会话;源会话行那份是它没有时的来处。
      forkFromProviderSessionId:
        this.runtimeView?.forkFromProviderSessionId ?? session?.forkFromProviderSessionId,
    });
  }

  /**
   * 「还没开始」不是「空」。刚建出来的会话，首轮已经在路上、只是还没进 transcript —— 这一小段里若按
   * 「没有消息 = 空」判，就会把「今天我们做点什么？」这块占位页摆到一个刚说完话的人面前，闪一下再消失。
   * 占位页是给真正空白会话的兜底，走到它本身就说明前面判错了。
   */
  get isEmpty(): boolean {
    return !this.historyLoading && this.messageCount === 0 && !this.hasPriorContext;
  }

  bootstrap(): void {
    if (this._transcriptReleased) {
      this._reloadReleasedTranscript();
      return;
    }
    if (this._bootstrapped) return;
    this._bootstrapped = true;
    if (this._disposed) return;
    void this._runBootstrap();
  }

  /**
   * 放掉这条会话的转录 —— 它不在屏上,也不在最近看过的那几条里(`KEPT_HIDDEN_TRANSCRIPTS`)。
   *
   * 为什么要放:tab 的资源跟着会话活到删除为止,于是**打开过的每一条会话**都把最新那一页(还有之后聊的
   * 每一轮)留在渲染进程里,并且每提交一轮就把它们整段重读一遍(`_refreshHistory`)。主人本机的
   * 实际数据:一页中位 1.3MB、p90 6.6MB、最大 62MB,其中八成是工具输出。
   *
   * 记录在库里,一个字都不丢:下一次上屏(`bootstrap`)照首次打开那样重读。
   * 活会话**照挂**:旁听口(别的机器上冒出的端口,d22)读的是这里提交的那一轮,❌ 跟着一起断。
   * 切回去等于重新打开:落在库里最新那一页上(chatState 里记着的那一行还在这一页里,就回到那一行)。
   */
  releaseTranscript(): void {
    if (
      this._transcriptReleased
      || this._disposed
      || !this._bootstrapped
      || this.isTransient
      || this._visualEvidenceOverride
      // 正挂在屏上(分屏时最近看过的那几条之外也可能在屏上),或者开场 / 重读还在途。
      || this._view !== null
      || this.historyLoading
      || this._bootstrapsInFlight > 0
    ) {
      return;
    }
    this._transcriptReleased = true;
    this._resetHistoryState();
    const activeTurn = this.chatState.transcript.state.activeTurnSnapshot;
    this.chatState.transcript.history.seed([]);
    // seed 按约定会清掉 activeTurn;还在跑的那一轮留着 —— 它提交时旁听口要读它。
    if (activeTurn) this.chatState.transcript.activeTurn.set(activeTurn);
    // 回来时先是「加载中」,❌ 空会话的占位页。
    this.historyLoading = true;
    this._syncMessageCount();
  }

  private _reloadReleasedTranscript(): void {
    this._transcriptReleased = false;
    if (this._disposed) return;
    // 活会话还挂着:与宿主重开后重挂同一条路(只附着、不再建立),库与引擎两份一起重读。
    if (this.session) {
      this.reattachAfterHostReload();
      return;
    }
    // 没有活会话(宿主停了它 / 起不来):只重读库里那份,停着的就让它停着 —— 下一次发消息才起(#6497)。
    this.historyLoading = true;
    this._resetHistoryState();
    const generation = this._historyGeneration;
    void this._loadStoredFirstPage(generation).finally(() =>
      runInAction(() => {
        if (generation !== this._historyGeneration) return;
        this.historyLoading = false;
        this._syncMessageCount();
      })
    );
  }

  retry(): void {
    // Terminal load errors stay put so remounts and generic retry callers do not
    // respawn/provision again — which ones are terminal lives in acp-load-error.
    if (this.historyLoading || !this.loadError || isTerminalLoadError(this.loadError)) return;
    this._unsubs.splice(0).forEach((unsub) => unsub());
    this.session?.dispose();
    this.session = null;
    this._closedByHost = false;
    this.historyLoading = true;
    this.loadError = null;
    void this._runBootstrap();
  }

  /**
   * 宿主停掉这条会话之后又把它起起来了(重开换模型 / 改 MCP 开关、定时到点、投递唤醒),重新挂上去 ——
   * 由 `_onSessionClosedByHost` 留着的那个句柄重新 seed 时调,不管是谁起的。
   *
   * ⚠️ 少了这一步,界面停在停掉之前:`model` / `modelOptions` 读自 `this.session.config`,而停掉时 `session` 已置空
   * (2026-09-07 隔离栈实测「点了确认,composer 上还是旧模型」;10-19「定时回合跑着,任务页不动」)。
   * ❌ 不在这里"把新模型写进本地状态" —— 那是拿我们自己的说法冒充运行时事实。重挂一次,让活会话自己报它现在是什么。
   */
  reattachAfterHostReload(): void {
    if (this._disposed || !this._bootstrapped) return;
    this._unsubs.splice(0).forEach((unsub) => unsub());
    this.session?.dispose();
    this.session = null;
    this._closedByHost = false;
    this.historyLoading = true;
    this.loadError = null;
    // ⚠️ `attachOnly` —— **重新附着,不是再建立一次**(#5550)。
    // 宿主刚刚完整地「停 → 改记录 → 起」过一次,那就是这次操作的**那一次**建立;
    // 这里再走一遍 start 的话,一次用户操作就产生两次建立,而第二次在运行时里
    // 什么都不做(`SessionManager.start` 对已存在的会话直接返回)、在主进程里却会
    // 把凭据轮换一遍 —— 于是先起来的那个适配器手里那张票当场作废,用户的下一句 401。
    // 实测(2026-09-13 mac1):点一次「Restart and continue」= 两次 start,相隔 1.148s,
    // 第一次签的 `47f1134e` 被第二次撤销 ⇒ 下一句 `Failed to send / prompt_failed`。
    void this._runBootstrap({ attachOnly: true });
  }

  bindView(view: ChatView | null): void {
    this._view = view;
  }

  installVisualEvidenceFixture(
    turns: TranscriptTurn[],
    collapsedIds: string[],
    terminals: {
      terminalId: string;
      outputText?: string;
      exitStatus?: { exitCode: number | null; signal: string | null };
    }[] = []
  ): void {
    if (!import.meta.env.DEV) {
      throw new Error('session chat visual evidence fixtures are available only in dev builds');
    }
    this._visualEvidenceOverride = true;
    this._unsubs.splice(0).forEach((unsub) => unsub());
    this.session?.dispose();
    this.session = null;
    this.chatState.transcript.history.seed(turns);
    for (const terminal of terminals) {
      if (terminal.outputText !== undefined) {
        this.chatState.session.setTerminalOutput(terminal.terminalId, terminal.outputText);
      }
      if (terminal.exitStatus !== undefined) {
        this.chatState.session.setTerminalExitStatus(terminal.terminalId, terminal.exitStatus);
      }
    }
    for (const id of collapsedIds) this.chatState.viewState.setCollapsed(id, true);
    this.historyLoading = false;
    this.loadError = null;
    this.messageCount = turns.reduce((count, turn) => count + turn.items.length, 0);
  }

  async uploadAttachment(input: {
    data?: Uint8Array;
    source?: BlobSource;
    size?: number;
    mimeType: AttachmentMimeType;
    name?: string;
    originalPath?: string;
  }): Promise<AttachmentRef | null> {
    try {
      const result = await this.session?.uploadAttachment(input);
      if (!result) {
        this._toastError('acpFailure.attachment', new Error('ACP session is not connected'));
        return null;
      }
      if (!result.success) {
        this._toastError('acpFailure.attachment', result.error);
        return null;
      }
      return result.data;
    } catch (error) {
      this._toastError('acpFailure.attachment', error);
      return null;
    }
  }

  async deleteAttachment(id: string): Promise<void> {
    const session = this._requireSession('acpFailure.attachment');
    if (!session) return;
    try {
      const result = await session.deleteAttachment(id);
      if (!result.success) this._toastError('acpFailure.attachment', result.error);
    } catch (error) {
      this._toastError('acpFailure.attachment', error);
    }
  }

  /**
   * @@@sessionpage layout — timeline-scrubber jump (spec session-page 会话页):
   * pin the given transcript item flush to the viewport top, same mechanism as
   * the pending-prompt pin in submitPrompt below.
   */
  scrollToItem(itemId: string): void {
    const pinMode = pinTopMode(itemId);
    this._view?.setScrollMode(pinMode);
    this.chatState.scroll.set(pinMode);
  }

  /**
   * 取会话；不在时**响亮失败**并返回 null。
   *
   * #3500：`this.session?.doSomething()` 这种写法在会话不在时整条短路 ——
   * 不发、不报错、连 `.then(… && toast)` 都一起消失。**`?.` 在这里是一个语法级的 fallback**，
   * 与本仓 fail loud 铁律直接冲突：调用点假设那件事发生了，而它没有。
   *
   * ⚠️ 这不是要清掉所有 `?.`：**读取型无害**（`this.session?.usage.current() ?? null`
   * 拿不到就是 null，调用方会处理）；**产生副作用的调用型才是嫌疑** ——
   * 目标不在时"这件事没发生"，而用户以为发生了。
   *
   * 调用点拿到 null 后必须自己**回滚已经做出的乐观改动**，否则用户会看到一条
   * 停在屏幕上、实际一个字节没发出去的消息。
   */
  /**
   * 一条**没能发出去**的用户输入的善后：回滚乐观行，并把文字还给 composer。
   *
   * ⚠️ 「回滚 + 弹错误」两条**都做还不够**，必须连文字一起还回去：
   * `acp-chat-panel.tsx:304-307` 在调用 `submitPrompt` **之前**就
   * `editorApiRef.current?.clear()` 了。只回滚乐观行的话，用户输入的内容在
   * **屏幕上和输入框里同时消失** —— 那比修之前更糟（修之前它至少还以气泡形式留着）。
   *
   * 草稿回填是真通的：`acp-chat-panel.tsx:258-259` 有 effect 监听 `store.draftText`
   * 并 `editor.setText(...)`。
   */
  private _rollbackUnsentPrompt(text: string, insertedOptimistic: boolean): void {
    if (insertedOptimistic) {
      this.chatState.session.setPendingPrompt(null);
      this._syncMessageCount();
    }
    // 只在输入框确实空了的时候还回去，避免覆盖用户在这期间新键入的内容。
    if (!this.draftText.trim()) this.setDraftText(text);
  }

  /**
   * provider 已确认的活设置 → 会话记录。
   *
   * ⚠️ 少了这一步,重开(app 重启 / 进程重拉 / 重载)时两条启动路读到的仍是建会话时那一档,
   * 运行时在 `session/load` 上把它重新下发 ⇒ 会话**悄悄回退**;权限那一维会回退到比用户
   * 最后一次选的**更松**的档。只在 `applied` 之后调,❌ 不乐观写(见主进程 record-live-session-setting)。
   * 分叉的侧边聊天(`runtimeView`)不落库:它借的是来源会话的 id,写了等于改来源那条的记录。
   *
   * 写失败只报错不回滚:活会话上已经生效了,回滚活会话等于再改一次用户的设置。
   */
  private async _recordLiveSetting(
    setting:
      | { dimension: 'permission'; modeId: string }
      | { dimension: 'effort'; value: string },
  ): Promise<void> {
    if (this.runtimeView) return;
    try {
      await rpc.sessions.recordLiveSessionSetting(this.sessionId, setting);
    } catch (error: unknown) {
      this._toastError('acpFailure.changeSetting', error);
    }
  }

  private _requireSession(failureTitle: AcpFailureTitle): AcpLiveSession | null {
    const session = this.session;
    if (!session) {
      this._toastError(failureTitle, new Error('ACP session is not connected'));
      return null;
    }
    return session;
  }

  /** `origin`: `communication` for a delivery envelope gugu wrote (an extension's relay), not typed text. */
  submitPrompt(
    text: string,
    attachments: AcpPromptAttachment[] = [],
    messageContext?: string,
    origin: 'manual' | 'communication' = 'manual',
    preserveComposerDraft = false,
  ): void {
    if (this.reverting || this.messageEdit) return;
    const promptAttachments = attachments.map((attachment) => attachment.ref);
    const input: PromptInput = {
      text,
      origin,
      ...(messageContext ? { hiddenContext: messageContext } : {}),
      ...(promptAttachments.length > 0 ? { attachments: promptAttachments } : {}),
    };
    if (this.canQueueBeforeSession) {
      this._queuePromptDuringStartup(input, text, 'acpFailure.sendMessage', attachments, 'send');
      return;
    }
    // 只有我们自己插入过乐观消息时才回滚它 —— 无条件清空会顺手抹掉别处设置的 pendingPrompt。
    let insertedOptimistic = false;
    if (!this.affordances.isWorking) {
      const optimisticId = `optimistic:user:${Date.now()}`;
      this.chatState.session.setPendingPrompt({
        id: optimisticId,
        text,
        attachments: attachments.map(toPendingAttachment),
        sentAt: Date.now(),
      });
      insertedOptimistic = true;
      this._syncMessageCount();
      const pinMode = pinTopMode(optimisticId);
      this._view?.setScrollMode(pinMode);
      this.chatState.scroll.set(pinMode);
    }

    const session = this._requireSession('acpFailure.sendMessage');
    if (!session) {
      this._rollbackUnsentPrompt(text, insertedOptimistic);
      return;
    }

    if (preserveComposerDraft) this._preserveComposerDraft = true;
    void session
      .sendPrompt(input)
      .then((result) => {
        if (result.success) return;
        // #7103 同一次失败只说一次:这一轮已经以失败结算,转录里「回合失败」那一行就是它,❌ 再弹一条。
        if ((result.error as { type?: unknown } | null)?.type === 'prompt_failed') {
          log.warn('ACP prompt failed; the failed turn row reports it', { sessionId: this.sessionId, error: describeFailureCause(result.error) });
          return;
        }
        this._toastError('acpFailure.sendMessage', result.error);
      })
      .catch((error: unknown) => this._toastError('acpFailure.sendMessage', error))
      .finally(() => { if (preserveComposerDraft) this._preserveComposerDraft = false; });
  }

  queuePrompt(
    text: string,
    attachments: AcpPromptAttachment[] = [],
    messageContext?: string,
    origin: 'manual' | 'communication' = 'manual'
  ): void {
    const promptAttachments = attachments.map((attachment) => attachment.ref);
    const input: PromptInput = {
      text,
      origin,
      ...(messageContext ? { hiddenContext: messageContext } : {}),
      ...(promptAttachments.length > 0 ? { attachments: promptAttachments } : {}),
    };
    if (this.canQueueBeforeSession) {
      this._queuePromptDuringStartup(input, text, 'acpFailure.sendMessage', attachments, 'queue');
      return;
    }
    const session = this._requireSession('acpFailure.sendMessage');
    if (!session) {
      // 队列项没有乐观行，但 composer 已经清空了（acp-chat-panel.tsx:316-319）⇒ 仍要把文字还回去。
      this._rollbackUnsentPrompt(text, false);
      return;
    }
    void session
      .queuePrompt(input)
      .then((result) => {
        if (!result.success) this._toastError('acpFailure.sendMessage', result.error);
      })
      .catch((error: unknown) => this._toastError('acpFailure.sendMessage', error));
  }

  private _queuePromptDuringStartup(
    input: PromptInput,
    text: string,
    title: AcpFailureTitle,
    attachments: readonly AcpPromptAttachment[],
    intent: 'send' | 'queue',
  ): void {
    // #6497 会话被宿主停掉之后的第一句:与首次打开走同一条路 —— 开场(起会话 + 重挂 live models)
    // 与这句排进运行时的启动队列**同时**发出。主进程把两个入口并成同一次在途启动
    // (`@@@one-start-owner`,#5233):注入只做一次、平台票只签一张,谁先到都一样。
    // ❌ 不在这里只排队不开场:排队那条会把会话起起来,可这一侧没人订它,回复永远画不出来。
    // 眼下没有开场在跑的别的情形(起不来之后再发一句……)也一样:运行时收到它会把会话起起来,这一侧得挂上去;
    // 不挂,上屏的那一句会永远停在「处理中」。
    if (this._closedByHost) {
      this._closedByHost = false;
      void this._runBootstrap();
    } else if (!this.starting) {
      if (this.loadError) this.retry();
      else void this._runBootstrap();
    }
    // 发出就要看得见(behavior session-page「打开速度」):没有别的在跑 ⇒ 这一句上屏、显示「处理中」,与第一条
    // 消息一样;已经有一句在跑(第一条还在等会话建好)⇒ 进排队条,与 agent 正忙时发的一样。
    // 别的 agent 派来的(`communication`)不是这里打的字,照旧不画(同 `firstPromptPreview`)。
    let optimisticId: string | null = null;
    let queuedId: string | null = null;
    if (input.origin !== 'communication') {
      const running = this.chatState.session.state.pendingPrompt !== null;
      if (intent === 'send' && !running) {
        optimisticId = `optimistic:user:${Date.now()}`;
        this._startupPendingIds.add(optimisticId);
        this._startupRunningId = optimisticId;
        this.chatState.session.setPendingPrompt({
          id: optimisticId,
          text,
          attachments: attachments.map(toPendingAttachment),
          sentAt: Date.now(),
        });
        this._syncMessageCount();
        const pinMode = pinTopMode(optimisticId);
        this._view?.setScrollMode(pinMode);
        this.chatState.scroll.set(pinMode);
      } else {
        queuedId = `startup-queued:${Date.now()}:${this._startupQueued.length}`;
        this._startupQueued = [
          ...this._startupQueued,
          { id: queuedId, text, origin: input.origin === 'typed' ? 'typed' : 'manual' },
        ];
      }
    }
    // 运行时拒收(会话起不来,它不替你存着)⇒ 这一句没发出去:撤下、字还回输入框,原因由失败那一行与提示说。
    // ❌ 像第一条那样留在屏上 —— 第一条存在会话记录里、重试会再发,这一句不会,留着就是假的「已发出」。
    // 用户按停止时已经把它撤回输入框了(`_stopStartup`)⇒ 随后的拒收是那次停止的回声,❌ 再还一次字、再弹错误。
    const stoppedByUser = (): boolean =>
      (optimisticId !== null && this._stoppedPromptIds.has(optimisticId))
      || (queuedId !== null && this._stoppedPromptIds.has(queuedId));
    const undo = (): void =>
      runInAction(() => {
        if (queuedId) this._startupQueued = this._startupQueued.filter((prompt) => prompt.id !== queuedId);
        const ours = optimisticId !== null && this.chatState.session.state.pendingPrompt?.id === optimisticId;
        if (ours) this._startupRunningId = null;
        // 起不来时它已经作为「还存着」留在屏上(`_holdStartupPrompt`);运行时这才回话说没收下 ⇒ 那一份也撤。
        if (optimisticId !== null && this._heldStartupPrompt?.id === optimisticId) {
          const heldId = heldFirstPromptTurnId(this._heldStartupPrompt);
          const turns = this.chatState.transcript.state.committedTurns;
          this.chatState.transcript.history.seed(turns.filter((turn) => turn.id !== heldId));
          this._heldStartupPrompt = null;
        }
        this._rollbackUnsentPrompt(text, ours);
      });
    void getAcpRuntimeClient(machineRegistry.machineOf(this.runtimeSessionId))
      .then((client) => client.queuePrompt({
        sessionId: this.runtimeSessionId,
        prompt: input,
        startInput: this._startInput(),
      }))
      .then((result) => {
        if (result.success || stoppedByUser()) return;
        undo();
        this._toastError(title, result.error);
      })
      .catch((error: unknown) => {
        if (stoppedByUser()) return;
        undo();
        this._toastError(title, error);
      });
  }

  setDraftText(text: string): void {
    if (text === this.draftText) return;
    this.draftText = text;
    this._draftRev += 1;
    this._pendingDraftRev = this._draftRev;
    this._scheduleDraftWrite(text, this._draftRev);
  }

  stop(): void {
    if (!this.session && this._startupRunningId !== null) {
      this._stopStartup();
      return;
    }
    const session = this._requireSession('acpFailure.stop');
    if (!session) return;
    void session
      .cancelTurn()
      .then((result) => {
        if (!result.success) this._toastError('acpFailure.stop', result.error);
      })
      .catch((error: unknown) => this._toastError('acpFailure.stop', error));
  }

  /**
   * 停掉一个后台子智能体(面板那张卡上的「停止」,#5117)。传派发它那次调用的 tool_use id。
   * 停成了由供应商的 stopped 通知落定(转录成「子智能体已停止」、卡随之撤),这里不预演。
   */
  stopSubagent(launchToolCallId: string): void {
    const session = this._requireSession('acpFailure.stop');
    if (!session) return;
    void session
      .stopBackgroundTask(launchToolCallId)
      .then((result) => {
        if (!result.success) this._toastError('acpFailure.stop', result.error);
      })
      .catch((error: unknown) => this._toastError('acpFailure.stop', error));
  }

  /**
   * 三维实时设置的公共尾巴 —— 运行时把结局送回来了,这里只负责**分流**,❌ 不折成文案。
   *
   * · `applied`          ⇒ 成了;带着生效值交给调用方 —— 模型那一维的调用方要据此让会话记录跟上(#6182),❌ 别吞成 null。
   * · `restart_required` ⇒ **不是错误**:这一维在这一家上只能重开会话才换得成。
   *   ⇒ 原样交给调用方,由它把「已有的那个重启动作」摆到用户面前。
   *   ⚠️ 这里曾经是一句 `_toastError('…must be explicitly restarted…')` —— 一句**没有任何动作**
   *      的错误提示:产品告诉用户「必须先重启会话」,而那句话里点不到任何东西(#5556,
   *      owner 亲手撞到)。重启这件事产品**早就有**(`requestSessionReload`,会话标题菜单里那个),
   *      缺的只是这条状态和那个动作之间的线。⇒ 分流在这里,接线在 `acp-chat-panel`。
   * · `pending_next_turn` ⇒ 下一轮才生效,照旧只提示。
   */
  /**
   * #6552 会话还在起时的一次选择:交给运行时,由启动在 `session/new` 之后设这一维的那一步采用
   * (与新建会话设记录里的值是同一步),应答在启动落定时回来,形状与活会话热切相同。
   * 界面先显示选的值;没设成就撤回,并照活会话那样报错。
   */
  private async _chooseAtStartup(
    dimension: 'model' | 'effort',
    value: string,
    title: AcpFailureTitle,
  ): Promise<LiveSettingOutcome> {
    const previous = this.startupChoice;
    runInAction(() => {
      this.startupChoice = { ...previous, [dimension]: value };
    });
    const rollback = () => runInAction(() => {
      if (this.startupChoice[dimension] === value) this.startupChoice = previous;
    });
    try {
      const client = await getAcpRuntimeClient(machineRegistry.machineOf(this.runtimeSessionId));
      const result = await client.setModelOption({
        sessionId: this.runtimeSessionId,
        dimension,
        value,
      });
      if (!result.success) rollback();
      return this._settleLiveSetting(title, result);
    } catch (error: unknown) {
      rollback();
      this._toastError(title, error);
      return null;
    }
  }

  private _sessionRecord() {
    return sessionRegistry.get(this.sessionId)?.sessions.get(this.sessionId)?.data;
  }

  private _settleLiveSetting(
    title: AcpFailureTitle,
    result: { success: true; data: LiveSettingResult } | { success: false; error: unknown },
  ): LiveSettingOutcome {
    if (!result.success) {
      this._toastError(title, result.error);
      return null;
    }
    if (result.data.status === 'applied') {
      return { kind: 'applied', effectiveValue: result.data.effectiveValue };
    }
    if (result.data.status === 'restart_required') {
      return { kind: 'restart-required', requestedValue: result.data.requestedValue };
    }
    toast({ title: translateSessionMessage('acpNotice.pendingNextTurn', { value: result.data.requestedValue }) });
    return null;
  }

  /**
   * 还没有引擎会话、但这句话可以**先进队列**等它（spec `session-always-openable`）。
   *
   * ⚠️ 这个判据此前是 `historyLoading && loadError === null` —— 只有「还在读历史、且一切正常」
   * 那一小段窗口能入队。启动失败之后两条都不成立，而 composer 现在是常驻的 ⇒ 用户打字按回车
   * 只会弹一条「发送失败」、文字被塞回输入框，队列里什么都没有。那等于「看得见但动不了」，
   * 是另一种打不开。
   *
   * ⇒ 判据改成：**引擎会话还没建立**，且这次失败不是终态（引擎根本不在盘上那种 ——
   *   那时排队等的是一件不会发生的事，如实拒绝才诚实）。`queuePrompt` 走的是运行时侧的
   *   启动队列，它本来就接未启动的会话。
   */
  get canQueueBeforeSession(): boolean {
    if (!this._bootstrapped || this.session) return false;
    return this.loadError === null || !isTerminalLoadError(this.loadError);
  }

  async setModel(model: string): Promise<LiveSettingOutcome> {
    if (!this.session && this.starting) return this._chooseAtStartup('model', model, 'acpFailure.changeSetting');
    // 没有活会话(起不来、或已经停了):换模型不需要它 —— 这一维只能按记录重开,交给调用方那条
    // 「宿主先写记录、再停、再起」的重开路。❌ 不拿「not connected」拦:记着的模型下架后会话正是因此
    // 起不来,拦下就等于这条会话永远换不走(2026-10-02 生产实撞)。
    const session = this.session;
    if (!session) return { kind: 'restart-required', requestedValue: model };
    try {
      return this._settleLiveSetting(
        'acpFailure.changeSetting',
        await session.setModelOption('model', model),
      );
    } catch (error: unknown) {
      this._toastError('acpFailure.changeSetting', error);
      return null;
    }
  }

  async setMode(modeId: string): Promise<LiveSettingOutcome> {
    // #7342 停下了:没有进程可设,记录就是下一次起的那一档 —— 直接记下,与活会话确认后记的是同一个写者。
    // ❌ 拿「not connected」拦:停下时摆出来的下拉点了就报错,是个假控件。
    // 还在起时不走这里:启动参数已经发出去了,此刻改记录 = 记录说一档、进程跑另一档。
    if (this.detachedPermissionTier !== null) {
      await this._recordLiveSetting({ dimension: 'permission', modeId });
      return null;
    }
    const session = this._requireSession('acpFailure.changeSetting');
    if (!session) return null;
    // 回合中改权限模式 ⇒ 排队记为「下一回合生效」,getter/notice 投影这个队首;落定后按结局清留。
    const activeTurnId = session.sessionState.current().activeTurnId;
    const requestId = ++this._permissionModeRequestId;
    if (activeTurnId) {
      this.pendingPermissionMode = { modeId, turnId: activeTurnId, requestId };
    }
    try {
      const result = await session.setModeOption(modeId);
      if (!result.success) {
        if (this.pendingPermissionMode?.requestId === requestId) this.pendingPermissionMode = null;
        this._toastError('acpFailure.changeSetting', result.error);
        return null;
      }
      if (result.data.status === 'restart_required') {
        if (this.pendingPermissionMode?.requestId === requestId) this.pendingPermissionMode = null;
        return { kind: 'restart-required', requestedValue: result.data.requestedValue };
      }
      if (result.data.status === 'applied') {
        if (this.pendingPermissionMode?.requestId === requestId) this.pendingPermissionMode = null;
        // 落库的是 provider **确认回来的**那一档(effectiveValue),❌ 不是我们发出去的那个。
        await this._recordLiveSetting({ dimension: 'permission', modeId: result.data.effectiveValue });
      }
      if (result.data.status === 'pending_next_turn') {
        return null;
      }
      return null;
    } catch (error: unknown) {
      if (this.pendingPermissionMode?.requestId === requestId) this.pendingPermissionMode = null;
      this._toastError('acpFailure.changeSetting', error);
      return null;
    }
  }

  async setEffort(effort: string): Promise<LiveSettingOutcome> {
    if (!this.session && this.starting) {
      const outcome = await this._chooseAtStartup('effort', effort, 'acpFailure.changeSetting');
      if (outcome?.kind === 'applied') {
        await this._recordLiveSetting({ dimension: 'effort', value: outcome.effectiveValue });
      }
      return outcome;
    }
    const session = this._requireSession('acpFailure.changeSetting');
    if (!session) return null;
    try {
      const result = await session.setModelOption('effort', effort);
      if (result.success && result.data.status === 'applied') {
        await this._recordLiveSetting({ dimension: 'effort', value: result.data.effectiveValue });
      }
      return this._settleLiveSetting('acpFailure.changeSetting', result);
    } catch (error: unknown) {
      this._toastError('acpFailure.changeSetting', error);
      return null;
    }
  }

  resolvePermission(requestId: string, optionId: string): void {
    const session = this._requireSession('acpFailure.resolvePermission');
    if (!session) return;
    void session
      .resolvePermission(requestId, optionId)
      .then((result) => {
        if (!result.success) this._toastError('acpFailure.resolvePermission', result.error);
      })
      .catch((error: unknown) => this._toastError('acpFailure.resolvePermission', error));
  }

  async editQueuedPrompt(id: string, text: string, queueEdit?: QueuedPromptEdit | null): Promise<boolean> {
    const session = this._requireSession('acpFailure.editQueued');
    if (!session) return false;
    const existing = session.sessionState.current().queuedPrompts.find((prompt) => prompt.id === id);
    if (!existing) return false;
    const input: PromptInput = {
      text, hiddenContext: existing.hiddenContext, attachments: existing.attachments,
      ...(existing.origin ? { origin: existing.origin } : {}),
    };
    try {
      const result = await session.editQueuedPrompt(id, input, queueEdit);
      if (!result.success) this._toastError('acpFailure.editQueued', result.error);
      return result.success;
    } catch (error: unknown) {
      this._toastError('acpFailure.editQueued', error);
      return false;
    }
  }

  async beginQueuedPromptEdit(id: string): Promise<void> {
    if (this.queueEditPending || this.queuedPromptEdit) return;
    const prompt = this._queuedPromptModels().find((entry) => entry.id === id);
    if (!prompt) return;
    this.queueEditPending = true;
    try {
      await this.editQueuedPrompt(id, prompt.text, { draftText: prompt.text, originalDraftText: this.draftText });
    } finally {
      runInAction(() => { this.queueEditPending = false; });
    }
  }

  changeQueuedPromptEdit(text: string): void {
    const edit = this.queuedPromptEdit;
    if (!edit || edit.pending) return;
    this.queuedEditDraft = { id: edit.id, text };
    if (this._queueEditTimer !== null) clearTimeout(this._queueEditTimer);
    this._queueEditTimer = setTimeout(() => {
      this._queueEditTimer = null;
      const current = this.queuedPromptEdit;
      const prompt = this._queuedPromptModels().find((entry) => entry.id === edit.id);
      if (!current || current.id !== edit.id || !prompt) return;
      void this.editQueuedPrompt(edit.id, prompt.text, {
        draftText: current.text, originalDraftText: current.originalDraftText,
      });
    }, 300);
  }

  async finishQueuedPromptEdit(text: string | null): Promise<void> {
    const edit = this.queuedPromptEdit;
    if (!edit || edit.pending || (text !== null && !text.trim())) return;
    const prompt = this._queuedPromptModels().find((entry) => entry.id === edit.id);
    if (!prompt) return;
    if (this._queueEditTimer !== null) clearTimeout(this._queueEditTimer);
    this._queueEditTimer = null;
    this.queueEditPending = true;
    try {
      const saved = await this.editQueuedPrompt(edit.id, text ?? prompt.text, null);
      if (saved) runInAction(() => { this.queuedEditDraft = null; });
    } finally {
      runInAction(() => { this.queueEditPending = false; });
    }
  }

  deleteQueuedPrompt(id: string): void {
    const session = this._requireSession('acpFailure.editQueued');
    if (!session) return;
    void session
      .deleteQueuedPrompt(id)
      .then((result) => {
        if (!result.success) this._toastError('acpFailure.editQueued', result.error);
      })
      .catch((error: unknown) => this._toastError('acpFailure.editQueued', error));
  }

  reorderQueuedPrompts(ids: string[]): void {
    const session = this._requireSession('acpFailure.editQueued');
    if (!session) return;
    const current = session.sessionState.current().queuedPrompts;
    const visibleIds = current.filter(isVisibleQueuedPrompt).map((prompt) => prompt.id);
    if (ids.length !== visibleIds.length || ids.some((id) => !visibleIds.includes(id))) {
      this._toastError('acpFailure.editQueued', new Error('Visible queue ids do not match visible prompts'));
      return;
    }
    const byId = new Map(current.map((prompt) => [prompt.id, prompt]));
    const visibleSlots = current
      .map((prompt, index) => (isVisibleQueuedPrompt(prompt) ? index : -1))
      .filter((index) => index >= 0);
    const reordered = [...current];
    visibleSlots.forEach((slot, index) => {
      const prompt = byId.get(ids[index]);
      if (!prompt) return;
      reordered[slot] = prompt;
    });
    void session
      .changeQueuePromptOrder(reordered.map((prompt) => prompt.id))
      .then((result) => {
        if (!result.success) this._toastError('acpFailure.editQueued', result.error);
      })
      .catch((error: unknown) => this._toastError('acpFailure.editQueued', error));
  }

  /** `steers`:这家能插话(#6574)⇒ 交给运行时插进当前回合;否则挪到队首,在跑就取消当前回合。 */
  sendQueuedPromptNow(id: string, opts: { steers: boolean }): void {
    void this._sendQueuedPromptNow(id, opts.steers);
  }

  exportTranscript(kind: 'parsed' | 'raw'): void {
    void this._exportTranscript(kind);
  }

  dispose(): void {
    if (this._queueEditTimer !== null) clearTimeout(this._queueEditTimer);
    this._queueEditTimer = null;
    if (this._disposed) return;
    this._disposed = true;
    unregisterSessionCommands(this.runtimeSessionId);
    if (this._draftTimer !== null) {
      window.clearTimeout(this._draftTimer);
      this._draftTimer = null;
    }
    this._unsubs.splice(0).forEach((unsub) => unsub());
    if (this.isTransient && this.session) void this._stopTransientSession(this.session);
    this.session?.dispose();
    this.chatState.dispose();
  }

  /**
   * 每次开场前把历史相关的状态清回初值(#5381 评审 #4)。
   *
   * `retry()` / `reattachAfterHostReload()` 都会重跑开场;不清的话,上一次翻出来的旧页和这次新读的
   * 库页之间会断档(中间又聊了几轮),游标重置后再往上翻又和旧页重叠 —— 同一批回合出现两遍。
   */
  private _resetHistoryState(): void {
    this._historyGeneration += 1;
    this._storedHistoryTurns = [];
    this._storedOrigins = [];
    this._storedBaseSeq = null;
    this._storedBootstrapMaxSeq = -1;
    this._persistedRuntimeTurnIds = new Set<string>();
    this._runtimeReplayEndSeq = 0;
    this._runtimeWindowStartSeq = 0;
    this._runtimeTurns = [];
    this._runtimeCursor = null;
    this._runtimeCount = 0;
    this._olderHistoryTurns = [];
    this._olderCursor = undefined;
    this._olderSource = 'runtime';
  }

  /**
   * @param attachOnly 只挂上宿主**已经建立好**的那一条,不带 start 输入。
   *
   * 两种形状的区别不是省一次 RPC:带 start 输入的那一支是「**建立**这条会话」,主进程会在它上面
   * 重算整份会话级注入(能力包、平台凭据),而凭据轮换是**一条会话一份、新的一来就撤旧的**。
   * 所以「明明不需要建立却传了 start 输入」不是冗余,是**副作用**。谁已经建立好了,谁就该被附着,
   * ❌ 不再建立一次。
   */
  private async _runBootstrap(options?: { attachOnly?: boolean }): Promise<void> {
    runInAction(() => {
      this._bootstrapsInFlight += 1;
    });
    try {
      await this._runBootstrapInner(options);
    } finally {
      runInAction(() => {
        this._bootstrapsInFlight -= 1;
        if (this._bootstrapsInFlight === 0) this.startupChoice = {};
      });
    }
  }

  private async _runBootstrapInner(options?: { attachOnly?: boolean }): Promise<void> {
    let providerId: string | undefined;
    let bootstrapSession: AcpLiveSession | undefined;
    let firstPrompt: PendingPrompt | null = null;
    this._closedByHost = false;
    const resuming = options?.attachOnly && this._runtimeCursor != null;
    if (resuming) this._historyGeneration += 1;
    else this._resetHistoryState();
    const generation = this._historyGeneration;
    try {
      // #5381 先把库里那份画出来,不等引擎。侧边对话跳过:它的上下文开在主对话那条上,
      // 自己不该有一份历史(库里也没有它的行 —— 它的 id 是运行时视图 id)。
      //
      // ⚠️ 读库失败**不许**把会话拖垮。spec session-history-replay:「会话能用 > 历史完整」——
      // 绝不能把「少了旧消息」升级成「这个会话打不开」。网页宿主里桥可能还没装上,
      // 那时这条 rpc 会直接抛;吞掉它,照常往下走,历史退回由重放供给。
      //
      // 读到就地上屏(在 then 里,不等下面任何一步),所以哪怕起引擎这一路整条失败,
      // 用户仍然看得到自己说过的话。
      const storedHistoryReady = this.isTransient || resuming
        ? Promise.resolve()
        : this._loadStoredFirstPage(generation);

      const session = sessionRegistry
        .get(this.sessionId)
        ?.sessions.get(this.sessionId)?.data;
      if (session?.providerSessionState === 'missing') {
        // provider 那侧的会话引用永久失效了。会话**照常打开**,库里那份记录照常上屏 ——
        // 失效的是「接着聊」这件事,不是「看看我说过什么」。
        //
        // ⚠️ 这个判断此前写在上面那次读库**之前**并且直接 return,于是本机
        // `session_turns` 完好无损却一行都画不出来,用户永久看不到自己说过的话。
        // 而 `providerSessionState: 'missing'` 是**写进库的持久状态**,判据只是一个
        // `-32002` 错误码(`packages/session-core/src/acp/provider-session.ts`)——
        // 一次误判就是永久。⇒ 读库无条件先行,❌ 这一步之前不许有任何 return。
        // (spec `session-always-openable`)
        await storedHistoryReady;
        runInAction(() => {
          this.historyLoading = false;
          this.loadError = { kind: 'provider_session_missing', message: '' };
        });
        return;
      }
      // 纯附着不解析 start 输入 —— 那份输入只有「要建立」时才有意义。
      const input = options?.attachOnly ? undefined : this._startInput();
      providerId = input?.providerId ?? session?.providerId;
      // 第一条消息不等会话建立:发出那一刻就以乐观行上屏,样子与之后每条消息发出时相同(气泡 + 「处理中」)。
      // 上一次没跑起来、留在屏上的那一句同理:这次起来时运行时会先发它。
      const preview = firstPromptPreview(input);
      const held = this._heldStartupPrompt;
      firstPrompt = preview ? { ...preview, sentAt: held?.sentAt ?? Date.now() } : held;
      if (firstPrompt) {
        const prompt = firstPrompt;
        this._startupPendingIds.add(prompt.id);
        if (preview) this._firstPromptId = prompt.id;
        runInAction(() => {
          this._startupRunningId = prompt.id;
          // 留在屏上的那一句(`_holdStartupPrompt`)换回在跑的样子,❌ 同一句画两遍。
          const turns = this.chatState.transcript.state.committedTurns;
          const heldIds = new Set([heldFirstPromptTurnId(prompt), ...(held ? [heldFirstPromptTurnId(held)] : [])]);
          if (turns.some((turn) => heldIds.has(turn.id))) {
            this.chatState.transcript.history.seed(turns.filter((turn) => !heldIds.has(turn.id)));
          }
          this._heldStartupPrompt = null;
          this.chatState.session.setPendingPrompt(prompt);
          this._syncMessageCount();
        });
      }
      // 起引擎与读库**并行**:两件事互不依赖。❌ 不许把 spawn 排在一次读之后 ——
      // 本机库读起来接近零延迟,会把这个串行藏得看不见,换到读得慢的那一侧(库大、盘忙、
      // 将来换成非本机的存储)它就是白等的一段,而 spec 要求会话启动不被任何东西挡住。
      const clientSessionReady = AcpLiveSession.create(this.runtimeSessionId, input);
      // 引擎这一路的错误统一在下面 await 时抛;这里只是别让它在等库期间变成未处理拒绝。
      clientSessionReady.catch(() => {});

      // 等它只为拿到 `_storedHistoryTurns` 的终值(下面去重要用),上屏在上面就做过了。
      await storedHistoryReady;
      const clientSession = await clientSessionReady;
      bootstrapSession = clientSession;

      if (resuming) {
        const delta = await this._mergeRuntimeChanges(clientSession, generation);
        if (this._disposed || generation !== this._historyGeneration) {
          clientSession.dispose();
          return;
        }
        if (delta && 'reset' in delta) {
          // Like the phone timeline, a different host epoch invalidates the cursor.
          clientSession.dispose();
          this._runtimeCursor = null;
          return this._runBootstrapInner(options);
        }
        if (delta) throw resultError(delta.error);
      } else {
        // 库里非空时引擎那一页只用来定分界(最后一轮的 seq)和改动游标:要一轮就够,❌ 要 100 轮再整页丢掉。
        const history = await clientSession.getHistory(undefined, this._storedBaseSeq === null ? 100 : 1);
        if (!history.success) throw resultError(history.error);
        // A spawned child has a durable first utterance. Once its ACP cell is ready and idle,
        // an empty history is a record-integrity failure, not a valid empty conversation. Surface it
        // instead of rendering a silent blank panel (the old Claude rendezvous bypass shape, #4949).
        const childSession = session?.spawnedBySessionId;
        const stateAfterLoad = clientSession.sessionState.current();
        if (
          childSession
          && session?.firstUtterance
          && history.data.turns.length === 0
          && stateAfterLoad.lifecycle === 'ready'
          && !stateAfterLoad.isGenerating
          && stateAfterLoad.queuedPrompts.length === 0
        ) {
          throw new Error('Spawned session is ready but its ACP transcript is empty; reload the session to recover provider history.');
        }
        // `reattachAfterHostReload()` 不看「上一次开场跑完没有」就重跑一次开场(#5550 那条路本来
        // 就该重挂)⇒ 慢的那次会在快的那次**之后**回到这里。没有这道代次闸的话,它会把自己那份
        // 陈的 history + 陈的 session handle 提交进 `this.session`,而界面上选中的是新的那条。
        if (this._disposed || generation !== this._historyGeneration) {
          if (this.isTransient) await this._stopTransientSession(clientSession);
          clientSession.dispose();
          return;
        }
        if (this._visualEvidenceOverride) {
          clientSession.dispose();
          return;
        }

        // 开场时引擎已有的回合,库里那份已经覆盖(重放回来的、或面板重挂前聊过的);之后新增的按 seq 认。
        const lastRuntimeSeq = history.data.turns.at(-1)?.seq;
        this._runtimeReplayEndSeq = lastRuntimeSeq === undefined ? 0 : lastRuntimeSeq + 1;
        this._runtimeCursor = history.data.cursor;
        this._runtimeCount = history.data.count;
        if (this._storedBaseSeq === null) {
          // 库里为空 ⇒ 引擎是唯一来源,往上翻也只能翻它;之后的对账并进这一页。
          this._olderSource = 'runtime';
          this._olderCursor = history.data.nextCursor;
          this._runtimeWindowStartSeq = history.data.turns[0]?.seq ?? 0;
          this._runtimeTurns = history.data.turns;
        } else {
          // 评审 #3:引擎就绪后**再读一次库**。读库与起引擎并行,开场那一刻恰好提交的那一轮可能
          // 引擎里已有、第一次读库时还没落盘 —— 它的 seq 落在分界之前,引擎那侧不会再出它,只能靠这里带出来。
          await this._reloadStoredTail(generation);
          if (this._disposed || generation !== this._historyGeneration) {
            clientSession.dispose();
            return;
          }
        }
      }
      const visibleTurns = this._composedHistory();

      runInAction(() => {
        this.session?.dispose();
        this.session = clientSession;
        this.chatState.transcript.history.seed(visibleTurns);
        this._subscribeLiveSession(clientSession);
        // 引擎就绪时首轮已经开出(活动轮接过了乐观行)或已讲完(在历史里);仍挂着就是它还排在运行时队列里,
        // 由队列那一格显示 —— 再留着就是同一句话画两遍。连上之前排进去的那几句同理,换成运行时那份真队列。
        this._handOffStartupPreviews();
        this._applyDraftSnapshot(clientSession.draft.current());
        this.historyLoading = false;
        this.loadError = null;
        this._syncMessageCount();
      });
    } catch (error) {
      if (this.isTransient && bootstrapSession) {
        await this._stopTransientSession(bootstrapSession);
        bootstrapSession.dispose();
      }
      if (this._disposed || generation !== this._historyGeneration) {
        if (generation !== this._historyGeneration) bootstrapSession?.dispose();
        return;
      }
      if (this._visualEvidenceOverride) {
        bootstrapSession?.dispose();
        return;
      }
      if (this._stoppedStartGeneration === generation) {
        // 用户在会话建立途中按了停止:这次「起不来」是他要的 —— ❌ 说失败。停下的那一句已经按停掉的一轮
        // 留在对话里(`_stopStartup`);下一句照首次打开那条路重新起。
        log.info('ACP session start stopped by the user', { sessionId: this.sessionId });
        runInAction(() => {
          this.historyLoading = false;
          this.loadError = null;
        });
        return;
      }
      const loadError = toLoadError(error);
      const details = {
        sessionId: this.sessionId,
        projectId: this.projectId,
        error,
      };
      if (loadError.kind === 'provider_session_missing') {
        log.info('ACP provider session is missing', details);
      } else {
        log.error('ACP chat bootstrap failed', details);
      }
      runInAction(() => {
        this.historyLoading = false;
        this.loadError = loadError;
        // 在「处理中」的那一句(第一条,或连上之前发的那句)不再显示在跑,留在屏上;原因与去路在它下面。
        const pending = this.chatState.session.state.pendingPrompt;
        this._holdStartupPrompt(pending && this._startupPendingIds.has(pending.id) ? pending : null);
        this._syncMessageCount();
      });
      if (this.loadError?.kind === 'auth_required' && providerId) {
        void this._refreshAuthStatus(providerId);
      }
    }
  }

  private async _stopTransientSession(session: AcpLiveSession): Promise<void> {
    try {
      const result = await session.stop();
      if (!result.success) {
        log.warn('Failed to stop runtime-only side chat', {
          sessionId: this.sessionId,
          runtimeSessionId: this.runtimeSessionId,
          error: result.error,
        });
      }
    } catch (error) {
      log.warn('Failed to stop runtime-only side chat', {
        sessionId: this.sessionId,
        runtimeSessionId: this.runtimeSessionId,
        error,
      });
    }
  }


  private async _refreshAuthStatus(providerId: string): Promise<void> {
    try {
      const client = await getAgentConfigRuntimeClient(machineRegistry.machineOf(this.runtimeSessionId));
      const result = await client.refreshAuthStatus({ providerId });
      if (!result.success) {
        log.warn('Failed to refresh agent auth status after ACP auth error', {
          providerId,
          error: result.error,
        });
      }
    } catch (error) {
      log.warn('Failed to refresh agent auth status after ACP auth error', {
        providerId,
        error,
      });
    }
  }

  private _startInput() {
    const session = sessionRegistry
      .get(this.sessionId)
      ?.sessions.get(this.sessionId)?.data;
    if (!session) throw new Error('Session not found');

    const page = asProvisioned(getSessionPageStore(this.projectId, this.sessionId));
    if (!page?.workspaceId) throw new Error('No workspace found for session');

    const workspace = workspaceRegistry.get(this.projectId, page.workspaceId);
    if (!workspace) throw new Error('Workspace not found');

    const initialQueue =
      session.providerSessionId === undefined && session.initialQueue?.length
        ? toJS(session.initialQueue)
        : undefined;

    // 两种分叉在这条载荷上的区别就是**带不带 `sourceConversationId`**,运行时靠它分路:
    //  · 运行时分叉(侧边聊天)= 带 —— 不落库、不进会话列表,产出的 id 就是来源的。
    //  · 持久分叉(spec session-fork-share 的 fork)= 不带 —— 走 `session/fork` 拿一个
    //    **独立**的新 id 落进这条会话,此后它就是一条普通 ACP 会话。
    // ⚠️ 持久分叉只在**还没认领首启**时发起:`sessionId` 一旦有值,分叉早已发生过,
    //    再发一次就会凭空多出一条分叉。
    const persistentForkFromProviderSessionId =
      !this.runtimeView && session.providerSessionId == null
        ? session.forkFromProviderSessionId
        : undefined;

    return {
      sessionId: this.runtimeSessionId,
      ...(this.runtimeView
        ? {
            sourceSessionId: this.sessionId,
            forkFromProviderSessionId: this.runtimeView.forkFromProviderSessionId,
          }
        : persistentForkFromProviderSessionId
          ? { forkFromProviderSessionId: persistentForkFromProviderSessionId }
          : {}),
      projectId: this.projectId,
      providerId: session.providerId,
      workspaceId: page.workspaceId,
      cwd: workspace.path,
      providerSessionId: session.providerSessionId ?? null,
      ...(session.startupOrigin ? { startupOrigin: session.startupOrigin } : {}),
      ...(session.initialMessageId ? { initialMessageId: session.initialMessageId } : {}),
      ...(session.taskChatId ? { taskChatId: session.taskChatId } : {}),
      model: session.model ?? null,
      effort: session.effort ?? null,
      // Runtime translates this intent after session/new exposes provider mode ids and before
      // initialQueue can start. ⚠️ session/load 上**同样**重新下发(session-manager
      // applyConfiguredPermissionMode)⇒ 记录必须是用户最后确认的那一档,见 _recordLiveSetting。
      // 缺省按编辑档;❌ 别把缺省当 read-only,那会把存量会话静默降权。
      permissionMode: resolveSessionPermissionMode(session),
      ...(initialQueue && { initialQueue }),
    };
  }

  private _queuedPromptModels(): QueuedPrompt[] {
    return this.session?.sessionState.current().queuedPrompts ?? [];
  }

  private async _sendQueuedPromptNow(id: string, steers: boolean): Promise<void> {
    const session = this._requireSession('acpFailure.sendMessage');
    if (!session) return;
    const current = session.sessionState.current().queuedPrompts;
    if (!current.some((prompt) => prompt.id === id)) return;

    if (steers) {
      // 在不在跑由运行时当场判:这里读到的「在跑」可能已经过时,插不进就留在队首。
      const steerResult = await session.steerQueuedPrompt(id);
      if (!steerResult.success) this._toastError('acpFailure.sendMessage', steerResult.error);
      return;
    }

    const ids = [id, ...current.map((prompt) => prompt.id).filter((promptId) => promptId !== id)];
    const reorderResult = await session.changeQueuePromptOrder(ids);
    if (!reorderResult.success) {
      this._toastError('acpFailure.sendMessage', reorderResult.error);
      return;
    }

    if (!this.affordances.isWorking) return;
    const cancelResult = await session.cancelTurn();
    if (!cancelResult.success) {
      this._toastError('acpFailure.sendMessage', cancelResult.error);
    }
  }

  private async _exportTranscript(kind: 'parsed' | 'raw'): Promise<void> {
    const session = this.session;
    if (!session) {
      this._toastError('acpFailure.exportTranscript', new Error('Chat is not loaded.'));
      return;
    }

    try {
      const result =
        kind === 'raw' ? await session.exportRawAcpLog() : await session.exportTranscript();
      if (!result.success) {
        this._toastError('acpFailure.exportTranscript', result.error);
        return;
      }

      const label = kind === 'raw' ? 'raw ACP log' : 'parsed transcript';
      const suffix = kind === 'raw' ? 'acp-raw' : 'transcript';
      const saved = await rpc.app.saveTextFile({
        title: `Export ${label}`,
        defaultPath: `${this.sessionId}-${suffix}.json`,
        content: result.data,
      });
      if (!saved.success) {
        this._toastError('acpFailure.exportTranscript', new Error(saved.error));
        return;
      }
      if (!saved.path) return;
      toast({ title: `Exported ${label}` });
    } catch (error) {
      this._toastError('acpFailure.exportTranscript', error);
    }
  }

  private _subscribeLiveSession(session: AcpLiveSession): void {
    this._unsubs.splice(0).forEach((unsub) => unsub());
    const initialState = session.sessionState.current();
    let refreshingChildren = false;
    let childrenChanged = false;
    let unsubscribed = false;
    const refreshChildHistory = async (): Promise<void> => {
      childrenChanged = true;
      if (refreshingChildren) return;
      refreshingChildren = true;
      try {
        while (childrenChanged && !unsubscribed) { childrenChanged = false; await this._refreshHistory({ preserveLiveTurn: true }); }
      } finally { refreshingChildren = false; }
    };
    this._unsubs.push(() => { unsubscribed = true; }, session.agents.onChange((agents) => {
      if (agents.some((agent) => agent.subagentSessionId && agent.launchTurnId !== session.activeTurn.current()?.id)) {
        void refreshChildHistory();
      }
    }));
    this._lastQueuedPrompts = [...initialState.queuedPrompts];
    this._lastActiveTurnId = initialState.activeTurnId;
    runInAction(() => this._syncRuntimeBackgroundTaskIds(initialState));
    const disconnectChatSession = connectSession(
      this.chatState,
      {
        activeTurn: asValueSource(session.activeTurn),
        plan: asValueSource(session.plan),
        sessionState: asValueSource(session.sessionState),
      },
      {
        onTurnCommitted: () => {
          // 旁听口(别的机器上的会话里发现端口,见 session-output-observers.ts):刚提交的就是此刻保留的那一帧。
          notifyCommittedTurn(
            { projectId: this.projectId, sessionId: this.sessionId },
            this.chatState.transcript.state.activeTurnSnapshot
          );
          void this._refreshHistory();
        },
      }
    );
    this._unsubs.push(
      disconnectChatSession,
      this._bindTerminalOutputs(session),
      session.sessionState.onChange(() =>
        runInAction(() => {
          const next = session.sessionState.current();
          const startedNewTurn =
            next.activeTurnId !== null && next.activeTurnId !== this._lastActiveTurnId;
          const removedManual = this._lastQueuedPrompts.find(
            (prompt) =>
              prompt.origin === 'manual'
              && !next.queuedPrompts.some((current) => current.id === prompt.id)
          );
          const active = session.activeTurn.current();
          if (
            startedNewTurn
            && removedManual
            && !containsUserPrompt(active, removedManual)
          ) {
            // The queue and active turn are separate live models. Keep the stable queue id visible
            // for the few frames between their updates; the authoritative active turn replaces it.
            this.chatState.transcript.activeTurn.set(queuedPromptTurn(removedManual));
          }
          this._lastQueuedPrompts = [...next.queuedPrompts];
          this._lastActiveTurnId = next.activeTurnId;
          this._syncRuntimeBackgroundTaskIds(next);
          if (next.lifecycle === 'lost') this._onSessionLost(next);
          if (next.lifecycle === 'closed') this._onSessionClosedByHost(session);
          this._syncMessageCount();
        })
      ),
      // #7327 运行时进程重启过(本机 worker 被拉起、server 升级重起账号进程):新进程里没有这条会话,
      // 旧进程也没来得及发 `closed`。重连时这份状态被拒(NOT_FOUND)就是那句话 —— 与宿主停掉是同一个状态。
      // 少了这一行,句柄指着不存在的会话:打一个字被拒一次「草稿没存上」,发出去的那句停在「处理中」。
      session.sessionState.onGone(() =>
        runInAction(() => this._onSessionClosedByHost(session))
      ),
      session.sessionState.onChange(() =>
        runInAction(() => {
          this._syncMessageCount();
        })
      ),
      session.activeTurn.onChange(() => runInAction(() => this._syncMessageCount())),
      session.draft.onChange((draft) =>
        runInAction(() => {
          this._applyDraftSnapshot(draft);
        })
      )
    );
  }

  private _scheduleDraftWrite(text: string, rev: number): void {
    if (this._draftTimer !== null) window.clearTimeout(this._draftTimer);
    this._draftTimer = window.setTimeout(() => {
      this._draftTimer = null;
      const draft = { rev, input: text.trim().length > 0 ? { text } : null };
      // Before ACP bootstrap completes the draft is local to this store. Persisting it through
      // the absent session would emit a false "Failed to sync draft" error while the startup
      // queue is explicitly holding user input.
      if (this.canQueueBeforeSession) return;
      const session = this._requireSession('acpFailure.syncDraft');
      if (!session) return;
      void session
        .setPromptDraft(draft)
        .then((result) => {
          if (!result.success) this._toastError('acpFailure.syncDraft', result.error);
          if (result.success && draft.input === null && this._pendingDraftRev === rev) {
            runInAction(() => {
              this._pendingDraftRev = null;
            });
          }
        })
        .catch((error: unknown) => this._toastError('acpFailure.syncDraft', error));
    }, 300);
  }

  private _applyDraftSnapshot(draft: PromptDraft | null | undefined): void {
    if (draft === undefined) return;
    if (draft === null) {
      if (this._preserveComposerDraft) {
        if (this.draftText.trim()) {
          this._draftRev += 1;
          this._pendingDraftRev = this._draftRev;
          this._scheduleDraftWrite(this.draftText, this._draftRev);
        }
        return;
      }
      if (this._pendingDraftRev === null) {
        this._draftRev += 1;
        this.draftText = '';
      }
      return;
    }

    if (this._pendingDraftRev !== null) {
      if (draft.rev >= this._pendingDraftRev) {
        this._draftRev = Math.max(this._draftRev, draft.rev);
        this._pendingDraftRev = null;
      }
      return;
    }

    if (draft.rev >= this._draftRev) {
      this._draftRev = draft.rev;
      this.draftText = draft.text;
    }
  }

  private _bindTerminalOutputs(session: AcpLiveSession): () => void {
    return bindSessionTerminalOutputs(
      session,
      (terminalId, text) => this.chatState.session.setTerminalOutput(terminalId, text),
      (terminalId, exitStatus) =>
        this.chatState.session.setTerminalExitStatus(terminalId, exitStatus)
    );
  }

  /** 库里最新那一页(100 轮),读到就地上屏。读失败只记日志 —— 历史退回由重放供给(见开场处的注释)。 */
  private _loadStoredFirstPage(generation: number): Promise<void> {
    return rpc.sessions
      .getStoredHistory({ sessionId: this.sessionId, limit: 100 })
      .then((stored) => {
        if (stored.turns.length === 0 || this._disposed) return;
        if (generation !== this._historyGeneration) return;
        runInAction(() => {
          this._storedHistoryTurns = stored.turns;
          this._storedOrigins = stored.originTurnIds;
          this._storedBaseSeq = stored.turns[0]!.seq;
          this._storedBootstrapMaxSeq = stored.turns.at(-1)!.seq;
          // 往上翻从这里接着翻:库里那份是完整的,一直翻它。
          this._olderSource = 'stored';
          this._olderCursor = stored.nextCursor;
          this.chatState.transcript.history.seed(stored.turns);
          this.historyLoading = false;
        });
      })
      .catch((error: unknown) => {
        log.warn('stored session history unavailable; falling back to replay', {
          sessionId: this.sessionId,
          error,
        });
      });
  }

  private _visibleHistoryTurns(turns: TranscriptTurn[]): TranscriptTurn[] {
    // 分叉重放进来的来源历史是给模型的上下文,不画;挂上之前就从这个视图开出来的那一轮照画(#6762)。
    return this.isTransient ? sideChatOwnTurns(turns) : turns;
  }

  /**
   * 上屏用的完整历史 = 往上翻出来的 + 库里那份 + 引擎里还没落库的(#5381)。
   * 判重按身份(seq 分界 + 运行时原始 turn id),❌ 不按条数 —— 规则与理由见 `composeHistoryTurns`。
   */
  private _composedHistory(): TranscriptTurn[] {
    return composeHistoryTurns({
      stored: this._storedHistoryTurns,
      runtime: this._visibleHistoryTurns(this._runtimeTurns),
      runtimeReplayEndSeq: this._runtimeReplayEndSeq,
      persistedRuntimeTurnIds: this._persistedRuntimeTurnIds,
      older: this._olderHistoryTurns,
    });
  }

  /** 还能不能往上翻。到头(游标为 null)或还没定下来来源时都是 false。 */
  get canLoadOlderHistory(): boolean {
    return typeof this._olderCursor === 'number';
  }

  /**
   * 往上翻一页(#5381)。返回**这一页**由旧到新的回合,交给视图 `loadOlder()` 去 prepend
   * (它会把滚动位置钉住);同时留在 store 里参与下一次合成。
   *
   * ⚠️ 翻不动**不是错误**:到顶是常态,一条短会话第一次滚到顶就该安静地什么都不做,
   * ❌ 不弹 toast。真出错(桥没装上、库读不了)也只记一行日志并停在原地 ——
   * spec `session-history-replay`:「会话能用 > 历史完整」,翻不到旧消息不该升级成一个坏掉的会话。
   */
  async loadOlderHistory(): Promise<TranscriptTurn[]> {
    if (this._loadingOlder || this._disposed) return [];
    const generation = this._historyGeneration;
    const before = this._olderCursor;
    if (typeof before !== 'number') return [];
    this._loadingOlder = true;
    try {
      const page =
        this._olderSource === 'stored'
          ? await rpc.sessions.getStoredHistory({
              sessionId: this.sessionId,
              before,
              limit: 100,
            })
          : await this._runtimeOlderPage(before);
      if (!page || this._disposed || generation !== this._historyGeneration) return [];
      runInAction(() => {
        this._olderCursor = page.nextCursor;
        if (page.turns.length > 0) {
          this._olderHistoryTurns = [...page.turns, ...this._olderHistoryTurns];
        }
      });
      return page.turns;
    } catch (error) {
      log.warn('failed to load older session history', {
        sessionId: this.sessionId,
        source: this._olderSource,
        error,
      });
      return [];
    } finally {
      this._loadingOlder = false;
    }
  }

  private async _runtimeOlderPage(
    before: number
  ): Promise<{ turns: TranscriptTurn[]; nextCursor: number | null } | null> {
    const session = this.session;
    if (!session) return null;
    const history = await session.getHistory(before, 100);
    if (!history.success) return null;
    return { turns: history.data.turns, nextCursor: history.data.nextCursor };
  }

  /**
   * 开场时补读一次库里「开场那一页之后」新落库的行(#5381 评审 #3):读库与起引擎并行,开场那一刻恰好提交的那一轮
   * 可能引擎里已有、第一次读库时还没落盘 —— 它的 seq 落在分界之前,引擎那侧不会再出它,只能靠这里带出来。
   * 只读 `_storedBootstrapMaxSeq` 之后的那几行并接在后面,❌ 从开场那页第一行整段重读。
   *
   * 读失败**不许**把会话拖垮:沿用已有的那份,只记日志 —— spec「会话能用 > 历史完整」。
   */
  private async _reloadStoredTail(generation: number): Promise<void> {
    if (this._storedBaseSeq === null || this.isTransient) return;
    try {
      const page = await rpc.sessions.getStoredHistory({
        sessionId: this.sessionId,
        fromSeq: this._storedBootstrapMaxSeq + 1,
      });
      if (this._disposed || generation !== this._historyGeneration || page.turns.length === 0) return;
      runInAction(() => {
        this._storedHistoryTurns = [...this._storedHistoryTurns, ...page.turns];
        this._storedOrigins = [...this._storedOrigins, ...page.originTurnIds];
        // 这几行来自引擎的哪几轮:引擎那侧据此不再重复出它们。
        this._persistedRuntimeTurnIds = new Set([...this._persistedRuntimeTurnIds, ...page.originTurnIds]);
      });
    } catch (error) {
      log.warn('stored session history reload failed; keeping the previous read', {
        sessionId: this.sessionId,
        error,
      });
    }
  }

  /**
   * 按改动游标并进引擎那侧新增 / 改过的回合(@@@history-change-cursor)。分界之后的直接并进手里那份;更早的那一轮
   * 被改了(后台命令的终态、子智能体的进展改的是起它的那一轮),它画的是库里那一行 —— 只重读那一行。
   * @returns 读失败时的那个结果(调用方弹错),成功为 null。
   */
  private async _mergeRuntimeChanges(session: AcpLiveSession, generation: number): Promise<{ error: unknown } | { reset: true } | null> {
    const changes = await session.getHistory(undefined, 100, this._runtimeCursor ?? undefined);
    if (!changes.success) return { error: changes.error };
    if (generation !== this._historyGeneration) return null;
    if (changes.data.reset) return { reset: true };
    const floor = this._storedBaseSeq !== null ? this._runtimeReplayEndSeq : this._runtimeWindowStartSeq;
    const bySeq = new Map(this._runtimeTurns.map((turn) => [turn.seq, turn]));
    const olderRevised: TranscriptTurn[] = [];
    for (const turn of changes.data.turns) {
      if (turn.seq >= floor) bySeq.set(turn.seq, turn);
      else olderRevised.push(turn);
    }
    // 回合数变少 = 有回合被拿掉了(回退、分叉):手里比它多出来的那几轮不再画。
    if (changes.data.count < this._runtimeCount) {
      for (const seq of [...bySeq.keys()]) if (seq >= changes.data.count) bySeq.delete(seq);
    }
    const storedRows = olderRevised.length > 0 && this._storedBaseSeq !== null
      ? await this._rereadStoredRows(olderRevised.map((turn) => turn.id))
      : [];
    if (generation !== this._historyGeneration) return null;
    runInAction(() => {
      this._runtimeTurns = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
      this._runtimeCursor = changes.data.cursor;
      this._runtimeCount = changes.data.count;
      if (this._storedBaseSeq === null) {
        // 库里为空:更早的轮是往上翻出来的引擎页,按 seq 换掉。
        const revised = new Map(olderRevised.map((turn) => [turn.seq, turn]));
        if (revised.size > 0) this._olderHistoryTurns = this._olderHistoryTurns.map((turn) => revised.get(turn.seq) ?? turn);
      }
      for (const { index, turn } of storedRows) {
        const next = [...this._storedHistoryTurns];
        next[index] = turn;
        this._storedHistoryTurns = next;
      }
    });
    return null;
  }

  /** 引擎这几轮(运行时原始 turn id)在库里的那一行各重读一遍:同一个原始 id 取最后那一行,与落库时改哪一行同一个判据。 */
  private async _rereadStoredRows(originIds: string[]): Promise<Array<{ index: number; turn: TranscriptTurn }>> {
    const rows: Array<{ index: number; turn: TranscriptTurn }> = [];
    for (const origin of originIds) {
      const index = this._storedOrigins.lastIndexOf(origin);
      const seq = index >= 0 ? this._storedHistoryTurns[index]?.seq : undefined;
      if (seq === undefined) continue;
      try {
        const page = await rpc.sessions.getStoredHistory({ sessionId: this.sessionId, before: seq + 1, limit: 1 });
        const turn = page.turns[0];
        if (turn?.seq === seq) rows.push({ index, turn });
      } catch (error) {
        log.warn('stored session row reread failed; keeping the previous read', { sessionId: this.sessionId, seq, error });
      }
    }
    return rows;
  }

  /**
   * 会话刚刚死了(适配器非正常退出)。
   *
   * ⚠️ **必须在这里重读一次历史,否则最后一轮的说辞会停在半路上**(#5858)。
   *
   * 时序(真机实测,mac1 2026-09-20,回合中途 kill -9):连接塌掉先让在飞的 `session/prompt`
   * 抛「ACP connection closed」⇒ 运行时把那一轮落成 `prompt_failed` ⇒ 这一侧照常重读一次
   * (`onTurnCommitted`)⇒ **毫秒之后**运行时才收到进程的 exit,据此把**同一轮**改口成
   * `process_closed` + 退出码/信号/stderr 尾巴。
   *
   * 而把新历史送过来的那条路(运行时的 `emitCommittedTurns`)**只发新增的那几轮** ——
   * 改口不改变轮数,于是它一条都不发,这一侧就永远停在改口之前那句「这条指令没能送达」上
   * (而指令其实送达了,是引擎死了)。运行时那边是对的,缺的只是这一侧再问一次。
   *
   * ⇒ 「会话刚死」是一个**明确的事件**,不是轮询:它恰好就是最后一轮可能被改口的那一刻。
   * ❌ 不用定时器、❌ 不做无条件轮询。判据见 `acp-chat-store.superseded-outcome-5858.test.ts`
   * (把下面那次 `_refreshHistory` 删掉,它会红)。
   */
  /**
   * #6497 宿主把这条会话**故意**停掉了:归档、切到编程模式、父会话 `session_stop`、远程 / 扩展停止。
   * 运行时在 dispose 这条会话的 live 实例之前,最后发出的 state 是 `closed`(与 `lost` 不同:那是
   * 适配器意外退出,要给「重连」;这里没有故障可报)。运行时进程整个重启过时没有人发 `closed`,
   * 由状态副本的 `onGone` 走到这里(#7327)—— 新进程里同样没有这条会话,同样等下一句再起。
   *
   * 这条会话此刻在运行时里不存在 —— 拿它当活会话,下一句发出去就是「Failed to send message」、回合停在 Working
   * (mac1 实测:session_stop 之后离开 8 s 再回来照样发不出)。⇒ 退订、`session` 置空,屏上的记录原样留着。
   *
   * ❌ 不在这里把会话重新起起来:停是宿主的本意 —— 归档了、切到编程腿了、被父会话停了,
   * 聊天面自己把它拉起来就是在违背那个决定(切到编程腿时还会和伪终端那条腿同时活着)。
   * 起它的是用户的下一句(`_queuePromptDuringStartup`),或者宿主自己(定时、投递、重开):句柄的副本跟着会话 id 走
   * (session-wire @@@follow-key),宿主把它再拉起来时重新 seed,这一侧随即重挂,❌ 等人发一句(10-19 实撞)。
   */
  private _onSessionClosedByHost(closed: AcpLiveSession): void {
    if (this.session !== closed) return;
    this._unsubs.splice(0).forEach((unsub) => unsub());
    this.session = null;
    this._unsubs.push(
      // 等它起完(重放过往回合)再挂:挂在 starting / replaying 上,读到的引擎历史缺一截,补上来的回合会再画一遍。
      closed.sessionState.onChange((state) => {
        if (HOST_NOT_SETTLED.has(state.lifecycle) || this._bootstrapsInFlight > 0) return;
        runInAction(() => this.reattachAfterHostReload());
      }),
      () => closed.dispose()
    );
    this._closedByHost = true;
    this.historyLoading = false;
    this.loadError = null;
  }

  private _onSessionLost(next: { failure?: { message?: string } | null }): void {
    this.historyLoading = false;
    this.loadError = {
      kind: 'adapter_lost',
      message: next.failure?.message ?? 'ACP adapter exited unexpectedly; reconnect to continue.',
    };
    void this._refreshHistory();
  }

  /**
   * 一轮讲完后跟后端对一次账。对账期间**画面上保留着刚讲完的那一帧**（见 chat-state.syncActiveTurn）：
   * 已提交列表只由这里的 seed 填充，若提交时就把活的那一轮抹掉，这一次往返（实测 ~100ms）里
   * transcript 会整段空掉、输入框退回空会话占位再弹回来 —— 也就是「答完了反而闪一下」。
   * 拿到结果（成功或失败）都要把那一帧交还，否则它会一直压在最新内容上面。
   * 只取改动游标之后的那几轮(`_mergeRuntimeChanges`)。
   */
  private async _refreshHistory(options?: { preserveLiveTurn?: boolean }): Promise<void> {
    if (this.reverting) return;
    const refreshGeneration = this._historyGeneration;
    // 转录放掉了(`releaseTranscript`):不对账 —— 上屏时整份重读,这里读回来只会把它又攒起来。
    if (this._transcriptReleased) return;
    // 保留的那一帧就是此刻 activeTurn 上的这个对象：提交后 source.activeTurn 已是 null，
    // 不会再有人往它上面写，所以它的身份在这次往返里是稳的 —— 用身份判「还是我保留的那一帧吗」。
    const retainedFrame = this.chatState.transcript.state.activeTurnSnapshot;
    const retainedFrameId = retainedFrame?.id ?? null;
    const retainedPending = this.chatState.session.state.pendingPrompt;
    let merged = false;
    const session = this._requireSession('acpFailure.refreshHistory');
    if (session) {
      try {
        const failed = await this._mergeRuntimeChanges(session, refreshGeneration);
        if (failed && 'reset' in failed) {
          this._runtimeCursor = null;
          this.reattachAfterHostReload();
        } else if (failed) this._toastError('acpFailure.refreshHistory', failed.error);
        else merged = true;
      } catch (error) {
        // 对账本身失败也要把帧交还，否则它会一直压在最新内容上面；❌ 静默吞掉这次失败。
        log.warn('Failed to reconcile transcript after a committed turn', {
          error: error instanceof Error ? error.message : String(error),
        });
        this._toastError('acpFailure.refreshHistory', error);
      }
    }
    if (refreshGeneration !== this._historyGeneration) return;
    runInAction(() => {
      if (merged) {
        const currentFrame = this.chatState.transcript.state.activeTurnSnapshot;
        const newerFrame = (currentFrame?.id ?? null) !== retainedFrameId;
        const liveFrame = options?.preserveLiveTurn ? session?.activeTurn.current() : null;
        this.chatState.transcript.history.seed(this._composedHistory());
        // history.seed resets activeTurn by contract. If another turn started while this history
        // request was in flight, put that newer frame back instead of erasing it until commit.
        if (newerFrame && currentFrame) {
          this.chatState.transcript.activeTurn.set(currentFrame);
        } else if (liveFrame) {
          // Child progress revises committed history while a notification or another turn is still live.
          this.chatState.transcript.activeTurn.set(liveFrame);
        }
        // Do not clear a prompt that was admitted after this reconciliation started.
        if (this.chatState.session.state.pendingPrompt === retainedPending) {
          this.chatState.session.setPendingPrompt(null);
        }
      }
      // 这一百毫秒里用户可能已经开了新一轮 —— 那一轮此刻占着 activeTurn，别把它抹掉。
      if (
        (this.chatState.transcript.state.activeTurnSnapshot?.id ?? null) === retainedFrameId
        && (!options?.preserveLiveTurn || session?.activeTurn.current()?.id !== retainedFrameId)
      ) {
        this.chatState.transcript.activeTurn.set(null);
      }
      this._syncMessageCount();
    });
  }

  /** 会话连上了:连上之前画出来的那几句交给真的那一轮 / 运行时队列。 */
  private _handOffStartupPreviews(): void {
    const pending = this.chatState.session.state.pendingPrompt;
    if (pending && this._startupPendingIds.has(pending.id)) this.chatState.session.setPendingPrompt(null);
    this._startupPendingIds.clear();
    this._startupQueued = [];
    this._startupRunningId = null;
    this._heldStartupPrompt = null;
  }

  /**
   * 会话还在建立时按了停止(behavior session-page「打开速度」:这段算运行中,就能停;启动没有超时,
   * 引擎卡住时这是唯一的出口)。放弃这次启动,然后与平时停掉一轮一样收场:
   * - 第一条消息留在对话里,下面是「你停止了这一轮」(点「继续」接着跑)—— 它存在会话记录里,接着跑会先发它;
   * - 第一条之外还没发出去的那几句(运行时没替你存着)撤下、字还回输入框。
   * ❌ 说成「起不来」、❌ 弹错误:这是用户要的停。
   */
  private _stopStartup(): void {
    this._stoppedStartGeneration = this._historyGeneration;
    const unsent: string[] = [];
    const pending = this.chatState.session.state.pendingPrompt;
    if (pending && this._startupPendingIds.has(pending.id)) {
      this._stoppedPromptIds.add(pending.id);
      if (pending.id === this._firstPromptId) {
        this._holdStartupPrompt(pending, { kind: 'cancelled', reason: 'cancelled' });
      } else {
        unsent.push(pending.text);
        this.chatState.session.setPendingPrompt(null);
      }
    }
    for (const prompt of this._startupQueued) {
      this._stoppedPromptIds.add(prompt.id);
      unsent.push(prompt.text);
    }
    this._startupQueued = [];
    this._startupPendingIds.clear();
    this._startupRunningId = null;
    if (unsent.length > 0) {
      this.setDraftText([...unsent, this.draftText].filter((text) => text.trim()).join('\n\n'));
    }
    this._syncMessageCount();
    void getAcpRuntimeClient(machineRegistry.machineOf(this.runtimeSessionId))
      .then((client) => client.stopSession({ sessionId: this.runtimeSessionId }))
      .then((result) => {
        if (!result.success) this._toastError('acpFailure.stop', result.error);
      })
      .catch((error: unknown) => this._toastError('acpFailure.stop', error));
  }

  /** 只撤自己挂上的那一条:这期间换上来的乐观行(别的发送)不是它的。 */
  private _dropFirstPromptPreview(prompt: PendingPrompt | null): boolean {
    if (!prompt || this.chatState.session.state.pendingPrompt?.id !== prompt.id) return false;
    this.chatState.session.setPendingPrompt(null);
    return true;
  }

  /**
   * 首条没能跑起来(要登录、引擎没装、起不来):那句话留在屏上、不再显示在跑,原因由它下面那一行说。
   * ❌ 撤掉它 —— 用户刚说完的话凭空消失,只剩一行「去登录」。重试时首条随启动输入再发,这一句换回在跑的样子。
   */
  private _holdStartupPrompt(prompt: PendingPrompt | null, outcome?: TranscriptTurn['outcome']): void {
    if (!prompt || !this._dropFirstPromptPreview(prompt)) return;
    this._startupRunningId = null;
    this._heldStartupPrompt = prompt;
    this.chatState.transcript.history.append([
      {
        id: heldFirstPromptTurnId(prompt),
        seq: 0,
        initiator: 'user',
        ...(prompt.sentAt !== undefined ? { startedAt: prompt.sentAt } : {}),
        items: [{ kind: 'message', id: prompt.id, seq: 0, role: 'user', text: prompt.text }],
        // 用户停下的那一句:与平时停掉的一轮同一个收尾(「你停止了这一轮」+「继续」)。
        ...(outcome ? { outcome } : {}),
      } as TranscriptTurn,
    ]);
  }

  private _syncMessageCount(): void {
    const state = this.chatState.transcript.state;
    const committedCount = state.committedTurns.reduce(
      (count, turn) => count + turn.items.length,
      0
    );
    const activeCount = state.activeTurnSnapshot?.items.length ?? 0;
    const pendingPromptCount = this.chatState.session.state.pendingPrompt ? 1 : 0;
    this.messageCount = committedCount + activeCount + pendingPromptCount;
  }

  /** Keep the failure reason visible through the existing one-line sanitizer, and persist its full detail. */
  private _toastError(title: AcpFailureTitle, error: unknown): void {
    const cause = describeFailureCause(error);
    log.error('ACP chat action failed', { sessionId: this.sessionId, title, error: cause });
    toast({
      title: translateSessionMessage(title),
      description: failureText(cause ?? '', translateSessionMessage),
      variant: 'destructive',
    });
  }
}

/**
 * 把失败的**病因**取出来,供日志与弹窗共用。失败的那一轮本身由转录里「回合失败」那一行说,原文在它的详情里。
 *
 * ⚠️ 这条路上的失败大多**不是 `Error` 实例** —— 它们是 Result 的错误对象
 * (`{ type, message }`)或 ACP 的 `RequestError`。原来的写法是
 * `error instanceof Error ? error.message : undefined`,于是这些一律落成 `undefined`
 * ⇒ 用户只看到一句 `Failed to send message`,而**唯一能做的动作是重试,重试永远不会成功**
 * (owner 2026-09-07 实撞:侧边聊天第一条就失败,界面一个字的线索都没有)。
 *
 * ⇒ 不带病因的失败提示,与不报错只差一层皮:它让用户以为这是偶发。
 *
 * ⚠️ **`cause` 这一层不是锦上添花** —— ACP 那侧的失败是 `acpErr.promptFailed(cause)`,形状是
 * `{ type: 'prompt_failed', cause: SerializedError }`:它**没有** `message`,于是旧写法一路落到
 * `record.type`,弹给用户的那句描述就是字面量 `prompt_failed`。真机 A/B(chole/Windows,
 * 回合进行中杀掉 codex app-server):dev 上 toast = 「Failed to send message / prompt_failed」,
 * 带上这一层 = 「Failed to send message / ACP connection closed」。
 * `depth` 只为挡住自指的 `cause`(x.cause === x)—— 那会栈溢出,而栈溢出在渲染层是白屏。
 *
 * ⚠️ 2026-09-20(#5858):`errorDataDetail` 改宽并改名成 `errorDetail` —— 它现在把**句子和
 * 结构化负载一起**交出来,而不只是 `data` 里那半句。这一侧一个字没改:精度顺序仍然只有那一份,
 * toast 与失败回合的 `outcome.detail` 读的是同一个函数,❌ 不许在这里再抄一份。
 */
function describeFailureCause(error: unknown, depth = 0): string | undefined {
  if (depth > 3) return undefined;
  const detail = errorDetail(error);
  if (detail) return detail;
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error || undefined;
  if (error && typeof error === 'object') {
    const record = error as { message?: unknown; type?: unknown; cause?: unknown };
    if (typeof record.message === 'string' && record.message) return record.message;
    const cause = describeFailureCause(record.cause, depth + 1);
    if (cause) return cause;
    if (typeof record.type === 'string' && record.type) return record.type;
  }
  return undefined;
}

function containsUserPrompt(turn: TranscriptTurn | null, prompt: QueuedPrompt): boolean {
  return Boolean(
    turn?.items.some(
      (item) =>
        item.kind === 'message'
        && item.role === 'user'
        && (item.id === prompt.id || item.text === prompt.text)
    )
  );
}

/**
 * 新建会话带着的第一条消息,在引擎起来之前的乐观行(behavior session-page「打开速度」)。
 *
 * 只认用户在会话页打的那一句:聊天页起的会话,宿主会把首条换成一封投递再交给引擎;别的 agent 派来的
 * (`communication`)也不是这里打的字 —— 两者若先画成气泡,真的那一轮到了会换成另一副样子。
 * 只画队首:乐观行只有一格,后面几条在启动队列里,会话挂上后由队列那一格显示。
 */
export function firstPromptPreview(
  input: { sessionId: string; startupOrigin?: 'chat-page' | 'session-page'; initialQueue?: readonly { text: string; origin?: PromptInput['origin'] }[] } | undefined,
): PendingPrompt | null {
  const first = input?.initialQueue?.[0];
  if (!first || input.startupOrigin === 'chat-page' || first.origin === 'communication') return null;
  return { id: `first-prompt:${input.sessionId}`, text: first.text };
}

function heldFirstPromptTurnId(prompt: PendingPrompt): string {
  return `${prompt.id}:held`;
}

function queuedPromptTurn(prompt: QueuedPrompt): TranscriptTurn {
  return {
    id: `queued:${prompt.id}`,
    seq: 0,
    initiator: 'user',
    items: [
      {
        kind: 'message',
        id: prompt.id,
        seq: 0,
        role: 'user',
        text: prompt.text,
        ...(prompt.attachments?.length
          ? {
              attachments: prompt.attachments.map((attachment, index) => ({
                id: attachment.type === 'attachment' ? attachment.id : `${prompt.id}-image-${index}`,
                name: attachment.name ?? `image-${index + 1}`,
                mimeType: attachment.mimeType,
              })),
            }
          : {}),
      },
    ],
  };
}

function toPendingAttachment(attachment: AcpPromptAttachment): ChatAttachment {
  return {
    id: attachment.ref.id,
    name: attachment.ref.name ?? 'image',
    dataUrl: attachment.previewUrl,
  };
}
