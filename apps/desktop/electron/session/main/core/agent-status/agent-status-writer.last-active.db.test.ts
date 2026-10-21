import { openFixture } from '@tooling/utils/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { statusWritesSettled } from './_support/status-writes-settled';
import type { AppDb } from '@main/db/client';
import type { AgentEvent } from '@shared/core/agents/agentEvents';

/**
 * 会话的「最近活动」(`lastInteractedAt`:侧栏按它排、行上写它,`session_get` 的 `last_active_at`、App 的 `updatedAt`)
 * 由唯一写入者在每一轮经过的那一笔里写下:面板会话从前建行之后就再也不动(只有终端按回车会动)。
 *
 * 判据打在真 SQLite 上,时刻一律取事件自带的时间戳,❌ 墙钟。对照:没发布的事件、「已读」不动它;
 * 没有状态源的终端腿只认给它一轮时合成的 start,照旧不写状态。
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
const { events } = await import('@main/lib/events');
const { sessionChangedChannel } = await import('@shared/core/sessions/sessionEvents');

const BORN = '2000-01-01T00:00:00.000Z';
const iso = (ms: number) => new Date(ms).toISOString();
let clock = 1_000_000;
function event(sessionId: string, providerId: string, type: AgentEvent['type']): AgentEvent {
  clock += 1_000;
  return { type, providerId, projectId: 'p1', sessionId, timestamp: clock, payload: {} };
}

describe('会话的最近活动跟着每一轮走', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  const published: string[] = [];
  let off: () => void = () => {};

  const lastActive = (id: string) =>
    (fixture.sqlite.prepare(`SELECT last_interacted_at AS at FROM sessions WHERE id = ?`).get(id) as { at: string | null }).at;
  const status = (id: string) =>
    (fixture.sqlite.prepare(`SELECT agent_status AS status FROM sessions WHERE id = ?`).get(id) as { status: string | null }).status;
  const seed = (id: string, provider: string, runtime: 'pty' | 'acp', agentStatus: string | null) =>
    fixture.sqlite
      .prepare(
        `INSERT INTO sessions (id, project_id, title, provider, runtime, agent_status, agent_status_seen, last_interacted_at)
         VALUES (?, 'p1', 'C', ?, ?, ?, 1, ?)`
      )
      .run(id, provider, runtime, agentStatus, BORN);
  const deliver = async (e: AgentEvent) => {
    agentHookService.emitAgentEvent(e, false);
    await statusWritesSettled(agentStatusWriter, e.sessionId);
    return e.timestamp;
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
    vi.mocked(events.emit).mockClear();
    fixture.sqlite.prepare(`INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/repo')`).run();
    off = agentStatusWriter.on('agent:status', ({ reading }) => {
      published.push(reading.status);
    });
  });
  afterEach(() => {
    off();
    fixture.close();
    mocks.db = undefined;
  });

  it('a panel session: the turn starting and the turn ending each move it, and the task page is told', async () => {
    const id = `panel-${clock}`;
    seed(id, 'claude', 'acp', 'idle');

    const started = await deliver(event(id, 'claude', 'start'));
    expect(status(id)).toBe('working');
    expect(lastActive(id)).toBe(iso(started));
    const ended = await deliver(event(id, 'claude', 'stop'));
    expect(status(id)).toBe('idle');
    expect(lastActive(id)).toBe(iso(ended));
    expect(vi.mocked(events.emit)).toHaveBeenCalledWith(sessionChangedChannel, {
      sessionId: id,
      projectId: 'p1',
      changes: { lastInteractedAt: iso(ended) },
    });
  });

  it('counter-cell: an event that publishes nothing, and opening the session (seen), leave it where it was', async () => {
    const id = `quiet-${clock}`;
    seed(id, 'claude', 'acp', 'idle');
    const ended = await deliver(event(id, 'claude', 'start')).then(() => deliver(event(id, 'claude', 'stop')));
    const before = published.length;

    await agentStatusWriter.markSeen(id);
    expect(published.length).toBe(before + 1); // seen is published …
    expect(lastActive(id)).toBe(iso(ended)); // … but it is not activity
  });

  it('a hookless terminal session: the start given it on Enter moves it; no status is written, nothing else moves it', async () => {
    const id = `hookless-${clock}`;
    seed(id, 'gemini', 'pty', null);

    const typed = await deliver(event(id, 'gemini', 'start'));
    expect(lastActive(id)).toBe(iso(typed));
    await deliver(event(id, 'gemini', 'stop'));
    await deliver(event(id, 'gemini', 'error'));
    expect(lastActive(id)).toBe(iso(typed));
    expect(status(id)).toBeNull();
    expect(published).toEqual([]);
  });

  it('a restart is activity: it moves it to the moment of the restart', async () => {
    const id = `restart-${clock}`;
    seed(id, 'claude', 'acp', 'idle');
    const now = vi.spyOn(Date, 'now').mockReturnValue(clock + 5_000);
    try {
      await agentStatusWriter.restart({ sessionId: id, projectId: 'p1' });
      await statusWritesSettled(agentStatusWriter, id);
      expect(lastActive(id)).toBe(iso(clock + 5_000));
    } finally {
      now.mockRestore();
    }
  });
});
