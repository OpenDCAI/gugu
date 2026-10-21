import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { isFileNotFoundCode } from '@gugu/session-core/files';
import { err, ok, withLease } from '@gugu/session-shared';
import { sql } from 'drizzle-orm';
import { projectEvents } from '@main/core/projects/project-events';
import { projectManager } from '@main/core/projects/project-manager';
import { statAbsolute } from '@main/core/runtime/files-helpers';
import { runtimeManager } from '@main/core/runtime/runtime-manager';
import { db } from '@main/db/client';
import { projects } from '@main/db/schema';
import { log } from '@main/lib/logger';
import { isImplicitSessionHomeProjectId } from '@shared/core/projects/session-home-project';
import type { CreateProjectResult, LocalProject, ProjectPathStatus } from '@shared/projects';
import { getDirectoryStatus, projectPathKey } from '../path-utils';
import { ensureProjectRepository } from './create-project-utils';
import { ensureRepositoryWorkspace } from './ensure-repository-workspace';
import { getLocalProjectByPath } from './getProjects';
import { attachProjectFolder, getProjectOwningAttachedFolder } from './project-folders';

export type CreateLocalProjectParams = {
  id?: string;
  path: string;
  name: string;
  initGitRepository?: boolean;
  createDirectory?: boolean;
  /**
   * @@@sessionpage 导入本机会话 (spec session-page-import)：放行非 git 目录，用目录本身当项目根、
   * baseRef=null 标记非 git —— 与远程项目同一口径（#2358）。实测本机会话里绝大多数跑在非 git
   * 目录（家目录、脚本目录），要求 git 仓库等于这个功能对多数会话不可用；而 git init 用户的目录
   * 是改写用户磁盘，绝不能替他做。用户手动「添加项目」的路径不受影响。
   */
  allowNonGit?: boolean;
  /**
   * true = 目标路径已经是某个项目时返回那个项目，而不是插一行重复的。
   * 导入会话要按目录找落点，撞上已有项目是常态而非错误。
   */
  reuseExisting?: boolean;
  /**
   * true = 就用传进来的这个目录当项目根，不做 git 仓库根归一化。
   * 导入本机会话要用：claude 按「会话所在目录」定位会话（`~/.claude/projects/<转义 cwd>`），
   * 归一化到仓库根会让 `--resume` 找不到原会话。
   */
  exactPath?: boolean;
};

export async function createLocalProject(
  input: CreateLocalProjectParams
): Promise<CreateProjectResult> {
  const params = { ...input, path: projectPathKey(input.path) };
  if ((params.createDirectory || params.initGitRepository) && !fs.existsSync(params.path)) {
    try {
      fs.mkdirSync(params.path, { recursive: true });
    } catch (error) {
      return err({
        type: 'inspect-failed',
        path: params.path,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const directoryStatus = getDirectoryStatus(params.path);
  if (directoryStatus.kind === 'inspect-failed') {
    return err({
      type: 'inspect-failed',
      path: params.path,
      message: directoryStatus.message,
    });
  }
  if (directoryStatus.kind !== 'directory') {
    return err({
      type: 'invalid-directory',
      path: params.path,
      message: 'Invalid directory',
    });
  }

  let gitInfo: { rootPath: string; baseRef: string | null };
  // Blank and app-owned task directories keep their exact path and do not
  // inspect, initialize or rewrite Git, including an enclosing repository.
  if (
    params.exactPath ||
    (params.createDirectory && !params.initGitRepository) ||
    isImplicitSessionHomeProjectId(params.id)
  ) {
    gitInfo = { rootPath: params.path, baseRef: null };
  } else {
    const repositoryResult = await withLease(runtimeManager.acquire(), (runtime) =>
      ensureProjectRepository(
        runtime.git,
        params.path,
        params.initGitRepository,
        params.allowNonGit
      )
    );
    if (!repositoryResult.success) return repositoryResult;
    gitInfo = repositoryResult.data;
  }

  // #7341 一个文件夹只属于一个项目:它已经挂在某个项目下 ⇒ 打开的就是那个项目,❌ 再建一个让它同属两个项目。
  const attachedOwner = await getProjectOwningAttachedFolder(gitInfo.rootPath);
  if (attachedOwner) return ok(attachedOwner);

  const detachedRoot = await getLocalProjectByPath(gitInfo.rootPath);
  if (detachedRoot?.rootFolderDetached) {
    const attached = await attachProjectFolder(detachedRoot.id, gitInfo.rootPath);
    if (!attached.success) return err({ type: 'init-failed', path: params.path, message: attached.error.message });
    const { rootFolderDetached: _detached, ...restored } = detachedRoot;
    return ok(restored);
  }

  if (params.reuseExisting) {
    // 路径可能落在某个已存在项目的仓库根上（会话 cwd 在仓库子目录里时尤其常见）。
    const existing = await getLocalProjectByPath(gitInfo.rootPath);
    if (existing) return ok(existing);
  }

  // A successful project always includes its real root folder. Register both
  // records atomically, before opening or publishing the project; a failed root
  // registration must not leave an empty project behind. Files stay untouched.
  const projectId = params.id ?? randomUUID();
  let project: LocalProject;
  try {
    project = db.transaction((tx) => {
      const row = tx.insert(projects).values({
        id: projectId,
        name: params.name,
        path: gitInfo.rootPath,
        workspaceProvider: 'local',
        baseRef: gitInfo.baseRef,
        gitless: gitInfo.baseRef === null,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      }).returning().get();
      const created: LocalProject = {
        type: 'local',
        id: row.id,
        name: row.name,
        path: row.path,
        baseRef: row.baseRef ?? gitInfo.baseRef,
        repositoryWorkspaceId: null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
      created.repositoryWorkspaceId = ensureRepositoryWorkspace(created, tx);
      return created;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('createLocalProject: project and root registration failed', { projectId, error: message });
    return err({ type: 'init-failed', path: gitInfo.rootPath, message });
  }

  await projectManager.openProject(project);
  projectEvents._emit('project:created', project);

  return ok(project);
}

export async function getLocalProjectPathStatus(path: string): Promise<ProjectPathStatus> {
  const runtimeLease = await runtimeManager.acquire();
  try {
    const pathEntry = await statAbsolute(runtimeLease.value.files, path);
    if (!pathEntry.success) {
      const code = 'code' in pathEntry.error ? pathEntry.error.code : undefined;
      if (isFileNotFoundCode(code)) {
        return { isDirectory: false, isGitRepo: false };
      }
      return {
        isDirectory: false,
        isGitRepo: false,
        error: { type: 'inspect-failed', path, message: pathEntry.error.message },
      };
    }
    if (pathEntry.data.type !== 'directory') {
      return { isDirectory: false, isGitRepo: false };
    }

    const inspection = await runtimeLease.value.git.inspectPath(path);
    if (inspection.kind === 'inspect-failed') {
      return {
        isDirectory: true,
        isGitRepo: false,
        error: { type: 'inspect-failed', path: inspection.path, message: inspection.message },
      };
    }
    return { isDirectory: true, isGitRepo: inspection.kind === 'repository' };
  } finally {
    await runtimeLease.release();
  }
}
