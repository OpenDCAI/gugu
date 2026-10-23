import { randomUUID } from 'node:crypto';
import { err, ok, type Result } from '@gugu/session-shared';
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { computeWorkspaceKey } from '@main/core/workspaces/workspace-key';
import { db } from '@main/db/client';
import { projects, sessions, workspaces } from '@main/db/schema';
import { events } from '@main/lib/events';
import type {
  AttachProjectFolderError,
  DetachProjectFolderError,
  ProjectFolder,
  ProjectFolderNotFound,
} from '@shared/core/projects/project-folders';
import { projectFoldersChangedChannel } from '@shared/core/projects/projectEvents';
import type { WorkspaceKind } from '@shared/core/workspaces/workspaces';
import { getDirectoryStatus, projectPathKey } from '../path-utils';
import { ensureRepositoryWorkspace } from './ensure-repository-workspace';
import { getLocalProjectByPath, getProjectById } from './getProjects';
import { readFolderBranch } from './read-folder-branch';
import { publishProjectVisibility } from './project-visibility';

/**
 * 项目挂的文件夹(product spec「挂文件夹」,#7341)。
 *
 * 一个文件夹 = 一条工作区记录(同一绝对路径只有一行,`workspaces.key` 唯一)。根目录由 `projects.repositoryWorkspaceId`
 * 指着;挂上来的文件夹是 `workspaces.projectId` = 这个项目的那些行。摘下 = 把这一格清空,❌ 删行:在里面跑着的会话
 * 照旧用它。
 */

/** 新建会话 / 拿草稿工作区时,这个工作区算不算这个项目的文件夹。 */
export type ProjectFolderTarget =
  | { kind: 'root' }
  | { kind: 'attached'; path: string; workspaceKind: WorkspaceKind | null };

/** 一个文件夹本身(不带此刻的分支与会话读数)。 */
export type ProjectFolderRef = {
  workspaceId: string;
  kind: ProjectFolder['kind'];
  path: string;
  attachedAt: string | null;
};

function projectNotFound(projectId: string): ProjectFolderNotFound {
  return { type: 'not-found', message: `没有这个项目:${projectId}` };
}

/**
 * 根目录 → `root`;挂在这个项目下 → `attached`(带上它的路径,会话就在那里开工);都不是 → null。
 * 根目录只认 `projects.repositoryWorkspaceId` 这一个 id,与新建会话一直以来的口径一致。
 */
export async function resolveProjectFolder(
  projectId: string,
  workspaceId: string
): Promise<ProjectFolderTarget | null> {
  const [projectRow] = await db
    .select({ repositoryWorkspaceId: projects.repositoryWorkspaceId, rootFolderDetached: projects.rootFolderDetached })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!projectRow) return null;
  if (!projectRow.rootFolderDetached && projectRow.repositoryWorkspaceId === workspaceId) return { kind: 'root' };

  const [row] = await db
    .select({ path: workspaces.path, kind: workspaces.kind })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.projectId, projectId)))
    .limit(1);
  if (!row?.path) return null;
  return { kind: 'attached', path: row.path, workspaceKind: row.kind ?? null };
}

/**
 * 这个文件夹挂在哪个项目下;没挂(或它是某个项目的根目录 —— 那归 getLocalProjectByPath 答)= undefined。
 * 新建项目 / 认路径时先问它:一个文件夹只属于一个项目(product spec「项目是什么」),
 * 已经挂在某个项目下的文件夹 ⇒ 就是那个项目,❌ 再给它建一个。
 */
export async function getProjectOwningAttachedFolder(
  folderPath: string
): Promise<Awaited<ReturnType<typeof getProjectById>>> {
  let key: string;
  try {
    key = computeWorkspaceKey(projectPathKey(folderPath));
  } catch {
    return undefined;
  }
  const [row] = await db
    .select({ projectId: workspaces.projectId })
    .from(workspaces)
    .where(eq(workspaces.key, key))
    .limit(1);
  return row?.projectId ? getProjectById(row.projectId) : undefined;
}

/**
 * 项目的根目录:它那一行工作区记录和路径(会话在根目录那一行记着的路径里跑,workspace-bootstrap-service)。
 * 本机没有这个项目 = undefined。App 的 `{ project }` 文件位置也认这一个。
 */
export async function projectRootFolder(projectId: string): Promise<{ workspaceId: string; path: string } | undefined> {
  const project = await getProjectById(projectId);
  if (!project) return undefined;
  // 与打开项目(openProject)同一步:项目一定有根目录那一行,指空了也就地按原 id 修好。项目首页本来就先打开项目,
  // 这里保留历史工作区锚点;是否还属于项目由 rootFolderDetached 单独记录。
  const workspaceId = ensureRepositoryWorkspace(project);
  const [rootRow] = await db.select({ path: workspaces.path }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  return { workspaceId, path: rootRow?.path ?? project.path };
}

/** 根目录在前,挂上的按挂上的先后。 */
export async function listProjectFolders(
  projectId: string
): Promise<Result<ProjectFolder[], ProjectFolderNotFound>> {
  const refs = await listProjectFolderRefs(projectId);
  if (!refs) return err(projectNotFound(projectId));
  return ok(await describeFolders(projectId, refs));
}

/** 同 listProjectFolders,只是文件夹本身(❌ 读分支、数会话):记到账号上的就是这一份(#113)。本机没有这个项目 = undefined。 */
export async function listProjectFolderRefs(projectId: string): Promise<ProjectFolderRef[] | undefined> {
  const root = await projectRootFolder(projectId);
  if (!root) return undefined;
  const rootWorkspaceId = root.workspaceId;
  const project = await getProjectById(projectId);

  const attachedRows = await db
    .select({ id: workspaces.id, path: workspaces.path, attachedAt: workspaces.attachedAt })
    .from(workspaces)
    .where(and(eq(workspaces.projectId, projectId), ne(workspaces.id, rootWorkspaceId)))
    .orderBy(asc(workspaces.attachedAt), asc(workspaces.createdAt), asc(workspaces.id));

  return [
    // 会话在根目录那一行记着的路径里跑(workspace-bootstrap-service),所以卡上写的也是它。
    ...(!project?.rootFolderDetached ? [{ workspaceId: rootWorkspaceId, kind: 'root' as const, path: root.path, attachedAt: null }] : []),
    ...attachedRows.flatMap((row) =>
      row.path
        ? [{ workspaceId: row.id, kind: 'attached' as const, path: row.path, attachedAt: row.attachedAt }]
        : []
    ),
  ];
}

/**
 * 把这台机器上的一个文件夹挂到项目上。同一个文件夹再挂一次 = 原样返回(幂等);它是哪个项目的根目录、
 * 或者已经在别的项目下,就说是谁 —— 一个文件夹只属于一个项目。
 */
export async function attachProjectFolder(
  projectId: string,
  folderPath: string
): Promise<Result<ProjectFolder, AttachProjectFolderError>> {
  const project = await getProjectById(projectId);
  if (!project) return err(projectNotFound(projectId));

  let path: string;
  try {
    path = projectPathKey(folderPath);
  } catch (error) {
    return err({ type: 'not-a-directory', message: error instanceof Error ? error.message : String(error) });
  }
  const status = getDirectoryStatus(path);
  if (status.kind === 'inspect-failed') {
    return err({ type: 'not-a-directory', message: `读不了这个文件夹:${path}(${status.message})` });
  }
  if (status.kind !== 'directory') {
    return err({ type: 'not-a-directory', message: `这不是一个文件夹:${path}` });
  }

  const rootOwner = await getLocalProjectByPath(path);
  if (rootOwner && !rootOwner.rootFolderDetached) {
    return err({
      type: 'is-project-root',
      projectId: rootOwner.id,
      projectName: rootOwner.name,
      message: `这个文件夹就是项目「${rootOwner.name}」的根目录`,
    });
  }

  const key = computeWorkspaceKey(path);
  const attachedAt = new Date().toISOString();
  const outcome = db.transaction(
    (tx):
      | { kind: 'conflict'; error: AttachProjectFolderError }
      | { kind: 'attached'; ref: ProjectFolderRef; changed: boolean } => {
      const [existing] = tx
        .select({ id: workspaces.id, path: workspaces.path, projectId: workspaces.projectId, attachedAt: workspaces.attachedAt })
        .from(workspaces)
        .where(eq(workspaces.key, key))
        .limit(1)
        .all();

      if (!existing) {
        const id = randomUUID();
        tx.insert(workspaces)
          .values({ id, kind: 'path', location: 'local', type: 'local', path, key, projectId, attachedAt })
          .run();
        return { kind: 'attached', ref: { workspaceId: id, kind: 'attached', path, attachedAt }, changed: true };
      }

      // 路径写法与项目表不同、key 却撞上某个项目的根目录那一行:同样是根目录。
      const [rootOf] = tx
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(and(eq(projects.repositoryWorkspaceId, existing.id), eq(projects.rootFolderDetached, false)))
        .limit(1)
        .all();
      if (rootOf) {
        return {
          kind: 'conflict',
          error: {
            type: 'is-project-root',
            projectId: rootOf.id,
            projectName: rootOf.name,
            message: `这个文件夹就是项目「${rootOf.name}」的根目录`,
          },
        };
      }

      const existingPath = existing.path ?? path;
      if (existing.projectId === projectId) {
        return {
          kind: 'attached',
          ref: { workspaceId: existing.id, kind: 'attached', path: existingPath, attachedAt: existing.attachedAt },
          changed: false,
        };
      }

      // 已经挂在别的项目下;或者还没挂,但别的项目有没归档的会话正在用它 —— 它实际上就是那个项目的文件夹
      // (那个项目的工作区列表里就有它),挂过来会让「在这里开的会话进哪个群」说不清。
      const otherProjectId =
        existing.projectId ??
        tx
          .select({ projectId: sessions.projectId })
          .from(sessions)
          .where(
            and(
              eq(sessions.workspaceId, existing.id),
              isNull(sessions.archivedAt),
              ne(sessions.projectId, projectId)
            )
          )
          .limit(1)
          .all()[0]?.projectId;
      if (otherProjectId) {
        const [owner] = tx
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(eq(projects.id, otherProjectId))
          .limit(1)
          .all();
        // project_id 带外键(ON DELETE SET NULL),会话行随项目级联删除:指着一个不存在的项目只能是库坏了。
        if (!owner) throw new Error(`工作区 ${existing.id} 指着不存在的项目 ${otherProjectId}`);
        return {
          kind: 'conflict',
          error: {
            type: 'belongs-to-other-project',
            projectId: owner.id,
            projectName: owner.name,
            message: `这个文件夹已经在项目「${owner.name}」下`,
          },
        };
      }

      // rootOf already checked current membership in this transaction. The earlier project snapshot
      // can predate a concurrent detach; using its flag would reclaim the root as a hidden attached row.
      const [currentProject] = tx.select({ rootId: projects.repositoryWorkspaceId }).from(projects)
        .where(eq(projects.id, projectId)).limit(1).all();
      if (currentProject?.rootId === existing.id) {
        tx.update(projects).set({ rootFolderDetached: false, updatedAt: sql`CURRENT_TIMESTAMP` })
          .where(eq(projects.id, projectId)).run();
        tx.update(workspaces).set({ kind: 'project-root', projectId: null, attachedAt: null, updatedAt: sql`CURRENT_TIMESTAMP` })
          .where(eq(workspaces.id, existing.id)).run();
        return {
          kind: 'attached',
          ref: { workspaceId: existing.id, kind: 'root', path: existingPath, attachedAt: null },
          changed: true,
        };
      }

      // 无主的旧行(例如从前的 worktree 行、已删项目留下的根目录行、摘下过的文件夹):认领它,沿用原 id —— 指着它的
      // 会话不必改。kind 一并改成 'path':从此它的 git 照它自己的目录判(workspace-git-context),❌ 再借本项目
      // 根目录的 git 服务 —— 旧行未必是本项目仓库的 worktree。
      tx.update(workspaces)
        .set({ projectId, attachedAt, kind: 'path', updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(eq(workspaces.id, existing.id))
        .run();
      return {
        kind: 'attached',
        ref: { workspaceId: existing.id, kind: 'attached', path: existingPath, attachedAt },
        changed: true,
      };
    }
  );

  if (outcome.kind === 'conflict') return err(outcome.error);
  if (outcome.changed) {
    events.emit(projectFoldersChangedChannel, { projectId });
    await publishProjectVisibility(projectId);
  }
  const [folder] = await describeFolders(projectId, [outcome.ref]);
  return ok(folder!);
}

/** Detach membership, keeping the workspace, sessions and history available. */
export async function detachProjectFolder(
  projectId: string,
  workspaceId: string
): Promise<Result<void, DetachProjectFolderError>> {
  const project = await getProjectById(projectId);
  if (!project) return err(projectNotFound(projectId));
  if (project.repositoryWorkspaceId === workspaceId) {
    if (project.rootFolderDetached) return err({ type: 'not-found', message: `这个项目下没有挂着这个文件夹:${workspaceId}` });
    await db.update(projects).set({ rootFolderDetached: true, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(projects.id, projectId));
    events.emit(projectFoldersChangedChannel, { projectId });
    await publishProjectVisibility(projectId);
    return ok();
  }

  const detached = db.transaction((tx) => {
    const [row] = tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.id, workspaceId), eq(workspaces.projectId, projectId)))
      .limit(1)
      .all();
    if (!row) return false;
    tx.update(workspaces)
      .set({ projectId: null, attachedAt: null, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(workspaces.id, workspaceId))
      .run();
    return true;
  });
  if (!detached) {
    return err({ type: 'not-found', message: `这个项目下没有挂着这个文件夹:${workspaceId}` });
  }

  events.emit(projectFoldersChangedChannel, { projectId });
  await publishProjectVisibility(projectId);
  return ok();
}

async function describeFolders(projectId: string, refs: ProjectFolderRef[]): Promise<ProjectFolder[]> {
  if (refs.length === 0) return [];
  const sessionRows = await db
    .select({ id: sessions.id, workspaceId: sessions.workspaceId })
    .from(sessions)
    .where(
      and(
        eq(sessions.projectId, projectId),
        isNull(sessions.archivedAt),
        inArray(
          sessions.workspaceId,
          refs.map((ref) => ref.workspaceId)
        )
      )
    )
    .orderBy(asc(sessions.createdAt), asc(sessions.id));
  const sessionIdsByWorkspace = new Map<string, string[]>();
  for (const row of sessionRows) {
    if (!row.workspaceId) continue;
    const ids = sessionIdsByWorkspace.get(row.workspaceId) ?? [];
    ids.push(row.id);
    sessionIdsByWorkspace.set(row.workspaceId, ids);
  }

  const branches = await Promise.all(refs.map((ref) => readFolderBranch(ref.path)));
  return refs.map((ref, index) => ({
    workspaceId: ref.workspaceId,
    projectId,
    kind: ref.kind,
    path: ref.path,
    branch: branches[index] ?? null,
    sessionIds: sessionIdsByWorkspace.get(ref.workspaceId) ?? [],
    attachedAt: ref.attachedAt,
  }));
}
