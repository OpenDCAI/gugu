import { err, ok } from '@gugu/session-shared';
import { runtimeManager } from '@main/core/runtime/runtime-manager';
import { createWorkspaceFactory } from '@main/core/workspaces/workspace-factory';
import { workspaceGitContext } from '@main/core/workspaces/workspace-git-context';
import { workspaceRegistry } from '@main/core/workspaces/workspace-registry';
import { projectManager } from '../project-manager';
import { getProjectById } from './getProjects';
import { resolveProjectFolder } from './project-folders';

/**
 * 新建会话页的草稿工作区(还没有会话时,输入框的文件工具就在这里干活)。可以是项目的根目录,也可以是挂在它下面的
 * 文件夹(#7341:点哪个文件夹,新会话就从哪开工);别的工作区一律不给。
 */
export async function acquireProjectWorkspace(projectId: string, workspaceId: string) {
  const projectData = await getProjectById(projectId);
  const folder = projectData
    ? projectData.repositoryWorkspaceId === workspaceId
      ? ({ kind: 'root' } as const)
      : await resolveProjectFolder(projectId, workspaceId)
    : null;
  if (!projectData || !folder) {
    return err({ type: 'not-found' as const, message: 'Project workspace not found' });
  }

  const project = projectManager.getProject(projectId);
  if (!project) {
    return err({ type: 'project-not-open' as const, message: 'Project is not open' });
  }

  // 根目录:项目自己的目录与 git 服务,与从前一字不差。挂上的文件夹:它自己的路径、它自己的 git。
  const workDir = folder.kind === 'attached' ? folder.path : project.repoPath;
  const git = workspaceGitContext(
    project,
    folder.kind === 'attached'
      ? { kind: folder.workspaceKind, path: folder.path }
      : { kind: 'project-root', path: project.repoPath }
  );

  try {
    const acquired = await workspaceRegistry.acquire(
      workspaceId,
      projectId,
      createWorkspaceFactory(workspaceId, {
        session: { id: workspaceId, title: projectData.name },
        workDir,
        projectId,
        projectPath: project.repoPath,
        workspaceRuntime: { manager: runtimeManager },
        settings: project.settings,
        logPrefix: 'ProjectWorkspaceLease',
        ...git,
      })
    );
    return ok({ workspaceId: acquired.workspace.id });
  } catch (error) {
    return err({
      type: 'acquire-failed' as const,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function releaseProjectWorkspace(projectId: string, workspaceId: string) {
  const belongsToProject = workspaceRegistry
    .listForProject(projectId)
    .some((workspace) => workspace.workspaceId === workspaceId);
  if (!belongsToProject) return ok();

  try {
    await workspaceRegistry.teardown(workspaceId, 'detach');
    return ok();
  } catch (error) {
    return err({
      type: 'release-failed' as const,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
