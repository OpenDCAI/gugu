import { sessionBootTasks } from '../boot-tasks';
import { openFixture } from '@tooling/utils/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { makeTmuxSessionName } from '@main/core/pty/tmux-session-name';
import { makePtySessionId } from '@shared/core/pty/ptySessionId';

/**
 * 开机收残只收引擎随上一个进程没了的会话:在 tmux 里活下来的那一轮还在跑,读数照旧。
 * 10-08 实读:账号进程一重启,在 tmux 里跑着的 claude 全被收成空闲,守护进程据此判「没有 agent 在跑」连升两级。
 * 活没活与接回同一个判据(`sessionsAliveInTmux`):开机问一次 tmux 的名字列表。
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
const { readInterruptedTurn } = await import('./interrupted-turns');
const { mapSessionRowToSession } = await import('@main/core/sessions/utils');

const tmuxName = (sessionId: string) => makeTmuxSessionName(makePtySessionId('p1', sessionId, sessionId));

describe('settling after a restart leaves sessions whose engine survived in tmux alone', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  const status = (id: string) =>
    (fixture.sqlite.prepare(`SELECT agent_status AS status, agent_status_detail AS detail FROM sessions WHERE id = ?`).get(id) as {
      status: string | null;
      detail: string | null;
    });
  const seed = (id: string, runtime: 'pty' | 'acp', agentStatus: string) =>
    fixture.sqlite
      .prepare(
        `INSERT INTO sessions (id, project_id, title, provider, runtime, agent_status, agent_status_seen)
         VALUES (?, 'p1', 'C', 'claude', ?, ?, 1)`
      )
      .run(id, runtime, agentStatus);

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
    fixture.sqlite.prepare(`INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/repo')`).run();
    seed('in-tmux', 'pty', 'working');
    seed('in-tmux-asking', 'pty', 'needs_user');
    seed('pty-gone', 'pty', 'working');
    seed('acp', 'acp', 'working');
    seed('idle', 'pty', 'idle');
  });
  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('a session still running in tmux keeps its reading; the ones whose engine died with the host are settled', async () => {
    await agentStatusWriter.settleAfterRestart(new Set([tmuxName('in-tmux'), tmuxName('in-tmux-asking'), 'gugu-someone-else']));

    expect(status('in-tmux').status).toBe('working');
    expect(status('in-tmux-asking').status).toBe('needs_user');
    expect(status('pty-gone')).toEqual({ status: 'error', detail: null });
    expect(status('acp')).toEqual({ status: 'error', detail: null });
    expect(status('idle').status).toBe('idle');
  });

  it('an interrupted turn is an error the person has not seen, with why the host stopped; the next start clears the why', async () => {
    await agentStatusWriter.settleAfterRestart(new Set(), 'update');

    const seen = fixture.sqlite.prepare(`SELECT agent_status_seen AS seen FROM sessions WHERE id = 'acp'`).get() as { seen: number };
    expect(seen.seen).toBe(0);
    expect(readInterruptedTurn('acp')).toBe('update');
    expect(readInterruptedTurn('idle')).toBeNull();
    const row = await fixture.db.query.sessions.findFirst({ where: (t, { eq }) => eq(t.id, 'acp') });
    expect(mapSessionRowToSession(row!)).toMatchObject({ agentStatus: 'error', interruptedBy: 'update' });

    await agentStatusWriter.restart({ sessionId: 'acp', projectId: 'p1' });
    expect(status('acp').status).toBe('working');
    expect(readInterruptedTurn('acp')).toBeNull();
  });

  it('no word left by the last exit = it did not shut down cleanly', async () => {
    await agentStatusWriter.settleAfterRestart(new Set());
    expect(readInterruptedTurn('acp')).toBe('unclean');
  });

  it('no tmux sessions (tmux off, or no tmux server): everything in flight is settled, as before', async () => {
    await agentStatusWriter.settleAfterRestart(new Set());

    for (const id of ['in-tmux', 'in-tmux-asking', 'pty-gone', 'acp']) {
      expect(status(id)).toEqual({ status: 'error', detail: null });
    }
  });
  it('records one task update refusal and continues restart recovery for the other tasks', async () => {
    fixture.sqlite.exec(`CREATE TRIGGER refuse_one_status BEFORE UPDATE ON sessions WHEN OLD.id='pty-gone' BEGIN SELECT RAISE(ABORT,'status fixture refusal'); END;`);
    await expect(agentStatusWriter.settleAfterRestart(new Set())).resolves.toBeUndefined();
    expect(status('pty-gone').status).toBe('working');
    expect(status('acp').status).toBe('error');
    expect(sessionBootTasks.snapshot()).toContainEqual(expect.objectContaining({ operation: 'status-recovery', taskId: 'pty-gone' }));
  });

});
