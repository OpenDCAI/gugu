import type { TranscriptTurn } from '@gugu/session-core/acp';
import { log } from '@main/lib/logger';
import { sessionRecordHarnessForProvider } from '@main/core/session-timeline/locate';
import { recordIdentityFor, recordTurnsAfterStore } from './record-backfill-match';
import { appendRecordTurnNow, readStoredTailNow, withStoredTurns } from './session-turn-store';

/**
 * #980 把 agent 自己的记录里有、库里(`session_turns`)还没有的那几轮补进库。
 *
 * 会话页的历史以 agent 自己的记录为准,库只是缓存:编程模式(终端)里跑的轮、在咕咕外面直接用命令跑的轮、
 * #5381 之前建的会话(库是空的),都只在记录里。从前它们靠「重放 + 按条数对齐」补进来 —— 条数在压缩、失败的轮
 * 之后就对不齐;而接回会话已经不再重放。
 *
 * 只补**库尾之后**新长出来的那一截,接在库尾:先后次序与记录一致,而且永远不会插进已有的两行中间。
 * 本次改动之前就漏在中间的那些轮(老会话里早年在终端跑过的)不补 —— 接在末尾会把次序打乱,比缺着更糟。
 */
export async function syncStoredHistoryFromRecord(sessionId: string): Promise<{ inserted: number }> {
  const { readSessionRow, pickRecordTurns } = await import('@main/core/session-timeline/service');
  const row = readSessionRow(sessionId);
  const identity = recordIdentityFor(sessionRecordHarnessForProvider(row?.provider));
  if (!row?.providerSessionId || !identity) return { inserted: 0 };
  // 正在跑的会话,它自己的回合正由运行时一轮轮落库;此刻补,会把还没落库的那一轮从记录里先抄一份进来。
  const { acpSessionLive } = await import('@main/core/session-timeline/write-bridge');
  if (await acpSessionLive(sessionId).catch(() => true)) return { inserted: 0 };
  return withStoredTurns(sessionId, async () => {
    const picked = await pickRecordTurns(sessionId, async (record) => {
      if (record.length === 0) return [];
      // 库尾一般第一行就对得上记录最后那一轮;对不上(最近几轮是失败的、没进记录)再往前多读一些。
      let missing: TranscriptTurn[] | null = null;
      const windows = identity === 'content' ? [...TAIL_WINDOWS, Number.MAX_SAFE_INTEGER] : TAIL_WINDOWS;
      for (const limit of windows) {
        const tail = await readStoredTailNow(sessionId, limit);
        missing = recordTurnsAfterStore(record, tail, identity, {
          hasOlderStoredTurns: tail.length === limit,
          hermesPromptReceipts: sessionRecordHarnessForProvider(row.provider) === 'hermes',
        });
        if (missing !== null || tail.length < limit) break;
      }
      return missing;
    });
    if (!picked.ok) return { inserted: 0 };
    if (picked.turns === null) {
      log.warn('[record-backfill] the record and the store diverged; nothing filled in', { sessionId });
      return { inserted: 0 };
    }
    for (const turn of picked.turns) await appendRecordTurnNow(sessionId, turn);
    if (picked.turns.length > 0) log.info('[record-backfill] filled in turns from the record', { sessionId, inserted: picked.turns.length });
    return { inserted: picked.turns.length };
  });
}

const TAIL_WINDOWS = [10, 50, 200] as const;
