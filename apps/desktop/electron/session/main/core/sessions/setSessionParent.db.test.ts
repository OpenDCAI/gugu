import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract';

/**
 * 改父会话(session_set_parent)打在真 SQLite 上:本机拖本机不等别的机器 —— 一台标成在线、实际不回话的
 * 机器会让每次都白等它超时(12–60 s)。只有父会话不在本机、或往上走出了本机,才问别的机器。
 */
const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const { resolveSessionParent, setOtherMachines, setSessionParent } = await import('./session-family');

describe('setSessionParent asks other machines only when this one cannot answer', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  const sessions = vi.fn();
  const insert = (id: string, parent: string | null = null, remoteParent?: string) =>
    fixture.sqlite
      .prepare(`INSERT INTO sessions (id, project_id, title, runtime, parent_session_id, config) VALUES (?, 'p1', ?, 'acp', ?, ?)`)
      .run(id, id, parent, remoteParent ? JSON.stringify({ version: '1', type: 'acp', parentRemote: { deviceId: 'dev-b', sessionId: remoteParent } }) : null);
  const parentOf = (id: string) => (fixture.sqlite.prepare(`SELECT parent_session_id FROM sessions WHERE id = ?`).get(id) as { parent_session_id: string | null }).parent_session_id;
  const remote = (id: string, parent: string | null) =>
    ({ deviceId: 'dev-b', label: 'Studio Mac', session: { conversationId: id, projectId: 'p-b', parentConversationId: parent } as SessionpageSessionSummary });

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    fixture.sqlite.prepare(`INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/repo')`).run();
    sessions.mockReset();
    sessions.mockResolvedValue({ sessions: [], unreached: [{ deviceId: 'dev-c', label: 'Silent Mac', detail: 'no answer' }] });
    setOtherMachines({ devices: async () => [], isThisDevice: async () => false, appSpawn: vi.fn(), sessions, archive: vi.fn(),
      appMessage: vi.fn(), appCall: vi.fn() });
  });
  afterEach(() => {
    setOtherMachines(null);
    fixture.close();
    mocks.db = undefined;
  });

  it('nests under a local parent whose chain is local, and moves back to the root, without asking anyone', async () => {
    insert('grand'); insert('mid', 'grand'); insert('child');
    expect(await setSessionParent('child', 'mid')).toEqual({ parent_session_id: 'mid', not_reached: [] });
    expect(parentOf('child')).toBe('mid');
    expect(await setSessionParent('child', null)).toEqual({ parent_session_id: null, not_reached: [] });
    expect(parentOf('child')).toBeNull();
    // A cycle the local rows show is refused locally too.
    await expect(setSessionParent('grand', 'mid')).rejects.toThrow(/session:mid is under session:grand/);
    expect(sessions).not.toHaveBeenCalled();
  });

  it('asks the other machines when the parent is not here, or its chain leaves this machine', async () => {
    insert('child'); insert('local-under-remote', null, 'b-parent');
    sessions.mockResolvedValue({ sessions: [remote('b-parent', null), remote('b-top', null)], unreached: [] });
    expect(await setSessionParent('child', 'b-top')).toEqual({ parent_session_id: 'b-top', not_reached: [] });
    expect(await setSessionParent('child', 'local-under-remote')).toEqual({ parent_session_id: 'local-under-remote', not_reached: [] });
    expect(sessions).toHaveBeenCalledTimes(2);
  });

  it('a parent found nowhere still names the machines that were not reached', async () => {
    insert('child');
    await expect(setSessionParent('child', 'missing')).rejects.toThrow('parent session not found on any of your machines (not reached: Silent Mac)');
    expect(sessions).toHaveBeenCalledOnce();
  });

  it('resolves a parent for a not-yet-created child without changing rows', async () => {
    insert('parent');
    expect(await resolveSessionParent(undefined, 'parent')).toEqual({ parent: { localSessionId: 'parent' }, not_reached: [] });
    expect(await resolveSessionParent(undefined, null)).toEqual({ parent: null, not_reached: [] });
    expect(fixture.sqlite.prepare('SELECT id, parent_session_id FROM sessions').all()).toEqual([{ id: 'parent', parent_session_id: null }]);
    expect(sessions).not.toHaveBeenCalled();
  });

  it('uses the same self and ancestor-cycle checks for a reserved child id before creation', async () => {
    insert('reserved'); insert('descendant', 'reserved');
    await expect(resolveSessionParent('reserved', 'reserved')).rejects.toThrow('a session cannot be its own parent');
    await expect(resolveSessionParent('reserved', 'descendant')).rejects.toThrow('session:descendant is under session:reserved');
    expect(parentOf('reserved')).toBeNull();
    expect(sessions).not.toHaveBeenCalled();
  });

  it('preserves the existing warning when a selected parent has an unreachable ancestor', async () => {
    sessions.mockResolvedValue({ sessions: [remote('remote-parent', 'offline-ancestor')], unreached: [{ deviceId: 'dev-c', label: 'Silent Mac', detail: 'no answer' }] });
    expect(await resolveSessionParent(undefined, 'remote-parent')).toEqual({
      parent: { deviceId: 'dev-b', sessionId: 'remote-parent' }, not_reached: ['Silent Mac'],
    });
    expect(fixture.sqlite.prepare('SELECT id FROM sessions').all()).toEqual([]);
  });
});
