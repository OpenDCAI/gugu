import type Database from 'better-sqlite3';
import { coverageReport } from '@gugu/core/shared/search/coverage';
import { highlight } from '@gugu/core/shared/search/highlight';
import { parseSearchTerms } from '@gugu/core/shared/search/query';
import { rankMessage } from '@gugu/core/shared/search/rank';
import { buildSearchSql } from '@gugu/core/shared/search/sql';
import { SEARCH_FACET_CAP, type SearchCoverage, type SearchCoverageReport, type SearchFacets, type SearchHit, type SearchTaskCoverage, type SearchQuery, type SearchResults } from '@gugu/core/shared/search/types';
import type { MessageSearchRequest } from '@shared/core/message-search';

type MessageRow = {
  id: string; chat_id: string | null; task_id: string | null; task_title: string | null; project_id: string | null; message_ref: string | null; role: 'user' | 'assistant' | null; thread_root_id: string | null; seq: number; sender_id: string | null;
  created_at_iso: string | null; text: string; to_user_ids: string; text_rank: number; has_file: number; has_image: number;
};
type CoverageRow = { chat_id: string; stream: string; oldest_seq: number | null; newest_seq: number | null; exhausted: number };

/** Read progress of every stream (main timelines and threads). */
export function readCoverage(db: Database.Database): SearchCoverage[] {
  return (db.prepare('SELECT * FROM coverage').all() as CoverageRow[]).map((row) => ({
    chatId: row.chat_id, threadRootId: row.stream || null, oldestSeq: row.oldest_seq, newestSeq: row.newest_seq,
    exhausted: row.exhausted === 1,
  }));
}

export const taskCoverageKey = (taskId: string) => `task:${taskId}`;

export function readTaskCoverage(db: Database.Database): SearchTaskCoverage[] {
  return (db.prepare(`SELECT task.id AS task_id,coalesce(task_coverage.last_seq,-1) AS last_seq,
    coalesce(task_coverage.exhausted,0) AS exhausted,task.terminal FROM task LEFT JOIN task_coverage ON task.id=task_id`).all() as
    { task_id: string; last_seq: number; exhausted: number; terminal: number }[])
    .map(row => ({ taskId: row.task_id, lastSeq: row.last_seq, exhausted: row.exhausted === 1 && row.terminal === 0,
      ...(row.terminal === 1 ? { reason: 'terminal' as const } : {}) }));
}

export const coverageKey = (chatId: string, threadRootId: string | null) => `${chatId}\u0000${threadRootId ?? ''}`;

/** A stream counts as read through only if the backfill reported on it since the store was opened (`current`). */
function readCoverageReport(db: Database.Database, current: ReadonlySet<string>, chatIds?: readonly string[]): SearchCoverageReport {
  const ids = chatIds ?? (db.prepare('SELECT id FROM chat').all() as { id: string }[]).map((row) => row.id);
  return coverageReport(ids, readCoverage(db).map((row) => ({ ...row, exhausted: row.exhausted && current.has(coverageKey(row.chatId, row.threadRootId)) })));
}

function readSearchCoverage(db: Database.Database, current: ReadonlySet<string>, query: SearchQuery): SearchCoverageReport {
  const chatReport = readCoverageReport(db, current, scopedChatIds(db, query));
  const taskIds = (query.filters.kind === 'message' ? [] : db.prepare('SELECT id FROM task').all() as { id: string }[]).map(row => row.id)
    .filter(id => !query.filters.in?.length || query.filters.in.some(scope => scope.kind === 'session' && scope.id === id));
  const stored = new Map(readTaskCoverage(db).map(row => [row.taskId, row]));
  const tasks = taskIds.map(taskId => ({ taskId, lastSeq: stored.get(taskId)?.lastSeq ?? -1,
    exhausted: stored.get(taskId)?.exhausted === true && current.has(taskCoverageKey(taskId)),
    ...(stored.get(taskId)?.reason ? { reason: stored.get(taskId)!.reason } : {}) }));
  return { chats: chatReport.chats, tasks,
    complete: (query.filters.kind === 'task' || chatReport.complete) && (query.filters.kind === 'message' || tasks.every(row => row.reason === 'terminal' || row.exhausted)) };
}

function scopedChatIds(db: Database.Database, query: SearchQuery): string[] | undefined {
  const scopes = query.filters.in;
  if (!scopes?.length) return undefined;
  const chats = db.prepare('SELECT id, source_chat_id FROM chat').all() as { id: string; source_chat_id: string | null }[];
  return chats.filter((chat) => scopes.some((scope) => scope.kind !== 'session' && (chat.id === scope.id
    || (scope.kind === 'chat' && scope.includeTopics !== false && chat.source_chat_id === scope.id)))).map((chat) => chat.id);
}

function hit(row: MessageRow, accountId: string, query: SearchQuery, now: number): SearchHit {
  const terms = parseSearchTerms(query.text).filter((term) => !term.exclude);
  const origin = row.task_id ? { kind: 'task' as const, taskId: row.task_id, projectId: row.project_id!, title: row.task_title!,
    reference: row.message_ref!, role: row.role!, attachment: null }
    : { kind: 'message' as const, chatId: row.chat_id!, threadRootId: row.thread_root_id,
      attachment: row.has_image ? 'image' as const : row.has_file ? 'file' as const : null };
  return {
    ...origin, id: row.id,
    seq: row.seq, senderId: row.sender_id, createdAt: row.created_at_iso, text: row.text,
    highlights: highlight(row.text, query.text),
    // The store has no familiarity or sender-kind projection. Unknown features stay neutral;
    // the shared SQL remains the ordering authority and the shared ranker supplies explanations.
    rank: rankMessage({
      phraseHit: terms.some((term) => term.phrase), allTermsHit: terms.length > 0,
      textRelevance: Math.abs(row.text_rank) / (1 + Math.abs(row.text_rank)), chatAffinity: 0, senderAffinity: 0,
      createdAt: row.created_at_iso, mentionsActor: (JSON.parse(row.to_user_ids) as string[]).includes(accountId),
      fromActor: row.sender_id === accountId, isAgent: row.role === 'assistant', isThreadReply: row.thread_root_id !== null,
    }, { now, sort: query.sort }),
  };
}

/**
 * Counts over the same SQL as the results, read in one pass over at most SEARCH_FACET_CAP + 1 matches: a very
 * common word must not cost a full count per facet. Past the cap, total is "1000+" and the kind counts are lower bounds.
 */
function readFacets(db: Database.Database, accountId: string, query: SearchQuery): SearchFacets {
  const count = (filters: SearchQuery['filters']) => {
    const { sql, params } = buildSearchSql({ ...query, filters }, accountId, { limit: SEARCH_FACET_CAP + 1, unordered: true });
    return db.prepare(`SELECT count(*) AS total, coalesce(sum(has_file), 0) AS file, coalesce(sum(has_image), 0) AS image,
      coalesce(sum(has_link), 0) AS link, coalesce(sum(chat_id IS NOT NULL),0) AS messages, coalesce(sum(task_id IS NOT NULL),0) AS tasks FROM (${sql})`).get(...params) as Omit<SearchFacets, 'otherChats'>;
  };
  const { has: _has, kind: _kind, ...filters } = query.filters;
  const scoped = count(filters);
  if (!filters.in?.length) return { ...scoped, otherChats: 0 };
  const { in: _in, ...everywhere } = filters;
  const all = count(everywhere).total;
  return { ...scoped, otherChats: all > SEARCH_FACET_CAP ? all : all - scoped.total };
}

export function readMessages(db: Database.Database, accountId: string, request: MessageSearchRequest, now: number, current: ReadonlySet<string>): SearchResults {
  const identity = JSON.stringify(request.query);
  let offset = 0;
  if (request.cursor) {
    const cursor = JSON.parse(request.cursor) as { identity: string; offset: number };
    if (cursor.identity !== identity || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) {
      throw new Error('Search cursor belongs to a different query');
    }
    offset = cursor.offset;
  }
  const limit = request.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Search limit must be a positive integer');
  const { sql, params } = buildSearchSql(request.query, accountId, { limit: limit + 1, offset });
  const rows = db.prepare(sql).all(...params) as MessageRow[];
  return {
    results: rows.slice(0, limit).map((row) => hit(row, accountId, request.query, now)),
    facets: readFacets(db, accountId, request.query),
    coverage: readSearchCoverage(db, current, request.query),
    nextCursor: rows.length > limit ? JSON.stringify({ identity, offset: offset + limit }) : null,
  };
}


export function readDateAnchor(db: Database.Database, accountId: string, query: SearchQuery): string | null {
  if (!query.filters.on) throw new Error('Date anchor requires an on date');
  const visible = buildSearchSql(query, accountId);
  const row = db.prepare(`WITH visible AS (${visible.sql}) SELECT id FROM visible ORDER BY created_at, seq, id LIMIT 1`)
    .get(...visible.params) as { id: string } | undefined;
  return row?.id ?? null;
}
