import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';

/**
 * #6089 —— 用户自己把 agent 杀掉时,那条「等你批准」当场变成 idle + 已读;agent 自己交回的「做完未读」
 * 不归打断(`interrupt`)管,要用户点开才算看过。
 *
 * 判据打在真 SQLite 上,读会话行的 agent_status / agent_status_seen(会话页侧栏读的就是这两列)。
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
  getPlugin: vi.fn(() => ({ capabilities: { hooks: { kind: 'config', supportedEvents: ['start', 'stop', 'notification', 'error'] } }, behavior: {} })),
  isValidProviderId: vi.fn(() => true),
}));

const { agentStatusWriter } = await import('./agent-status-writer');

describe('#6089 agent 被杀掉后的已读位', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    fixture.sqlite.prepare(`INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/repo')`).run();
    fixture.sqlite
      .prepare(
        `INSERT INTO sessions (id, project_id, provider, runtime, agent_status, agent_status_seen)
         VALUES ('c1', 'p1', 'claude', 'pty', 'needs_user', 0)`
      )
      .run();
  });

  afterEach(() => {
    agentStatusWriter.dispose();
    fixture.close();
    mocks.db = undefined;
  });

  const row = () =>
    fixture.sqlite
      .prepare(`SELECT agent_status AS status, agent_status_seen AS seen FROM sessions WHERE id = 'c1'`)
      .get() as { status: string; seen: number };

  it('interrupt 把等批准的会话写成 idle + 已读', async () => {
    expect(row(), '前提:一条等人输入且没看过的会话').toEqual({ status: 'needs_user', seen: 0 });

    await agentStatusWriter.interrupt({ sessionId: 'c1', projectId: 'p1' });

    expect(row()).toEqual({ status: 'idle', seen: 1 });
  });

  it('不该动的行不动:状态不在 working/needs_user 时 interrupt 什么都不做', async () => {
    fixture.sqlite.prepare(`UPDATE sessions SET agent_status = 'idle' WHERE id = 'c1'`).run();

    await agentStatusWriter.interrupt({ sessionId: 'c1', projectId: 'p1' });

    // 阴控:做完未读(idle + 未读)不归 interrupt 管(它是 agent 自己交回的回合,要用户点开才算看过)。
    expect(row()).toEqual({ status: 'idle', seen: 0 });
  });
});
