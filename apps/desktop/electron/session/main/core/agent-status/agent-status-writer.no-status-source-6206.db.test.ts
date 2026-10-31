import { openFixture } from '@tooling/utils/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { statusWritesSettled } from './_support/status-writes-settled';
import type { AppDb } from '@main/db/client';
import type { AgentEvent } from '@shared/core/agents/agentEvents';

/**
 * #6206 —— 没有状态源的会话(终端腿、这一家 hooks 为 none)一条 hook 边沿都不会来;落到唯一写入者这里的
 * 只有宿主自己合成的边(回车 / 首句的 start、投递失败的 error)。那些不是「这一轮在不在跑」的证据 ⇒
 * 整条不写:`agent_status` 保持出生时的 `null`,也不播 `agent:status`。
 *
 * 判据打在真 SQLite 上。两个阳控钉住「键是会话的腿 + descriptor,不是 provider 名、也不是事件来源」:
 * 同一家的 ACP 腿照常写;有 hooks 的家的终端腿照常写。
 */
const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));

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
vi.mock('@main/core/sessions/set-session-id', () => ({ setProviderSessionId: vi.fn() }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn(), on: vi.fn(() => () => {}) } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('@main/core/agents/plugin-registry', () => ({
  getPlugin: vi.fn((providerId: string) => ({
    capabilities: {
      hooks: providerId === 'gemini'
        ? { kind: 'none' }
        : { kind: 'config', supportedEvents: ['start', 'stop', 'notification', 'error'] },
    },
    behavior: {},
  })),
  isValidProviderId: vi.fn(() => true),
}));

const { agentHookService } = await import('../agent-hooks/agent-hook-service');
const { agentStatusWriter } = await import('./agent-status-writer');

let clock = 1_000;
function event(sessionId: string, providerId: string, type: AgentEvent['type']): AgentEvent {
  clock += 1;
  return { type, providerId, projectId: 'p1', sessionId, timestamp: clock, payload: {} };
}

describe('#6206 没有状态源的终端会话不写派生活动', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  const published: { sessionId: string; status: string }[] = [];
  let off: () => void = () => {};

  const status = (id: string) =>
    (fixture.sqlite.prepare(`SELECT agent_status AS status FROM sessions WHERE id = ?`).get(id) as {
      status: string | null;
    }).status;
  const seed = (id: string, provider: string, runtime: 'pty' | 'acp', agentStatus: string | null) =>
    fixture.sqlite
      .prepare(
        `INSERT INTO sessions (id, project_id, title, provider, runtime, agent_status, agent_status_seen)
         VALUES (?, 'p1', 'C', ?, ?, ?, 1)`
      )
      .run(id, provider, runtime, agentStatus);
  const deliver = async (e: AgentEvent) => {
    const before = published.length;
    agentHookService.emitAgentEvent(e);
    await statusWritesSettled(agentStatusWriter, e.sessionId);
    expect(published.length).toBe(before + 1);
  };
  const deliverNoop = async (e: AgentEvent) => {
    const before = published.length;
    agentHookService.emitAgentEvent(e);
    await statusWritesSettled(agentStatusWriter, e.sessionId);
    expect(published.length, `${e.providerId}/${e.type} must not publish a status`).toBe(before);
  };

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
    published.length = 0;
    fixture.sqlite.prepare(`INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/repo')`).run();
    off = agentStatusWriter.on('agent:status', ({ sessionId, reading }) => {
      published.push({ sessionId, status: reading.status });
    });
  });
  afterEach(() => {
    off();
    fixture.close();
    mocks.db = undefined;
  });

  it('hookless TUI: synthesized start / error / stop and the exit reset leave agent_status null and publish nothing', async () => {
    const id = `hookless-${clock}`;
    seed(id, 'gemini', 'pty', null);

    await deliverNoop(event(id, 'gemini', 'start'));
    await deliverNoop(event(id, 'gemini', 'error'));
    await deliverNoop(event(id, 'gemini', 'stop'));
    await agentStatusWriter.settleSessionExited({ sessionId: id, projectId: 'p1' });

    expect(status(id)).toBeNull();
    expect(published).toEqual([]);
  });

  // @@@deleted-row-late-hook:终端会话的删除是「先删行、后停进程」,停进程时 harness 打出的退出边带着有效令牌到达。
  it('a late hook for a conversation whose row is already deleted writes nothing and publishes nothing', async () => {
    const id = `deleted-${clock}`;
    seed(id, 'claude', 'pty', 'working');
    fixture.sqlite.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);

    await deliverNoop(event(id, 'claude', 'stop'));
    expect(published).toEqual([]);
  });

  it('positive control — the same hookless harness on its ACP leg still gets status written', async () => {
    const id = `acp-${clock}`;
    seed(id, 'gemini', 'acp', 'idle');

    await deliver(event(id, 'gemini', 'start'));
    expect(status(id)).toBe('working');
  });

  it('positive control — a harness with hooks on the TUI leg still gets status written', async () => {
    const id = `hooked-${clock}`;
    seed(id, 'claude', 'pty', 'idle');

    await deliver(event(id, 'claude', 'start'));
    expect(status(id)).toBe('working');
    await deliver(event(id, 'claude', 'stop'));
    expect(status(id)).toBe('idle');
  });
});
