import type { TranscriptTurn } from '@gugu/session-core/acp';
import { setTimeout as pause } from 'node:timers/promises';
import { isAgentActive, parseAgentStatus } from '@gugu/core/shared/agentStatus';
import { log } from '@main/lib/logger';
import { sessionRecordHarnessForProvider } from '@main/core/session-timeline/locate';
import { recordIdentityFor, recordTurnsAfterStore } from './record-backfill-match';
import { appendRecordTurnNow, readUnfinishedRecordTurnsNow, readStoredTailNow, reviseRecordTurnNow, withStoredTurns } from './session-turn-store';
import { sessionProcess } from './session-process';

export type RecordBackfillResult = {
  inserted: number;
  status: 'complete' | 'active' | 'settling' | 'unavailable' | 'unsupported' | 'diverged' | 'cancelled' | 'runtime-changed';
};

/**
 * #980 把 agent 自己的记录里有、库里(`session_turns`)还没有的那几轮补进库。
 *
 * 会话页的历史以 agent 自己的记录为准,库只是缓存:编程模式(终端)里跑的轮、在咕咕外面直接用命令跑的轮、
 * #5381 之前建的会话(库是空的),都只在记录里。从前它们靠「重放 + 按条数对齐」补进来 —— 条数在压缩、失败的轮
 * 之后就对不齐;而接回会话已经不再重放。
 *
 * 新轮只接在库尾;同一条记录轮的迟到答复在原行更新,不改它的库内顺序/引用。
 * 本次改动之前就漏在中间的那些轮(老会话里早年在终端跑过的)不补 —— 接在末尾会把次序打乱,比缺着更糟。
 */
export async function syncStoredHistoryFromRecord(sessionId: string, options: { signal?: AbortSignal; runtime?: 'pty' } = {}): Promise<RecordBackfillResult> {
  const { readSessionRow, pickRecordTurns } = await import('@main/core/session-timeline/service');
  return withStoredTurns(sessionId, async () => {
    const result = (status: RecordBackfillResult['status'], inserted = 0): RecordBackfillResult => ({ inserted, status });
    if (options.signal?.aborted) return result('cancelled');
    // Runtime and record identity are read inside the same queue as live writes, never from a pre-queue snapshot.
    const row = readSessionRow(sessionId, { includeArchived: true });
    if (!row) return result('unavailable');
    if (options.runtime === 'pty' && row.runtime === 'acp') return result('runtime-changed');
    const identity = recordIdentityFor(sessionRecordHarnessForProvider(row.provider));
    if (!identity) return result('unsupported');
    if (!row.providerSessionId) return result('unavailable');
    if (row.runtime === 'acp') {
      const { acpSessionLive } = await import('@main/core/session-timeline/write-bridge');
      if (await acpSessionLive(sessionId)) return result('active');
    }
    const current = () => {
      const latest = readSessionRow(sessionId, { includeArchived: true });
      return latest && latest.runtime === row.runtime && latest.provider === row.provider
        && latest.providerSessionId === row.providerSessionId;
    };
    const active = () => {
      const latest = readSessionRow(sessionId, { includeArchived: true });
      if (!latest || latest.archivedAt) return false;
      const status = parseAgentStatus(latest.agentStatus);
      return isAgentActive(status ? { status } : null) || (!status && sessionProcess(sessionId) !== null);
    };
    // End metadata is not a liveness signal: a stopped/crashed terminal can retain an unfinished last turn.
    const committedOnly = row.runtime !== 'acp' && active();
    const unfinished = await readUnfinishedRecordTurnsNow(sessionId);
    const revisions = new Map<string, number>();
    let lastSettled = true;
    const picked = await pickRecordTurns(sessionId, async (record) => {
      if (record.length === 0) return [];
      lastSettled = !!record.at(-1)!.outcome;
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
      // An earlier idle snapshot may have ended at the prompt. Identity matching finds that row, but must
      // not treat its old projection as final: the same record identity now carries its settled reply.
      if (missing === null) return null;
      const revised: TranscriptTurn[] = [];
      for (const turn of record) {
        const matches = unfinished.filter(stored => recordTurnsAfterStore([turn], [stored], identity)?.length === 0);
        if (matches.length > 1) return null;
        if (matches.length === 0) continue;
        revisions.set(turn.id, matches[0].seq);
        revised.push(turn);
      }
      return [...revised, ...missing];
    }, { images: true, committedOnly, includeArchived: true, afterForkOf: row.config?.forkedFrom?.sessionId });
    if (!picked.ok) return result(picked.reason ?? 'unavailable');
    if (picked.turns === null) {
      log.warn('[record-backfill] the record and the store diverged; nothing filled in', { sessionId });
      return result('diverged');
    }
    let inserted = 0;
    let processed = 0;
    for (const turn of picked.turns) {
      if (options.signal?.aborted) return result('cancelled', inserted);
      if (!current()) return result('runtime-changed', inserted);
      // If a new turn started during an idle snapshot, leave its unproved suffix for the settled edge.
      if (row.runtime !== 'acp' && !committedOnly && active()) return result('active', inserted);
      const seq = revisions.get(turn.id);
      if (seq !== undefined) await reviseRecordTurnNow(sessionId, seq, turn);
      else { await appendRecordTurnNow(sessionId, turn); inserted++; }
      // Reuse the account feed's serial worker; yield without starting another queue or polling loop.
      if (options.signal && ++processed % 64 === 0) await pause(200, undefined, { signal: options.signal });
    }
    if (inserted > 0) log.info('[record-backfill] filled in turns from the record', { sessionId, inserted });
    if (!current()) return result('runtime-changed', inserted);
    if (!picked.complete || active()) return result('active', inserted);
    // A terminal reports idle before its buffered record write lands. While its process lives, an unsettled
    // last turn is still being written; once the process is gone, the record is final as it stands.
    return result(row.runtime !== 'acp' && !lastSettled && sessionProcess(sessionId) !== null ? 'settling' : 'complete', inserted);
  });
}

const TAIL_WINDOWS = [10, 50, 200] as const;
