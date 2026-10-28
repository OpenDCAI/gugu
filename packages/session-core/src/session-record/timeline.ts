import type { SessionLiveReply } from './live-reply';
import type { SessionUpdate } from '@agentclientprotocol/sdk';

import type { QueuedPrompt } from '../acp/models/prompt';
import { toolCallName } from '../acp/models/turns/tool-calls';
import type { TranscriptItem, TranscriptTurn, TranscriptTurnOutcome } from '../acp/models/turns/turn';
import { RECENT_ACTION_MAX_ENTRIES, RECENT_ACTION_WINDOW_MS, recentActionName } from '../acp/recent-actions';
import { AcpTranscriptParser } from '../acp/reducer';
import { decodeSessionUpdate } from '../acp/reducer/decode';
import type { ParserState } from '../acp/reducer/reducer';
import type {
  PendingRequest,
  RecordBoundary,
  RecordCursor,
  RecordEntry,
  RecordResetReason,
  SessionRecordResume,
  SessionRecordSource,
  SessionTimeline,
  SettleResult,
  Settlement,
  TimelineAfterResult,
  TimelineBatch,
  TimelineOlderResult,
  TimelineSnapshot,
  TurnPatch
} from './contract';
import { questionAnswered, readQuestion } from './sources/question-tools';

/**
 * 一条已经折算好的时间线的存档。
 *
 * 存在的理由：打开一条会话时，机器要把整份记录从头折算一遍才答得出「最近 20 轮是什么」——
 * 一份 18MB 的 claude 记录实测 1713ms，而手机上冷开一次总共才 3.5 秒左右，这一项是最大的。
 * 把折算结果存下来，下次只读文件新长出来的那一段，这一项就从 1.7 秒掉到几十毫秒。
 *
 * ⚠️ 这是**内部存档**，不是对外契约：字段变了就升 `version`，版本对不上一律整份重放。
 * 存档只是一条更快的捷径，❌ 任何一处对不上都必须能安全地退回「从头读」——
 * 接错了拼出来的是一份缺了中间的时间线，而那种缺失不报错、和"读得慢"在界面上分不出来。
 */
export const TIMELINE_ARCHIVE_VERSION = 3;

export type TimelineArchive = {
  readonly version: number;
  /** 记录源自己的续读点（含它的身份指纹）。 */
  readonly resume: SessionRecordResume;
  readonly epoch: string;
  readonly seq: number;
  readonly lastAt: number | null;
  readonly lastBoundaryMessageId: string | null;
  /** reducer 的整份内部状态。 */
  readonly parser: ParserState;
  readonly seenKeys: readonly string[];
  readonly settlements: readonly Settlement[];
  readonly settlementSeq: readonly (readonly [string, number])[];
  readonly removed: readonly (readonly [string, number])[];
  readonly recentActions: readonly RecentActionEntry[];
  /**
   * 每一轮上次发布到哪个 seq。存了它，装回来之后**手机手里的游标仍然有效** ——
   * 它只要「我那之后的增量」，不必整份重下一次快照。不存的话就只能换代重来，
   * 那等于把省下来的机器时间又在传输上赔回去。
   */
  readonly published: readonly TurnPublishArchive[];
};

export type TurnPublishArchive = {
  readonly turnId: string;
  readonly metaSeq: number;
  readonly orderSeq: number;
  readonly touchedSeq: number;
  readonly items: readonly (readonly [string, number])[];
};

export type SessionTimelineDeps = {
  /** 进 reducer 的 turn id 前缀。同一份记录用同一个值，turn id 才在重开之间稳定。 */
  sessionId: string;
  /** 默认快照取多少轮。 */
  defaultLimit?: number;
  now?: () => number;
  /** 换代号。默认单调计数，测试里可以钉死。 */
  newEpoch?: () => string;
  /**
   * 上一次的存档。给了就先装回来、再只读增量；装不上（版本/指纹/续读点任一对不上）
   * 就当没给过，整份重放 —— 那只是慢，不是错。
   */
  archive?: TimelineArchive | null;
  /**
   * 这条会话里记录认出来的提问(AskUserQuestion)宿主能不能代答 —— 宿主按腿与这家的声明算好传进来;
   * 能 ⇒ 提问结算带上整份 `questions`(契约里「有 questions 就能代答」)。
   */
  answerableQuestions?: boolean;
};

/**
 * 快照默认取最近多少轮。50 → 20（#3566 审计）：快照是整轮不裁的，一条中等会话 50 轮就是
 * 78KB 一包，而打开会话的首屏只需要最近几轮，更早的走 `getOlder` 懒加载。
 */
const DEFAULT_LIMIT = 20;

/**
 * 世代号（epoch）必须在**进程之间**也不重复。
 *
 * 原来的默认值是每个实例自己从 1 数（`e1`），而生产路径从不注入别的生成器 ⇒ 宿主重启后
 * 新开的时间线还叫 `e1`。手机拿着上一条命的游标来续，`epoch !== this.epochValue` 判不出来，
 * `cursor.seq > this.seq` 又常常不成立（新实例整份读完只发一次、seq=1，而手机第一次打开一条
 * 会话时游标恰恰就是 seq=1）⇒ 宿主认为「可以续」，只回它自己 seq=1 之后的那点东西，
 * 手机把它并进手里那两轮，**静默**拼出一份缺了中间几十轮的时间线。
 * 实测：会话从 1 轮长到 41 轮、桌面重启后手机重连，手机手里只有 2 轮、缺 39 轮，全程无提示。
 *
 * 计数器也必须是**模块级**的：同进程内空闲拆除（IDLE_DISPOSE_MS）后重开同一条会话，
 * 实例级计数器同样会再给出一个 `1`。
 */
const EPOCH_RUN_ID = `${Date.now().toString(36)}${epochRandomSuffix()}`;
let epochCounter = 0;

function epochRandomSuffix(): string {
  const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (webCrypto?.randomUUID) return webCrypto.randomUUID().slice(0, 8);
  return Math.random().toString(36).slice(2, 10);
}

function defaultNewEpoch(): string {
  epochCounter += 1;
  return `${EPOCH_RUN_ID}-${epochCounter}`;
}

/**
 * 记录源 → `SessionTimeline`。
 *
 * 返回 Promise 是**故意**的：契约要求 `start()` 返回时首轮读取已完成，而定位不到文件要
 * 响亮地失败。把这件事藏在同步构造函数后面，调用方拿到的就是一条"看起来正常、其实是空的"
 * 时间线 —— 那正是最难查的一类假象。
 */
export async function createSessionTimeline(
  source: SessionRecordSource,
  deps: SessionTimelineDeps
): Promise<SessionTimeline> {
  const timeline = new RecordTimeline(source, deps);
  await timeline.begin();
  return timeline;
}

type Subscriber = {
  cursor: RecordCursor;
  listener: (result: TimelineAfterResult) => void;
};

type PublishedItem = { item: TranscriptItem; json: string; seq: number };
/**
 * 上一次发布出去的一轮，按**条目**记版本：每条条目各有自己的 seq（最后一次变化的发布序号），
 * 轮的元信息（seq/initiator/startedAt/endedAt/outcome）与条目顺序也各记一个 seq。
 * `batchAfter(seq)` 据此只挑出比游标新的那几条 —— 这就是「按条目增量」的全部机关。
 */
type PublishedTurn = {
  turn: TranscriptTurn;
  metaJson: string;
  metaSeq: number;
  orderJson: string;
  orderSeq: number;
  items: Map<string, PublishedItem>;
  /** 上面几个 seq 里最大的那个：这一轮最后一次有任何变化的发布序号。 */
  touchedSeq: number;
};
type RecentActionEntry = { id: string; name: string; at: number };
type QueuedPromptText = Pick<QueuedPrompt, 'id' | 'text' | 'queueEdit'>;

class RecordTimeline implements SessionTimeline {
  private readonly now: () => number;
  private readonly newEpoch: () => string;
  private readonly defaultLimit: number;

  private epochValue: string;
  private seq = 0;

  private parser: AcpTranscriptParser;
  private seenKeys = new Set<string>();
  /** 上一次发布出去的每一轮，按 id。用来判"这一轮到底变了没有"。 */
  private published = new Map<string, PublishedTurn>();
  private removed = new Map<string, number>();
  private settlements = new Map<string, Settlement>();
  /**
   * 提问还没带上题目的那几条:itemId → 工具名。有的记录源先报一条参数为空的 tool_call、参数随后面的
   * tool_call_update 才到(opencode:`decodeTool`「Pending starts with empty input」),题目要在那时补上。
   */
  private questionsAwaitingInput = new Map<string, string>();
  private settlementSeq = new Map<string, number>();
  private dirtySettlements = new Set<string>();
  /**
   * 由 `syncPendingRequests` 报进来的那些 itemId。
   *
   * 必须单独记：撤销一条「宿主报过、这次没报」的待结算是对的，撤销一条记录里认出来的提问项
   * 却是错的 —— 活运行时压根不供给它们，「不在名单里」对它们不是一个信号。
   * 两者混在同一张表里就分不出来了。
   */
  private liveItemIds = new Set<string>();
  /** 排队提示：宿主从 ACP 运行时同步来的那份（`syncQueuedPrompts`）。与记录换代无关。 */
  private queued: QueuedPromptText[] = [];
  private queuedDirty = false;
  private liveReply: SessionLiveReply | null = null;
  private liveReplyDirty = false;
  private liveReplyTimer: ReturnType<typeof setTimeout> | null = null;
  private subscribers = new Set<Subscriber>();
  /** 最近一条记录的 provider 时钟。没有时钟的记录跟着上一条走，❌ 别拿 Date.now() 冒充。 */
  private lastAt: number | null = null;
  private lastBoundaryMessageId: string | null = null;
  /** Per-tool timestamps collected from the same records that feed the transcript reducer. */
  private recentActionEntries = new Map<string, RecentActionEntry>();
  /** 这一代是被什么换掉的。拿旧 epoch 游标来续的人要看到真原因，不是笼统的 epoch_changed。 */
  private lastResetReason: RecordResetReason | null = null;
  private needsPublish = false;
  private suspended = false;
  private resetTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly source: SessionRecordSource,
    private readonly deps: SessionTimelineDeps
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.newEpoch = deps.newEpoch ?? defaultNewEpoch;
    this.defaultLimit = deps.defaultLimit ?? DEFAULT_LIMIT;
    this.epochValue = this.newEpoch();
    this.parser = new AcpTranscriptParser({ sessionId: deps.sessionId });
  }

  async begin(): Promise<void> {
    // 整份读会分几十批进来。每批都发布一次只会把 seq 冲到几十，
    // 而那几十步没有任何订阅者看得到 —— 首轮统一算一次。
    this.suspended = true;
    const restored = this.restoreArchive(this.deps.archive ?? null);
    try {
      await this.source.start(
        {
          onEntries: (entries) => this.apply(entries),
          onReset: (reason) => this.reset(reason)
        },
        restored ? (this.deps.archive as TimelineArchive).resume : undefined
      );
    } finally {
      this.suspended = false;
    }
    this.publish();
  }

  /**
   * 把存档装回来。返回 false = 没装（外面据此照常整份重读）。
   *
   * 只做版本判断这一层：续读点还成不成立由记录源自己核（它才知道自己那份记录长什么样），
   * 核不过它会自己整份重读，而那时我们手里这份装回来的状态就是错的 ——
   * 所以源一旦报 `onReset`，`reset()` 会把这里装的东西整份清掉，这条链是闭合的。
   */
  private restoreArchive(archive: TimelineArchive | null): boolean {
    if (!archive || archive.version !== TIMELINE_ARCHIVE_VERSION) return false;
    this.parser.restoreState(archive.parser);
    this.epochValue = archive.epoch;
    this.seq = archive.seq;
    this.lastAt = archive.lastAt;
    this.lastBoundaryMessageId = archive.lastBoundaryMessageId;
    this.seenKeys = new Set(archive.seenKeys);
    this.settlements = new Map(archive.settlements.map((one) => [one.itemId, one]));
    this.settlementSeq = new Map(archive.settlementSeq.map(([id, at]) => [id, at]));
    this.removed = new Map(archive.removed.map(([id, at]) => [id, at]));
    this.recentActionEntries = new Map(archive.recentActions.map((one) => [one.id, one]));
    // `published` 里那两串 JSON 是用来比对"这一轮变了没有"的，存下来纯属浪费（它就是整条会话）——
    // 装回来时按当前的轮重算一遍即可（一份 39MB 的记录实测 23ms）。seq 才是必须存的那一半。
    this.published = new Map();
    const byId = new Map(this.currentTurns().map((turn) => [turn.id, turn]));
    for (const entry of archive.published) {
      const turn = byId.get(entry.turnId);
      if (!turn) continue;
      const { items: _items, ...meta } = turn;
      const seqById = new Map(entry.items.map(([id, at]) => [id, at]));
      const items = new Map<string, PublishedItem>();
      for (const item of turn.items) {
        items.set(item.id, {
          item,
          json: JSON.stringify(item),
          // 存档里没有的条目只可能来自版本漂移；给它当前 seq，宁可多发一次也不少发。
          seq: seqById.get(item.id) ?? entry.touchedSeq
        });
      }
      this.published.set(turn.id, {
        turn,
        metaJson: JSON.stringify(meta),
        metaSeq: entry.metaSeq,
        orderJson: JSON.stringify(turn.items.map((item) => item.id)),
        orderSeq: entry.orderSeq,
        items,
        touchedSeq: entry.touchedSeq
      });
    }
    // 活审批不进存档：它是**此刻**运行时里等着的那些，宿主起来后会整份同步一次。
    // 存了反而危险 —— 「这次没报 ⇒ 撤销」会在宿主还没同步时对着一份陈年名单开火。
    this.liveItemIds = new Set();
    return true;
  }

  /**
   * 交出此刻的存档。返回 null = 这条时间线不能存（记录源不支持续读，或此刻续读点取不到）。
   */
  async archive(): Promise<TimelineArchive | null> {
    if (this.disposed) return null;
    const resume = await this.source.resumePoint?.();
    if (!resume) return null;
    const published: TurnPublishArchive[] = [];
    for (const [turnId, entry] of this.published) {
      published.push({
        turnId,
        metaSeq: entry.metaSeq,
        orderSeq: entry.orderSeq,
        touchedSeq: entry.touchedSeq,
        items: [...entry.items].map(([id, one]) => [id, one.seq] as const)
      });
    }
    return {
      version: TIMELINE_ARCHIVE_VERSION,
      resume,
      epoch: this.epochValue,
      seq: this.seq,
      lastAt: this.lastAt,
      lastBoundaryMessageId: this.lastBoundaryMessageId,
      parser: this.parser.snapshotState(),
      seenKeys: [...this.seenKeys],
      settlements: [...this.settlements.values()],
      settlementSeq: [...this.settlementSeq].map(([id, at]) => [id, at] as const),
      removed: [...this.removed].map(([id, at]) => [id, at] as const),
      recentActions: [...this.recentActionEntries.values()],
      published
    };
  }

  get epoch(): string {
    return this.epochValue;
  }

  getSnapshot(options?: { limit?: number }): TimelineSnapshot {
    const limit = options?.limit ?? this.defaultLimit;
    const all = this.currentTurns();
    const turns = limit >= all.length ? all : all.slice(all.length - limit);
    return {
      cursor: { epoch: this.epochValue, seq: this.seq },
      turns,
      settlements: [...this.settlements.values()],
      hasOlder: turns.length < all.length,
      ...this.recentActionsSnapshot(),
      queuedPrompts: [...this.queued],
      liveReply: this.liveReply
    };
  }

  /**
   * 往前翻。基准是**轮 id** 而不是下标：两次请求之间轮可能被分叉掉，下标会指到另一轮上去，
   * 那样翻出来的是错位的一段而不是更早的一段。
   */
  getOlder(input: { beforeTurnId: string; limit?: number }): TimelineOlderResult {
    const limit = input.limit ?? this.defaultLimit;
    const all = this.currentTurns();
    const index = all.findIndex((turn) => turn.id === input.beforeTurnId);
    // 基准轮已经不在这份时间线里（分叉/回滚掉了）：如实说「前面没有了」，
    // ❌ 不退回去从头给一段 —— 那一段接不到手里那份上。
    if (index <= 0) return { epoch: this.epochValue, turns: [], hasOlder: false };
    const start = Math.max(0, index - limit);
    return {
      epoch: this.epochValue,
      turns: all.slice(start, index),
      hasOlder: start > 0
    };
  }

  getAfter(cursor: RecordCursor): TimelineAfterResult {
    if (cursor.epoch !== this.epochValue) {
      return {
        ok: false,
        reset: this.lastResetReason ?? 'epoch_changed',
        snapshot: this.getSnapshot()
      };
    }
    if (cursor.seq > this.seq) {
      // 游标比我还新 = 对面记着一段我没有的历史（宿主重开过、状态回退过）。
      return { ok: false, reset: 'cursor_ahead', snapshot: this.getSnapshot() };
    }
    const batch = this.batchAfter(cursor.seq);
    // spec「补不上（…缺口太大）就整份重载」：缺口大过一份快照时，补缺口既不更省，
    // 拼接面还更大 —— 直接给整份，让对面换掉手里那份。
    if (batch.turns.length > this.defaultLimit) {
      return { ok: false, reset: 'gap_too_large', snapshot: this.getSnapshot() };
    }
    return { ok: true, batch };
  }

  subscribe(
    cursor: RecordCursor | null,
    listener: (result: TimelineAfterResult) => void
  ): () => void {
    const start = cursor ?? { epoch: this.epochValue, seq: 0 };
    const subscriber: Subscriber = { cursor: start, listener };
    this.subscribers.add(subscriber);
    // 订阅那一刻先补缺口：不补的话订阅者要一直等到下一条记录才看得到任何东西。
    this.deliver(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  settle(input: { itemId: string; optionId: string | null; by: string }): SettleResult {
    const existing = this.settlements.get(input.itemId);
    if (existing && existing.state !== 'pending') {
      // compare-and-set：谁先答谁生效，第二个端拿到已有结算而不是覆盖它。
      return { ok: false, existing };
    }
    const settlement: Settlement = {
      // 保住 kind/title/detail/options：结算完手机还要显示"当时问的是什么、答的是哪一项"。
      ...(existing ?? { itemId: input.itemId }),
      itemId: input.itemId,
      state: 'resolved',
      optionId: input.optionId,
      resolvedBy: input.by,
      resolvedAt: this.now()
    };
    this.putSettlement(settlement);
    this.publish();
    return { ok: true, settlement };
  }

  syncPendingRequests(requests: readonly PendingRequest[]): void {
    const present = new Set<string>();
    for (const request of requests) {
      present.add(request.itemId);
      this.liveItemIds.add(request.itemId);
      const existing = this.settlements.get(request.itemId);
      // 已经有结局的不许被「它还在等」拉回去:CAS 抢完到 provider 那边真正消失之间有一小段窗口,
      // 那期间它照样出现在这一批里。倒回 pending = 同一条被答两次。
      if (existing && existing.state !== 'pending') continue;
      const next: Settlement = {
        itemId: request.itemId,
        kind: request.kind,
        title: request.title,
        ...(request.detail !== undefined ? { detail: request.detail } : {}),
        ...(request.options.length > 0 ? { options: request.options } : {}),
        ...(request.origin ? { origin: request.origin } : {}),
        ...(request.origin?.source === 'agent-question' && request.questions ? { questions: request.questions, askedAt: request.askedAt } : {}),
        state: 'pending',
        optionId: null,
        resolvedBy: null,
        resolvedAt: null
      };
      // 内容一字没变就别标脏:宿主是按活状态整份同步的,每次心跳都推一遍等于把同一张卡
      // 一秒广播一次到手机。
      if (existing && sameSettlement(existing, next)) continue;
      this.putSettlement(next);
    }

    for (const itemId of [...this.liveItemIds]) {
      if (present.has(itemId)) continue;
      this.liveItemIds.delete(itemId);
      const existing = this.settlements.get(itemId);
      if (!existing || existing.state !== 'pending') continue;
      this.putSettlement({
        ...existing,
        state: 'cancelled',
        optionId: null,
        resolvedBy: null,
        resolvedAt: this.now()
      });
    }
    this.publish();
  }

  syncQueuedPrompts(prompts: readonly QueuedPromptText[]): void {
    if (this.disposed) return;
    const next = prompts.map(({ id, text, queueEdit }) => ({ id, text, ...(queueEdit ? { queueEdit } : {}) }));
    // 宿主按活状态整份同步，没变就别推：每次心跳都广播一遍同一份队列是白占通道。
    if (JSON.stringify(next) === JSON.stringify(this.queued)) return;
    this.queued = next;
    this.queuedDirty = true;
    this.publish();
  }

  syncLiveReply(reply: SessionLiveReply | null): void {
    if (this.disposed) return;
    const a = this.liveReply;
    if (a === reply || (a?.sourceMessageId === reply?.sourceMessageId && a?.activity.phase === reply?.activity.phase
      && (a?.activity.phase === 'thinking' && reply?.activity.phase === 'thinking'
        ? a.activity.id === reply.activity.id && a.activity.startedAt === reply.activity.startedAt && a.activity.text === reply.activity.text
        : a?.activity.phase === 'draft' && reply?.activity.phase === 'draft'
          ? a.activity.id === reply.activity.id && a.activity.text === reply.activity.text && a.activity.replyToMessageId === reply.activity.replyToMessageId
          : a?.activity.phase === 'tools' && reply?.activity.phase === 'tools' ? a.activity.count === reply.activity.count : true))) return;
    this.liveReply = reply;
    this.liveReplyDirty = true;
    // First stage and phase boundaries are immediate. Coalesce only text in the same thought:
    // token-by-token full-text broadcasts would otherwise flood cross-device subscribers.
    const continuing = a?.sourceMessageId === reply?.sourceMessageId && (
      (a?.activity.phase === 'thinking' && reply?.activity.phase === 'thinking' && a.activity.id === reply.activity.id && a.activity.startedAt === reply.activity.startedAt)
      || (a?.activity.phase === 'draft' && reply?.activity.phase === 'draft' && a.activity.id === reply.activity.id));
    if (continuing) {
      this.liveReplyTimer ??= setTimeout(() => { this.liveReplyTimer = null; this.publish(); }, 100);
    } else {
      if (this.liveReplyTimer) clearTimeout(this.liveReplyTimer);
      this.liveReplyTimer = null;
      this.publish();
    }
  }

  async catchUp(): Promise<void> {
    await this.source.catchUp?.();
  }

  /**
   * 记录里这道提问还没有结果。只看记录:有 `questions` 的是记录认出来、宿主能代答的提问,
   * 结果一到就记 `resultRecorded` —— 认领(`settle`)不算结果,认领了选择器也还开着。
   */
  questionOpen(itemId: string): boolean {
    const settlement = this.settlements.get(itemId);
    return !!settlement?.questions && !settlement.resultRecorded && settlement.state !== 'cancelled';
  }

  cancelSettlement(itemId: string): void {
    const existing = this.settlements.get(itemId);
    // 已经有人答过的不许被"超时"抹掉：那会让界面把一个已生效的选择显示成作废。
    if (existing && existing.state !== 'pending') return;
    this.putSettlement({
      ...(existing ?? { itemId }),
      itemId,
      state: 'cancelled',
      optionId: null,
      resolvedBy: null,
      resolvedAt: this.now()
    });
    this.publish();
  }

  releaseSettlement(itemId: string): void {
    const existing = this.settlements.get(itemId);
    // 没答过的本来就还在等，回滚是空操作；已取消的是终态，❌ 不许被"回滚"复活成可答。
    if (!existing || existing.state !== 'resolved') return;
    // 提问的结果已经进了记录:选择器关了,放掉认领就是这条已经不需要回答了 —— 与没人认领时同一条规则。
    this.putSettlement({
      ...existing,
      state: existing.resultRecorded ? 'cancelled' : 'pending',
      optionId: null,
      resolvedBy: null,
      resolvedAt: existing.resultRecorded ? this.now() : null
    });
    this.publish();
  }

  dispose(): void {
    if (this.liveReplyTimer) clearTimeout(this.liveReplyTimer);
    this.liveReplyTimer = null;
    this.disposed = true;
    if (this.resetTimer) clearTimeout(this.resetTimer);
    this.resetTimer = null;
    this.subscribers.clear();
    this.source.stop();
  }

  // ─── 内部 ──────────────────────────────────────────────────────────────────

  private apply(entries: RecordEntry[]): void {
    if (this.disposed) return;
    let changed = false;
    for (const entry of entries) {
      // 去重按 key：同一件事从两个来源各报一次（分叉抄录、轮询重读）也只算一次。
      if (this.seenKeys.has(entry.key)) continue;
      this.seenKeys.add(entry.key);
      const at = entry.at ?? this.lastAt ?? this.now();
      this.lastAt = at;
      if (entry.boundary) {
        this.lastBoundaryMessageId = entry.boundary.messageId ?? null;
        // 边界不是内容：它不进时间线，只把当前这一轮关掉并给它结局。
        // 没有活着的一轮时 reducer 自己 no-op，所以重复的边界是安全的。
        this.parser.settleTurn(outcomeOf(entry.boundary), at);
      } else {
        // Even an empty final thinking row carries its provider message identity.
        // Later fragments of that same message use the common completed-turn tail.
        const tail = !this.parser.activeTurn &&
          (entry.update.sessionUpdate === 'agent_message_chunk' || entry.update.sessionUpdate === 'agent_thought_chunk') &&
          entry.update.messageId && entry.update.messageId === this.lastBoundaryMessageId;
        if (tail) this.parser.pushTail(decodeSessionUpdate(entry.update), at);
        else this.parser.push(entry.update, at);
        this.recordRecentActions(this.parser.activeTurn?.items ?? [], at);
        this.trackSettlement(entry.update, at);
      }
      changed = true;
    }
    if (changed) this.publish();
  }

  /**
   * 提问型工具调用 → 一条待结算。
   *
   * ACP 里提问走的是请求应答，记录里只剩工具调用本身；不在这里认回来，手机就没有任何
   * 依据知道"这一步在等人回答"。provider 自己把这条工具调用做完了（有 tool_call_update）
   * ⇒ 有人答了 = 已经在别处答了（终端里直接答的);没答(拒答、超时、这一轮被停、codex 回「这一问用不了」)= 本地这条作废。
   * 答没答按工具判,判据只在 `questionAnswered`。
   */
  private trackSettlement(update: SessionUpdate, at: number): void {
    if (update.sessionUpdate === 'tool_call') {
      const question = readQuestion(update);
      if (!question || this.settlements.has(question.itemId)) return;
      if (question.kind === 'question' && !question.questions) this.questionsAwaitingInput.set(question.itemId, question.toolName);
      // 连提问内容一起带上：只报一个 pending，手机知道"在等人答"却画不出卡片，
      // 那张卡就只能显示成一句干瞪眼的提示（契约 @@@settlement-prompt）。
      this.putSettlement({
        itemId: question.itemId,
        kind: question.kind,
        origin: { source: question.kind === 'question' ? 'harness-question' : 'harness-permission' },
        title: question.title,
        ...(question.detail !== undefined ? { detail: question.detail } : {}),
        ...(question.options.length > 0 ? { options: question.options } : {}),
        // 只有宿主能代答的提问才带整份题目(#6798);有它 ⇔ 手机能答。
        ...(question.questions && this.deps.answerableQuestions ? { questions: question.questions, askedAt: at } : {}),
        state: 'pending',
        optionId: null,
        resolvedBy: null,
        resolvedAt: null
      });
      return;
    }
    if (update.sessionUpdate === 'tool_call_update') {
      const awaiting = this.questionsAwaitingInput.get(update.toolCallId);
      if (awaiting !== undefined && update.rawInput !== undefined) {
        const late = readQuestion({ sessionUpdate: 'tool_call', toolCallId: update.toolCallId, title: awaiting, rawInput: update.rawInput });
        if (late?.questions) {
          this.questionsAwaitingInput.delete(update.toolCallId);
          const pending = this.settlements.get(update.toolCallId);
          if (pending?.state === 'pending') {
            this.putSettlement({
              ...pending,
              title: late.title,
              ...(late.detail !== undefined ? { detail: late.detail } : {}),
              ...(late.options.length > 0 ? { options: late.options } : {}),
              ...(this.deps.answerableQuestions ? { questions: late.questions, askedAt: at } : {}),
            });
          }
        }
      }
      const existing = this.settlements.get(update.toolCallId);
      if (!existing) return;
      if (update.status !== 'completed' && update.status !== 'failed') return;
      // 能代答的提问记下「选择器关了」(questionOpen 靠它);结算照一条规则走,不分腿:
      // 认领过的是「已在某端回答」;没人认领、有人答了的是在别处答的(卡写「已在其他端回答」),
      // 没答的才是「这条已经不需要回答了」。❌ 都写成后者:终端里直接答过的每一问,回看时都成了「没答」;
      // ❌ 拿「正常结束」当「答了」:codex 没答的几种结局都是正常输出(见 questionAnswered)。
      const closed = existing.questions ? { resultRecorded: true } : {};
      if (existing.state !== 'pending') {
        if (existing.questions && !existing.resultRecorded) this.putSettlement({ ...existing, ...closed });
        return;
      }
      this.putSettlement({
        ...existing,
        ...closed,
        itemId: update.toolCallId,
        state: questionAnswered(this.questionToolName(update.toolCallId), update) ? 'resolved' : 'cancelled',
        optionId: null,
        resolvedBy: null,
        resolvedAt: at
      });
    }
  }

  private putSettlement(settlement: Settlement): void {
    this.settlements.set(settlement.itemId, settlement);
    this.dirtySettlements.add(settlement.itemId);
  }

  private reset(reason: Extract<RecordResetReason, 'source_replaced' | 'source_unreadable'>): void {
    if (this.disposed) return;
    this.epochValue = this.newEpoch();
    this.lastResetReason = reason;
    this.seq = 0;
    this.parser = new AcpTranscriptParser({ sessionId: this.deps.sessionId });
    this.seenKeys = new Set();
    this.published = new Map();
    this.removed = new Map();
    this.settlements = new Map();
    this.questionsAwaitingInput = new Map();
    this.settlementSeq = new Map();
    this.dirtySettlements = new Set();
    // 换代后这张表也清空:宿主下一次同步会把当前全集重新报一遍。留着旧 id 只会让
    // 「这次没报 ⇒ 撤销」在一份还没被同步过的新代上误开火。
    this.liveItemIds = new Set();
    this.lastAt = null;
    this.lastBoundaryMessageId = null;
    this.recentActionEntries = new Map();
    this.needsPublish = true;
    // 不当场发：源紧接着就会把重读的内容送进来，那时快照才是完整的。
    // 但也不能只等它 —— 一份被删掉的记录不会再有任何 onEntries，所以补一个兜底节拍。
    if (!this.resetTimer) {
      this.resetTimer = setTimeout(() => {
        this.resetTimer = null;
        if (this.needsPublish) this.publish();
      }, 0);
      this.resetTimer.unref?.();
    }
  }

  /** 问这一问的工具:时间线里那条工具项的名字(存档装回来的待答也认得,parser 状态在存档里)。 */
  private questionToolName(toolCallId: string): string | null {
    const turns = this.currentTurns();
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const name = toolNameIn(turns[index].items, toolCallId);
      if (name !== null) return name;
    }
    return null;
  }

  private currentTurns(): TranscriptTurn[] {
    const active = this.parser.activeTurn;
    return active ? [...this.parser.history, active] : [...this.parser.history];
  }

  /**
   * 把当前状态与上一次发布的比一遍，有差就 seq+1 并推给订阅者。
   *
   * 增量以**轮**为单位整轮替换：每一轮带着自己的完整当前状态，所以同一批应用两次结果一样 ——
   * 手机侧因此不需要任何"这条增量是不是重复了"的判断，重连时重放一段旧增量也无害。
   */
  private publish(): void {
    if (this.disposed || this.suspended) return;
    const turns = this.currentTurns();
    const nextSeq = this.seq + 1;
    let changed = this.needsPublish || this.dirtySettlements.size > 0 || this.queuedDirty || this.liveReplyDirty;

    // 先把要变的都算出来放一边，确认真有变化才提交 —— seq 只在有变化时前进。
    const staged = new Map<string, PublishedTurn>();
    const alive = new Set<string>();
    for (const turn of turns) {
      alive.add(turn.id);
      const prior = this.published.get(turn.id);
      // 轮是不可变的：对象身份没换 = 这一轮一个字都没动，既不用重算 JSON 也不用逐条比对。
      // 不跳过的话，直播时每吐一段都要把**整条会话**重新序列化一遍，成本随会话长度线性涨
      // （实测 2000 轮的会话每推一次 28ms，而真正变了的只有最后那一轮）。
      if (prior && prior.turn === turn) continue;
      const { items: _items, ...meta } = turn;
      const metaJson = JSON.stringify(meta);
      const order = turn.items.map((item) => item.id);
      const orderJson = JSON.stringify(order);
      let touched = false;

      const nextItems = new Map<string, PublishedItem>();
      for (const item of turn.items) {
        const json = JSON.stringify(item);
        const priorItem = prior?.items.get(item.id);
        if (priorItem && priorItem.json === json) {
          nextItems.set(item.id, priorItem);
          continue;
        }
        nextItems.set(item.id, { item, json, seq: nextSeq });
        touched = true;
      }
      const metaSeq = prior && prior.metaJson === metaJson ? prior.metaSeq : nextSeq;
      const orderSeq = prior && prior.orderJson === orderJson ? prior.orderSeq : nextSeq;
      if (metaSeq === nextSeq || orderSeq === nextSeq) touched = true;
      if (!touched && prior) continue;

      staged.set(turn.id, {
        turn,
        metaJson,
        metaSeq,
        orderJson,
        orderSeq,
        items: nextItems,
        touchedSeq: nextSeq
      });
      changed = true;
    }
    const gone: string[] = [];
    for (const id of this.published.keys()) {
      if (!alive.has(id)) gone.push(id);
    }
    if (gone.length > 0) changed = true;

    if (!changed) return;

    this.seq = nextSeq;
    for (const [id, entry] of staged) {
      this.published.set(id, entry);
      this.removed.delete(id);
    }
    for (const id of gone) {
      // 轮消失只可能来自分叉/回滚：得显式告诉手机把它抹掉，否则它会永远挂在那儿。
      this.published.delete(id);
      this.removed.set(id, nextSeq);
    }
    for (const id of this.dirtySettlements) this.settlementSeq.set(id, nextSeq);
    this.dirtySettlements.clear();
    this.queuedDirty = false;
    this.liveReplyDirty = false;
    this.needsPublish = false;

    for (const subscriber of [...this.subscribers]) this.deliver(subscriber);
  }

  private deliver(subscriber: Subscriber): void {
    const result = this.getAfter(subscriber.cursor);
    if (result.ok) {
      if (this.isEmptyBatch(result.batch) && result.batch.cursor.seq === subscriber.cursor.seq) {
        return;
      }
      subscriber.cursor = result.batch.cursor;
    } else {
      subscriber.cursor = result.snapshot.cursor;
    }
    subscriber.listener(result);
  }

  private isEmptyBatch(batch: TimelineBatch): boolean {
    return (
      batch.turns.length === 0 &&
      batch.removedTurnIds.length === 0 &&
      batch.settlements.length === 0
    );
  }

  private batchAfter(seq: number): TimelineBatch {
    const turns: TurnPatch[] = [];
    for (const entry of this.published.values()) {
      if (entry.touchedSeq <= seq) continue;
      const { items: _items, ...meta } = entry.turn;
      const changedItems: TranscriptItem[] = [];
      for (const id of entry.turn.items.map((item) => item.id)) {
        const published = entry.items.get(id);
        if (published && published.seq > seq) changedItems.push(published.item);
      }
      turns.push({
        ...meta,
        itemIds: entry.turn.items.map((item) => item.id),
        items: changedItems
      });
    }
    turns.sort((a, b) => a.seq - b.seq);
    const removedTurnIds: string[] = [];
    for (const [id, at] of this.removed) {
      if (at > seq) removedTurnIds.push(id);
    }
    const settlements: Settlement[] = [];
    for (const [itemId, at] of this.settlementSeq) {
      if (at <= seq) continue;
      const settlement = this.settlements.get(itemId);
      if (settlement) settlements.push(settlement);
    }
    return {
      from: seq,
      cursor: { epoch: this.epochValue, seq: this.seq },
      turns,
      removedTurnIds,
      settlements,
      ...this.recentActionsSnapshot(),
      queuedPrompts: [...this.queued],
      liveReply: this.liveReply
    };
  }



  private recordRecentActions(items: readonly TranscriptItem[], at: number): void {
    for (const item of items) {
      if (item.kind === 'message' || item.kind === 'thinking' || item.kind === 'compaction' || item.kind === 'context-reset' || item.kind === 'session-notice') continue;
      if (item.kind === 'tool-group') {
        this.recordRecentActions(item.children, at);
        continue;
      }
      const name = recentActionName(item);
      if (name && !this.recentActionEntries.has(item.id)) {
        this.recentActionEntries.set(item.id, { id: item.id, name, at });
      }
      if (item.children) this.recordRecentActions(item.children, at);
    }
  }

  private recentActionsSnapshot(): { recentActions: string[]; lastActionAt: number | null } {
    const now = this.now();
    const entries = [...this.recentActionEntries.values()].sort(
      (a, b) => a.at - b.at || a.id.localeCompare(b.id)
    );
    const last = entries.at(-1)?.at ?? null;
    // Keep the newest stale action for the "last active" readout, but do not let
    // an append-only transcript make this in-memory index grow without bound.
    for (const entry of entries) {
      if (entry.at !== last && now - entry.at > RECENT_ACTION_WINDOW_MS) {
        this.recentActionEntries.delete(entry.id);
      }
    }
    const recent = entries
      .filter((entry) => now - entry.at <= RECENT_ACTION_WINDOW_MS)
      .slice(-RECENT_ACTION_MAX_ENTRIES);
    const keepIds = new Set(recent.map((entry) => entry.id));
    if (entries.length > 0) keepIds.add(entries[entries.length - 1].id);
    for (const entry of entries) {
      if (!keepIds.has(entry.id)) this.recentActionEntries.delete(entry.id);
    }
    return { recentActions: recent.map((entry) => entry.name), lastActionAt: last };
  }
}

/**
 * 记录里的边界 → reducer 的轮结局。
 *
 * `max_turn_requests` 在三家记录里都没出现过（它是 ACP 侧的说法），留着是因为契约上那一档存在；
 * 真映射不出来的一律落回 `end_turn` —— 一轮结束了是确定的，只是没说清为什么。
 */
function sameSettlement(a: Settlement, b: Settlement): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function toolNameIn(items: readonly TranscriptItem[], toolCallId: string): string | null {
  for (const item of items) {
    if (item.kind !== 'tool-group' && !('toolCallId' in item)) continue;
    if ('toolCallId' in item && item.toolCallId === toolCallId) return toolCallName(item);
    const nested = item.children ? toolNameIn(item.children, toolCallId) : null;
    if (nested !== null) return nested;
  }
  return null;
}

function outcomeOf(boundary: RecordBoundary): TranscriptTurnOutcome {
  if (boundary.kind === 'turn_aborted') return { kind: 'cancelled', reason: 'cancelled' };
  if (boundary.kind === 'turn_failed') return { kind: 'error', reason: 'prompt_failed' };
  return { kind: 'done', reason: boundary.stopReason ?? 'end_turn' };
}
