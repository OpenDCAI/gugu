import { beforeEach, describe, expect, it, vi } from 'vitest';

const opened = vi.hoisted(() => ({ screen: true, beside: vi.fn(), ready: vi.fn(), navigate: vi.fn() }));
vi.mock('@renderer/app/screen-layout-actions', () => ({
  isScreenView: () => opened.screen,
  showSessionBeside: opened.beside,
  showBesideOnScreen: vi.fn(),
  showOnScreen: vi.fn(),
}));
vi.mock('@renderer/features/sessions/open-session-in-session', () => ({ openSessionInSessionWhenReady: opened.ready }));
vi.mock('@renderer/features/projects/stores/project-groups-store', () => ({ projectGroupsStore: { projectOfChat: () => null } }));
vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: { navigation: { currentViewId: 'screen', navigate: opened.navigate } },
  sidebarStore: { rowProjectIdOf: (id: string) => id },
}));

import { openSessionOnScreen } from './open-chat';

const session = { projectId: 'p', sessionId: 's' };
beforeEach(() => { vi.clearAllMocks(); opened.screen = true; });

describe('opening a task from the shell', () => {
  it('places a side-by-side block only once the task can be opened, so a task that never gets ready leaves no empty block', () => {
    openSessionOnScreen(session, true);
    expect(opened.beside).not.toHaveBeenCalled();
    expect(opened.ready).toHaveBeenCalledExactlyOnceWith({ ...session, onReady: expect.any(Function) });
    opened.ready.mock.calls[0][0].onReady();
    expect(opened.beside).toHaveBeenCalledExactlyOnceWith(session);
    expect(opened.navigate).not.toHaveBeenCalled();
  });

  it('navigates a plain click right away; the task page shows its own readiness', () => {
    openSessionOnScreen(session, false);
    expect(opened.navigate).toHaveBeenCalledExactlyOnceWith('session', session);
    expect(opened.ready).toHaveBeenCalledExactlyOnceWith(session);
    expect(opened.beside).not.toHaveBeenCalled();
  });
});
