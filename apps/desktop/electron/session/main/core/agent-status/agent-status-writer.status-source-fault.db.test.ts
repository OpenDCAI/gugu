import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { statusWritesSettled } from './_support/status-writes-settled';
import type { AppDb } from '@main/db/client';

/**
 * spec hook-status-derivation「打断边:会话在场文件」—— 状态来源失效是随状态输出发布的会话级标注:
 * 不改读数、不落库;标上 / 撤掉时把此刻的读数重发一次,界面据此标出。会话在场文件的读者只在写入者认为
 * 它在跑或在等时读(`isWorkingOrWaiting`)。判据打在真 SQLite 上,只看 'agent:status' 的输出。
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
  getPlugin: vi.fn(() => ({ capabilities: {}, behavior: {} })),
  isValidProviderId: vi.fn(() => true),
}));

const { agentHookService } = await import('../agent-hooks/agent-hook-service');
const { agentStatusWriter } = await import('./agent-status-writer');

describe('状态来源失效:随状态输出发布,不改读数', () => {
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

  it('标上 → 重发此刻的读数并带上原因;撤掉 → 再发一次 null;读数与库都不动', async () => {
    const out: Array<{ status: string; fault: string | null }> = [];
    const off = agentStatusWriter.on('agent:status', ({ sessionId, reading, statusSourceFault }) => {
      if (sessionId === 'c1') out.push({ status: reading.status, fault: statusSourceFault });
    });
    expect(agentStatusWriter.isWorkingOrWaiting('c1')).toBe(false);

    agentHookService.emitAgentEvent(
      { type: 'start', providerId: 'claude', projectId: 'p1', sessionId: 'c1', timestamp: Date.now(), payload: {} },
    );
    await statusWritesSettled(agentStatusWriter, 'c1');
    expect(agentStatusWriter.isWorkingOrWaiting('c1')).toBe(true);

    agentStatusWriter.reportStatusSourceFault({ sessionId: 'c1', projectId: 'p1', message: 'sessions/42.json did not appear' });
    await statusWritesSettled(agentStatusWriter, 'c1');
    agentStatusWriter.reportStatusSourceFault({ sessionId: 'c1', projectId: 'p1', message: 'sessions/42.json did not appear' });
    await statusWritesSettled(agentStatusWriter, 'c1');
    agentStatusWriter.reportStatusSourceFault({ sessionId: 'c1', projectId: 'p1', message: null });
    await statusWritesSettled(agentStatusWriter, 'c1');
    off();

    expect(out).toEqual([
      { status: 'working', fault: null },
      { status: 'working', fault: 'sessions/42.json did not appear' },
      { status: 'working', fault: null },
    ]);
    expect(agentStatusWriter.getStatusSourceFault('c1')).toBeNull();
    expect((fixture.sqlite.prepare(`SELECT agent_status AS s FROM sessions WHERE id = 'c1'`).get() as { s: string }).s).toBe('working');
  });
});
