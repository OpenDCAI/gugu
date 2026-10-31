import { openFixture } from '@tooling/utils/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { statusWritesSettled } from './_support/status-writes-settled';
import type { AppDb } from '@main/db/client';
import type { AgentEvent, NotificationType } from '@shared/core/agents/agentEvents';

/**
 * #6377 —— 一轮结束时 harness 报告还有后台任务在干活(Claude Stop payload 的 `background_tasks`,解析器数成
 * `payload.backgroundTasks`),会话仍是 working;60 秒后的 idle_prompt 不把它抹成 idle;后台做完后 Claude 自己
 * 注入的那一轮(UserPromptSubmit = start)结束时的 `stop`(后台为 0)才是回合结束边。进程退出照旧由退出重置写 idle。
 * 事件序列照 2026-09-24 在 macOS 上实测录下的 hooks(第 3 轮)。
 */
const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined, emit: vi.fn() }));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('../agent-hooks/hook-server', () => ({
  HookServer: class {
    async start() {}
    stop() {}
    getPort() {
      return 0;
    }
    createSource(ptyId: string) {
      return { id: `source-${ptyId}`, token: 'token', dispose() {} };
    }
  },
}));
vi.mock('../agent-hooks/event-enricher', () => ({ parseHookEvent: vi.fn() }));
vi.mock('../agent-hooks/app-focus', () => ({ isAppFocused: () => false }));
vi.mock('@main/core/sessions/set-session-id', () => ({ setProviderSessionId: vi.fn() }));
vi.mock('@main/lib/events', () => ({ events: { emit: mocks.emit, on: vi.fn(() => () => {}) } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('@main/core/agents/plugin-registry', () => ({
  getPlugin: vi.fn(() => ({ capabilities: { hooks: { kind: 'config', supportedEvents: ['start', 'stop', 'notification', 'error'] } }, behavior: {} })),
  isValidProviderId: vi.fn(() => true),
}));

const { agentHookService } = await import('../agent-hooks/agent-hook-service');
const { agentStatusWriter } = await import('./agent-status-writer');

let clock = 1_000;
// 宿主的内存观测按会话 id 留着 ⇒ 每格一个新会话 id,格与格互不继承。
let cid = 'c0';
function event(type: AgentEvent['type'], notificationType?: NotificationType, backgroundTasks?: number): AgentEvent {
  clock += 1;
  return {
    type,
    providerId: 'claude',
    projectId: 'p1',
    sessionId: cid,
    timestamp: clock,
    payload: {
      ...(notificationType ? { notificationType } : {}),
      ...(backgroundTasks !== undefined ? { backgroundTasks } : {}),
    },
  };
}

describe('#6377 回合结束但后台任务还在 ⇒ 仍在工作,后台做完那一轮的 stop 才回 idle', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  const statuses: string[] = [];
  let off: () => void = () => {};

  const row = () =>
    fixture.sqlite
      .prepare(`SELECT agent_status AS status, agent_status_seen AS seen FROM sessions WHERE id = ?`)
      .get(cid) as { status: string; seen: number };
  const deliver = async (e: AgentEvent) => {
    const before = statuses.length;
    agentHookService.emitAgentEvent(e, false);
    await statusWritesSettled(agentStatusWriter, e.sessionId);
    expect(statuses.length).toBe(before + 1);
  };
  const deliverNoop = async (e: AgentEvent) => {
    const before = statuses.length;
    agentHookService.emitAgentEvent(e, false);
    await statusWritesSettled(agentStatusWriter, e.sessionId);
    expect(statuses.length, `${e.type}/${String(e.payload.notificationType)} must not write a status`).toBe(before);
  };
  const sounds = () =>
    mocks.emit.mock.calls
      .filter(([, payload]) => payload && 'soundEvent' in payload)
      .map(([, payload]) => (payload as { soundEvent?: string }).soundEvent)
      .filter(Boolean);

  beforeAll(async () => {
    await agentHookService.initialize();
    agentStatusWriter.initialize();
  });
  afterAll(() => {
    agentStatusWriter.dispose();
    agentHookService.dispose();
  });

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    mocks.emit.mockClear();
    cid = `c${clock}`;
    statuses.length = 0;
    fixture.sqlite.prepare(`INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/repo')`).run();
    fixture.sqlite
      .prepare(
        `INSERT INTO sessions (id, project_id, title, provider, runtime, agent_status, agent_status_seen)
         VALUES (?, 'p1', 'C', 'claude', 'pty', 'idle', 1)`
      )
      .run(cid);
    off = agentStatusWriter.on('agent:status', ({ reading }) => {
      statuses.push(reading.status);
    });
  });

  afterEach(async () => {
    off();
    fixture.close();
    mocks.db = undefined;
  });

  it('stop(后台 1)仍 working、不响;idle_prompt 不抹;task-notification 那一轮的 stop(后台 0)才 idle + 做完', async () => {
    await deliver(event('start'));
    await deliver(event('stop', undefined, 1));
    expect(row()).toEqual({ status: 'working', seen: 1 });
    expect(sounds(), '这一轮没真结束,不响').toEqual([]);

    await deliverNoop(event('notification', 'idle_prompt'));
    expect(row(), '闲置提醒不看后台,不能把它抹成 idle').toEqual({ status: 'working', seen: 1 });

    // 后台做完:Claude 注入 <task-notification>(UserPromptSubmit ⇒ start),那一轮结束时后台为 0。
    await deliver(event('start'));
    await deliver(event('stop', undefined, 0));
    expect(row()).toEqual({ status: 'idle', seen: 0 });
    expect(sounds()).toEqual(['task_complete']);
  });

  it('阴控:没有后台任务的回合原样 —— stop 即 idle + 做完,之后的 idle_prompt 不改', async () => {
    await deliver(event('start'));
    await deliver(event('stop', undefined, 0));
    expect(row()).toEqual({ status: 'idle', seen: 0 });
    expect(sounds()).toEqual(['task_complete']);
    await deliverNoop(event('notification', 'idle_prompt'));
    expect(row()).toEqual({ status: 'idle', seen: 0 });
  });

  it('阴控:harness 不报后台(字段缺席)时与今天相同', async () => {
    await deliver(event('start'));
    await deliver(event('stop'));
    expect(row()).toEqual({ status: 'idle', seen: 0 });
  });

  it('后台还在跑时 agent 退出 ⇒ 退出重置写回 idle,不卡在 working', async () => {
    await deliver(event('start'));
    await deliver(event('stop', undefined, 2));
    expect(row().status).toBe('working');
    await agentStatusWriter.settleSessionExited({ sessionId: cid });
    expect(row().status).toBe('idle');
  });

  it('这一位由下一次 stop 覆盖:后台清空后的闲置提醒照常把漏掉 stop 的 working 拉回 idle', async () => {
    await deliver(event('start'));
    await deliver(event('stop', undefined, 1));
    await deliver(event('start'));
    await deliver(event('stop', undefined, 0));
    await deliver(event('start'));
    // 这一轮没有 stop(例如失败回合没发 Stop):闲置提醒是唯一把它拉回 idle 的事实。
    await deliver(event('notification', 'idle_prompt'));
    expect(row().status).toBe('idle');
  });

  it('那一位只由会话自己的边写:子代理的 stop(#6385)不清它,之后的闲置提醒仍不抹 working', async () => {
    await deliver(event('start'));
    await deliver(event('stop', undefined, 1));
    const subagentStop = event('stop');
    await deliverNoop({ ...subagentStop, payload: { ...subagentStop.payload, origin: 'subagent' } });
    await deliverNoop(event('notification', 'idle_prompt'));
    expect(row(), '子代理的 stop 说不出会话还挂着几个后台').toEqual({ status: 'working', seen: 1 });
  });
});
