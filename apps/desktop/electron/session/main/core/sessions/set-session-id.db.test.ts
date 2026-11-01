import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { sessionChangedChannel } from '@shared/core/sessions/sessionEvents';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  emit: vi.fn(),
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

vi.mock('@main/lib/events', () => ({
  events: { emit: mocks.emit },
}));

import { clearProviderSessionId, setProviderSessionId } from './set-session-id';

describe('setSessionId publication', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    mocks.emit.mockReset();
    fixture.sqlite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('project-1', 'Project', '/repo');
      INSERT INTO sessions (id, project_id, provider, runtime, config)
        VALUES ('conversation-1', 'project-1', 'codex', 'acp',
                '{"version":"1","type":"acp"}');
    `);
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('publishes the persisted provider session id to the live renderer', async () => {
    await expect(setProviderSessionId('conversation-1', ' provider-session-1 ')).resolves.toEqual({
      success: true,
      data: undefined,
    });

    expect(
      fixture.sqlite
        .prepare('SELECT provider_session_id FROM sessions WHERE id = ?')
        .get('conversation-1')
    ).toEqual({ provider_session_id: 'provider-session-1' });
    expect(mocks.emit).toHaveBeenCalledOnce();
    expect(mocks.emit).toHaveBeenCalledWith(sessionChangedChannel, {
      sessionId: 'conversation-1',
      projectId: 'project-1',
      changes: { providerSessionId: 'provider-session-1' },
    });
  });

  it('does not publish when the conversation does not exist', async () => {
    await expect(setProviderSessionId('missing', 'provider-session-1')).resolves.toMatchObject({
      success: false,
      error: { type: 'session-not-found' },
    });
    expect(mocks.emit).not.toHaveBeenCalled();
  });
});

describe('clearSessionId', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  const providerSessionIdOf = (id: string) =>
    (
      fixture.sqlite.prepare('SELECT provider_session_id FROM sessions WHERE id = ?').get(id) as
        | { provider_session_id: string | null }
        | undefined
    )?.provider_session_id ?? null;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    mocks.emit.mockReset();
    fixture.sqlite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('project-1', 'Project', '/repo');
      INSERT INTO sessions (id, project_id, provider, runtime, config, provider_session_id)
        VALUES ('conversation-1', 'project-1', 'claude', 'pty',
                '{"version":"1","type":"pty"}', 'claimed-id');
    `);
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  // 「清空」必须能过 JSON —— 网页宿主那条传输就是 JSON.stringify,而它会把值为 undefined 的键
  // 整个丢掉。判据直接对**序列化之后**的载荷断言:写成 `undefined` 时这一条必红。
  it('clears the row and publishes a change that survives JSON transport', async () => {
    await expect(clearProviderSessionId('conversation-1', 'claimed-id')).resolves.toBe(true);
    expect(providerSessionIdOf('conversation-1')).toBeNull();

    expect(mocks.emit).toHaveBeenCalledOnce();
    const [, payload] = mocks.emit.mock.calls[0] as [unknown, { changes: Record<string, unknown> }];
    expect(payload.changes).toEqual({ providerSessionId: null });
    const overTheWire = JSON.parse(JSON.stringify(payload)) as { changes: Record<string, unknown> };
    expect('providerSessionId' in overTheWire.changes).toBe(true);
    expect(overTheWire.changes.providerSessionId).toBeNull();
  });

  // 退账只退自己那笔:认领之后 fork-capture 可能在 spawn 的窗口里绑上一个**真的** provider 会话 id,
  // 无条件清空会把它抹掉,而用户什么都没做。
  it('refuses to clear an id it did not claim, and says nothing', async () => {
    fixture.sqlite
      .prepare('UPDATE sessions SET provider_session_id = ? WHERE id = ?')
      .run('real-provider-session', 'conversation-1');

    await expect(clearProviderSessionId('conversation-1', 'claimed-id')).resolves.toBe(false);
    expect(providerSessionIdOf('conversation-1')).toBe('real-provider-session');
    expect(mocks.emit).not.toHaveBeenCalled();
  });
});
