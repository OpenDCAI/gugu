import { describe, expect, it, vi } from 'vitest';
import { foldersInScope, selectedScope } from './project-device-scope';
import type { ProjectFoldersState, ShownFolder } from './project-folders';

const folder = (projectId: string): ShownFolder => ({ projectId, workspaceId: projectId, path: '/same/path', kind: 'root', branch: null, attachedAt: null, sessionIds: [], offline: projectId === 'remote' });
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
  it('a scoped device that has not answered yet is unknown (loading), not a device without folders', () => {
    const waiting = { ...state, folders: [local], chosen: local, unanswered: ['remote'] };
    expect(foldersInScope(waiting, ['device-b'], deviceOf).folders).toBeNull();
    // Another scoped device already has folders: show them, ❌ wait for every device.
    expect(foldersInScope(waiting, ['local', 'device-b'], deviceOf).folders).toEqual([local]);
    // Answered (or past the deadline) and still nothing in scope: that is a real empty scope.
    expect(foldersInScope({ ...waiting, unanswered: [] }, ['device-b'], deviceOf).folders).toEqual([]);
  });
});
