import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptTurn } from '@gugu/session-core/acp';

const fixtureRef = vi.hoisted(() => ({
  current: undefined as Awaited<ReturnType<typeof openFixture>> | undefined,
}));

vi.mock('@main/db/client', () => ({
  get db() {
    return fixtureRef.current!.db;
  },
  get sqlite() {
    return fixtureRef.current!.sqlite;
  },
}));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));

const { initializeDatabase } = await import('@main/db/initialize');
const { searchService, textCondition } = await import('./search-service');
const { persistCommittedTurn, truncateStoredHistory, withStoredTurns, appendRecordTurnNow } = await import('../sessions/session-turn-store');

function turn(id: string, items: TranscriptTurn['items'], seq = 0): TranscriptTurn {
  return { id, seq, initiator: 'user', items } as TranscriptTurn;
}
const said = (id: string, role: 'user' | 'assistant', text: string) => ({ kind: 'message', id, seq: 0, role, text }) as TranscriptTurn['items'][number];

const fixture = () => fixtureRef.current!;
const indexed = () => fixture().sqlite.prepare('SELECT session_id, seq, role, text FROM turn_text_rows ORDER BY session_id, seq, id').all();
const found = (query: string) => searchService.searchTaskTurns(query).map((hit) => hit.excerpt);

describe('textCondition', () => {
  it('matches pieces of three or more characters on the trigram index and shorter ones by LIKE, all required', () => {
    expect(textCondition(' deploy  数据库 登录 ', 't', ['c', 'd'])).toEqual({
      sql: "t MATCH ? AND (c LIKE ? ESCAPE '\\' OR d LIKE ? ESCAPE '\\')",
      params: ['"deploy" AND "数据库"', '%登录%', '%登录%'],
    });
  });

  it('keeps a Chinese run whole: one substring, not words', () => {
    expect(textCondition('修复登录问题', 't', ['c'])).toEqual({ sql: 't MATCH ?', params: ['"修复登录问题"'] });
  });

  it('escapes LIKE wildcards and FTS quotes', () => {
    expect(textCondition('a_ 5%', 't', ['c'])!.params).toEqual(['%a\\_%', '%5\\%%']);
    expect(textCondition('say"hi"', 't', ['c'])!.params).toEqual(['"say""hi"""']);
  });

  it('has no condition for blank text', () => {
    expect(textCondition(' \n\t ', 't', ['c'])).toBeNull();
  });
});

describe('task content search (turn_text, fed by session_turns triggers)', () => {
  beforeEach(async () => {
    fixtureRef.current = await openFixture('empty');
    fixture().sqlite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/repo');
      INSERT INTO projects (id, name, path, workspace_provider) VALUES ('p-ssh', 'R', '/srv', 'ssh');
      INSERT INTO sessions (id, project_id, title) VALUES ('s1', 'p1', 'Task one'), ('s2', 'p1', 'Task two'), ('s-ssh', 'p-ssh', 'Remote');
    `);
  });

  afterEach(() => {
    fixtureRef.current?.close();
    fixtureRef.current = undefined;
  });

  it('indexes only what the person and the agent said, from every live turn', async () => {
    await persistCommittedTurn({ sessionId: 's1', source: 'live', turn: turn('t0', [
      said('u', 'user', '请帮我修复登录页面的 crash'),
      { kind: 'thinking', id: 'th', seq: 1, text: 'secret plan about deployment' } as TranscriptTurn['items'][number],
      said('a', 'assistant', 'The deployment script is fixed.'),
    ]) });
    expect(indexed()).toEqual([
      { session_id: 's1', seq: 0, role: 'user', text: '请帮我修复登录页面的 crash' },
      { session_id: 's1', seq: 0, role: 'assistant', text: 'The deployment script is fixed.' },
    ]);
    expect(found('登录')).toEqual(['请帮我修复登录页面的 crash']);
    expect(found('deployment')).toEqual(['The deployment script is fixed.']);
    expect(found('secret')).toEqual([]);
    const [hit] = searchService.searchTaskTurns('crash');
    expect(hit).toMatchObject({ sessionId: 's1', projectId: 'p1', title: 'Task one', role: 'user', archived: false });
    const stored = JSON.parse((fixture().sqlite.prepare('SELECT data FROM session_turns').get() as { data: string }).data) as TranscriptTurn;
    expect(hit!.itemId).toBe(stored.items[0]!.id);
  });

  it('indexes what a delivery said, not its envelope, and never the silence marker', async () => {
    const { buildSystemNoticeEnvelope } = await import('@gugu/core/local/agent/deliveryEnvelope');
    const delivered = buildSystemNoticeEnvelope({ messageId: '0b1e7c1a-0000-4000-8000-000000000001', content: '主人把你改名为小橘', at: '2026-10-31T10:00:00Z' });
    await persistCommittedTurn({ sessionId: 's1', source: 'live', turn: turn('t0', [said('u', 'user', delivered), said('a', 'assistant', '[NO_REPLY]')]) });
    expect(indexed()).toEqual([{ session_id: 's1', seq: 0, role: 'user', text: '主人把你改名为小橘' }]);
    expect(found('小橘')).toEqual(['主人把你改名为小橘']);
    expect(found('gugu_delivery')).toEqual([]);
    expect(found('NO_REPLY')).toEqual([]);
  });

  it('follows a revision, a record append, a truncation and a session delete', async () => {
    await persistCommittedTurn({ sessionId: 's1', source: 'live', turn: turn('t0', [said('a', 'assistant', 'first draft answer')]) });
    await persistCommittedTurn({ sessionId: 's1', source: 'revision', turn: turn('t0', [said('a', 'assistant', 'final revised answer')]) });
    expect(found('draft')).toEqual([]);
    expect(found('revised')).toEqual(['final revised answer']);

    await withStoredTurns('s1', () => appendRecordTurnNow('s1', turn('t1', [said('r', 'assistant', 'from the native record')], 1)));
    expect(found('native record')).toEqual(['from the native record']);

    await truncateStoredHistory('s1', 1);
    expect(found('native')).toEqual([]);
    expect(found('revised')).toEqual(['final revised answer']);

    fixture().sqlite.exec("DELETE FROM sessions WHERE id = 's1'");
    expect(indexed()).toEqual([]);
    expect(found('revised')).toEqual([]);
  });

  it('keeps remote projects out and returns the newest first', async () => {
    fixture().sqlite.exec(`INSERT INTO session_turns (id, session_id, seq, turn_id, data, created_at) VALUES
      ('s1:0', 's1', 0, 't', '{"items":[{"kind":"message","id":"x","role":"user","text":"older alpha"}]}', '2026-10-01 00:00:00'),
      ('s2:0', 's2', 0, 't', '{"items":[{"kind":"message","id":"y","role":"assistant","text":"newer alpha"}]}', '2026-10-02 00:00:00'),
      ('s-ssh:0', 's-ssh', 0, 't', '{"items":[{"kind":"message","id":"z","role":"user","text":"remote alpha"}]}', '2026-10-03 00:00:00')`);
    expect(found('alpha')).toEqual(['newer alpha', 'older alpha']);
  });

  it('backfills turns stored before the index existed', async () => {
    fixture().sqlite.exec(`INSERT INTO session_turns (id, session_id, seq, turn_id, data) VALUES
      ('s1:0', 's1', 0, 't', '{"items":[{"kind":"message","id":"x","role":"user","text":"历史里的数据库迁移"}]}')`);
    fixture().sqlite.exec("DELETE FROM turn_text_rows; UPDATE kv SET value = '5' WHERE key = 'fts_version'");
    await initializeDatabase(fixture().sqlite);
    expect(found('数据库迁移')).toEqual(['历史里的数据库迁移']);
    expect(found('数据迁移')).toEqual([]);
    expect(found('迁移')).toEqual(['历史里的数据库迁移']);
  });
});

describe('search_index writes', () => {
  beforeEach(async () => {
    fixtureRef.current = await openFixture('empty');
    fixture().sqlite.exec("INSERT INTO projects (id, name, path) VALUES ('p1', 'alpha project', '/repo')");
    searchService.initialize();
  });

  afterEach(() => {
    fixtureRef.current?.close();
    fixtureRef.current = undefined;
  });

  it('keeps one row per item when it is written again', async () => {
    const { eq } = await import('drizzle-orm');
    const { sessions } = await import('@main/db/schema');
    const { sessionEvents } = await import('../sessions/session-events');
    const { mapSessionRowToSession } = await import('../sessions/utils');
    const { db, sqlite } = fixture();
    sqlite.exec("INSERT INTO sessions (id, project_id, title) VALUES ('s1', 'p1', 'alpha one'), ('s2', 'p1', 'alpha two')");
    for (const id of ['s1', 's2']) sessionEvents._emit('session:created', mapSessionRowToSession(db.select().from(sessions).where(eq(sessions.id, id)).get()!));
    sqlite.exec("UPDATE sessions SET title = 'alpha renamed' WHERE id = 's1'");
    sessionEvents._emit('session:renamed', 's1', 'p1', 'alpha renamed');
    await vi.waitFor(() => expect(sqlite.prepare("SELECT title FROM search_index WHERE item_id = 's1'").all()).toEqual([{ title: 'alpha renamed' }]));
    expect(sqlite.prepare("SELECT title FROM search_index WHERE item_id = 'p1'").all()).toEqual([{ title: 'alpha project' }]);
  });
});
