import { describe, expect, it, vi } from 'vitest';
import { adoptLegacyScope, foldersInScope, selectedScope } from './project-device-scope';
import type { ProjectFoldersState, ShownFolder } from './project-folders';

const folder = (projectId: string): ShownFolder => ({ projectId, workspaceId: projectId, path: '/same/path', kind: 'root', branch: null, attachedAt: null, sessionIds: [], offline: projectId === 'remote', deviceId: projectId === 'remote' ? 'device-b' : null });
const local = folder('local');
const remote = folder('remote');
const state: ProjectFoldersState = { folders: [local, remote], chosen: local, fresh: undefined, loadError: false, unanswered: [], choose: vi.fn(), reload: vi.fn(), attach: vi.fn(), detach: vi.fn() };
const deviceOf = (id: string) => id === 'remote' ? 'device-b' : null;

describe('project device scope', () => {
  it('all devices includes devices subsequently linked to the project', () => {
    expect(selectedScope(null, ['local', 'device-b', 'device-c'])).toEqual(['local', 'device-b', 'device-c']);
    expect(selectedScope(['local'], ['local', 'device-b'])).toEqual(['local']);
  });
  it('discards stale device IDs without producing an unusable empty scope', () => {
    expect(selectedScope(['removed', 'device-b'], ['local', 'device-b'])).toEqual(['device-b']);
    expect(selectedScope(['removed'], ['device-b'])).toEqual(['device-b']);
  });
  it('a remote-only scope chooses that remote folder, including when it is offline', () => {
    const scoped = foldersInScope(state, ['device-b'], deviceOf);
    expect(scoped.folders).toEqual([remote]);
    expect(scoped.chosen).toBe(remote);
    expect(scoped.chosen?.offline).toBe(true);
    expect(state.folders).toEqual([local, remote]);
  });
  it('multiple devices retain the existing choice and each device’s identical path', () => {
    const scoped = foldersInScope(state, ['local', 'device-b'], deviceOf);
    expect(scoped.folders).toHaveLength(2);
    expect(scoped.chosen).toBe(local);
  });
  // PR4:文件夹按自己记着的那台机器分(folder.deviceId),❌ 拿 projectId 反查 —— 同一个本地项目 id 可能先后登记在两条设备行下。
  it('a folder is in scope by the device it was read from, whatever its project id maps to now', () => {
    const moved = { ...remote, projectId: 'local' };
    const scoped = foldersInScope({ ...state, folders: [local, moved] }, ['device-b'], () => null);
    expect(scoped.folders).toEqual([moved]);
  });
  it('the scope saved under the old row id is read once, moved to the project group key, and the old key dropped', () => {
    expect(adoptLegacyScope({ 'row-1': ['device-b'], other: null }, 'chat-1', 'row-1')).toEqual({ other: null, 'chat-1': ['device-b'] });
    // Already moved, nothing under the old key, or no group yet (same key): nothing to do.
    expect(adoptLegacyScope({ 'chat-1': ['local'], 'row-1': ['device-b'] }, 'chat-1', 'row-1')).toBeNull();
    expect(adoptLegacyScope({}, 'chat-1', 'row-1')).toBeNull();
    expect(adoptLegacyScope({ 'row-1': ['device-b'] }, 'row-1', 'row-1')).toBeNull();
  });
  it('a scoped device that has not answered yet is unknown (loading), not a device without folders', () => {
    const waiting = { ...state, folders: [local], chosen: local, unanswered: ['remote'] };
    expect(foldersInScope(waiting, ['device-b'], deviceOf).folders).toBeNull();
    // Another scoped device already has folders: show them, ❌ wait for every device.
    expect(foldersInScope(waiting, ['local', 'device-b'], deviceOf).folders).toEqual([local]);
    // Answered (or past the deadline) and still nothing in scope: that is a real empty scope.
    expect(foldersInScope({ ...waiting, unanswered: [] }, ['device-b'], deviceOf).folders).toEqual([]);
  });
});
