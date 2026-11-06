// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Real navigation, screen layout and screen actions; only the project's own stores and row chrome are stand-ins.
vi.mock('@renderer/lib/layout/navigation-provider', async () => {
  const { appState } = await import('@renderer/lib/stores/app-state');
  return {
    useNavigate: () => ({ navigate: appState.navigation.navigate.bind(appState.navigation) }),
    useWorkspaceSlots: () => ({ currentView: appState.navigation.currentViewId }),
    useParams: (view: string) => ({ params: (appState.navigation.viewParamsStore as Record<string, unknown>)[view] ?? {} }),
  };
});
vi.mock('@renderer/features/projects/hooks/use-confirm-delete-project', () => ({ useConfirmDeleteProject: () => vi.fn() }));
vi.mock('@renderer/features/projects/stores/project', () => ({ isUnregisteredProject: () => false }));
vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  getProjectStore: () => ({ id: 'trial', name: 'Trial', state: 'mounted', data: { path: '/trial' } }),
  getGitRepositoryStore: () => null, projectViewKind: () => 'ready',
}));
vi.mock('@renderer/features/projects/project-presence', () => ({ projectPresence: () => 'present' }));
vi.mock('@/components/chat/ProjectRowContextMenu', () => ({ ProjectRowContextMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('./project-row-parts', () => ({ ProjectNeedsYouDot: () => null, ProjectRowTitle: ({ name }: { name: string }) => <span>{name}</span> }));
vi.mock('./sidebar-list-switch', () => ({ SidebarUnreadCount: () => null }));
vi.mock('./use-session-drop-target', () => ({ useSessionDropTarget: () => ({ bind: () => ({}) }) }));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));

import { appState } from '@renderer/lib/stores/app-state';
import { screenLayout } from '@renderer/app/screen-layout';
import { ensureScreenLayoutSync } from '@renderer/app/screen-layout-actions';
import { SidebarProjectItem } from './project-item';

it('a project row click puts the project block on screen even when navigation already names that project', async () => {
  for (const view of ['home', 'project', 'session', 'chat', 'screen'] as const) appState.navigation.registerView(view);
  ensureScreenLayoutSync();
  appState.navigation.navigate('project', { projectId: 'trial' });
  // Navigation and screen disagree: navigation is on the project while only one of its sessions fills the screen.
  screenLayout.show({ kind: 'session', projectId: 'trial', sessionId: 'dsh-1' });
  expect(appState.navigation.currentViewId).toBe('project');
  expect(screenLayout.blocks.get(screenLayout.focusedBlockId!)).toEqual({ kind: 'session', projectId: 'trial', sessionId: 'dsh-1' });

  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<SidebarProjectItem projectId="trial" />));
    const row = host.querySelector('[data-project-row="trial"]') as HTMLElement;
    // The row does not claim to be what is on screen.
    expect(row.hasAttribute('data-active')).toBe(false);
    await act(async () => row.click());
    expect(screenLayout.blocks.get(screenLayout.focusedBlockId!)).toEqual({ kind: 'project', projectId: 'trial' });
    expect(appState.navigation.currentViewId).toBe('project');
    expect(row.hasAttribute('data-active')).toBe(true);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
