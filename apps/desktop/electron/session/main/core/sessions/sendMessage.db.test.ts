import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

import {
  claimInterruptedDispatches,
  sendMessage,
} from './sendMessage';
import { setSessionMessageRouter } from './session-message-router';

describe('conversation message SQLite outbox', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  const target = {
    projectId: 'project-1',
    sessionId: 'conversation-1',
  };

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    fixture.sqlite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('project-1', 'Project', '/repo');
      INSERT INTO sessions (id, project_id, provider, runtime, config)
        VALUES (
          'conversation-1',
          'project-1',
          'codex',
          'acp',
          '{"version":"1","type":"acp"}'
        );
    `);
  });

  afterEach(() => {
    setSessionMessageRouter(null);
    fixture.close();
    mocks.db = undefined;
  });

  it('records a live session-direct only in the recipient timeline', async () => {
    setSessionMessageRouter(async (_sessionId, message) => ({ status: 'accepted', messageId: message.id }));
    await expect(sendMessage({
      ...target,
      clientMessageId: 'message-uncertain',
      text: 'provider accepted before host commit',
      kind: 'session-direct',
    })).resolves.toMatchObject({ id: 'message-uncertain', status: 'delivered' });
    expect(fixture.sqlite.prepare('SELECT id FROM messages WHERE id = ?').get('message-uncertain')).toBeTruthy();
    const saved = fixture.sqlite.prepare('SELECT timestamp FROM messages WHERE id = ?').get('message-uncertain') as { timestamp: string };
    expect(saved.timestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
    expect(fixture.sqlite
      .prepare("SELECT json_extract(config, '$.messageOutbox') AS outbox FROM sessions WHERE id = ?")
      .get(target.sessionId)).toEqual({ outbox: null });
    expect(claimInterruptedDispatches()).toBe(0);
  });

  // 复核 139:恢复失败时发信方要看到原因,并知道消息已经留下(照「not live」重发,恢复后收件方收到两遍)。
  it('keeps a recovery-rejected session-direct pending for the common inbox reader, and tells the sender why and not to resend', async () => {
    setSessionMessageRouter(async () => ({ status: 'not-ready', preserve: true, reason: 'platform model access could not be restored (ticket refused)' }));
    const diskRoot = await mkdtemp(join(tmpdir(), 'gugu-p-e3-'));
    const before = await readdir(diskRoot);
    await expect(sendMessage({ ...target, clientMessageId: 'offline-1', text: 'offline', kind: 'session-direct' }))
      .rejects.toMatchObject({
        code: 'SESSION_DIRECT_NOT_LIVE',
        message: expect.stringContaining('platform model access could not be restored (ticket refused); the message is kept and goes out when it recovers — do not send it again'),
      });
    expect(fixture.sqlite.prepare('SELECT id, content FROM messages WHERE id = ?').get('offline-1'))
      .toEqual({ id: 'offline-1', content: 'offline' });
    expect(fixture.sqlite
      .prepare("SELECT json_extract(config, '$.messageOutbox') AS outbox FROM sessions WHERE id = ?")
      .get(target.sessionId)).toEqual({ outbox: JSON.stringify([{ id: 'offline-1', text: 'offline', kind: 'session-direct', state: 'pending' }]) });
    expect(await readdir(diskRoot)).toEqual(before);
    await rm(diskRoot, { recursive: true, force: true });
  });

  // 复核 122:outbox 只存 text,留下一条带 delivery 的消息,以后会按默认送法投出去(插进当前这一轮、key 也丢了)。
  // 所以带 delivery 的不留,发信方当场知道没送到。变异对照:去掉 `&& params.delivery` 那道判断,这条红在 outbox 不为空。
  it('does not keep a recovery-rejected message sent with delivery "queue": the sender is told and nothing is queued', async () => {
    setSessionMessageRouter(async () => ({ status: 'not-ready', preserve: true, reason: 'platform model access could not be restored (ticket refused)' }));
    await expect(sendMessage({
      ...target,
      clientMessageId: 'queued-offline',
      text: 'paper 5',
      kind: 'session-direct',
      delivery: { queue: true, coalesceKey: 'session:caller:paper' },
    })).rejects.toMatchObject({
      code: 'SESSION_DIRECT_NOT_LIVE',
      message: expect.stringMatching(/ticket refused.*not kept for later/),
    });
    expect(fixture.sqlite.prepare('SELECT id FROM messages WHERE id = ?').get('queued-offline')).toBeUndefined();
    expect(fixture.sqlite
      .prepare("SELECT json_extract(config, '$.messageOutbox') AS outbox FROM sessions WHERE id = ?")
      .get(target.sessionId)).toEqual({ outbox: null });
  });

  it('keeps a genuinely non-live session-direct as a caller-visible failure', async () => {
    setSessionMessageRouter(async () => ({ status: 'not-ready' }));
    await expect(sendMessage({ ...target, clientMessageId: 'offline-real', text: 'offline', kind: 'session-direct' }))
      .rejects.toMatchObject({ code: 'SESSION_DIRECT_NOT_LIVE' });
    expect(fixture.sqlite.prepare('SELECT id FROM messages WHERE id = ?').get('offline-real')).toBeUndefined();
    expect(fixture.sqlite
      .prepare("SELECT json_extract(config, '$.messageOutbox') AS outbox FROM sessions WHERE id = ?")
      .get(target.sessionId)).toEqual({ outbox: null });
  });

  it('delivers identical live session-direct bodies as independent messages', async () => {
    setSessionMessageRouter(async (_sessionId, message) => ({ status: 'accepted', messageId: message.id }));
    for (const [id, text] of [['direct-1', 'first'], ['direct-2', 'second']] as const) {
      await expect(sendMessage({ ...target, clientMessageId: id, text, kind: 'session-direct' }))
        .resolves.toMatchObject({ id, status: 'delivered' });
    }
    expect(fixture.sqlite
      .prepare('SELECT id FROM messages WHERE id IN (?, ?) ORDER BY id')
      .all('direct-1', 'direct-2')).toHaveLength(2);
  });
});
