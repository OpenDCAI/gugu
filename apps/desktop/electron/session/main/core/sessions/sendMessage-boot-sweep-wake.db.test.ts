import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('@gugu/session-plugins/agents', () => ({
  resolveSessionpageSessionIntegration: () => ({ identity: 'addressable', messageTransport: 'router' }),
}));
vi.mock('@main/core/projects/utils', () => ({ resolveSession: () => null }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));

import { drainAllSessionMessageOutboxes, drainSessionMessageOutbox, sendMessage } from './sendMessage';
import { setSessionMessageRouter } from './session-message-router';
import { SessionpageLocalDeliveryRouter } from '../../../../sessionpage/session-injection';

// 体检 B10 + 统筹口径 10-18:桌面重启后,开机扫一遍 outbox(drainAllSessionMessageOutboxes)遇到一条压着普通消息、
// 引擎没在跑的原生终端会话,经路由器唯一的去重唤醒口把它重开 —— 与 ACP 会话从前的行为一致。路由器这一层的接法
// 就是 main.ts sessionMessageRouter 普通消息那一支:tryInjectOrWake,没收 ⇒ not-ready(消息留在 outbox)。
describe('the boot sweep wakes a terminal session that holds a pending ordinary message', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  const target = { projectId: 'project-1', sessionId: 'conv-tui' };

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    fixture.sqlite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('project-1', 'Project', '/repo');
      INSERT INTO sessions (id, project_id, title, provider, runtime, config)
        VALUES ('conv-tui', 'project-1', 'Terminal', 'codex', 'pty', '{"version":"1","type":"pty"}');
    `);
  });

  afterEach(() => {
    setSessionMessageRouter(null);
    fixture.close();
    mocks.db = undefined;
  });

  it('reopens it once and keeps the message pending until it is live', async () => {
    // Before the restart: no router yet (the host is not up) — the ordinary message is kept in the outbox.
    await expect(sendMessage({ ...target, clientMessageId: 'held-1', text: 'while you were away' })).resolves.toMatchObject({ id: 'held-1' });
    const wakeSession = vi.fn(async () => undefined);
    const router = new SessionpageLocalDeliveryRouter([{
      deliveryTargetName: 'tui-owner',
      liveSessionIdByAgent: () => null,
      deliveryKeyForSession: (sessionId) => (sessionId === target.sessionId ? sessionId : null),
      sessionProviderSurface: () => ({ providerId: 'codex', surface: 'tui' }),
      // Not live yet: the engine is not running, nothing is taken.
      tryInjectSessionMessage: async () => false,
    }], { wakeSession, processRunning: () => false });
    setSessionMessageRouter(async (sessionId, message) => {
      const accepted = await router.tryInjectOrWake(sessionId, message);
      return accepted === false ? { status: 'not-ready' } : { status: 'accepted', messageId: message.id };
    });

    await drainAllSessionMessageOutboxes();

    await vi.waitFor(() => expect(wakeSession).toHaveBeenCalledWith(target.sessionId));
    expect(wakeSession).toHaveBeenCalledTimes(1);
    expect(fixture.sqlite
      .prepare("SELECT json_extract(config, '$.messageOutbox') AS outbox FROM sessions WHERE id = ?")
      .get(target.sessionId)).not.toEqual({ outbox: null });
  });

  async function holdMessage(sessionId: string, id: string): Promise<void> {
    await sendMessage({ projectId: target.projectId, sessionId, clientMessageId: id, text: 'held for startup' });
    // Settle the normal no-router drain before changing archival state.
    await drainSessionMessageOutbox({ projectId: target.projectId, sessionId });
  }

  it('continues boot with archived pending data preserved and active delivery still eligible', async () => {
    fixture.sqlite.exec(`INSERT INTO sessions (id,project_id,title,provider,runtime,config)
      VALUES ('archived','project-1','Archived','codex','pty','{"version":"1","type":"pty"}');`);
    await holdMessage('archived', 'archived-held');
    await holdMessage(target.sessionId, 'active-held');
    fixture.sqlite.prepare('UPDATE sessions SET archived_at=? WHERE id=?').run('2026-10-29T00:00:00Z', 'archived');
    const snapshot = () => ({
      session: fixture.sqlite.prepare('SELECT config,archived_at FROM sessions WHERE id=?').get('archived'),
      messages: fixture.sqlite.prepare('SELECT content,metadata FROM messages WHERE session_id=? ORDER BY id').all('archived'),
    });
    const before = snapshot();
    const deliver = vi.fn(async () => ({ status: 'not-ready' as const }));
    setSessionMessageRouter(deliver);

    await expect(drainAllSessionMessageOutboxes()).resolves.toBeUndefined();

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(target.sessionId, expect.objectContaining({ id: 'active-held' }));
    expect(snapshot()).toEqual(before);
  });

  it('allows archival to win between sweep selection and the serialized drain', async () => {
    await holdMessage(target.sessionId, 'archiving-held');
    const before = fixture.sqlite.prepare('SELECT config FROM sessions WHERE id=?').get(target.sessionId);
    const deliver = vi.fn(async () => ({ status: 'not-ready' as const }));
    setSessionMessageRouter(deliver);

    const sweep = drainAllSessionMessageOutboxes();
    fixture.sqlite.prepare('UPDATE sessions SET archived_at=? WHERE id=?').run('2026-10-29T00:00:00Z', target.sessionId);
    await expect(sweep).resolves.toBeUndefined();

    expect(deliver).not.toHaveBeenCalled();
    expect(fixture.sqlite.prepare('SELECT config FROM sessions WHERE id=?').get(target.sessionId)).toEqual(before);
  });

  it('keeps genuine active delivery failures visible to the boot caller', async () => {
    await holdMessage(target.sessionId, 'failed-held');
    const failure = new Error('provider transport failed');
    setSessionMessageRouter(async () => { throw failure; });

    await expect(drainAllSessionMessageOutboxes()).rejects.toBe(failure);
  });
});
