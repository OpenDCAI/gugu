import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MESSAGES_VIEW_SELECT, type RawMessageRow } from '@gugu/core/cloud/messageItem';
import type { SearchQuery } from '@gugu/core/shared/search/types';
import { AccountMessageSearch, MessageSearchStore } from './message-store';

let root: string;
const opened: MessageSearchStore[] = [];
const account = 'account-a';
const at = '2026-10-30T13:30:00.000900+08:00';
const query = (text: string, filters: SearchQuery['filters'] = {}): { query: SearchQuery } => ({ query: { text, filters, sort: 'recent' } });
const groups = { kind: 'chats' as const, chats: [
  { id: 'g', kind: 'group' as const, sourceChatId: null },
  { id: 't', kind: 'topic' as const, sourceChatId: 'g' },
  { id: 'other', kind: 'group' as const, sourceChatId: null },
] };
function row(id: string, extra: Record<string, unknown> = {}): RawMessageRow {
  return { ...Object.fromEntries(MESSAGES_VIEW_SELECT.split(', ').map((field) => [field, null])),
    id, chat_id: 'g', sender_user_id: 'peer', to_user_ids: null, seq: 1, content: '發佈計劃', content_type: 'text',
    created_at: at, thread_root_id: null, is_whisper: false, reply_to_message_id: null, ...extra };
}
function open(id = account) {
  const store = new MessageSearchStore(root, id); opened.push(store); return store;
}
const ids = (store: MessageSearchStore, text: string, filters?: SearchQuery['filters']) =>
  store.global(query(text, filters)).results.map((hit) => hit.id);
const ftsRows = (store: MessageSearchStore) => {
  const db = new Database(store.path, { readonly: true });
  try { return (db.prepare('SELECT count(*) AS n FROM msg_fts').get() as { n: number }).n; } finally { db.close(); }
};
function storedRows(store: MessageSearchStore, table: 'msg' | 'coverage' | 'chat', chatId?: string): number {
  const db = new Database(store.path, { readonly: true });
  try {
    const column = table === 'chat' ? 'id' : 'chat_id';
    return (db.prepare(`SELECT count(*) AS n FROM ${table}${chatId ? ` WHERE ${column}=?` : ''}`)
      .get(...(chatId ? [chatId] : [])) as { n: number }).n;
  } finally { db.close(); }
}
function matchingFtsRows(store: MessageSearchStore, term: string): number {
  const db = new Database(store.path, { readonly: true });
  try { return (db.prepare('SELECT count(*) AS n FROM msg_fts WHERE msg_fts MATCH ?').get(term) as { n: number }).n; }
  finally { db.close(); }
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'message-search-')); });
afterEach(() => {
  for (const store of opened.splice(0)) store.close();
  rmSync(root, { recursive: true, force: true });
});

describe('account message index on real SQLite FTS5', () => {
  it('shares contentless FTS across origins while chat/task inventories purge independently', () => {
    const store = open();
    const document = { id: 'task:s:ref', taskId: 's', reference: 'ref', role: 'assistant' as const, seq: 0, text: 'taskneedle', createdAt: at };
    store.apply([groups, { kind: 'task', task: { id: 's', title: 'Original', projectId: 'p' } },
      { kind: 'taskTurn', taskId: 's', seq: 0, documents: [document] }, { kind: 'rows', rows: [row('m', { content: 'chatneedle' })] }]);
    expect(store.global(query('taskneedle')).results[0]).toMatchObject({ kind: 'task', reference: 'ref', title: 'Original' });
    expect(ids(store, 'taskneedle', { has: ['file'] })).toEqual([]);
    expect(ids(store, 'taskneedle', { in: [{ kind: 'session', id: 's' }] })).toEqual([document.id]);
    store.apply([{ kind: 'chats', chats: [] }, { kind: 'task', task: { id: 's', title: 'Renamed', projectId: 'p' } }]);
    expect(ids(store, 'chatneedle')).toEqual([]);
    expect(store.global(query('taskneedle')).results[0]).toMatchObject({ title: 'Renamed' });
    store.apply([{ kind: 'taskTurn', taskId: 's', seq: 0, documents: [{ ...document, text: 'revisedneedle' }] }]);
    expect(matchingFtsRows(store, 'taskneedle')).toBe(0);
    expect(ids(store, 'revisedneedle')).toEqual([document.id]);
    store.apply([{ kind: 'tasks', tasks: [] }]);
    expect(matchingFtsRows(store, 'revisedneedle')).toBe(0);
  });

  it('re-earns task completeness on reopen and invalidates it on truncation', () => {
    const store = open();
    const task = { id: 's', title: 'Task', projectId: 'p' };
    const scoped = query('', { in: [{ kind: 'session', id: 's' }] });
    store.apply([{ kind: 'task', task }, { kind: 'taskCoverage', coverage: { taskId: 's', lastSeq: 20, exhausted: true } }]);
    expect(store.global(scoped).coverage.complete).toBe(true);
    store.close();
    const reopened = open();
    expect(reopened.taskCoverage()[0].lastSeq).toBe(20);
    expect(reopened.global(scoped).coverage.complete).toBe(false);
    reopened.apply([{ kind: 'taskCoverage', coverage: { taskId: 's', lastSeq: 20, exhausted: true } },
      { kind: 'truncateTask', taskId: 's', fromSeq: 5 }]);
    expect(reopened.global(scoped).coverage.complete).toBe(false);
  });

  it('indexes read rows idempotently and returns the original ISO time with highlights', () => {
    const store = open();
    store.apply([groups, { kind: 'rows', rows: [row('m')] }]);
    store.apply([{ kind: 'rows', rows: [row('m')] }]);
    expect(store.global(query('发布')).results.map((hit) => [hit.id, hit.createdAt, hit.highlights]))
      .toEqual([['m', at, [{ start: 0, end: 2 }]]]);
    expect(ftsRows(store)).toBe(1);
    expect(storedRows(store, 'msg')).toBe(1);
  });

  it('removes a deleted message from the table and the full-text index', () => {
    const store = open();
    store.apply([groups, { kind: 'rows', rows: [row('m', { content: '发布 deletedneedle' }), row('n', { seq: 2, content: '发布 retainedneedle' })] }]);
    expect(matchingFtsRows(store, 'deletedneedle')).toBe(1);
    store.apply([{ kind: 'remove', ids: ['m'] }]);
    expect(ids(store, '发布')).toEqual(['n']);
    expect(ftsRows(store)).toBe(1);
    expect(matchingFtsRows(store, 'deletedneedle')).toBe(0);
    expect(matchingFtsRows(store, 'retainedneedle')).toBe(1);
  });

  it('replaces a row re-read as retracted, and drops rows that carry nothing searchable', () => {
    const store = open();
    store.apply([groups, { kind: 'rows', rows: [row('m'), row('sys', { content_type: 'system' })] }]);
    expect(ids(store, '发布')).toEqual(['m']);
    store.apply([{ kind: 'rows', rows: [row('m', { retracted_at: at })] }]);
    expect(ids(store, '发布')).toEqual([]);
  });

  it('purges every row and coverage of a chat that leaves the authoritative list', () => {
    const store = open();
    store.apply([groups, { kind: 'rows', rows: [row('m'), row('x', { chat_id: 'other', content: '发布 droppedneedle' })] },
      { kind: 'coverage', coverage: { chatId: 'g', threadRootId: null, oldestSeq: 1, newestSeq: 1, exhausted: true } },
      { kind: 'coverage', coverage: { chatId: 'other', threadRootId: null, oldestSeq: 1, newestSeq: 1, exhausted: true } }]);
    expect(storedRows(store, 'msg', 'other')).toBe(1);
    expect(matchingFtsRows(store, 'droppedneedle')).toBe(1);
    store.apply([{ kind: 'chats', chats: groups.chats.filter((chat) => chat.id !== 'other') }]);
    expect(ids(store, '发布')).toEqual(['m']);
    expect(store.coverage()).toEqual([{ chatId: 'g', threadRootId: null, oldestSeq: 1, newestSeq: 1, exhausted: true }]);
    expect(storedRows(store, 'msg', 'other')).toBe(0);
    expect(storedRows(store, 'coverage', 'other')).toBe(0);
    expect(storedRows(store, 'chat', 'other')).toBe(0);
    expect(matchingFtsRows(store, 'droppedneedle')).toBe(0);
    // A row of a chat that is not listed is not kept.
    store.apply([{ kind: 'rows', rows: [row('late', { chat_id: 'other' })] }]);
    expect(ids(store, '发布')).toEqual(['m']);
  });

  it('clears one chat for me without touching another', () => {
    const store = open();
    store.apply([groups, { kind: 'rows', rows: [row('m'), row('x', { chat_id: 'other' })] },
      { kind: 'coverage', coverage: { chatId: 'g', threadRootId: null, oldestSeq: 1, newestSeq: 1, exhausted: true } },
      { kind: 'coverage', coverage: { chatId: 'other', threadRootId: null, oldestSeq: 1, newestSeq: 1, exhausted: false } }]);
    expect(storedRows(store, 'msg', 'g')).toBe(1);
    expect(storedRows(store, 'coverage', 'g')).toBe(1);
    store.apply([{ kind: 'clearChat', chatId: 'g' }]);
    expect(ids(store, '发布')).toEqual(['x']);
    expect(store.coverage()).toEqual([{ chatId: 'other', threadRootId: null, oldestSeq: 1, newestSeq: 1, exhausted: false }]);
    expect(storedRows(store, 'msg', 'g')).toBe(0);
    expect(storedRows(store, 'coverage', 'g')).toBe(0);
    expect(storedRows(store, 'msg', 'other')).toBe(1);
  });

  it('applies one list of ops atomically', () => {
    const store = open();
    store.apply([groups]);
    expect(() => store.apply([{ kind: 'rows', rows: [row('m')] }, { kind: 'rows', rows: [row('bad', { created_at: 'yesterday' })] }])).toThrow();
    expect(ids(store, '发布')).toEqual([]);
  });

  it.each([
    ['empty', { content: '   ' }],
    ['malformed', { sender_user_id: undefined }],
  ])('removes a previously indexed row when re-read as %s', (_name, patch) => {
    const store = open();
    store.apply([groups, { kind: 'rows', rows: [row('m', { content: 'oldneedle' }), row('n')] }]);
    expect(matchingFtsRows(store, 'oldneedle')).toBe(1);
    store.apply([{ kind: 'rows', rows: [row('m', patch)] }]);
    expect(matchingFtsRows(store, 'oldneedle')).toBe(0);
    expect(ids(store, '发布')).toEqual(['n']);
    expect(storedRows(store, 'msg')).toBe(1);
  });

  it('filters by topic inheritance, sender, attachment, mention and whisper', () => {
    const store = open();
    const attachment = '[附件] 发布计划.pdf (application/pdf)\n[Size] 10\n[Kind] file';
    store.apply([groups, { kind: 'rows', rows: [
      row('main', { to_user_ids: [account] }),
      row('topic', { chat_id: 't' }),
      row('file', { seq: 2, content: attachment, content_type: 'attachment', file_blob_id: 'blob' }),
      row('whisper', { seq: 3, is_whisper: true, sender_user_id: account, to_user_ids: ['peer'] }),
    ] }]);
    expect(ids(store, '发布', { in: [{ kind: 'chat', id: 'g' }] }).sort()).toEqual(['file', 'main', 'topic', 'whisper']);
    expect(ids(store, '发布', { in: [{ kind: 'chat', id: 'g', includeTopics: false }] })).not.toContain('topic');
    expect(ids(store, '发布', { has: ['file'] })).toEqual(['file']);
    expect(ids(store, '发布', { is: ['mention'] })).toEqual(['main']);
    expect(ids(store, '发布', { is: ['whisper'] })).toEqual(['whisper']);
    expect(ids(store, '发布', { from: [account] })).toEqual(['whisper']);
  });

  it('counts facets over the same query, ignoring the has: filter, and counts matches outside in:', () => {
    const store = open();
    const attachment = '[附件] 发布计划.pdf (application/pdf)\n[Size] 10\n[Kind] file';
    store.apply([groups, { kind: 'rows', rows: [
      row('text', { content: '发布 https://example.com' }),
      row('file', { seq: 2, content: attachment, content_type: 'attachment', file_blob_id: 'blob' }),
      row('elsewhere', { chat_id: 'other' }),
    ] }]);
    const scoped = store.global(query('发布', { in: [{ kind: 'chat', id: 'g' }], has: ['file'] }));
    expect(scoped.results.map((hit) => [hit.id, hit.attachment])).toEqual([['file', 'file']]);
    expect(scoped.facets).toEqual({ total: 2, file: 1, image: 0, link: 1, otherChats: 1, messages: 2, tasks: 0 });
    expect(store.global(query('发布')).facets.otherChats).toBe(0);
  });

  it('stops counting a facet one past the cap instead of counting every match', () => {
    const store = open();
    store.apply([groups, { kind: 'rows', rows: Array.from({ length: 1005 }, (_, i) => row(`m${i}`, { seq: i + 1 })) }]);
    const { results, facets } = store.global(query('发布'));
    expect(results).toHaveLength(50);
    expect(facets).toEqual({ total: 1001, file: 0, image: 0, link: 0, otherChats: 0, messages: 1001, tasks: 0 });
  });

  it('does not index card or widget messages, so a search never shows them', () => {
    const store = open();
    store.apply([groups, { kind: 'rows', rows: [row('card', { content_type: 'card', content: '{"title":"发布计划"}' }),
      row('widget', { seq: 2, content_type: 'widget', content: '发布计划' })] }]);
    expect(ids(store, '发布')).toEqual([]);
  });

  it('anchors a date-only query on the first message of that local day', () => {
    const store = open();
    const start = new Date(2026, 9, 27).getTime();
    const next = new Date(2026, 9, 28).getTime();
    store.apply([groups, { kind: 'rows', rows: [
      row('previous', { seq: 1, created_at: new Date(start - 1).toISOString() }),
      row('first', { seq: 2, created_at: new Date(start).toISOString() }),
      row('late', { seq: 3, created_at: new Date(next - 1).toISOString() }),
      row('next', { seq: 4, created_at: new Date(next).toISOString() }),
    ] }]);
    expect(store.dateAnchor({ text: '', filters: { on: '2026-10-27' }, sort: 'recent' })).toBe('first');
    expect(ids(store, '', { on: '2026-10-27' })).toEqual(['late', 'first']);
  });

  it('reports coverage per stream and completeness per listed chat', () => {
    const store = open();
    store.apply([groups,
      { kind: 'coverage', coverage: { chatId: 'g', threadRootId: null, oldestSeq: 1, newestSeq: 9, exhausted: true } },
      { kind: 'coverage', coverage: { chatId: 'g', threadRootId: 'root', oldestSeq: null, newestSeq: null, exhausted: false } }]);
    expect(store.coverage()).toHaveLength(2);
    expect(store.global(query('x', { in: [{ kind: 'chat', id: 'g', includeTopics: false }] })).coverage.complete).toBe(true);
    expect(store.global(query('x')).coverage.complete).toBe(false);
  });

  it('keeps rows across reopen at the same schema version', () => {
    const first = open();
    first.apply([groups, { kind: 'rows', rows: [row('m')] }]);
    first.close();
    expect(ids(open(), '发布')).toEqual(['m']);
  });

  it('rebuilds an actual schema-3 file, removes its actor tables, and accepts current writes', () => {
    mkdirSync(join(root, 'search'));
    const path = join(root, 'search', account + '.sqlite');
    const legacy = new Database(path);
    try {
      legacy.exec(readFileSync(join(__dirname, 'fixtures/message-search-schema3.sql'), 'utf8'));
      legacy.prepare("INSERT INTO search_meta VALUES ('version', '3:1')").run();
      legacy.prepare("INSERT INTO chat VALUES ('g', 'Legacy group', 'group', NULL)").run();
      legacy.prepare(`INSERT INTO msg
        (id,chat_id,seq,sender_id,created_at,created_at_iso,text,body,is_whisper,to_user_ids,has_file,has_image,has_link)
        VALUES ('legacy','g',1,'peer',0,'1970-01-01T00:00:00Z','legacyneedle','legacyneedle',0,'[]',0,0,0)`).run();
      expect((legacy.prepare('SELECT count(*) AS n FROM msg').get() as { n: number }).n).toBe(1);
    } finally { legacy.close(); }
    const store = open();
    const rebuilt = new Database(path, { readonly: true });
    try {
      expect(rebuilt.prepare("SELECT value FROM search_meta WHERE key='version'").get()).toEqual({ value: '5:2' });
      expect(rebuilt.prepare("SELECT name FROM sqlite_master WHERE name IN ('actor_scope','msg_actor')").all()).toEqual([]);
    } finally { rebuilt.close(); }
    expect(storedRows(store, 'msg')).toBe(0);
    expect(matchingFtsRows(store, 'legacyneedle')).toBe(0);
    store.apply([groups, { kind: 'rows', rows: [row('new')] }]);
    expect(ids(store, '发布')).toEqual(['new']);
  });

  it('deletes the previous account index on sign-out', async () => {
    let current: string | null = account;
    const search = new AccountMessageSearch(() => root, async () => current, async () => true);
    search.accountChanged(account);
    await search.write([groups, { kind: 'rows', rows: [row('m')] }]);
    expect(readdirSync(join(root, 'search')).some((name) => name.startsWith(account))).toBe(true);
    current = null;
    search.accountChanged(null);
    expect(readdirSync(join(root, 'search')).filter((name) => name.startsWith(account))).toEqual([]);
    await expect(search.global(query('发布'))).rejects.toThrow(/not signed in/);
  });

  it('drops writes and opens nothing while global search is disabled', async () => {
    const search = new AccountMessageSearch(() => root, async () => account, async () => false);
    await expect(search.write([groups])).resolves.toBe(false);
    await expect(search.global(query('发布'))).rejects.toThrow(/not enabled/);
    expect(existsSync(join(root, 'search'))).toBe(false);
  });

  it('does not report a chat complete until the backfill has reported on it since the store opened', async () => {
    const exhausted = { kind: 'coverage' as const, coverage: { chatId: 'g', threadRootId: null, oldestSeq: 1, newestSeq: 9, exhausted: true } };
    const scoped = query('x', { in: [{ kind: 'chat', id: 'g', includeTopics: false }] });
    const first = open();
    first.apply([groups, exhausted]);
    expect(first.global(scoped).coverage.complete).toBe(true);
    first.close();
    // Restart: the stored progress remains, but nothing has caught up since.
    const reopened = open();
    expect(reopened.coverage()).toEqual([exhausted.coverage]);
    expect(reopened.global(scoped).coverage.complete).toBe(false);
    reopened.apply([exhausted]);
    expect(reopened.global(scoped).coverage.complete).toBe(true);
  });

  it('makes completeness be earned again after a write was dropped while disabled', async () => {
    let enabled = true;
    const search = new AccountMessageSearch(() => root, async () => account, async () => enabled);
    const scoped = query('x', { in: [{ kind: 'chat', id: 'g', includeTopics: false }] });
    await search.write([groups, { kind: 'coverage', coverage: { chatId: 'g', threadRootId: null, oldestSeq: 1, newestSeq: 9, exhausted: true } }]);
    expect((await search.global(scoped)).coverage.complete).toBe(true);
    enabled = false;
    await expect(search.write([{ kind: 'remove', ids: ['missed'] }])).resolves.toBe(false);
    enabled = true;
    expect((await search.global(scoped)).coverage.complete).toBe(false);
    search.accountChanged(null);
  });

  it('deletes all previous-account files on switch and starts the next account with no old hits', async () => {
    let current: string | null = account;
    const search = new AccountMessageSearch(() => root, async () => current, async () => true);
    const files = (id: string) => ['', '-wal', '-shm'].map((suffix) => join(root, 'search', id + '.sqlite' + suffix));
    try {
      await search.write([groups, { kind: 'rows', rows: [row('old-account-message')] }]);
      for (const path of files(account)) expect(existsSync(path), path).toBe(true);
      current = 'account-b';
      search.accountChanged(current);
      for (const path of files(account)) expect(existsSync(path), path).toBe(false);
      await search.write([groups, { kind: 'rows', rows: [row('new-account-message')] }]);
      expect((await search.global(query('发布'))).results.map((hit) => hit.id)).toEqual(['new-account-message']);
      current = null;
      search.accountChanged(null);
      for (const path of files('account-b')) expect(existsSync(path), path).toBe(false);
    } finally { search.accountChanged(null); }
  });
});
