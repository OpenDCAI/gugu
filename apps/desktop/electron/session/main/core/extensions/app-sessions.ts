import { isAbsolute, resolve } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { TRANSCRIPT_SOURCE_IDS, type TranscriptSource } from '@gugu/core/shared/types/transcripts';
import { db } from '@main/db/client';
import { projectRemotes, projects, sessions } from '@main/db/schema';
import { getLocalSessionSource } from '@main/core/session-import/host-source';
import { createLocalGroupOf } from '@main/core/session-history/local-session-group';
import { findRepoRoot } from '@main/core/session-history/repo-root';
import { projectRootFolder } from '@main/core/projects/operations/project-folders';
import { parseRepositoryRef } from '@shared/repository-ref';
import { sessionPageNumber, type AppSessionGroup, type AppSessionIndex } from '@shared/extensions/app-sessions';

const invalid = (message: string): never => { throw Object.assign(new Error(message), { code: 'invalid' }); };
function sourceOf(value: unknown): TranscriptSource | undefined {
  if (value === undefined) return undefined;
  if (!TRANSCRIPT_SOURCE_IDS.includes(value as TranscriptSource)) return invalid(`source is ${TRANSCRIPT_SOURCE_IDS.join(' or ')}`);
  return value as TranscriptSource;
}

export async function indexSessionsForApp(args: Record<string, unknown>): Promise<AppSessionIndex> {
  const source = sourceOf(args.source);
  const offset = sessionPageNumber(args.offset, 'offset', 0);
  const limit = sessionPageNumber(args.limit, 'limit', 100);
  if (args.groupPaths !== undefined && (!Array.isArray(args.groupPaths)
    || !args.groupPaths.every((path) => typeof path === 'string' && isAbsolute(path)))) {
    return invalid('groupPaths is an array of absolute directories');
  }
  const groupPaths = (args.groupPaths as string[] | undefined) ?? [];
  let cwd: string | undefined;
  if (args.project !== undefined) {
    if (typeof args.project !== 'string' || !args.project) return invalid('project is a project id or an absolute directory');
    if (isAbsolute(args.project)) cwd = resolve(args.project);
    else {
      const root = await projectRootFolder(args.project);
      if (!root) throw Object.assign(new Error('Project has no root folder on this machine'), { code: 'not-found' });
      cwd = root.path;
    }
  }
  const [page, sessionProjects, registeredRemotes] = await Promise.all([
    getLocalSessionSource().list({ engine: source, cwd, offset, limit }),
    db.select({ projectId: sessions.projectId, projectPath: projects.path, projectName: projects.name })
      .from(sessions).innerJoin(projects, eq(projects.id, sessions.projectId)),
    db.select({ path: projects.path, url: projectRemotes.remoteUrl }).from(projects)
      .leftJoin(projectRemotes, and(eq(projectRemotes.projectId, projects.id), eq(projectRemotes.remoteName, 'origin'))),
  ]);
  const localGroupOf = createLocalGroupOf(sessionProjects);
  const remotes = new Map(registeredRemotes.map(({ path, url }) => [path, url]));
  const repositoryUrls = new Map<string | null, Promise<string | undefined>>();
  const groupOf = (directory: string | null): Promise<AppSessionGroup> => {
    const group = localGroupOf(directory);
    if (!repositoryUrls.has(group.key)) repositoryUrls.set(group.key, (async () => {
      let url = group.key ? remotes.get(group.key) : undefined;
      if (group.key && !remotes.has(group.key) && isAbsolute(group.key) && findRepoRoot(group.key) === group.key) {
        const { runtimeManager } = await import('@main/core/runtime/runtime-manager');
        const runtime = await runtimeManager.acquire();
        try {
          const repository = await runtime.value.git.openRepository(group.key);
          try { url = (await repository.value.getRemotes()).remotes.find((remote) => remote.name === 'origin')?.url; }
          finally { await repository.release(); }
        } finally { await runtime.release(); }
      }
      return parseRepositoryRef(url)?.repositoryUrl;
    })());
    return repositoryUrls.get(group.key)!.then((repositoryUrl) => repositoryUrl ? { ...group, repositoryUrl } : group);
  };
  const next = offset + page.rows.length;
  return {
    rows: await Promise.all(page.rows.map(async ({ engine, ...row }) => ({ source: engine, ...row, group: await groupOf(row.cwd) }))),
    groups: await Promise.all(groupPaths.map(async (path) => ({ path, group: await groupOf(resolve(path)) }))),
    total: page.matched, pending: page.pending, stale: page.stale,
    nextOffset: next < page.matched ? next : null,
  };
}

export async function readSessionForApp(args: Record<string, unknown>) {
  const source = sourceOf(args.source);
  if (!source || typeof args.filePath !== 'string' || !args.filePath) return invalid('read names a source and an indexed filePath');
  if (args.view !== undefined && args.view !== 'conversation' && args.view !== 'context') return invalid('view is conversation or context');
  return getLocalSessionSource().read({ filePath: args.filePath, source, view: args.view, offset: sessionPageNumber(args.offset, 'offset', 0), limit: sessionPageNumber(args.limit, 'limit', 50) });
}
