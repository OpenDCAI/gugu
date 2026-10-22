import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { KV } from '@main/db/kv';
import { projects, sessions } from '@main/db/schema';
import { sanitizeNavigationSnapshotForRestore, type RestoredSessionState } from './navigation-restore';

const viewStateKV = new KV<Record<string, unknown>>('view-state');

/**
 * 这条会话在这台机器眼里是什么状态 —— 「确知已删除」只认一种:它的项目在这台机器上,会话行却没了
 * (本机会话消失只有 deleteSession / deleteProject 两条路,都删行;归档留着行)。项目也不在这台机器上 = 会话在
 * 别的机器上(咕咕 server、别的电脑):这里不知道它的死活,❌ 当成删了 —— 由那台机器说了算。
 */
async function restoredSessionState(sessionId: string, projectId: string): Promise<RestoredSessionState> {
  const [row] = await db
    .select({ archivedAt: sessions.archivedAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (row) return row.archivedAt ? 'archived' : 'live';
  if (!projectId) return 'deleted';
  const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1);
  return project ? 'deleted' : 'elsewhere';
}

export const viewStateService = {
  save: (key: string, snapshot: unknown): Promise<void> => viewStateKV.set(key, snapshot),

  get: async (key: string): Promise<unknown> => {
    const snapshot = await viewStateKV.get(key);
    if (key !== 'navigation') return snapshot;
    // #4277 开机不能默认落到已归档 / 已删除的会话上(见 navigation-restore.ts)。DB 查询一次,同步判。
    const session = (snapshot as { viewParams?: { session?: { sessionId?: unknown; projectId?: unknown } } } | null)
      ?.viewParams?.session;
    const sessionId = session?.sessionId;
    const projectId = typeof session?.projectId === 'string' ? session.projectId : '';
    const state = typeof sessionId === 'string' && sessionId ? await restoredSessionState(sessionId, projectId) : 'live';
    return sanitizeNavigationSnapshotForRestore(snapshot, () => state);
  },

  getAll: (): Promise<Record<string, unknown>> =>
    viewStateKV.getAll() as Promise<Record<string, unknown>>,

  del: (key: string): Promise<void> => viewStateKV.del(key),

  reset: (): Promise<void> => viewStateKV.clear(),
};
