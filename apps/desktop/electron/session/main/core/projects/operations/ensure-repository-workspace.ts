import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { computeWorkspaceKey } from '@main/core/workspaces/workspace-key';
import { db, type AppDb, type DrizzleTx } from '@main/db/client';
import { sessions, projects, workspaces } from '@main/db/schema';
import { log } from '@main/lib/logger';
import type { LocalProject } from '@shared/projects';

type WorkspaceRowReader = {
  select: typeof db.select;
};

/**
 * `projects.repositoryWorkspaceId` 指着的那一行还在不在。
 *
 * @@@5173 这个问题以前没人问过:这一列一旦写上就被全链路当成事实 —— createSession 的
 * `repository-instance` 分支照抄它写进会话的 `workspace_id`(自己不建行、也不核对),
 * 直到打开会话时 `ensureWorkspaceSetupForSession` 才第一次去查,查不到只会报「没有文件记录」。
 * 于是**一条悬空的引用不是坏掉一条会话,是把整个项目永久钉死**:老会话全打不开,新建的会话
 * 照样抄到同一个悬空 id,界面上没有任何一条路能回来。所以这里要真的看一眼。
 */
function workspaceRowExists(runner: WorkspaceRowReader, workspaceId: string): boolean {
  const [row] = runner
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1)
    .all();
  return !!row;
}

/**
 * Ensures the project has a `project-root` workspace row and sets
 * `projects.repositoryWorkspaceId` if it is not already set.
 *
 * This is idempotent and race-safe — the INSERT and UPDATE are wrapped in a
 * transaction. If a concurrent call already inserted a workspace with the same
 * key, we recover by looking up the existing row by key and linking it.
 *
 * 它同时是这条不变量的**唯一修复点**:发现记着的 id 已经指空,就照着那个 id 把行重建回来 ——
 * 重建时沿用同一个 id,是为了让**已经指着它的那些任务行**一并复活,而不是只让下一条新任务好用。
 *
 * Called from `createLocalProject` (so the returned project
 * already carries the ID) and from `openProject` (for pre-migration rows) —— 也就是说
 * 每次打开项目都会过一遍,坏掉的库下一次启动就自己好了,不需要用户做任何事。
 */
export function ensureRepositoryWorkspace(project: LocalProject, runner: AppDb | DrizzleTx = db): string {
  const [row] = runner
    .select({ repositoryWorkspaceId: projects.repositoryWorkspaceId })
    .from(projects)
    .where(eq(projects.id, project.id))
    .limit(1)
    .all();

  const storedId = row?.repositoryWorkspaceId ?? null;
  if (storedId && workspaceRowExists(runner, storedId)) {
    return storedId;
  }

  const key = computeWorkspaceKey(project.path);

  return runner.transaction((tx) => {
    // Re-check inside the transaction to avoid races.
    const [current] = tx
      .select({ repositoryWorkspaceId: projects.repositoryWorkspaceId })
      .from(projects)
      .where(eq(projects.id, project.id))
      .limit(1)
      .all();

    const currentId = current?.repositoryWorkspaceId ?? null;
    if (currentId && workspaceRowExists(tx as unknown as WorkspaceRowReader, currentId)) {
      return currentId;
    }

    // Check if a workspace with this key already exists (orphan from a previous
    // partial failure or concurrent insert).
    const [existingWs] = tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.key, key))
      .limit(1)
      .all();

    // 悬空修复优先沿用记着的那个 id —— 任务行上写的就是它。❌ 别在这里发新 uuid:
    // 发了新的,行是建出来了,可老任务仍然指着那个不存在的 id,一条都救不回来。
    const repairId = currentId ?? randomUUID();
    const resolvedId = existingWs?.id ?? repairId;

    if (!existingWs) {
      tx.insert(workspaces)
        .values({
          id: repairId,
          kind: 'project-root',
          location: 'local',
          sshConnectionId: null,
          type: 'local',
          path: project.path,
          key,
        })
        .run();
    }

    tx.update(projects)
      .set({ repositoryWorkspaceId: resolvedId })
      .where(eq(projects.id, project.id))
      .run();

    // 同一个 key 上已经躺着另一行时,沿用它 —— 那么指着旧 id 的会话行必须跟着迁过去,
    // 否则它们仍然指空。(id 沿用得上的那条路走不到这里:resolvedId === currentId。)
    if (currentId && resolvedId !== currentId) {
      tx.update(sessions)
        .set({ workspaceId: resolvedId })
        .where(eq(sessions.workspaceId, currentId))
        .run();
    }

    if (currentId) {
      // ⚠️ 这条必须是 error 级,理由不是「有多严重」,是**能不能留下痕迹**:主进程日志默认级别
      // 就是 warn(resolveLogLevel 的兜底),info 根本不落盘。本次事故查不出成因,正是因为
      // 建行那条是 info、删行那处只在失败时才 warn —— 整条路径在正常运行下一条痕迹都没有。
      // 所以这次自愈**不是**替这个故障遮丑,它是目前唯一会响的那个报警器:
      // 库里出现过一次悬空,日志里就必须留下这一行,下次才有得查。
      log.error('ensureRepositoryWorkspace: 项目指着的 project-root 工作区行不存在,已按原 id 重建', {
        projectId: project.id,
        danglingWorkspaceId: currentId,
        workspaceId: resolvedId,
        reusedExisting: !!existingWs,
        relinkedSessions: resolvedId !== currentId,
      });
    } else {
      log.info('ensureRepositoryWorkspace: created project-root workspace', {
        projectId: project.id,
        workspaceId: resolvedId,
        reusedExisting: !!existingWs,
      });
    }

    return resolvedId;
  });
}
