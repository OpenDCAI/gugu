import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  enqueue: vi.fn((_input: Record<string, unknown>) => ({ seq: 1, state: 'accepted' })),
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

import { sendMessage } from './sendMessage';
import { setSessionMessageRouter } from './session-message-router';

describe('real MCP SDK to durable native/DOM receipt chain', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    fixture.sqlite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('project-1', 'Project', '/repo');
      INSERT INTO sessions (id, project_id, title, provider, runtime, config)
        VALUES ('parent-session', 'project-1', 'Parent', 'codex', NULL, '{"version":"1","type":"pty"}');
      INSERT INTO sessions (id, project_id, title, provider, runtime, config)
        VALUES ('acp-session', 'project-1', 'ACP', 'codex', 'acp', '{"version":"1","type":"acp"}');
    `);
    mocks.enqueue.mockClear();
  });

  afterEach(() => {
    setSessionMessageRouter(null);
    fixture.close();
    mocks.db = undefined;
  });

  // Retargeted to a PTY target (runtime null): the router + messages-table receipt chain now applies only to non-ACP sessions.
  it('an SDK session-direct is delivered synchronously to a live target', async () => {
    const messageId = '11111111-1111-4111-8111-111111111111';
    const marker = 'sdk-durable-native-dom-marker';
    setSessionMessageRouter(async (_sessionId, message) => ({ status: 'accepted', messageId: message.id }));
    await expect(sendMessage({
      projectId: 'project-1', sessionId: 'parent-session',
      clientMessageId: messageId, text: marker, kind: 'session-direct',
    })).resolves.toMatchObject({ id: messageId, status: 'delivered' });
    expect(fixture.sqlite.prepare('SELECT content FROM messages WHERE id = ?').get(messageId))
      .toEqual({ content: marker });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('an SDK session-direct to an ACP target goes to session-life, not the router or the messages table', async () => {
    const messageId = '22222222-2222-4222-8222-222222222222';
    const router = vi.fn();
    setSessionMessageRouter(router);
    await expect(sendMessage({
      projectId: 'project-1', sessionId: 'acp-session',
      clientMessageId: messageId, text: 'to acp', kind: 'session-direct',
    })).resolves.toEqual({ id: messageId, status: 'delivered' });
    expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'acp-session', messageId, text: 'to acp', kind: 'session-direct',
    });
    expect(router).not.toHaveBeenCalled();
    expect(fixture.sqlite.prepare('SELECT id FROM messages WHERE id = ?').get(messageId)).toBeUndefined();
  });
});
