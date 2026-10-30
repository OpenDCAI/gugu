import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RawMessageRow } from '@gugu/core/cloud/messageItem';
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
  return { id, chat_id: 'g', sender_user_id: 'peer', to_user_ids: null, seq: 1, content: '發佈計劃', content_type: 'text',
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

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'message-search-')); });
afterEach(() => {
  for (const store of opened.splice(0)) store.close();
  rmSync(root, { recursive: true, force: true });
});

describe('account message index on real SQLite FTS5', () => {
  it('indexes read rows idempotently and returns the original ISO time with highlights', () => {
    const store = open();
    store.apply([groups, { kind: 'rows', rows: [row('m')] }]);
    store.apply([{ kind: 'rows', rows: [row('m')] }]);
    expect(store.global(query('发布')).results.map((hit) => [hit.id, hit.createdAt, hit.highlights]))
      .toEqual([['m', at, [{ start: 0, end: 2 }]]]);
    expect(ftsRows(store)).toBe(1);
  });

  it('removes a deleted message from the table and the full-text index', () => {
    const store = open();
    store.apply([groups, { kind: 'rows', rows: [row('m'), row('n', { seq: 2 })] }]);
    store.apply([{ kind: 'remove', ids: ['m'] }]);
    expect(ids(store, '发布')).toEqual(['n']);
    expect(ftsRows(store)).toBe(1);
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
    store.apply([groups, { kind: 'rows', rows: [row('m'), row('x', { chat_id: 'other' })] },
      { kind: 'coverage', coverage: { chatId: 'other', threadRootId: null, oldestSeq: 1, newestSeq: 1, exhausted: true } }]);
    store.apply([{ kind: 'chats', chats: groups.chats.filter((chat) => chat.id !== 'other') }]);
    expect(ids(store, '发布')).toEqual(['m']);
    expect(store.coverage()).toEqual([]);
    // A row of a chat that is not listed is not kept.
    store.apply([{ kind: 'rows', rows: [row('late', { chat_id: 'other' })] }]);
    expect(ids(store, '发布')).toEqual(['m']);
  });

  it('clears one chat for me without touching another', () => {
    const store = open();
    store.apply([groups, { kind: 'rows', rows: [row('m'), row('x', { chat_id: 'other' })] },
      { kind: 'coverage', coverage: { chatId: 'g', threadRootId: null, oldestSeq: 1, newestSeq: 1, exhausted: true } }]);
    store.apply([{ kind: 'clearChat', chatId: 'g' }]);
    expect(ids(store, '发布')).toEqual(['x']);
    expect(store.coverage()).toEqual([]);
  });

  it('applies one list of ops atomically', () => {
    const store = open();
    store.apply([groups]);
    expect(() => store.apply([{ kind: 'rows', rows: [row('m')] }, { kind: 'rows', rows: [row('bad', { created_at: 'yesterday' })] }])).toThrow();
    expect(ids(store, '发布')).toEqual([]);
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

  it('does not index card or widget messages, so a search never shows them', () => {
    const store = open();
    store.apply([groups, { kind: 'rows', rows: [row('card', { content_type: 'card', content: '{"title":"发布计划"}' }),
      row('widget', { seq: 2, content_type: 'widget', content: '发布计划' })] }]);
    expect(ids(store, '发布')).toEqual([]);
  });

  it('anchors a date-only query on the first message of that local day', () => {
    const store = open();
    store.apply([groups, { kind: 'rows', rows: [
      row('late', { seq: 2, created_at: '2026-10-27T20:00:00+00:00' }),
      row('first', { seq: 1, created_at: '2026-10-27T01:00:00+00:00' }),
    ] }]);
    const day = new Date('2026-10-27T01:00:00Z');
    const on = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    expect(store.dateAnchor({ text: '', filters: { on }, sort: 'recent' })).toBe('first');
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

  it('keeps rows across reopen and rebuilds an index of an older schema version', () => {
    const first = open();
    first.apply([groups, { kind: 'rows', rows: [row('m')] }]);
    first.close();
    expect(ids(open(), '发布')).toEqual(['m']);
    opened.splice(0).forEach((store) => store.close());
    const db = new Database(first.path);
    db.prepare("UPDATE search_meta SET value='3:1' WHERE key='version'").run();
    db.close();
    expect(ids(open(), '发布')).toEqual([]);
  });

  it('deletes the previous account index on sign-out and account switch', async () => {
    let current: string | null = account;
    const search = new AccountMessageSearch(() => root, async () => current, async () => true);
    search.accountChanged(account);
    await search.apply([groups, { kind: 'rows', rows: [row('m')] }]);
    expect(readdirSync(join(root, 'search')).some((name) => name.startsWith(account))).toBe(true);
    current = null;
    search.accountChanged(null);
    expect(readdirSync(join(root, 'search')).filter((name) => name.startsWith(account))).toEqual([]);
    await expect(search.global(query('发布'))).rejects.toThrow(/not signed in/);
  });

  it('opens nothing while global search is disabled', async () => {
    const search = new AccountMessageSearch(() => root, async () => account, async () => false);
    await expect(search.apply([groups])).rejects.toThrow(/not enabled/);
    expect(existsSync(join(root, 'search'))).toBe(false);
  });
});
