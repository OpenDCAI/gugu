import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  // session-life owns ACP sessions; here only its enqueue boundary is observed.
  enqueue: vi.fn((_input: Record<string, unknown>): { seq: number; state: string } => ({ seq: 1, state: 'queued' })),
}));

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
vi.mock('./session-life', () => ({ sessionLife: () => ({ enqueue: mocks.enqueue }) }));

import {
  claimInterruptedDispatches,
  drainAllSessionMessageOutboxes,
  drainSessionMessageOutbox,
  sendMessage,
} from './sendMessage';
import { setSessionMessageRouter } from './session-message-router';

// Retargeted to a PTY session (runtime null): the legacy SQLite outbox now serves only non-ACP sessions;
// ACP sessions go to session-life's queue (covered by session-pending.db.test.ts and the owner cases).
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
      INSERT INTO sessions (id, project_id, title, provider, runtime, config)
        VALUES (
          'conversation-1',
          'project-1',
          'Conversation',
          'codex',
          NULL,
          '{"version":"1","type":"pty"}'
        );
    `);
    mocks.enqueue.mockClear();
  });

  afterEach(() => {
    expect(mocks.enqueue, 'a non-ACP session never reaches session-life').not.toHaveBeenCalled();
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

describe('ACP sessions: sendMessage hands the message to session-life', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  const target = { projectId: 'project-1', sessionId: 'acp-1' };
  const router = vi.fn();
  const outbox = () => fixture.sqlite
    .prepare("SELECT json_extract(config, '$.messageOutbox') AS outbox FROM sessions WHERE id = ?")
    .get(target.sessionId);

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    fixture.sqlite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('project-1', 'Project', '/repo');
      INSERT INTO sessions (id, project_id, title, provider, runtime, config)
        VALUES ('acp-1', 'project-1', 'Conversation', 'codex', 'acp', '{"version":"1","type":"acp"}');
    `);
    mocks.enqueue.mockReset();
    router.mockReset();
    setSessionMessageRouter(router);
  });

  afterEach(() => {
    // The legacy transport and outbox never see an ACP message.
    expect(router).not.toHaveBeenCalled();
    expect(outbox()).toEqual({ outbox: null });
    setSessionMessageRouter(null);
    fixture.close();
    mocks.db = undefined;
  });

  it('enqueues the exact message (id, text, kind, delivery) and nothing else', async () => {
    mocks.enqueue.mockReturnValueOnce({ seq: 1, state: 'queued' });
    const delivery = { queue: true as const, coalesceKey: 'session:caller:paper' };
    await expect(sendMessage({ ...target, clientMessageId: 'm-1', text: 'paper 5', kind: 'session-direct', delivery }))
      .resolves.toEqual({ id: 'm-1', status: 'queued' });
    expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'acp-1', messageId: 'm-1', text: 'paper 5', kind: 'session-direct', delivery,
    });

    mocks.enqueue.mockReturnValueOnce({ seq: 2, state: 'queued' });
    await sendMessage({ ...target, clientMessageId: 'm-2', text: 'hello' });
    expect(mocks.enqueue).toHaveBeenLastCalledWith({ sessionId: 'acp-1', messageId: 'm-2', text: 'hello', kind: 'ordinary' });
    expect(fixture.sqlite.prepare('SELECT id FROM messages').all()).toEqual([]);
  });

  it.each([
    ['queued', 'queued'],
    ['dispatching', 'queued'],
    ['accepted', 'delivered'],
    ['unknown', 'outcome-unknown'],
  ] as const)('maps a %s receipt to %s', async (state, status) => {
    mocks.enqueue.mockReturnValueOnce({ seq: 1, state });
    await expect(sendMessage({ ...target, clientMessageId: 'm', text: 'hi', kind: 'session-direct' }))
      .resolves.toEqual({ id: 'm', status });
  });

  it('a message whose receipt already failed is a caller-visible failure', async () => {
    mocks.enqueue.mockReturnValueOnce({ seq: 1, state: 'failed' });
    await expect(sendMessage({ ...target, clientMessageId: 'm-failed', text: 'hi', kind: 'session-direct' }))
      .rejects.toMatchObject({ code: 'SESSION_DIRECT_NOT_LIVE', message: expect.stringContaining('m-failed already failed') });
  });

  it('the legacy outbox refuses an ACP session and the boot sweep skips it', async () => {
    await expect(drainSessionMessageOutbox(target)).rejects.toThrow('owned by session-life');
    // A stale legacy row left on an ACP session is not replayed by the boot sweep.
    fixture.sqlite.prepare("UPDATE sessions SET config = ? WHERE id = 'acp-1'")
      .run(JSON.stringify({ version: '1', type: 'acp', messageOutbox: [{ id: 'stale', text: 'old', kind: 'ordinary', state: 'pending' }] }));
    await expect(drainAllSessionMessageOutboxes()).resolves.toBeUndefined();
    expect(JSON.parse((outbox() as { outbox: string }).outbox)).toEqual([{ id: 'stale', text: 'old', kind: 'ordinary', state: 'pending' }]);
    fixture.sqlite.prepare("UPDATE sessions SET config = ? WHERE id = 'acp-1'").run('{"version":"1","type":"acp"}');
  });
});
