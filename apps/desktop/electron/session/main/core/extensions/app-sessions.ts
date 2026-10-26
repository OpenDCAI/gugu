import { isAbsolute, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { TRANSCRIPT_SOURCE_IDS, type TranscriptSource } from '@gugu/core/shared/types/transcripts';
import { db } from '@main/db/client';
import { projects, sessions } from '@main/db/schema';
import { getLocalSessionSource } from '@main/core/session-import/host-source';
import { createLocalGroupOf } from '@main/core/session-history/local-session-group';
import { projectRootFolder } from '@main/core/projects/operations/project-folders';
import { sessionPageNumber, type AppSessionIndex } from '@shared/extensions/app-sessions';

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
  const [page, sessionProjects] = await Promise.all([
    getLocalSessionSource().list({ engine: source, cwd, offset, limit }),
    db.select({ projectId: sessions.projectId, projectPath: projects.path, projectName: projects.name })
      .from(sessions).innerJoin(projects, eq(projects.id, sessions.projectId)),
  ]);
  const localGroupOf = createLocalGroupOf(sessionProjects);
  const next = offset + page.rows.length;
  return {
    rows: page.rows.map(({ engine, ...row }) => ({ source: engine, ...row, group: localGroupOf(row.cwd) })),
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
