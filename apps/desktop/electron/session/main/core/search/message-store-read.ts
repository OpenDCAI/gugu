import type Database from 'better-sqlite3';
import { coverageReport } from '@gugu/core/shared/search/coverage';
import { highlight } from '@gugu/core/shared/search/highlight';
import { parseSearchTerms } from '@gugu/core/shared/search/query';
import { rankMessage } from '@gugu/core/shared/search/rank';
import { buildSearchSql } from '@gugu/core/shared/search/sql';
import type { SearchCoverage, SearchCoverageReport, SearchMessageHit, SearchQuery, SearchResults } from '@gugu/core/shared/search/types';
import type { MessageSearchRequest } from '@shared/core/message-search';

type MessageRow = {
  id: string; chat_id: string; thread_root_id: string | null; seq: number; sender_id: string | null;
  created_at_iso: string; text: string; to_user_ids: string; text_rank: number;
};
type CoverageRow = { chat_id: string; stream: string; oldest_seq: number | null; newest_seq: number | null; exhausted: number };

/** Read progress of every stream (main timelines and threads). */
export function readCoverage(db: Database.Database): SearchCoverage[] {
  return (db.prepare('SELECT * FROM coverage').all() as CoverageRow[]).map((row) => ({
    chatId: row.chat_id, threadRootId: row.stream || null, oldestSeq: row.oldest_seq, newestSeq: row.newest_seq,
    exhausted: row.exhausted === 1,
  }));
}

function readCoverageReport(db: Database.Database, chatIds?: readonly string[]): SearchCoverageReport {
  const ids = chatIds ?? (db.prepare('SELECT id FROM chat').all() as { id: string }[]).map((row) => row.id);
  return coverageReport(ids, readCoverage(db));
}

function scopedChatIds(db: Database.Database, query: SearchQuery): string[] | undefined {
  const scopes = query.filters.in;
  if (!scopes?.length) return undefined;
  const chats = db.prepare('SELECT id, source_chat_id FROM chat').all() as { id: string; source_chat_id: string | null }[];
  return chats.filter((chat) => scopes.some((scope) => chat.id === scope.id
    || (scope.kind === 'chat' && scope.includeTopics !== false && chat.source_chat_id === scope.id))).map((chat) => chat.id);
}

function hit(row: MessageRow, accountId: string, query: SearchQuery, now: number): SearchMessageHit {
  const terms = parseSearchTerms(query.text).filter((term) => !term.exclude);
  return {
    kind: 'message', id: row.id, chatId: row.chat_id, threadRootId: row.thread_root_id,
    seq: row.seq, senderId: row.sender_id, createdAt: row.created_at_iso, text: row.text,
    highlights: highlight(row.text, query.text),
    // The store has no familiarity or sender-kind projection. Unknown features stay neutral;
    // the shared SQL remains the ordering authority and the shared ranker supplies explanations.
    rank: rankMessage({
      phraseHit: terms.some((term) => term.phrase), allTermsHit: terms.length > 0,
      textRelevance: Math.abs(row.text_rank) / (1 + Math.abs(row.text_rank)), chatAffinity: 0, senderAffinity: 0,
      createdAt: row.created_at_iso, mentionsActor: (JSON.parse(row.to_user_ids) as string[]).includes(accountId),
      fromActor: row.sender_id === accountId, isAgent: false, isThreadReply: row.thread_root_id !== null,
    }, { now, sort: query.sort }),
  };
}

export function readMessages(db: Database.Database, accountId: string, request: MessageSearchRequest, now: number): SearchResults {
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
    coverage: readCoverageReport(db, scopedChatIds(db, request.query)),
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
