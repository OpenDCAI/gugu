import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import type { RecordEntry, SessionRecordSource } from '../contract';
import { createSessionTimeline } from '../timeline';
import { boundaryEntries, contentEntries } from '../test-support';
import { createHermesSqliteSource } from './hermes-sqlite';
import { SessionRecordNotFoundError } from './shared';

/**
 * 一个真会话(Hermes v0.21.0 `hermes chat` 写的 state.db 行,上游是脚本化的假 OpenAI 端点、没有真模型):
 *  1 工具后作答 · 2 直接作答 · 3 工具跑到一半被 SIGINT 打断 · 4 工具后作答 ·
 *  5 输出截断(`length`)后 Hermes 自己插一条 `[System: …truncated…]` 续写 · 6 content_filter 且没回话(Hermes 什么都不存)。
 * 会话最后以 `cli_close` 关掉(`ended_at` 有值)。
 */
const FIXTURE = fileURLToPath(new URL('../__fixtures__/hermes-state.json', import.meta.url));

type Row = Record<string, unknown> & { id: number; role: string; content: string | null };
type Fixture = { session: { id: string; ended_at: number }; messages: Row[] };

const disposers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (disposers.length > 0) await disposers.pop()?.();
});

async function loadFixture(): Promise<Fixture> {
  return JSON.parse(await readFile(FIXTURE, 'utf8')) as Fixture;
}

/** Hermes schema 30 里记录源读到的那几列。 */
async function stageDb(fixture: Fixture, rows: Row[], ended: boolean) {
  const dir = await mkdtemp(join(tmpdir(), 'hermes-record-'));
  disposers.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.db');
  const db = new Database(path);
  disposers.push(() => {
    db.close();
  });
  db.exec(`
    create table sessions (id text primary key, ended_at real);
    create table messages (
      id integer primary key autoincrement, session_id text not null, role text not null, content text,
      tool_call_id text, tool_calls text, tool_name text, timestamp real not null, finish_reason text,
      reasoning text, reasoning_content text, active integer not null default 1, compacted integer not null default 0,
      _compressed_summary integer not null default 0, display_kind text);
  `);
  db.prepare('insert into sessions (id, ended_at) values (?, ?)').run(fixture.session.id, ended ? fixture.session.ended_at : null);
  const insert = (row: Row) =>
    db
      .prepare(
        `insert into messages (id, session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, finish_reason,
          reasoning, reasoning_content, active, compacted, _compressed_summary, display_kind)
         values (@id, @session_id, @role, @content, @tool_call_id, @tool_calls, @tool_name, @timestamp, @finish_reason,
          @reasoning, @reasoning_content, @active, @compacted, @_compressed_summary, @display_kind)`
      )
      .run({ ...row, session_id: fixture.session.id });
  for (const row of rows) insert(row);
  return { path, db, insert };
}

function collect(source: SessionRecordSource) {
  const entries: RecordEntry[] = [];
  const resets: string[] = [];
  disposers.push(() => source.stop());
  const started = source.start({ onEntries: (batch) => entries.push(...batch), onReset: (reason) => resets.push(reason) });
  return { entries, resets, started };
}

const texts = (entries: RecordEntry[], kind: 'user_message_chunk' | 'agent_message_chunk' | 'agent_thought_chunk') =>
  contentEntries(entries).flatMap((entry) => {
    const update = entry.update;
    if (update.sessionUpdate !== kind) return [];
    return update.content.type === 'text' ? [update.content.text] : [];
  });

describe('hermes state.db 记录源', () => {
  it('按候选库依次找有这个会话的那一份;都没有就响亮地失败', async () => {
    const fixture = await loadFixture();
    const { path } = await stageDb(fixture, fixture.messages, true);
    const { entries, started } = collect(
      createHermesSqliteSource({ harness: 'hermes', providerSessionId: fixture.session.id, roots: [join(path, '..', 'missing.db'), path] })
    );
    await started;
    expect(entries.length).toBeGreaterThan(0);
    await expect(
      createHermesSqliteSource({ harness: 'hermes', providerSessionId: 'nope', roots: [path] }).start({ onEntries: () => {}, onReset: () => {} })
    ).rejects.toBeInstanceOf(SessionRecordNotFoundError);
  });

  it.each(['error', 'agent_error'])('finish_reason=%s ⇒ turn_failed,其余 stop 照旧是正常收尾', async (reason) => {
    const fixture = await loadFixture();
    const firstStop = fixture.messages.findIndex((row) => row.finish_reason === 'stop');
    const rows = fixture.messages.map((row, i) => (i === firstStop ? { ...row, finish_reason: reason } : row));
    const { path } = await stageDb(fixture, rows, true);
    const { entries, started } = collect(
      createHermesSqliteSource({ harness: 'hermes', providerSessionId: fixture.session.id, roots: [path] })
    );
    await started;
    const kinds = boundaryEntries(entries).map((entry) => entry.boundary.kind);
    expect(kinds).toContain('turn_failed');
    // 对照:样本里别的 stop 行还在,照旧是正常收尾 —— 不是「凡边界都成了失败」。
    expect(kinds).toContain('turn_end');
  });

  it('解码：用户话、思考、工具、回答;Hermes 自己插的 `[System: …]` 行不是谁说的话', async () => {
    const fixture = await loadFixture();
    // 对照：这份真记录里确实有一条 `[System:` 开头的用户行。
    expect(fixture.messages.some((row) => row.role === 'user' && row.content?.startsWith('[System:'))).toBe(true);
    const { path } = await stageDb(fixture, fixture.messages, true);
    const { entries, started } = collect(createHermesSqliteSource({ harness: 'hermes', providerSessionId: fixture.session.id, roots: [path] }));
    await started;
    const users = texts(entries, 'user_message_chunk');
    expect(users).toHaveLength(fixture.messages.filter((row) => row.role === 'user').length - 1);
    expect(users.some((text) => text.startsWith('[System:'))).toBe(false);
    expect(texts(entries, 'agent_thought_chunk')).toEqual(['I should list the folder first.']);
    const calls = contentEntries(entries).flatMap((entry) => (entry.update.sessionUpdate === 'tool_call' ? [entry.update] : []));
    expect(calls.map((call) => [call.toolCallId, call.kind, call.rawInput])).toContainEqual(['call_11', 'execute', { command: 'ls' }]);
    const results = contentEntries(entries).flatMap((entry) => (entry.update.sessionUpdate === 'tool_call_update' ? [entry.update.toolCallId] : []));
    expect(results).toEqual(['call_11', 'call_10']);
  });

  it('接到时间线上：打断按下一句用户话到来时上一轮的形状认;截断后续写完的一轮是 done;会话关了还没回话的一轮是 cancelled', async () => {
    const fixture = await loadFixture();
    const { path } = await stageDb(fixture, fixture.messages, true);
    const timeline = await createSessionTimeline(
      createHermesSqliteSource({ harness: 'hermes', providerSessionId: fixture.session.id, roots: [path] }),
      { sessionId: 'conv-hermes' }
    );
    disposers.push(() => timeline.dispose());
    expect(timeline.getSnapshot().turns.map((turn) => turn.outcome?.kind)).toEqual(['done', 'done', 'cancelled', 'done', 'done', 'cancelled']);
  });

  it('会话还开着时最后一轮不收尾(还在跑的那一轮不能被画成打断)', async () => {
    const fixture = await loadFixture();
    const { path } = await stageDb(fixture, fixture.messages, false);
    const { entries, started } = collect(createHermesSqliteSource({ harness: 'hermes', providerSessionId: fixture.session.id, roots: [path] }));
    await started;
    const last = fixture.messages[fixture.messages.length - 1];
    expect(boundaryEntries(entries).map((entry) => entry.key)).not.toContain(`hermes:${last.id}#end`);
  });

  it('尾读只发增量;会话关掉时补上那一轮的结局', async () => {
    const fixture = await loadFixture();
    const head = fixture.messages.filter((row) => row.id <= 12);
    const { path, db, insert } = await stageDb(fixture, head, false);
    const source = createHermesSqliteSource({ harness: 'hermes', providerSessionId: fixture.session.id, roots: [path] }, { pollIntervalMs: 60_000 });
    const { entries, resets, started } = collect(source);
    await started;
    const before = entries.length;
    for (const row of fixture.messages.filter((row) => row.id > 12)) insert(row);
    db.prepare('update sessions set ended_at = ?').run(fixture.session.ended_at);
    await source.catchUp?.();
    expect(resets).toEqual([]);
    const added = entries.slice(before).map((entry) => entry.key);
    expect(added.every((key) => Number(/^hermes:(\d+)#/.exec(key)?.[1]) > 12)).toBe(true);
    expect(added).toContain('hermes:17#end');
  });

  it('撤回(行变成 active=0、compacted=0)⇒ 整份重来;原地压缩(总结掉的行 compacted=1)⇒ 不重来，总结行不显示', async () => {
    const fixture = await loadFixture();
    const { path, db, insert } = await stageDb(fixture, fixture.messages, true);
    const source = createHermesSqliteSource({ harness: 'hermes', providerSessionId: fixture.session.id, roots: [path] }, { pollIntervalMs: 60_000 });
    const { entries, resets, started } = collect(source);
    await started;

    db.prepare('update messages set active = 0, compacted = 1 where id <= 6').run();
    insert({ ...fixture.messages[0], id: 18, role: 'user', content: 'SUMMARY OF EARLIER TURNS', _compressed_summary: 1 });
    await source.catchUp?.();
    expect(resets).toEqual([]);
    expect(texts(entries, 'user_message_chunk')).not.toContain('SUMMARY OF EARLIER TURNS');

    entries.length = 0;
    db.prepare('update messages set active = 0, compacted = 0 where id = 16').run();
    await source.catchUp?.();
    expect(resets).toEqual(['source_replaced']);
    expect(contentEntries(entries).some((entry) => entry.key.startsWith('hermes:16#'))).toBe(false);
    expect(contentEntries(entries).some((entry) => entry.key.startsWith('hermes:1#'))).toBe(true);
  });
});
