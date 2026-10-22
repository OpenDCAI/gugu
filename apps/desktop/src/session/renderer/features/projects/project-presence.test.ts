import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  projects: new Map<string, unknown>(),
  pending: new Set<string>(),
  awaiting: false,
}));

vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: { projects: { projects: mocks.projects, pendingCreationIds: mocks.pending } },
}));
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({
  remoteHostsStore: { awaitsMachineLists: () => mocks.awaiting },
}));
vi.mock('@renderer/features/sessions/stores/session-selectors', () => ({ getSessionManagerStore: () => undefined }));
vi.mock('@renderer/features/sessions/leave-session-view', () => ({ sessionLeaveDestination: () => ({ viewId: 'home' }) }));
vi.mock('./components/project-view-wrapper', () => ({ ProjectViewWrapper: () => null }));
vi.mock('./components/main-panel/main-panel', () => ({ ProjectMainPanel: () => null }));
vi.mock('./components/project-titlebar', () => ({ ProjectTitlebar: () => null }));

const { projectPresence } = await import('./project-presence');
const { sessionViewCanActivate } = await import('@renderer/features/sessions/session-view-guard');
const { projectView } = await import('./view');

// Restoring the last view at boot: a project of another machine is not in the table yet — its list comes later.
// Only a project known to be deleted sends the person away.
describe('project presence: "not in the table yet" is not "deleted"', () => {
  beforeEach(() => {
    mocks.projects.clear();
    mocks.pending.clear();
    mocks.awaiting = false;
  });

  it('tells present, unknown and deleted apart', () => {
    mocks.projects.set('local', {});
    mocks.pending.add('being-created');
    expect(projectPresence('local')).toBe('present');
    expect(projectPresence('being-created')).toBe('present');
    expect(projectPresence('gone')).toBe('deleted');
    // other machines' lists not all in yet (the restore at boot, before the machine roster is attached)
    mocks.awaiting = true;
    expect(projectPresence('on-a-server')).toBe('unknown');
    expect(projectPresence('local')).toBe('present');
  });

  it('both guards let an unknown project through and send a deleted one home', () => {
    mocks.awaiting = true;
    expect(sessionViewCanActivate({ projectId: 'on-a-server', sessionId: 's' })).toEqual({ ok: true });
    expect(projectView.canActivate({ projectId: 'on-a-server' })).toEqual({ ok: true });
    mocks.awaiting = false;
    expect(sessionViewCanActivate({ projectId: 'gone', sessionId: 's' })).toEqual({ ok: false, redirect: 'home' });
    expect(projectView.canActivate({ projectId: 'gone' })).toEqual({ ok: false, redirect: 'home' });
  });
});
