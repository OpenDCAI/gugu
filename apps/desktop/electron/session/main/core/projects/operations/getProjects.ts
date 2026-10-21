import { and, asc, desc, eq, exists, isNull, or } from 'drizzle-orm';
import { db } from '@main/db/client';
import { projects, sessions, workspaces } from '@main/db/schema';
import { isImplicitSessionHomeProjectId } from '@shared/core/projects/session-home-project';
import type { LocalProject, ProjectPathConflict } from '@shared/projects';
import { projectPathKey } from '../path-utils';

function localProjectBaseRef(row: typeof projects.$inferSelect): string | null {
  // Old task-home rows still say gitless=false. Its execution contract is an
  // ordinary directory regardless of that historical flag or a leftover .git.
  return row.gitless || isImplicitSessionHomeProjectId(row.id) ? null : (row.baseRef ?? 'main');
}

function toLocalProject(row: typeof projects.$inferSelect): LocalProject {
  return {
    type: 'local' as const,
    id: row.id,
    name: row.name,
    path: row.path,
    baseRef: localProjectBaseRef(row),
    repositoryWorkspaceId: row.repositoryWorkspaceId ?? null,
    ...(row.rootFolderDetached ? { rootFolderDetached: true } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * 只返回本机项目。SSH 远程项目已下架(owner 2026-09-22,#6264):库里的行原样保留不删,
 * 但产品里不再出现、不能再跑。
 */
export async function getProjects(options: { includeHidden?: boolean } = {}): Promise<LocalProject[]> {
  const rows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.workspaceProvider, 'local'), options.includeHidden ? undefined : or(
      eq(projects.rootFolderDetached, false),
      exists(db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.projectId, projects.id))),
      exists(db.select({ id: sessions.id }).from(sessions).where(and(eq(sessions.projectId, projects.id), isNull(sessions.archivedAt)))),
    )))
    .orderBy(desc(projects.updatedAt));
  return rows.map(toLocalProject);
}

export async function getProjectById(projectId: string): Promise<LocalProject | undefined> {
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspaceProvider, 'local')))
    .limit(1);
  return row ? toLocalProject(row) : undefined;
}

export async function getLocalProjectByPath(path: string): Promise<LocalProject | undefined> {
  // 必须按 provider 过滤：库里还留着已下架的 SSH 远程项目行(#6264),路径可能与本机目录重名,
  // 而且那是另一台机器上的路径,不能拿本机的写法去规范化。
  // 两边都规范化再比:库里还有规范化之前写进来的行(如 `C:\Users\x\Documents/项目`),
  // 只规范化输入就认不出它们,又会再建一个。同一文件夹有多行时取最早的那行。
  const key = projectPathKey(path);
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.workspaceProvider, 'local'))
    .orderBy(asc(projects.createdAt));
  const row = rows.find((candidate) => projectPathKey(candidate.path) === key);
  return row ? toLocalProject(row) : undefined;
}

/** Query the same global path key used by `idx_projects_path` for conflict diagnostics. */
export async function getProjectPathOccupant(
  path: string
): Promise<ProjectPathConflict | undefined> {
  const [row] = await db
    .select({
      id: projects.id,
      workspaceProvider: projects.workspaceProvider,
      name: projects.name,
    })
    .from(projects)
    .where(eq(projects.path, projectPathKey(path)))
    .limit(1);
  if (!row) return undefined;
  if (row.workspaceProvider !== 'local' && row.workspaceProvider !== 'ssh') {
    throw new Error(`Unknown project workspace provider: ${row.workspaceProvider}`);
  }
  const workspaceProvider = row.workspaceProvider;
  return { id: row.id, workspaceProvider, name: row.name };
}
