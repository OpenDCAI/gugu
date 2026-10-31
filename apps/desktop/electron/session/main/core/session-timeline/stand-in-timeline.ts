import type {
  RecordCursor,
  SessionTimeline,
  TimelineAfterResult,
  TimelineSnapshot,
} from '@gugu/session-core/session-record';
import type { TranscriptTurn } from '@gugu/session-core/acp/client';

/**
 * #6264 一条**没有记录可读**的会话的时间线替身:agent 没真正开出会话(建的时候没起来),
 * 或者这一家的记录还没接。spec session-always-openable:这种会话也必须打得开 —— 从前这里直接报
 * `record_unsupported`,于是桌面侧栏把它画成一行点不开的灰字,手机上也进不去。
 *
 * 替身只有一样东西:**这个人发出去的第一句话**(会话上还记着,带附件的路径 mention 一并在里面)。
 * 为什么没起来、怎么再试,由各端按会话摘要里的原因码画成转录末尾的一行(那一行随状态走,❌ 进记录)。
 *
 * 真记录出现之后(再试一次成功了):订阅的人收到一批换了世代的空增量 —— 那是客户端「整份重拉」的信号,
 * 重拉时宿主已经换成真时间线。❌ 不把替身和真记录拼成一份。
 */
export const STAND_IN_EPOCH_PREFIX = 'stand-in:';

export type StandInTimelineInput = {
  sessionId: string;
  /** 第一句话;没有(存量空壳)就是空转录。 */
  firstMessage: string | null;
  /** 会话行上的创建时间(epoch ms);拿不到就不标时间(缺席 = 不知道,❌ 冒充「现在」)。 */
  createdAt: number | null;
  /** 真记录此刻能读了吗。订阅期间按 `pollMs` 问一次。 */
  recordAvailable: () => boolean;
  pollMs?: number;
  setInterval?: (run: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
};

export function standInTurns(input: Pick<StandInTimelineInput, 'sessionId' | 'firstMessage' | 'createdAt'>): TranscriptTurn[] {
  const text = input.firstMessage?.trim();
  if (!text) return [];
  const turnId = `stand-in-${input.sessionId}`;
  return [
    {
      id: turnId,
      seq: 0,
      initiator: 'user',
      ...(input.createdAt !== null ? { startedAt: input.createdAt } : {}),
      // 这一轮**已经了结**:agent 没接住它。❌ 留成没有结局的一轮 —— 那在各端读作「正在跑」
      // (「处理中…」、输入框变成停止键),而这条会话根本没开起来(#6264 走查)。
      // 用 `done` 而不是 `error`:为什么没开起来由转录末尾那一行说(带「再试一次」),
      // `error` 会再多画一行泛泛的「出错了」,同一件事说两遍。
      outcome: { kind: 'done' },
      items: [
        {
          kind: 'message',
          id: `${turnId}-user`,
          seq: 0,
          role: 'user',
          text,
          ...(input.createdAt !== null ? { at: input.createdAt } : {}),
        },
      ],
    },
  ];
}

export function createStandInTimeline(input: StandInTimelineInput): SessionTimeline {
  const epoch = `${STAND_IN_EPOCH_PREFIX}${input.sessionId}`;
  const cursor: RecordCursor = { epoch, seq: 0 };
  const turns = standInTurns(input);
  const snapshot = (): TimelineSnapshot => ({ cursor, turns, settlements: [], hasOlder: false });
  const every = input.setInterval ?? ((run, ms) => setInterval(run, ms));
  const stop = input.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  const timers = new Set<unknown>();

  return {
    epoch,
    getSnapshot: snapshot,
    getAfter: (from) =>
      from.epoch === epoch
        ? { ok: true, batch: { from: from.seq, cursor, turns: [], removedTurnIds: [], settlements: [] } }
        : { ok: false, reset: 'epoch_changed', snapshot: snapshot() },
    getOlder: () => ({ epoch, turns: [], hasOlder: false }),
    subscribe: (_from, listener: (result: TimelineAfterResult) => void) => {
      let done = false;
      const handle = every(() => {
        if (done || !input.recordAvailable()) return;
        done = true;
        stop(handle);
        timers.delete(handle);
        // 换了世代的空增量 = 「整份重拉」:客户端的 reducer 见世代不同就要一份新快照。
        listener({
          ok: true,
          batch: { from: 0, cursor: { epoch: `${epoch}:replaced`, seq: 0 }, turns: [], removedTurnIds: [], settlements: [] },
        });
      }, input.pollMs ?? 2_000);
      (handle as { unref?: () => void } | null)?.unref?.();
      timers.add(handle);
      return () => {
        done = true;
        stop(handle);
        timers.delete(handle);
      };
    },
    settle: () => {
      throw new Error('这条会话还没有开出来,没有可回答的请求');
    },
    syncPendingRequests: () => undefined,
    syncQueuedPrompts: () => undefined,
    syncTerminals: () => {},
    syncLiveReply: () => undefined,
    catchUp: async () => undefined,
    questionOpen: () => false,
    cancelSettlement: () => undefined,
    releaseSettlement: () => undefined,
    dispose: () => {
      for (const handle of timers) stop(handle);
      timers.clear();
    },
  };
}
