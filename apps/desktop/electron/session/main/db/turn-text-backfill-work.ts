import type Database from 'better-sqlite3';
import { setTimeout as delay } from 'node:timers/promises';
import type { SearchProgress } from '@gugu/core/cloud/serverTransition';
import { backfillTurnText, registerSearchText } from './initialize';

/** The projection and cursor algorithm have one owner: backfillTurnText. */
export async function runTurnTextBackfill(connection: Database.Database, report: (progress: SearchProgress) => void): Promise<void> {
  registerSearchText(connection);
  const upper = connection.prepare('SELECT session_id, seq FROM session_turns ORDER BY session_id DESC, seq DESC LIMIT 1').get() as { session_id: string; seq: number } | undefined;
  const count = connection.prepare('SELECT count(*) n FROM session_turns WHERE (session_id, seq) <= (?, ?)');
  const total = upper ? (count.get(upper.session_id, upper.seq) as { n: number }).n : 0;
  const cursor = connection.prepare("SELECT value FROM kv WHERE key = 'turn_text_backfill_cursor'");
  let done = 0;
  const progress = () => {
    const saved = cursor.get() as { value: string } | undefined;
    if (saved && upper) {
      const [session, seq] = JSON.parse(saved.value) as [string, number];
      done = Math.min(total, (count.get(session, seq) as { n: number }).n);
    }
    report({ state: 'running', done, total });
  };
  progress();
  const timer = setInterval(progress, 500);
  try {
    for (;;) {
      try { await backfillTurnText(connection); break; }
      catch (error) {
        // A live turn can win a WAL write lock between this worker's read and write. Retry its durable cursor.
        if (!(error instanceof Error) || !('code' in error) || !String(error.code).startsWith('SQLITE_BUSY')) throw error;
        await delay(50);
      }
    }
    report({ state: 'complete', done: total, total });
  } catch (error) {
    report({ state: 'failed', done, total });
    throw error;
  } finally { clearInterval(timer); }
}
