/**
 * `remote-open-external.ts` 的生产装配:会话目录来自数据库(会话所在任务的工作区,没有就是项目文件夹),
 * `GUGU_PTY_ID` 按 ptyId.ts 解析,路由是这台机器共用的那一份(remote-pane.ts)。
 * 依赖一律用时再 import:套接字在进程起来时就开好,❌ 因为它提前拉起数据库。
 */
import fs from 'node:fs/promises';
import { parsePtyId } from '../pty/ptyId';
import { answerOpenExternal, type SessionRoot, type OpenExternalDeps } from './remote-open-external';
import { sharedRemotePaneRoute } from './remote-pane';

/** 这台机器上每条会话的工作目录,最近用过的在前(同一个目录上好几条会话时,当前目录认会话按这个先后兜底)。 */
async function sessionRoots(): Promise<SessionRoot[]> {
  const [{ desc, eq }, { db }, { sessions, projects, workspaces }] = await Promise.all([
    import('drizzle-orm'),
    import('@main/db/client'),
    import('@main/db/schema'),
  ]);
  const rows = db
    .select({ sessionId: sessions.id, workspacePath: workspaces.path, projectPath: projects.path })
    .from(sessions)
    .innerJoin(projects, eq(sessions.projectId, projects.id))
    .leftJoin(workspaces, eq(sessions.workspaceId, workspaces.id))
    .orderBy(desc(sessions.updatedAt))
    .all();
  return rows
    .map((row) => ({ sessionId: row.sessionId, root: row.workspacePath || row.projectPath || '' }))
    .filter((row) => row.root);
}

export function openExternalDeps(): OpenExternalDeps {
  return {
    route: sharedRemotePaneRoute(),
    sessionFromPtyId: (ptyId) => parsePtyId(ptyId)?.sessionId ?? null,
    sessionRoots,
    isFile: async (path) => {
      try {
        return (await fs.stat(path)).isFile();
      } catch {
        return false;
      }
    },
  };
}

export function answerOpenExternalCall(payload: unknown) {
  return answerOpenExternal(payload, openExternalDeps());
}
