import type { IFileSystem } from '@gugu/session-core/files';
import { eq } from 'drizzle-orm';
import { workspaceRegistry } from '@main/core/workspaces/workspace-registry';
import { db } from '@main/db/client';
import { sessions, projects as projectsTable } from '@main/db/schema';
import type {
  ProjectSettingsWriteTarget,
  ProjectSettingsWriteTargetOption,
  WriteProjectConfigRequest,
} from '@shared/core/project-settings/project-settings';
import type { ProjectProvider } from '../../project-provider';
import { resolveWorkspace } from '../../utils';

export type ProjectSettingsResolvedTarget = ProjectSettingsWriteTargetOption & {
  fileSystem: IFileSystem;
  configPath: string;
};

function stripTarget(target: ProjectSettingsWriteTargetOption): ProjectSettingsWriteTarget {
  if (target.type === 'project') return { type: 'project' };
  return { type: 'workspace', workspaceId: target.workspaceId };
}

export function stripResolvedTarget(
  target: ProjectSettingsResolvedTarget
): ProjectSettingsWriteTargetOption {
  const { configPath: _configPath, fileSystem: _fileSystem, ...option } = target;
  return option;
}

function targetKey(target: ProjectSettingsWriteTarget): string {
  if (target.type === 'project') return 'project';
  return `workspace:${target.workspaceId}`;
}

/** 一条会话挂着的、不是项目根目录的工作区(它自己的 worktree):可以单独写一份配置。 */
function resolveSessionWorkspaceTarget(
  project: ProjectProvider,
  session: { title: string; workspaceId: string | null }
): ProjectSettingsResolvedTarget | null {
  const workspace = session.workspaceId ? workspaceRegistry.get(session.workspaceId) : undefined;
  if (!session.workspaceId || !workspace || workspace.path === project.repoPath) return null;
  return {
    type: 'workspace',
    workspaceId: session.workspaceId,
    label: session.title,
    path: workspace.path,
    fileSystem: workspace.fileSystem,
    configPath: workspace.configPath,
  };
}

export async function resolveAllProjectSettingsTargets(
  project: ProjectProvider
): Promise<ProjectSettingsResolvedTarget[]> {
  const projectFileSystem = resolveProjectFileSystem(project);
  if (!projectFileSystem) return [];

  const [projectRow] = await db
    .select({ name: projectsTable.name })
    .from(projectsTable)
    .where(eq(projectsTable.id, project.projectId))
    .limit(1);

  const projectTarget: ProjectSettingsResolvedTarget = {
    type: 'project',
    label: projectRow?.name ?? 'Project repository',
    path: project.repoPath,
    fileSystem: projectFileSystem,
    configPath: project.projectConfigPath,
  };
  if (!projectRow) return [projectTarget];

  const sessionRows = await db
    .select({ title: sessions.title, workspaceId: sessions.workspaceId })
    .from(sessions)
    .where(eq(sessions.projectId, project.projectId));

  // 多条会话共享一个工作区时只列一次。
  const byWorkspace = new Map<string, ProjectSettingsResolvedTarget>();
  for (const session of sessionRows) {
    const target = resolveSessionWorkspaceTarget(project, session);
    if (target?.type === 'workspace' && !byWorkspace.has(target.workspaceId)) {
      byWorkspace.set(target.workspaceId, target);
    }
  }
  return [projectTarget, ...byWorkspace.values()];
}

export function getProjectSettingsWriteTargets(
  targets: ProjectSettingsResolvedTarget[]
): ProjectSettingsWriteTargetOption[] {
  return targets.map(stripResolvedTarget);
}

export async function resolveProjectSettingsTarget(
  project: ProjectProvider,
  request: Pick<WriteProjectConfigRequest, 'target'>,
  resolvedTargets: ProjectSettingsResolvedTarget[]
): Promise<ProjectSettingsResolvedTarget | null> {
  const target = resolvedTargets.find(
    (candidate) => targetKey(stripTarget(candidate)) === targetKey(request.target)
  );
  if (target) return target;

  if (request.target.type === 'workspace') {
    const workspace = resolveWorkspace(project.projectId, request.target.workspaceId);
    if (!workspace) return null;
    return {
      type: 'workspace',
      workspaceId: request.target.workspaceId,
      label: 'Workspace',
      path: workspace.path,
      fileSystem: workspace.fileSystem,
      configPath: workspace.configPath,
    };
  }

  return null;
}

function resolveProjectFileSystem(project: ProjectProvider): IFileSystem | null {
  return project.fileSystem;
}
