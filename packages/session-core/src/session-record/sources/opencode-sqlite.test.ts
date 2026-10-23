import { recordProjection } from '../test-support';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RecordEntry, SessionRecordSource, TimelineAfterResult } from '../contract';
import { createSessionTimeline } from '../timeline';
import {
  boundaryEntries,
  collectItems,
  contentEntries,
  type ContentEntry,
  type ToolItemView
} from '../test-support';
import { createOpencodeSqliteSource } from './opencode-sqlite';
import { SessionRecordNotFoundError } from './shared';

const FIXTURE = fileURLToPath(new URL('../__fixtures__/opencode-rows.json', import.meta.url));

type Fixture = {
  session: { id: string; title: string; time_created: number; time_updated: number };
  messages: Array<{
    id: string;
    session_id: string;
    time_created: number;
    time_updated: number;
    data: string;
  }>;
  parts: Array<{
    id: string;
    message_id: string;
    session_id: string;
    time_created: number;
    time_updated: number;
    data: string;
  }>;
};

const disposers: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  while (disposers.length > 0) await disposers.pop()?.();
});

/**
 * 轮询节拍是被测对象：尾读用例把 setInterval 换成假时钟，写完库推一个节拍再判，❌ 押在墙钟上等。
 * 源的轮询是同步读库，推过这一拍时增量已经交到订阅者手里。
 */
function fakePollClock(): void {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
}

async function loadFixture(): Promise<Fixture> {
  return JSON.parse(await readFile(FIXTURE, 'utf8')) as Fixture;
}

/**
 * 照 opencode 真库的建表语句造一个临时库（列名/类型一字不差），再把真实行灌进去。
 * ❌ 不要直接读用户的 `~/.local/share/opencode/opencode.db`：那是活库。
 */
async function stage(mutate?: (fixture: Fixture) => void): Promise<{ dbPath: string; fixture: Fixture }> {
  const fixture = await loadFixture();
  mutate?.(fixture);
  const dir = await mkdtemp(join(tmpdir(), 'opencode-record-'));
  disposers.push(() => rm(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'opencode.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE session (id text PRIMARY KEY, title text NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL);
    CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
    CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
  `);
  db.prepare(
    'insert into session (id, title, time_created, time_updated) values (?, ?, ?, ?)'
  ).run(
    fixture.session.id,
    fixture.session.title,
    fixture.session.time_created,
    fixture.session.time_updated
  );
  const insertMessage = db.prepare(
    'insert into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)'
  );
  for (const row of fixture.messages) {
    insertMessage.run(row.id, row.session_id, row.time_created, row.time_updated, row.data);
  }
  const insertPart = db.prepare(
    'insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)'
  );
  for (const row of fixture.parts) {
    insertPart.run(
      row.id,
      row.message_id,
      row.session_id,
      row.time_created,
      row.time_updated,
      row.data
    );
  }
  db.close();
  return { dbPath, fixture };
}

function startAll(source: SessionRecordSource): Promise<RecordEntry[]> {
  const entries: RecordEntry[] = [];
  disposers.push(() => source.stop());
  return source
    .start({ onEntries: (batch) => entries.push(...batch), onReset: () => {} })
    .then(() => entries);
}

/** 只要内容条 —— 解码类断言不关心边界条，让它们混进来只会到处判 update 在不在。 */
function start(source: SessionRecordSource): Promise<ContentEntry[]> {
  return startAll(source).then(contentEntries);
}

describe('opencode sqlite 记录源', () => {
  it('preserves the native fixture event and transcript projection', async () => {
    const { dbPath, fixture } = await stage();
    const entries = await startAll(createOpencodeSqliteSource({ harness: 'opencode', providerSessionId: fixture.session.id, roots: [dbPath] }));
    expect(recordProjection(entries)).toMatchSnapshot();
  });

  it('库里没有这个会话时响亮地失败', async () => {
    const { dbPath } = await stage();
    await expect(
      start(
        createOpencodeSqliteSource({ harness: 'opencode', providerSessionId: 'ses_nope', roots: [dbPath] })
      )
    ).rejects.toBeInstanceOf(SessionRecordNotFoundError);
  });

  it('库文件不存在时响亮地失败', async () => {
    await expect(
      start(
        createOpencodeSqliteSource({
          harness: 'opencode',
          providerSessionId: 'ses_any',
          roots: [join(tmpdir(), 'definitely-missing-opencode.db')]
        })
      )
    ).rejects.toBeInstanceOf(SessionRecordNotFoundError);
  });

  it('把 message/part 三表解码成 SessionUpdate', async () => {
    const { dbPath, fixture } = await stage();
    const entries = await start(
      createOpencodeSqliteSource({
        harness: 'opencode',
        providerSessionId: fixture.session.id,
        roots: [dbPath]
      })
    );
    const kinds = entries.map((entry) => entry.update.sessionUpdate);
    expect(kinds).toContain('user_message_chunk');
    expect(kinds).toContain('agent_message_chunk');
    expect(kinds).toContain('tool_call');
    for (const entry of entries) expect(entry.key.startsWith('opencode:prt_')).toBe(true);

    // step-start / step-finish 是计费与分段的账，不是会话内容：解出来的条目数必须少于 part 行数。
    expect(entries.length).toBeLessThan(fixture.parts.length);
    const partTypes = fixture.parts.map((row) => JSON.parse(row.data).type as string);
    expect(partTypes).toContain('step-start');
    expect(partTypes).toContain('step-finish');
  });

  it('user 与 assistant 的文本按 message.role 分开', async () => {
    const { dbPath, fixture } = await stage();
    const entries = await start(
      createOpencodeSqliteSource({ harness: 'opencode', providerSessionId: fixture.session.id, roots: [dbPath] })
    );
    const userTexts = entries
      .filter((entry) => entry.update.sessionUpdate === 'user_message_chunk')
      .map((entry) => (entry.update as { content: { text: string } }).content.text);
    const agentTexts = entries
      .filter((entry) => entry.update.sessionUpdate === 'agent_message_chunk')
      .map((entry) => (entry.update as { content: { text: string } }).content.text);
    expect(userTexts).toHaveLength(1);
    expect(agentTexts).toHaveLength(1);
    expect(userTexts[0]).not.toBe(agentTexts[0]);
  });

  describe('接到 timeline 上', () => {
    const POLL_INTERVAL_MS = 100;

    async function build(mutate?: (fixture: Fixture) => void) {
      const staged = await stage(mutate);
      const source = createOpencodeSqliteSource(
        { harness: 'opencode', providerSessionId: staged.fixture.session.id, roots: [staged.dbPath] },
        { pollIntervalMs: POLL_INTERVAL_MS }
      );
      const timeline = await createSessionTimeline(source, { sessionId: 'conv-opencode' });
      disposers.push(() => timeline.dispose());
      return { ...staged, timeline };
    }

    it('completed 的工具 part 折成 done', async () => {
      const { timeline } = await build();
      const tools = collectItems(timeline.getSnapshot().turns).filter(
        (item): item is ToolItemView => item.kind.endsWith('-tool-call')
      );
      expect(tools).toHaveLength(1);
      expect(tools[0].status).toBe('done');
    });

    it('阴控：工具 part 还在 running 时解码出的状态不是 completed', async () => {
      // 判在**解码这一层**，不看时间线上那颗条目：一轮收尾时 reducer 会把 running 的工具
      // 一并结成 done（finalizeItems，既有行为）—— 拿收尾后的条目来判，这条阴控会为了
      // 一个与解码无关的理由变绿。
      const staged = await stage((fixture) => {
        for (const row of fixture.parts) {
          const data = JSON.parse(row.data) as { type: string; state?: Record<string, unknown> };
          if (data.type !== 'tool' || !data.state) continue;
          data.state.status = 'running';
          delete data.state.output;
          row.data = JSON.stringify(data);
        }
      });
      const entries = await start(
        createOpencodeSqliteSource({
          harness: 'opencode',
          providerSessionId: staged.fixture.session.id,
          roots: [staged.dbPath]
        })
      );
      const calls = entries.filter((entry) => entry.update.sessionUpdate === 'tool_call');
      expect(calls).toHaveLength(1);
      expect((calls[0].update as { status?: string }).status).not.toBe('completed');
    });

    it('插入一行后，下一个轮询节拍订阅者就收到增量', async () => {
      fakePollClock();
      const { dbPath, fixture, timeline } = await build();
      const seen: TimelineAfterResult[] = [];
      disposers.push(
        timeline.subscribe(timeline.getSnapshot().cursor, (result) => seen.push(result))
      );

      const writer = new Database(dbPath);
      const now = Date.now();
      const messageId = fixture.messages.find(
        (row) => (JSON.parse(row.data) as { role: string }).role === 'assistant'
      )!.id;
      writer
        .prepare(
          'insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)'
        )
        .run(
          'prt_tailtest',
          messageId,
          fixture.session.id,
          now,
          now,
          JSON.stringify({ type: 'text', text: '轮询到了' })
        );
      writer.close();

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      expect(seen.length).toBeGreaterThan(0);
      const texts = seen
        .flatMap((result) => (result.ok ? result.batch.turns : result.snapshot.turns))
        .flatMap((turn) => collectItems([turn]))
        .filter((item) => item.kind === 'message')
        .map((item) => (item as { text: string }).text);
      expect(texts.join('')).toContain('轮询到了');
    });

    it('part 比它的 message 先被读到时，用户消息不会被标成 agent 说的', async () => {
      // 两条 select 之间新写进来的 part 就是这个形状：message 行的 time_updated 落在水位线之前，
      // 这一轮的 message 查询根本查不到它，只有 part 查得到。
      fakePollClock();
      const { dbPath, fixture, timeline } = await build();
      const writer = new Database(dbPath);
      const now = Date.now();
      writer
        .prepare(
          'insert into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)'
        )
        .run('msg_late_user', fixture.session.id, 1, 1, JSON.stringify({ role: 'user' }));
      writer
        .prepare(
          'insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)'
        )
        .run(
          'prt_late_user',
          'msg_late_user',
          fixture.session.id,
          now,
          now,
          JSON.stringify({ type: 'text', text: '这句是我说的' })
        );
      writer.close();

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      const texts = collectItems(timeline.getSnapshot().turns)
        .filter((item) => item.kind === 'message')
        .map((item) => item as { role: string; text: string });
      const mine = texts.find((item) => item.text.includes('这句是我说的'));
      expect(mine).toBeDefined();
      expect(mine!.role).toBe('user');
    });

    it('文本长大时只发增量，不把前半段说第二遍', async () => {
      // 判在**记录源发出的那一条**上，不看时间线渲染出来的文字：reducer 对同一 messageId 是
      // 追加语义，源只要重发全文就会翻倍，所以"源发了什么"才是这条要守的东西。
      const staged = await stage();
      fakePollClock();
      const source = createOpencodeSqliteSource(
        {
          harness: 'opencode',
          providerSessionId: staged.fixture.session.id,
          roots: [staged.dbPath]
        },
        { pollIntervalMs: POLL_INTERVAL_MS }
      );
      const seen: RecordEntry[] = [];
      disposers.push(() => source.stop());
      await source.start({ onEntries: (batch) => seen.push(...batch), onReset: () => {} });

      const target = staged.fixture.parts.find((row) => {
        const data = JSON.parse(row.data) as { type: string; text?: string };
        return data.type === 'text' && (data.text?.length ?? 0) > 0;
      })!;
      const original = JSON.parse(target.data) as { type: string; text: string };
      const writer = new Database(staged.dbPath);
      writer
        .prepare('update part set data = ?, time_updated = ? where id = ?')
        .run(JSON.stringify({ ...original, text: original.text + '（续写）' }), Date.now(), target.id);
      writer.close();

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      const grown = contentEntries(seen)
        .map((entry) => (entry.update as { content?: { text?: string } }).content?.text ?? '')
        .find((text) => text.includes('（续写）'));
      // 增量那一条只该带新长出来的那截；带上前半段 = 界面上前半段说两遍。
      expect(grown).toBe('（续写）');
      expect(grown).not.toContain(original.text);
    });
  });

  it('一轮只在结尾那条 assistant 消息上收:finish=tool-calls 的那一步不是边界', async () => {
    const { dbPath, fixture } = await stage();
    const all = await startAll(
      createOpencodeSqliteSource({ harness: 'opencode', providerSessionId: fixture.session.id, roots: [dbPath] })
    );
    // 对照:这份真记录里两条 assistant 都盖了完成戳，第一条是 tool-calls —— 只看完成戳会出两条边界、把一句话切成两轮。
    const assistants = fixture.messages
      .map((row) => JSON.parse(row.data) as { role: string; finish?: string; time: { completed?: number } })
      .filter((data) => data.role === 'assistant');
    expect(assistants.map((data) => data.finish)).toEqual(['tool-calls', 'stop']);
    expect(assistants.every((data) => data.time.completed !== undefined)).toBe(true);
    const bounds = boundaryEntries(all);
    expect(bounds.map((bound) => bound.boundary)).toEqual([{ kind: 'turn_end', stopReason: 'end_turn' }]);
    expect(bounds[0].key.endsWith('#end')).toBe(true);
  });

});

const MIMOCODE_FIXTURE = fileURLToPath(new URL('../__fixtures__/mimocode-rows.json', import.meta.url));

type MimocodeSession = {
  session: Fixture['session'];
  messages: Array<Fixture['messages'][number] & { agent_id: string }>;
  parts: Fixture['parts'];
};

/**
 * mimocode 真库(mac1 `~/.local/share/mimocode/mimocode.db`,0.1.13)里挑的两条会话,文本一律换成占位、结构原样:
 *  · 第一条:主 agent 三轮 + 一个子 agent(`general-1`)的两条消息同住一个会话;每轮都塞了一段 synthetic 技能清单。
 *  · 第二条:一轮,assistant 报 APIError 且**没有** `time.completed`。
 * 建表照 mimocode 的列:`message` 多一列 `agent_id`。
 */
async function stageMimocode(dbName = 'mimocode.db'): Promise<{ dir: string; dbPath: string; sessions: MimocodeSession[] }> {
  const { sessions } = JSON.parse(await readFile(MIMOCODE_FIXTURE, 'utf8')) as { sessions: MimocodeSession[] };
  const dir = await mkdtemp(join(tmpdir(), 'mimocode-record-'));
  disposers.push(() => rm(dir, { recursive: true, force: true }));
  const dbPath = join(dir, dbName);
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE session (id text PRIMARY KEY, title text NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL);
    CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL,
      agent_id text NOT NULL DEFAULT 'main');
    CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
  `);
  for (const { session, messages, parts } of sessions) {
    db.prepare('insert into session values (?, ?, ?, ?)').run(
      session.id, session.title, session.time_created, session.time_updated
    );
    for (const row of messages) {
      db.prepare('insert into message values (?, ?, ?, ?, ?, ?)').run(
        row.id, row.session_id, row.time_created, row.time_updated, row.data, row.agent_id
      );
    }
    for (const row of parts) {
      db.prepare('insert into part values (?, ?, ?, ?, ?, ?)').run(
        row.id, row.message_id, row.session_id, row.time_created, row.time_updated, row.data
      );
    }
  }
  db.close();
  return { dir, dbPath, sessions };
}

describe('mimocode 库(opencode 族)', () => {
  it('非正式通道的库 `mimocode-<通道>.db`:目录里只有它、会话在里面 ⇒ 读得到', async () => {
    const { dir, sessions } = await stageMimocode('mimocode-nightly.db');
    const locator = {
      harness: 'opencode' as const,
      providerSessionId: sessions[0].session.id,
      agentId: 'main',
      roots: [join(dir, 'mimocode.db')],
    };
    // 对照:不给通道库，候选里那份 `mimocode.db` 不存在 ⇒ 找不到。
    await expect(start(createOpencodeSqliteSource(locator))).rejects.toBeInstanceOf(SessionRecordNotFoundError);
    const entries = await start(
      createOpencodeSqliteSource({ ...locator, channelDbs: { app: 'mimocode', dirs: [join(dir, 'missing'), dir] } })
    );
    expect(entries.length).toBeGreaterThan(0);
  });

  it('只读 agentId 那个 agent:子 agent 的消息不进时间线', async () => {
    const { dbPath, sessions } = await stageMimocode();
    const [mixed] = sessions;
    const subMessages = new Set(mixed.messages.filter((row) => row.agent_id !== 'main').map((row) => row.id));
    const subParts = mixed.parts.filter((row) => subMessages.has(row.message_id)).map((row) => `opencode:${row.id}`);
    // 对照:这份记录里真有子 agent 的 part,不给 agentId 时它们照样被解出来。
    expect(subParts.length).toBeGreaterThan(0);
    const unfiltered = await start(
      createOpencodeSqliteSource({ harness: 'opencode', providerSessionId: mixed.session.id, roots: [dbPath] })
    );
    expect(unfiltered.some((entry) => subParts.includes(entry.key))).toBe(true);

    const filtered = await start(
      createOpencodeSqliteSource({
        harness: 'opencode',
        providerSessionId: mixed.session.id,
        agentId: 'main',
        roots: [dbPath]
      })
    );
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.some((entry) => subParts.includes(entry.key))).toBe(false);
  });

  it('synthetic 文本不当成谁说的话', async () => {
    const { dbPath, sessions } = await stageMimocode();
    const [mixed] = sessions;
    const synthetic = mixed.parts
      .filter((row) => (JSON.parse(row.data) as { synthetic?: boolean }).synthetic === true)
      .map((row) => `opencode:${row.id}`);
    expect(synthetic.length).toBeGreaterThan(0);
    const entries = await start(
      createOpencodeSqliteSource({
        harness: 'opencode',
        providerSessionId: mixed.session.id,
        agentId: 'main',
        roots: [dbPath]
      })
    );
    expect(entries.some((entry) => synthetic.includes(entry.key))).toBe(false);
    // 主 agent 三条用户消息里,只有两条带真正的用户文本(中间那条只有 synthetic)。
    expect(entries.filter((entry) => entry.update.sessionUpdate === 'user_message_chunk')).toHaveLength(2);
  });

  it('出错且没盖完成戳的 assistant 消息也关掉这一轮', async () => {
    const { dbPath, sessions } = await stageMimocode();
    const failed = sessions[1];
    const assistant = failed.messages.find((row) => (JSON.parse(row.data) as { role: string }).role === 'assistant')!;
    const data = JSON.parse(assistant.data) as { time: { completed?: number }; error?: { name: string } };
    // 对照:这条真记录就是「有 error、无 completed」—— 只看完成戳时这一轮永远是进行中。
    expect(data.time.completed).toBeUndefined();
    expect(data.error?.name).toBe('APIError');

    const source = createOpencodeSqliteSource({
      harness: 'opencode',
      providerSessionId: failed.session.id,
      agentId: 'main',
      roots: [dbPath]
    });
    const timeline = await createSessionTimeline(source, { sessionId: 'conv-mimocode' });
    disposers.push(() => timeline.dispose());
    const turns = timeline.getSnapshot().turns;
    expect(turns).toHaveLength(1);
    expect(turns[0].outcome?.kind).toBe('error');
  });

  it('主 agent 每一轮都有结局', async () => {
    const { dbPath, sessions } = await stageMimocode();
    const source = createOpencodeSqliteSource({
      harness: 'opencode',
      providerSessionId: sessions[0].session.id,
      agentId: 'main',
      roots: [dbPath]
    });
    const timeline = await createSessionTimeline(source, { sessionId: 'conv-mimocode-mixed' });
    disposers.push(() => timeline.dispose());
    const turns = timeline.getSnapshot().turns;
    // 第一轮里有七步 tool-calls、中间还夹一条只有 synthetic 文本的用户消息，它们都不另起一轮。
    expect(turns).toHaveLength(2);
    for (const turn of turns) expect(turn.outcome?.kind).toBe('done');
  });

  it('边界插在它自己那些 part 之后，而不是全堆到批尾', async () => {
    const { dbPath, sessions } = await stageMimocode();
    const all = await startAll(
      createOpencodeSqliteSource({
        harness: 'opencode',
        providerSessionId: sessions[0].session.id,
        agentId: 'main',
        roots: [dbPath]
      })
    );
    // 首轮整份读把整个会话装进**一批**,边界若一律追加到批尾，第一条关掉的是最后一轮。
    // 判据：第一条边界排在最后一条内容之前。全堆批尾时这条必红。
    expect(boundaryEntries(all)).toHaveLength(2);
    const firstBoundary = all.findIndex((entry) => entry.boundary !== undefined);
    const lastContent = all.findLastIndex((entry) => entry.update !== undefined);
    expect(firstBoundary).toBeGreaterThanOrEqual(0);
    expect(firstBoundary).toBeLessThan(lastContent);
  });

  it('出错(不是打断)⇒ turn_failed', async () => {
    const { dbPath, sessions } = await stageMimocode();
    const all = await startAll(
      createOpencodeSqliteSource({ harness: 'opencode', providerSessionId: sessions[1].session.id, agentId: 'main', roots: [dbPath] })
    );
    expect(boundaryEntries(all).map((entry) => entry.boundary)).toEqual([{ kind: 'turn_failed' }]);
  });
});

describe('opencode 被打断的消息', () => {
  it('MessageAbortedError ⇒ turn_aborted,时间线上是 cancelled', async () => {
    const { dbPath, fixture } = await stage((f) => {
      const last = f.messages.findLast((row) => (JSON.parse(row.data) as { role: string }).role === 'assistant')!;
      const data = JSON.parse(last.data) as Record<string, unknown>;
      last.data = JSON.stringify({ ...data, error: { name: 'MessageAbortedError', data: { message: 'aborted' } } });
    });
    const all = await startAll(
      createOpencodeSqliteSource({ harness: 'opencode', providerSessionId: fixture.session.id, roots: [dbPath] })
    );
    const kinds = boundaryEntries(all).map((entry) => entry.boundary.kind);
    expect(kinds).toEqual(['turn_aborted']);
  });
});

// #7035 终端腿的 question 工具:part 先以参数为空的 pending 出现,参数随后才到;Esc 拒绝后是 error。
describe('question 进结算(#7035)', () => {
  const POLL_INTERVAL_MS = 100;
  const CALL = 'call_question_7035';
  const input = {
    questions: [
      { question: 'Which pets do you like?', header: 'Pets', multiple: true, options: [{ label: 'Cats', description: 'Cats' }, { label: 'Dogs', description: 'Dogs' }] },
    ],
  };

  async function build() {
    fakePollClock();
    const staged = await stage();
    const source = createOpencodeSqliteSource(
      { harness: 'opencode', providerSessionId: staged.fixture.session.id, roots: [staged.dbPath] },
      { pollIntervalMs: POLL_INTERVAL_MS }
    );
    const timeline = await createSessionTimeline(source, { sessionId: 'conv-opencode', answerableQuestions: true });
    disposers.push(() => timeline.dispose());
    const messageId = staged.fixture.messages.find((row) => (JSON.parse(row.data) as { role: string }).role === 'assistant')!.id;
    const write = async (state: Record<string, unknown>, insert = false) => {
      const db = new Database(staged.dbPath);
      const now = Date.now();
      const data = JSON.stringify({ type: 'tool', callID: CALL, tool: 'question', state });
      if (insert) {
        db.prepare('insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)')
          .run('prt_question', messageId, staged.fixture.session.id, now, now, data);
      } else {
        db.prepare('update part set data = ?, time_updated = ? where id = ?').run(data, now, 'prt_question');
      }
      db.close();
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    };
    const settlement = () => timeline.getSnapshot().settlements.find((s) => s.itemId === CALL);
    return { timeline, write, settlement };
  }

  it('参数为空先到、参数后到 ⇒ 后到时补上题目;Esc 拒绝 ⇒ 选择器关了', async () => {
    const { timeline, write, settlement } = await build();
    await write({ status: 'pending', input: {} }, true);
    // 阳控:此时已经认出是一道提问,只是还没有题目。
    expect(settlement()).toMatchObject({ kind: 'question', state: 'pending' });
    expect(settlement()?.questions).toBeUndefined();

    await write({ status: 'running', input });
    expect(settlement()).toMatchObject({
      title: 'Which pets do you like?',
      questions: [{ question: 'Which pets do you like?', header: 'Pets', multiSelect: true, options: [{ optionId: 'Cats' }, { optionId: 'Dogs' }] }],
    });
    expect(timeline.questionOpen(CALL)).toBe(true);

    await write({ status: 'error', input, error: 'The user dismissed this question' });
    expect(timeline.questionOpen(CALL)).toBe(false);
    expect(settlement()).toMatchObject({ state: 'cancelled', resultRecorded: true });
  });

  // 10-12:opencode 关掉一问是 error(上一格),答了是正常结束 ⇒ 没人在咕咕里认领时写「已在其他端回答」。
  // 输出原文照 mac1 真库里答过的 3 条(completed + metadata.answers)。
  it('终端里答了 ⇒ 在别处答的', async () => {
    const { write, settlement } = await build();
    await write({ status: 'running', input }, true);
    await write({
      status: 'completed',
      input,
      output: 'User has answered your questions: "Which pets do you like?"="Cats". You can now continue with the user\'s answers in mind.',
      metadata: { answers: [['Cats']], truncated: false },
    });
    expect(settlement()).toMatchObject({ state: 'resolved', resolvedBy: null, resultRecorded: true });
  });
});
