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
        VALUES ('parent-session', 'project-1', 'Parent', 'codex', 'acp', '{"version":"1","type":"acp"}');
    `);
  });

  afterEach(() => {
    setSessionMessageRouter(null);
    fixture.close();
    mocks.db = undefined;
  });

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
  });
});
