import { eq } from 'drizzle-orm';
import { db, sqlite } from '@main/db/client';
import { sessions, projects, workspaces } from '@main/db/schema';
import { log } from '@main/lib/logger';
import { ALL_COMMAND_DEFS } from '@shared/commands';
import type { Session } from '@shared/core/sessions/sessions';
import type {
  CommandPaletteQuery,
  SearchItem,
  SearchItemKind,
  WorkspaceFileHit,
} from '@shared/core/search';
import type { Project } from '@shared/projects';
import { sessionEvents } from '../sessions/session-events';
import { mapSessionRowToSession } from '../sessions/utils';
import { projectEvents } from '../projects/project-events';
import { workspaceFileIndexService } from './workspace-file-index-service';

type FtsRow = {
  item_type: string;
  item_id: string;
  project_id: string | null;
  title: string;
  rank: number;
};

type RecentSessionRow = {
  id: string;
  title: string;
  project_id: string;
};

/** 已下架的 SSH 远程项目(#6264)行原样留在库里、也可能早已写进 search_index:查询时按项目的 workspace_provider 排除。 */
const LOCAL_PROJECTS_ONLY = `NOT EXISTS (SELECT 1 FROM projects p
  WHERE p.id = COALESCE(search_index.project_id,
    CASE WHEN search_index.item_type = 'project' THEN search_index.item_id END)
    AND p.workspace_provider != 'local')`;

class SearchService {
  initialize(): void {
    projectEvents.on('project:created', (project) => this.upsertProject(project));
    projectEvents.on('project:deleted', (projectId) => this.removeByType('project', projectId));

    sessionEvents.on('session:created', (session) => void this.upsertSession(session));
    sessionEvents.on('session:renamed', (sessionId) => {
      const [row] = db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1).all();
      if (row) void this.upsertSession(mapSessionRowToSession(row));
    });
    // 归档与删除对搜索索引同效:列表里点不到的会话不该还能被搜出来。
    sessionEvents.on('session:archived', (sessionId) =>
      this.removeByType('session', sessionId)
    );
    sessionEvents.on('session:deleted', (sessionId) =>
      this.removeByType('session', sessionId)
    );

    this.backfill();
    this.seedCommands();
  }

  searchFiles(workspaceId: string, query: string, limit?: number): WorkspaceFileHit[] {
    return workspaceFileIndexService.searchFiles(workspaceId, query, limit);
  }

  search({ query, context }: CommandPaletteQuery): SearchItem[] {
    if (!query.trim()) return this.recents(context);

    // Trigram tokenizer requires each term to be at least 3 characters.
    // Terms shorter than 3 chars are dropped; if nothing survives, fall back
    // to recents rather than sending an invalid query to SQLite.
    const terms = query
      .trim()
      .split(/[\s\-_]+/)
      .filter((t) => t.length >= 3);

    if (terms.length === 0) return this.recents(context);

    const ftsQuery = terms.map((t) => `"${t}"`).join(' AND ');

    let rows: FtsRow[];
    try {
      rows = sqlite
        .prepare(
          `SELECT item_type, item_id, project_id, title, bm25(search_index) AS rank
           FROM search_index
           WHERE search_index MATCH ? AND ${LOCAL_PROJECTS_ONLY}
           ORDER BY rank
           LIMIT 30`
        )
        .all(ftsQuery) as FtsRow[];
    } catch (e) {
      log.warn('SearchService: FTS query failed', { query, error: String(e) });
      return [];
    }

    const results: SearchItem[] = rows.map((r) => ({
      kind: r.item_type as SearchItemKind,
      id: r.item_id,
      projectId: r.project_id,
      title: r.title,
      subtitle: '',
      score: r.rank,
    }));

    if (context?.workspaceId) {
      const fileHits = workspaceFileIndexService.search(context.workspaceId, query);
      for (const h of fileHits) {
        results.push({
          kind: 'file',
          id: h.path,
          projectId: context.projectId ?? null,
          title: h.filename,
          subtitle: h.path,
          score: 0,
        });
      }
    }

    return results;
  }

  /** 没有输入时:最近交互的会话(在一个项目里就只看这个项目的)。 */
  private recents(context?: CommandPaletteQuery['context']): SearchItem[] {
    const rows = sqlite
      .prepare(
        `SELECT c.id, c.title, c.project_id
         FROM sessions c
         WHERE c.archived_at IS NULL AND c.automation_run_id IS NULL
           AND (? IS NULL OR c.project_id = ?)
           AND NOT EXISTS (SELECT 1 FROM projects p
             WHERE p.id = c.project_id AND p.workspace_provider != 'local')
         ORDER BY c.last_interacted_at DESC
         LIMIT 10`
      )
      .all(context?.projectId ?? null, context?.projectId ?? null) as RecentSessionRow[];

    return rows.map((r) => ({
      kind: 'session' as const,
      id: r.id,
      projectId: r.project_id,
      title: r.title,
      subtitle: '',
      score: 0,
    }));
  }

  /** 会话按标题搜,外加它工作区的分支名与关联 issue。 */
  private async upsertSession(session: Session): Promise<void> {
    let branchName: string | undefined;
    if (session.workspaceId) {
      const [ws] = await db
        .select({ branchName: workspaces.branchName })
        .from(workspaces)
        .where(eq(workspaces.id, session.workspaceId))
        .limit(1);
      branchName = ws?.branchName ?? undefined;
    }
    const keywords = [branchName, session.linkedIssue?.identifier, session.linkedIssue?.title]
      .filter(Boolean)
      .join(' ');
    try {
      sqlite
        .prepare(
          `INSERT OR REPLACE INTO search_index(item_type, item_id, project_id, title, keywords)
           VALUES ('session', ?, ?, ?, ?)`
        )
        .run(session.id, session.projectId, session.title, keywords);
    } catch (e) {
      log.warn('SearchService: upsertSession failed', { sessionId: session.id, error: String(e) });
    }
  }

  private upsertProject(project: Project): void {
    try {
      sqlite
        .prepare(
          `INSERT OR REPLACE INTO search_index(item_type, item_id, project_id, title, keywords)
           VALUES ('project', ?, NULL, ?, ?)`
        )
        .run(project.id, project.name, project.path);
    } catch (e) {
      log.warn('SearchService: upsertProject failed', {
        projectId: project.id,
        error: String(e),
      });
    }
  }

  private removeByType(itemType: string, itemId: string): void {
    try {
      sqlite
        .prepare(`DELETE FROM search_index WHERE item_id = ? AND item_type = ?`)
        .run(itemId, itemType);
    } catch (e) {
      log.warn('SearchService: removeByType failed', { itemType, itemId, error: String(e) });
    }
  }

  private seedCommands(): void {
    try {
      sqlite.transaction(() => {
        sqlite.prepare(`DELETE FROM search_index WHERE item_type = 'command'`).run();
        const stmt = sqlite.prepare(
          `INSERT INTO search_index (item_type, item_id, project_id, title, keywords)
           VALUES ('command', ?, NULL, ?, ?)`
        );
        for (const def of ALL_COMMAND_DEFS) {
          stmt.run(def.id, def.label, def.description ?? '');
        }
      })();
      log.info('SearchService: seeded commands', { count: ALL_COMMAND_DEFS.length });
    } catch (e) {
      log.warn('SearchService: seedCommands failed', { error: String(e) });
    }
  }

  private backfill(): void {
    try {
      const count = (
        sqlite.prepare(`SELECT count(*) as n FROM search_index`).get() as { n: number }
      ).n;

      if (count > 0) return;

      const allProjects = db.select().from(projects).all();
      const allSessions = db
        .select({
          id: sessions.id,
          projectId: sessions.projectId,
          title: sessions.title,
          archivedAt: sessions.archivedAt,
          linkedIssue: sessions.linkedIssue,
          branchName: workspaces.branchName,
        })
        .from(sessions)
        .leftJoin(workspaces, eq(sessions.workspaceId, workspaces.id))
        .all()
        .filter((c) => !c.archivedAt);

      const upsertStmt = sqlite.prepare(
        `INSERT OR REPLACE INTO search_index(item_type, item_id, project_id, title, keywords)
         VALUES (?, ?, ?, ?, ?)`
      );

      sqlite.transaction(() => {
        for (const p of allProjects) {
          upsertStmt.run('project', p.id, null, p.name, p.path);
        }
        for (const c of allSessions) {
          const keywords = [c.branchName, c.linkedIssue?.identifier, c.linkedIssue?.title].filter(Boolean).join(' ');
          upsertStmt.run('session', c.id, c.projectId, c.title, keywords);
        }
      })();

      log.info('SearchService: backfilled search index', {
        projects: allProjects.length,
        sessions: allSessions.length,
      });
    } catch (e) {
      log.warn('SearchService: backfill failed', { error: String(e) });
    }
  }
}

export const searchService = new SearchService();
