import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { statusWritesSettled } from './_support/status-writes-settled';
import type { AgentStatus } from '@shared/core/agents/agentEvents';
import type { AppDb } from '@main/db/client';

/**
 * #6180 —— 'agent:status' 是会话状态**写下之后**的唯一输出,presence 订的就是它。
 *
 * 用户点 Stop 的 ACP 回合由状态桥经写入者**打断**成 idle(不发事件)。两条写入 —— 回合起的 working 与
 * 取消的 idle —— 必须按到达顺序各播一次:后到的重置若在前一条还没落库时就去读库,会读到旧值、
 * 什么都不播,presence 就停在 working。判据打在真 SQLite 上,读数只看 'agent:status' 的输出序列。
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
vi.mock('../agent-hooks/app-focus', () => ({ isAppFocused: () => false }));
vi.mock('@main/core/sessions/set-session-id', () => ({ setProviderSessionId: vi.fn() }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn(), on: vi.fn(() => () => {}) } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('@main/core/agents/plugin-registry', () => ({
  getPlugin: vi.fn(() => ({ capabilities: {}, behavior: {} })),
  isValidProviderId: vi.fn(() => true),
}));

const { agentHookService } = await import('../agent-hooks/agent-hook-service');
const { agentStatusWriter } = await import('./agent-status-writer');

describe('#6180 状态输出按写入顺序播出,取消重置也在其中', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    fixture.sqlite.prepare(`INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/repo')`).run();
    fixture.sqlite
      .prepare(
        `INSERT INTO sessions (id, project_id, title, runtime, agent_status, agent_status_seen)
         VALUES ('c1', 'p1', 'C', 'acp', 'idle', 1)`
      )
      .run();
    await agentHookService.initialize();
    agentStatusWriter.initialize();
  });

  afterEach(() => {
    agentStatusWriter.dispose();
    agentHookService.dispose();
    fixture.close();
    mocks.db = undefined;
  });

  it('回合起之后紧跟的取消重置:输出 working → idle,库里也是 idle', async () => {
    const statuses: AgentStatus[] = [];
    const off = agentStatusWriter.on('agent:status', ({ sessionId, reading }) => {
      if (sessionId === 'c1') statuses.push(reading.status);
    });

    agentHookService.emitAgentEvent(
      {
        type: 'start',
        providerId: 'codex',
        projectId: 'p1',
        sessionId: 'c1',
        timestamp: Date.now(),
        payload: {},
      }
    );
    await agentStatusWriter.interrupt({ sessionId: 'c1', projectId: 'p1' });
    off();

    expect(statuses).toEqual(['working', 'idle']);
    expect(
      (fixture.sqlite.prepare(`SELECT agent_status AS s FROM sessions WHERE id = 'c1'`).get() as { s: string }).s
    ).toBe('idle');
  });

  // provider 门 / 阻塞也是状态写入:注意力角标订 'agent:status',❌ 只写库和渲染层让它看不到「需要你」。
  it('provider 阻塞与审阅门同样经 agent:status 播出,且库里是未读', async () => {
    const statuses: AgentStatus[] = [];
    const off = agentStatusWriter.on('agent:status', ({ sessionId, reading }) => {
      if (sessionId === 'c1') statuses.push(reading.status);
    });
    const row = () =>
      fixture.sqlite.prepare(`SELECT agent_status AS s, agent_status_seen AS seen FROM sessions WHERE id = 'c1'`).get();

    agentStatusWriter.reportProviderReviewGate({ sessionId: 'c1', projectId: 'p1', gate: 'mcp' });
    await statusWritesSettled(agentStatusWriter, 'c1');
    expect(statuses).toEqual(['needs_user']);
    expect(row()).toEqual({ s: 'needs_user', seen: 0 });

    agentStatusWriter.reportProviderBlocker({
      sessionId: 'c1',
      projectId: 'p1',
      blocker: { kind: 'provider', message: 'User not found', reason: 'auth' },
    });
    await statusWritesSettled(agentStatusWriter, 'c1');
    expect(statuses).toEqual(['needs_user', 'error']);
    expect(row()).toEqual({ s: 'error', seen: 0 });
    off();
  });
});
