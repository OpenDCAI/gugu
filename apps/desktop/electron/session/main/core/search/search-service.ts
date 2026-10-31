import { eq } from 'drizzle-orm';
import { db, sqlite } from '@main/db/client';
import { sessions, workspaces } from '@main/db/schema';
import { readProjects } from '../projects/operations/getProjects';
import { log } from '@main/lib/logger';
import type { Session } from '@shared/core/sessions/sessions';
import type {
  CommandPaletteQuery,
  SearchItem,
  SearchItemKind,
  TaskTurnHit,
  WorkspaceFileHit,
} from '@shared/core/search';
import { excerpt } from '@shared/core/search';
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

/**
 * One text, one condition, for every trigram index here: the text is split on whitespace and each piece is a substring
 * that must occur. A piece of three or more characters MATCHes the trigram index (a substring index, so no word
 * segmentation, Chinese included); a shorter one is a LIKE over the given columns. No pieces → null (nothing to search).
 */
export function textCondition(text: string, ftsTable: string, likeColumns: readonly string[]): { sql: string; params: string[] } | null {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const long = words.filter((word) => [...word].length >= 3), short = words.filter((word) => [...word].length < 3);
  const sql: string[] = [], params: string[] = [];
  if (long.length) {
    sql.push(`${ftsTable} MATCH ?`);
    params.push(long.map((word) => `"${word.replaceAll('"', '""')}"`).join(' AND '));
  }
  for (const word of short) {
    sql.push(`(${likeColumns.map((column) => `${column} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
    params.push(...likeColumns.map(() => `%${word.replace(/[\\%_]/g, '\\$&')}%`));
  }
  return { sql: sql.join(' AND '), params };
}

class SearchService {
  initialize(): void {
    projectEvents.on('project:created', (project) => this.upsertProject(project));
    projectEvents.on('project:deleted', (projectId) => this.removeByType('project', projectId));

    sessionEvents.on('session:created', (session) => {
      const project = readProjects().find(project => project.id === session.projectId);
      if (project) this.upsertProject(project);
      void this.upsertSession(session);
    });
    sessionEvents.on('session:renamed', (sessionId) => {
      const [row] = db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1).all();
      if (row) void this.upsertSession(mapSessionRowToSession(row));
    });
    // 已归档任务离开活动搜索,历史仍保留。
    sessionEvents.on('session:archived', (sessionId) =>
      this.removeByType('session', sessionId)
    );

    sqlite.prepare("DELETE FROM search_index WHERE item_type = 'command'").run();
    this.backfill();
  }

  searchFiles(workspaceId: string, query: string, limit?: number): WorkspaceFileHit[] {
    return workspaceFileIndexService.searchFiles(workspaceId, query, limit);
  }

  search({ query }: CommandPaletteQuery): SearchItem[] {
    if (!query.trim()) return this.recents();

    const condition = textCondition(query, 'search_index', ['title', 'keywords']);
    if (!condition) return [];
    let rows: FtsRow[];
    try {
      rows = sqlite.prepare(`SELECT item_type, item_id, project_id, title, ${condition.sql.includes('MATCH') ? 'bm25(search_index)' : '0'} AS rank
        FROM search_index WHERE ${condition.sql} AND ${LOCAL_PROJECTS_ONLY} ORDER BY rank LIMIT 30`).all(...condition.params) as FtsRow[];
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


    return results;
  }

  /** What was said in local tasks (turn_text, kept by triggers on session_turns), newest first. */
  searchTaskTurns(query: string, limit = 30): TaskTurnHit[] {
    const condition = textCondition(query, 'turn_text', ['r.text']);
    if (!condition) return [];
    const where = condition.sql.replace('turn_text MATCH ?', 'r.id IN (SELECT rowid FROM turn_text WHERE turn_text MATCH ?)');
    const rows = sqlite.prepare(`SELECT r.session_id, r.item_id, r.role, r.text, s.title, s.project_id, s.archived_at, t.created_at
      FROM turn_text_rows r JOIN sessions s ON s.id = r.session_id JOIN session_turns t ON t.session_id = r.session_id AND t.seq = r.seq
      WHERE ${where} AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = s.project_id AND p.workspace_provider != 'local')
      ORDER BY t.created_at DESC, r.id DESC LIMIT ?`).all(...condition.params, Math.min(Math.max(limit, 1), 100)) as {
        session_id: string; item_id: string; role: string; text: string; title: string; project_id: string; archived_at: string | null; created_at: string;
      }[];
    return rows.map((row) => ({ sessionId: row.session_id, projectId: row.project_id, title: row.title, archived: row.archived_at !== null,
      itemId: row.item_id, role: row.role === 'user' ? 'user' : 'assistant', excerpt: excerpt(row.text, query), at: row.created_at }));
  }

  /** 没有输入时:最近交互的任务。 */
  private recents(): SearchItem[] {
    const rows = sqlite
      .prepare(
        `SELECT c.id, c.title, c.project_id
         FROM sessions c
         WHERE c.archived_at IS NULL AND c.automation_run_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM projects p
             WHERE p.id = c.project_id AND p.workspace_provider != 'local')
         ORDER BY c.last_interacted_at DESC
         LIMIT 10`
      )
      .all() as RecentSessionRow[];

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
      this.replace('session', session.id, session.projectId, session.title, keywords);
    } catch (e) {
      log.warn('SearchService: upsertSession failed', { sessionId: session.id, error: String(e) });
    }
  }

  private upsertProject(project: Project): void {
    try {
      this.replace('project', project.id, null, project.name, project.path);
    } catch (e) {
      log.warn('SearchService: upsertProject failed', {
        projectId: project.id,
        error: String(e),
      });
    }
  }

  /** FTS5 has no key to replace on: an item's row is deleted before it is written again. */
  private replace(itemType: SearchItemKind, itemId: string, projectId: string | null, title: string, keywords: string): void {
    sqlite.transaction(() => {
      sqlite.prepare('DELETE FROM search_index WHERE item_id = ? AND item_type = ?').run(itemId, itemType);
      sqlite.prepare('INSERT INTO search_index(item_type, item_id, project_id, title, keywords) VALUES (?, ?, ?, ?, ?)')
        .run(itemType, itemId, projectId, title, keywords);
    })();
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

  private backfill(): void {
    try {
      const count = (
        sqlite.prepare(`SELECT count(*) as n FROM search_index`).get() as { n: number }
      ).n;

      if (count > 0) return;

      const allProjects = readProjects();
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
        `INSERT INTO search_index(item_type, item_id, project_id, title, keywords)
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
