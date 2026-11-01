import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
const mock = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({ get db() { if (!mock.db) throw new Error('Missing fixture'); return mock.db; } }));
import { pendingNativeConversationInbox, publishNativeConversationInbox, queueNativeConversationInbox, startNativeConversationInboxHost } from './native-conversation-inbox';
let fixture: Awaited<ReturnType<typeof openFixture>>;
let host: ReturnType<typeof startNativeConversationInboxHost> | undefined;
beforeEach(async () => {
  fixture = await openFixture('empty'); mock.db = fixture.db;
  fixture.sqlite.exec("INSERT INTO projects(id,name,path) VALUES('p','Fixture','/fixture'); INSERT INTO sessions(id,project_id) VALUES('s','p'),('second','p')");
});
afterEach(() => { host?.dispose(); host = undefined; fixture.close(); mock.db = undefined; });

it('does not create DMs or refresh conversation time at startup, even with historical native activity', async () => {
  fixture.sqlite.prepare('INSERT INTO kv(key,value,updated_at) VALUES(?,?,?)').run('native-conversation-activity:s', JSON.stringify({ text: 'Old personal reply', at: '2026-10-29T11:00:00Z', turnSeq: 0 }), 123);
  const open = vi.fn(async () => 'dm');
  host = startNativeConversationInboxHost({ open, failed: error => { throw error; } });
  await host.flush();
  expect(open).not.toHaveBeenCalled();
  expect(fixture.sqlite.prepare('SELECT updated_at FROM kv WHERE key = ?').get('native-conversation-activity:s')).toEqual({ updated_at: 123 });
});

it('opens one canonical address for an actual exchange and does not reopen it for later turns', async () => {
  queueNativeConversationInbox('s', fixture.db);
  const open = vi.fn(async () => 'dm');
  host = startNativeConversationInboxHost({ open, failed: error => { throw error; } });
  await host.flush();
  expect(open).toHaveBeenCalledExactlyOnceWith({ sessionId: 's', projectId: 'p' });
  expect(pendingNativeConversationInbox()).toEqual([]);
  expect(queueNativeConversationInbox('s', fixture.db)).toBe(false);
  publishNativeConversationInbox(); await host.flush();
  expect(open).toHaveBeenCalledTimes(1);
});

it('retains a failed explicit request and resumes it after restart without deriving new ones from history', async () => {
  queueNativeConversationInbox('s', fixture.db);
  const failed = vi.fn();
  host = startNativeConversationInboxHost({ open: async () => { throw new Error('offline'); }, failed });
  await host.flush(); await host.flush();
  expect(pendingNativeConversationInbox()).toEqual([{ sessionId: 's', projectId: 'p' }]);
  expect(failed).toHaveBeenCalledTimes(1);
  host.dispose();
  const open = vi.fn(async () => 'dm');
  host = startNativeConversationInboxHost({ open, failed });
  await host.flush();
  expect(open).toHaveBeenCalledExactlyOnceWith({ sessionId: 's', projectId: 'p' });
  expect(pendingNativeConversationInbox()).toEqual([]);
});

it('picks up a second personal conversation queued while the first address is opening', async () => {
  queueNativeConversationInbox('s', fixture.db);
  let release!: (value: string) => void;
  const open = vi.fn(({ sessionId }: { sessionId: string }) => sessionId === 's' ? new Promise<string>(resolve => { release = resolve; }) : Promise.resolve('dm-second'));
  host = startNativeConversationInboxHost({ open, failed: error => { throw error; } });
  queueNativeConversationInbox('second', fixture.db); publishNativeConversationInbox();
  release('dm'); await host.flush();
  expect(open.mock.calls.map(([target]) => target.sessionId)).toEqual(['s', 'second']);
  expect(pendingNativeConversationInbox()).toEqual([]);
});

it('does not recreate an agent address for a task deleted before its pending request could run', async () => {
  queueNativeConversationInbox('s', fixture.db);
  fixture.sqlite.prepare('DELETE FROM sessions WHERE id = ?').run('s');
  const open = vi.fn(async () => 'dm');
  host = startNativeConversationInboxHost({ open, failed: error => { throw error; } });
  await host.flush();
  expect(open).not.toHaveBeenCalled();
});
