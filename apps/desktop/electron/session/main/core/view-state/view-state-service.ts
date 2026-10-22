import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { KV } from '@main/db/kv';
import { sessions } from '@main/db/schema';
import { sanitizeNavigationSnapshotForRestore, type RestoredSessionState } from './navigation-restore';

const viewStateKV = new KV<Record<string, unknown>>('view-state');

async function restoredSessionState(sessionId: string): Promise<RestoredSessionState> {
  const [row] = await db
    .select({ archivedAt: sessions.archivedAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!row) return 'missing';
  return row.archivedAt ? 'archived' : 'live';
}

export const viewStateService = {
  save: (key: string, snapshot: unknown): Promise<void> => viewStateKV.set(key, snapshot),

  get: async (key: string): Promise<unknown> => {
    const snapshot = await viewStateKV.get(key);
    if (key !== 'navigation') return snapshot;
    // #4277 开机不能默认落到已归档 / 已删除的会话上(见 navigation-restore.ts)。DB 查询一次,同步判。
    const sessionId = (snapshot as { viewParams?: { session?: { sessionId?: unknown } } } | null)?.viewParams
      ?.session?.sessionId;
    const state = typeof sessionId === 'string' && sessionId ? await restoredSessionState(sessionId) : 'live';
    return sanitizeNavigationSnapshotForRestore(snapshot, () => state);
  },

  getAll: (): Promise<Record<string, unknown>> =>
    viewStateKV.getAll() as Promise<Record<string, unknown>>,

  del: (key: string): Promise<void> => viewStateKV.del(key),

  reset: (): Promise<void> => viewStateKV.clear(),
};
