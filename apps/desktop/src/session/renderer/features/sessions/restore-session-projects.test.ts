// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import type { NavigationSnapshot } from '@shared/view-state';

const state = vi.hoisted(() => ({
  session: { projectId: 'old', sessionId: 'assistant' },
  screen: null as unknown, save: vi.fn(async () => {}), update: vi.fn(), restore: vi.fn(), warn: vi.fn(),
  locations: vi.fn(async (_ids: string[]) => [{ conversationId: 'assistant', projectId: 'tasks' }]),
}));
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { navigation: {
  currentViewId: 'library',
  get viewParamsStore() { return { session: state.session }; }, updateViewParams: state.update,
} } }));
vi.mock('@renderer/app/screen-layout', () => ({ screenLayout: { get snapshot() { return state.screen; }, restore: state.restore } }));
vi.mock('@renderer/lib/ipc', () => ({ rpc: { viewState: { save: state.save } },
  rpcOn: () => ({ sessionTimeline: { sessionProjectLocations: state.locations } }),
}));
vi.mock('@renderer/utils/logger', () => ({ log: { warn: state.warn } }));

import { prepareSessionProjectRestore, readSavedSessionProjectLocations, reconcileSessionProjectLocations } from './restore-session-projects';

const locations = [{ conversationId: 'assistant', projectId: 'tasks' }];
const screen = () => ({ layout: { pane: 'first' }, focused: 'first', blocks: { first: { kind: 'session', sessionId: 'assistant', projectId: 'old' } } });
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks(); state.session = { projectId: 'old', sessionId: 'assistant' }; state.screen = screen();
});

it('queries only distinct saved navigation and layout session IDs rather than the session directory', async () => {
  localStorage.setItem('gugu.screen-layout.v1', JSON.stringify(screen()));
  await readSavedSessionProjectLocations({ currentViewId: 'session', viewParams: { session: state.session } });
  expect(state.locations).toHaveBeenCalledExactlyOnceWith(['assistant']);
});

it('does no session RPC for a cold start without saved task references', async () => {
  expect(await readSavedSessionProjectLocations(null)).toEqual([]);
  expect(state.locations).not.toHaveBeenCalled();
});

it('repairs the persisted navigation, cached task views and screen before cold restore', () => {
  const nav: NavigationSnapshot = { currentViewId: 'session', viewParams: { session: state.session } };
  localStorage.setItem('gugu.screen-layout.v1', JSON.stringify(screen()));
  const restored = prepareSessionProjectRestore(nav, { task: state.session }, locations);
  expect(restored.navigation?.viewParams.session).toEqual({ projectId: 'tasks', sessionId: 'assistant' });
  expect(restored.views.task).toEqual({ projectId: 'tasks', sessionId: 'assistant' });
  expect(state.save).toHaveBeenCalledWith('navigation', restored.navigation);
  expect(JSON.parse(localStorage.getItem('gugu.screen-layout.v1')!).blocks.first.projectId).toBe('tasks');
});

it('updates remote session references without changing which non-task page the person is reading', () => {
  reconcileSessionProjectLocations(locations);
  expect(state.update).toHaveBeenCalledWith('session', { projectId: 'tasks', sessionId: 'assistant' });
  expect(state.restore).toHaveBeenCalledWith(expect.objectContaining({ blocks: { first: { kind: 'session', projectId: 'tasks', sessionId: 'assistant' } } }));
});

it('does not let an unreadable screen snapshot prevent restoring a known task', () => {
  localStorage.setItem('gugu.screen-layout.v1', 'invalid');
  const restored = prepareSessionProjectRestore({ currentViewId: 'session', viewParams: { session: state.session } }, {}, locations);
  expect(restored.navigation?.viewParams.session).toEqual({ projectId: 'tasks', sessionId: 'assistant' });
  expect(state.warn).toHaveBeenCalledOnce();
});
