import { afterEach, expect, it, vi } from 'vitest';
import { PaneLayoutStore } from '../tabs/pane-layout-store';
import { createTabProvider, createTabRegistry } from '../tabs/core/tab-provider-registry';

const state = vi.hoisted(() => ({ layout: null as PaneLayoutStore | null }));
vi.mock('./stores/session-selectors', () => ({
  getSessionPageStore: () => ({}), sessionViewKind: () => 'live',
  getSessionView: () => ({ paneLayout: state.layout }),
}));
vi.mock('./session-pane-ready', () => ({ sessionPaneReady: () => () => true }));
vi.mock('./offline-session-input-target', () => ({ offlineSessionInputTarget: () => false }));
vi.mock('./stores/session-registry', () => ({ sessionRegistry: { get: () => ({ sessions: new Map([['same-task', { data: { runtime: 'pty' } }]]) }) } }));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@renderer/localization/locale-store', () => ({ translateSessionMessage: (key: string) => key }));
import { openSessionInSessionWhenReady } from './open-session-in-session';

afterEach(() => { state.layout?.dispose(); state.layout = null; });
it('reopens the same task from another tab and pane without mounting a second terminal', () => {
  const initialize = vi.fn(() => ({ dispose() {} }));
  const provider = (kind: string) => createTabProvider({ kind, resourceKey: (s: { sessionId: string }) => s.sessionId, initialize, dispose() {}, TabBarItem: () => null, TabBarItemDragPreview: () => null, TabContent: () => null });
  const layout = state.layout = new PaneLayoutStore(createTabRegistry([provider('session'), provider('file')]), { viewId: 'same-task' });
  const task = layout.open('session', { sessionId: 'same-task' }, { from: null, intent: 'newTab' })!;
  const owner = layout.focusedPane;
  const file = layout.open('file', { sessionId: 'README' }, { from: null, intent: 'newTab' })!;
  layout.splitPane(layout.activePaneId, 'right', file);
  const ids = layout.groups.flatMap(({ pane }) => pane.tabOrder);
  const tree = JSON.stringify(layout.layout);
  const mounted = initialize.mock.calls.length;
  for (let n = 0; n < 4; n++) {
    layout.groups.find(({ pane }) => pane.entries.has(file))!.pane.setActiveTab(file);
    openSessionInSessionWhenReady({ projectId: 'project', sessionId: 'same-task' });
    expect(layout.groups.flatMap(({ pane }) => pane.tabOrder)).toEqual(ids);
    expect(layout.focusedPane).toBe(owner);
    expect(owner.resolvedActiveTabId).toBe(task);
    expect(JSON.stringify(layout.layout)).toBe(tree);
    expect(initialize.mock.calls.length).toBe(mounted);
  }
});
