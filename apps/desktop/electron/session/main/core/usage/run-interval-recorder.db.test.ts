import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';

// #6334 用量页的本机底账:运行区间的记录(事件 + 对账 + 开机收口)与 usage.localDaily 的整条取数。

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  home: '' as string,
  warnings: [] as unknown[][],
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('@main/core/agents/agent-home', () => ({
  resolveAgentHomeRoot: async () => mocks.home,
  resolveAgentHomeEnv: async () => ({}),
}));
// worker 线程换成进程内实现(真线程那条在 token-scan-client.test.ts 里单独测)。
vi.mock('./token-scan-worker/spawn', async () => ({
  spawnTokenScanWorker: (await import('./_support/in-process-worker')).createInProcessTokenScanWorker,
}));
vi.mock('@main/lib/logger', () => ({
  log: {
    info: () => {},
    debug: () => {},
    warn: (...args: unknown[]) => mocks.warnings.push(args),
    error: (...args: unknown[]) => mocks.warnings.push(args),
  },
}));

import { buildLocalUsageSnapshot } from './build-local-usage-snapshot';
import { recordModelSource } from './model-source-recorder';
import { usageController } from './controller';
import {
  RunIntervalRecorder,
  closeInterruptedRunIntervals,
  installRunIntervalRecorder,
} from './run-interval-recorder';

type Fixture = Awaited<ReturnType<typeof openFixture>>;
type IntervalRow = { session_id: string; provider: string | null; started_at: number; ended_at: number | null; last_seen_at: number };

const at = (day: number, hour: number, minute = 0) => new Date(2026, 8, day, hour, minute).getTime();
const MIN = 60_000;

describe('run-interval-recorder', () => {
  let fixture: Fixture;
  let clock: number;
  let recorder: RunIntervalRecorder;

  const intervals = () =>
    fixture.sqlite
      .prepare('SELECT session_id, provider, started_at, ended_at, last_seen_at FROM session_run_intervals ORDER BY id')
      .all() as IntervalRow[];
  const setStatus = (id: string, status: string) =>
    fixture.sqlite.prepare('UPDATE sessions SET agent_status = ? WHERE id = ?').run(status, id);

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    mocks.warnings = [];
    fixture.sqlite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/repo');
      INSERT INTO sessions (id, project_id, provider, created_at, updated_at)
        VALUES ('c1', 'p1', 'claude', '2026-01-01 00:00:00', '2026-01-01 00:00:00');
      INSERT INTO sessions (id, project_id, provider, created_at, updated_at)
        VALUES ('c2', 'p1', 'codex', '2026-01-01 00:00:00', '2026-01-01 00:00:00');
    `);
    clock = at(23, 10);
    recorder = new RunIntervalRecorder(() => clock);
  });

  afterEach(() => {
    fixture?.close();
  });

  it('进 working 开一段,needs_user 仍是同一段,落回 idle 收口', () => {
    // 事件间隔都在一个心跳周期内(真机上每 60 秒有一次心跳;断档另有用例)
    recorder.observeStatus('c1', 'working');
    clock += MIN;
    recorder.observeStatus('c1', 'needs_user');
    clock += MIN;
    recorder.observeStatus('c1', 'working');
    clock += MIN;
    recorder.observeStatus('c1', 'idle');
    recorder.observeStatus('c1', 'idle'); // 重复收口是空操作
    expect(intervals()).toEqual([
      { session_id: 'c1', provider: 'claude', started_at: at(23, 10), ended_at: at(23, 10, 3), last_seen_at: at(23, 10, 3) },
    ]);
  });

  // #6448:park 仍是 working —— 后台在跑的那段照算;只剩定时唤醒(/loop、cron 在两次之间)的那段不算运行时长,
  // 对账也不能因为库里是 working 把它补开回来。
  it('park 里后台在跑照算;只剩定时唤醒收口,对账不补开', () => {
    recorder.observeStatus('c1', 'working', { running: true, background: null });
    clock += MIN;
    recorder.observeStatus('c1', 'working', { running: false, background: 'running' });
    clock += MIN;
    recorder.observeStatus('c1', 'working', { running: false, background: 'scheduled' });
    fixture.sqlite.exec(`UPDATE sessions SET agent_status = 'working' WHERE id = 'c1'`);
    clock += MIN;
    recorder.reconcile();
    expect(intervals()).toEqual([
      { session_id: 'c1', provider: 'claude', started_at: at(23, 10), ended_at: at(23, 10, 2), last_seen_at: at(23, 10, 2) },
    ]);
  });

  it('error 也收口;任务归档后结束区间并保留用量历史', () => {
    recorder.observeStatus('c1', 'working');
    recorder.observeStatus('c2', 'working');
    clock += MIN;
    recorder.observeStatus('c1', 'error');
    fixture.sqlite.exec(`UPDATE sessions SET archived_at = '2026-09-28 23:11:00' WHERE id = 'c2'`);
    clock += MIN;
    recorder.observeArchived('c2');
    expect(intervals().map((row) => [row.session_id, row.ended_at])).toEqual([
      ['c1', at(23, 10, 1)],
      ['c2', at(23, 10, 2)],
    ]);
  });

  it('旁路:出生即 working 的会话,对账补开一段,起点是创建时刻', () => {
    // 模拟「对账之后才建出来、出生即 working」—— build-session-row 不播 agent:status。
    const createdAt = new Date(clock + 20_000).toISOString();
    fixture.sqlite
      .prepare(
        `INSERT INTO sessions (id, project_id, provider, agent_status, created_at, updated_at)
         VALUES ('c3', 'p1', 'claude', 'working', ?, ?)`
      )
      .run(createdAt, createdAt);
    clock += MIN;
    recorder.reconcile();
    expect(intervals()).toEqual([
      { session_id: 'c3', provider: 'claude', started_at: Date.parse(createdAt), ended_at: null, last_seen_at: clock },
    ]);
    // 之后真实的 working 事件到了 —— 已经开着,不另开一段。
    recorder.observeStatus('c3', 'working');
    expect(intervals()).toHaveLength(1);
  });

  it('旁路:restart 直接把状态写成 working(updated_at 盖成现在),对账按 updated_at 开', () => {
    clock += MIN;
    const restartedAt = clock - 10_000;
    fixture.sqlite
      .prepare(`UPDATE sessions SET agent_status = 'working', updated_at = ? WHERE id = 'c1'`)
      .run(new Date(restartedAt).toISOString());
    recorder.reconcile();
    expect(intervals()[0].started_at).toBe(restartedAt);
  });

  it('对账:时刻早于上一次对账的 created/updated 不可信,按现在开;库里已不在干活的开着的区间收掉', () => {
    setStatus('c1', 'working'); // 老会话(2026-01-01 建的)被某个旁路写成 working
    clock += MIN;
    recorder.reconcile();
    expect(intervals()[0].started_at).toBe(clock);

    recorder.observeStatus('c2', 'working'); // 事件开的
    setStatus('c2', 'idle'); // 状态被别的写者抹回 idle,没播事件
    clock += MIN;
    recorder.reconcile();
    const bySession = Object.fromEntries(intervals().map((row) => [row.session_id, row]));
    expect(bySession.c2.ended_at).toBe(clock);
    // 还在跑的那条盖心跳。
    expect(bySession.c1).toMatchObject({ ended_at: null, last_seen_at: clock });
  });

  it('合盖睡了一夜:对账在最后一次心跳处收口,醒来仍在干活的从现在另开一段 —— 睡着的时间不算运行时长', () => {
    setStatus('c1', 'working');
    recorder.observeStatus('c1', 'working');
    clock += MIN;
    recorder.reconcile();
    const lastBeat = clock;
    clock += 8 * 60 * MIN; // 合盖 8 小时,期间 setInterval 不触发
    recorder.reconcile();
    const rows = intervals();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ session_id: 'c1', started_at: at(23, 10), ended_at: lastBeat });
    expect(rows[1]).toMatchObject({ session_id: 'c1', started_at: clock, ended_at: null });
  });

  it('合盖醒来的第一条 idle 事件:收口在最后一次心跳处,❌ 不在醒来那一刻', () => {
    setStatus('c1', 'working');
    recorder.observeStatus('c1', 'working');
    clock += MIN;
    recorder.reconcile();
    const lastBeat = clock;
    clock += 8 * 60 * MIN;
    setStatus('c1', 'idle');
    recorder.observeStatus('c1', 'idle');
    expect(intervals()).toEqual([expect.objectContaining({ started_at: at(23, 10), ended_at: lastBeat })]);
  });

  it('醒来后先来一条 working:旧段收在最后一次心跳,从现在另开一段', () => {
    recorder.observeStatus('c1', 'working');
    clock += 8 * 60 * MIN;
    recorder.observeStatus('c1', 'working');
    expect(intervals()).toEqual([
      expect.objectContaining({ started_at: at(23, 10), ended_at: at(23, 10) }),
      expect.objectContaining({ started_at: clock, ended_at: null }),
    ]);
  });

  it('心跳没断档时照常:收口在现在', () => {
    setStatus('c1', 'working');
    recorder.observeStatus('c1', 'working');
    clock += 2 * MIN;
    recorder.observeStatus('c1', 'idle');
    expect(intervals()[0].ended_at).toBe(clock);
  });

  it('开机收口按最后一次心跳,不按开机时刻', () => {
    setStatus('c1', 'working');
    recorder.observeStatus('c1', 'working');
    clock += 3 * MIN;
    recorder.reconcile(); // 心跳 = 10:03
    clock += 60 * MIN; // 进程被强杀,一小时后才重开
    expect(closeInterruptedRunIntervals()).toBe(1);
    expect(intervals()[0]).toMatchObject({ started_at: at(23, 10), ended_at: at(23, 10, 3) });
  });

  it('装上之后,agent:status 与 session:archived 都进得来;订阅方抛错不会传回状态管道', () => {
    const handlers: Record<string, (arg: never) => void> = {};
    const source = {
      on: (name: string, handler: (arg: never) => void) => {
        handlers[name] = handler;
      },
    };
    const uninstall = installRunIntervalRecorder({
      agentStatus: source,
      sessionEvents: source,
      recorder,
      heartbeatMs: 1_000_000,
    });
    try {
      (handlers['agent:status'] as (input: { sessionId: string; reading: { status: string } }) => void)({
        sessionId: 'c1',
        reading: { status: 'working' },
      });
      clock += MIN;
      (handlers['session:archived'] as (id: string) => void)('c1');
      expect(intervals()[0]).toMatchObject({ session_id: 'c1', ended_at: at(23, 10, 1) });

      // 库坏了:只记一笔日志,不抛。
      fixture.sqlite.exec('DROP TABLE session_run_intervals');
      expect(() =>
        (handlers['agent:status'] as (input: { sessionId: string; reading: { status: string } }) => void)({
          sessionId: 'c1',
          reading: { status: 'working' },
        })
      ).not.toThrow();
      expect(mocks.warnings.length).toBeGreaterThan(0);
    } finally {
      uninstall();
    }
  });
});

describe('buildLocalUsageSnapshot / usage.localDaily', () => {
  let fixture: Fixture;
  let home: string;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    mocks.warnings = [];
    home = mkdtempSync(join(tmpdir(), 'gugu-usage-home-'));
    mocks.home = home;
  });
  afterEach(() => {
    fixture?.close();
    rmSync(home, { recursive: true, force: true });
  });

  it('会话数、运行时长、并行、token 从库与日志合成一份快照;只读咕咕会话的日志', async () => {
    const createdUtc = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
    fixture.sqlite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/repo');
    `);
    const addSession = fixture.sqlite.prepare(
      `INSERT INTO sessions (id, project_id, provider, provider_session_id, created_at, archived_at)
       VALUES (?, 'p1', ?, ?, ?, ?)`
    );
    addSession.run('c1', 'claude', 'sid-claude', createdUtc(at(23, 9)), null);
    addSession.run('c2', 'codex', '01a0ce35-43e0-7db2-b762-49dd6f882b08', createdUtc(at(23, 9, 30)), '2026-09-23 12:00:00'); // 已归档也算
    addSession.run('c3', 'opencode', 'oc-1', createdUtc(at(23, 11)), null);

    const addInterval = fixture.sqlite.prepare(
      `INSERT INTO session_run_intervals (session_id, provider, started_at, ended_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`
    );
    addInterval.run('c1', 'claude', at(23, 10), at(23, 11), at(23, 11));
    // 来源:c1 在 10:00 启动时用的咕咕模型(启动记录);c2 没有启动记录,退回会话级当前选择 = 自家模型。
    recordModelSource('c1', 'gugu', at(23, 10));
    recordModelSource('c1', 'gugu', at(23, 10, 30)); // 同来源重启不另起一段
    fixture.sqlite
      .prepare(`INSERT INTO kv (key, value) VALUES (?, ?)`)
      .run('sessionpage-platform-model:c2', JSON.stringify({ platformModel: null }));
    expect((fixture.sqlite.prepare('SELECT count(*) AS n FROM session_model_sources').get() as { n: number }).n).toBe(1);
    addInterval.run('c2', 'codex', at(23, 10, 30), at(23, 10, 45), at(23, 10, 45));

    const claudeDir = join(home, '.claude', 'projects', '-repo');
    mkdirSync(claudeDir, { recursive: true });
    const assistant = (id: string, ts: number) =>
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date(ts).toISOString(),
        requestId: `r-${id}`,
        message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } },
      });
    writeFileSync(join(claudeDir, 'sid-claude.jsonl'), `${assistant('m1', at(23, 10, 5))}\n${assistant('m1', at(23, 10, 5))}\n`);
    // 同目录下一份**不属于咕咕**的会话 —— 不许算进来。
    writeFileSync(join(claudeDir, 'not-gugu.jsonl'), `${assistant('m9', at(23, 10, 5))}\n`);
    const codexDay = join(home, '.codex', 'sessions', '2026', '09', '23');
    mkdirSync(codexDay, { recursive: true });
    writeFileSync(
      join(codexDay, 'rollout-2026-09-23T10-30-00-01a0ce35-43e0-7db2-b762-49dd6f882b08.jsonl'),
      [
        JSON.stringify({ timestamp: new Date(at(23, 10, 31)).toISOString(), type: 'turn_context', payload: { model: 'gpt-5.5' } }),
        JSON.stringify({
          timestamp: new Date(at(23, 10, 32)).toISOString(),
          type: 'event_msg',
          payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10, total_tokens: 110 } } },
        }),
        '',
      ].join('\n')
    );

    // 渲染层拿到的是原始快照,没有 Result 信封。
    const snapshot = await usageController.localDaily({ from: '2026-09-23', to: '2026-09-23' });
    expect(snapshot).toMatchObject({ from: '2026-09-23', to: '2026-09-23' });
    const byEngine = Object.fromEntries(snapshot.engines.map((row) => [row.engine, row]));
    expect(byEngine.claude).toMatchObject({
      sessions: 1,
      runSeconds: 3600,
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      models: { 'claude-opus-5-5': 10 },
      guguModels: { 'claude-opus-5-5': 10 },
      byokModels: {},
    });
    expect(byEngine.claude.hours[9]).toBe(1);
    expect(byEngine.codex).toMatchObject({
      sessions: 1,
      runSeconds: 900,
      inputTokens: 60,
      cacheReadTokens: 40,
      outputTokens: 10,
      models: { 'gpt-5.5': 110 },
      guguModels: {},
      byokModels: { 'gpt-5.5': 110 },
    });
    expect(byEngine.opencode).toMatchObject({ sessions: 1, runSeconds: 0, inputTokens: 0, models: {} });
    expect(snapshot.device).toEqual([{ day: '2026-09-23', parallelSeconds: 900, peakConcurrency: 2 }]);
    expect(mocks.warnings).toEqual([]);

    // 第二次:日志没变,全部走缓存,结果逐字相同。
    const cachedRows = fixture.sqlite.prepare('SELECT count(*) AS n FROM usage_token_file_cache').get() as { n: number };
    expect(cachedRows.n).toBe(2);
    const again = await buildLocalUsageSnapshot({ from: '2026-09-23', to: '2026-09-23' });
    expect(again).toEqual(snapshot);
  });

  it('还开着的区间算到 now 为止', async () => {
    fixture.sqlite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/repo');
      INSERT INTO sessions (id, project_id, provider, agent_status) VALUES ('c1', 'p1', 'claude', 'working');
    `);
    fixture.sqlite
      .prepare(`INSERT INTO session_run_intervals (session_id, provider, started_at, ended_at, last_seen_at) VALUES ('c1', 'claude', ?, NULL, ?)`)
      .run(at(23, 10), at(23, 10, 19)); // 最后一次心跳在 1 分钟前 —— 还在跑
    const snapshot = await buildLocalUsageSnapshot({ from: '2026-09-23', to: '2026-09-23' }, at(23, 10, 20));
    expect(snapshot.engines.find((row) => row.engine === 'claude')?.runSeconds).toBe(20 * 60);
  });

  it('非法范围直接 reject(invoke 的 promise 失败),不读库', async () => {
    await expect(usageController.localDaily({ from: '2026-09-24', to: '2026-09-23' })).rejects.toThrow(/after/);
  });
});
