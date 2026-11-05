import { describe, expect, it } from 'vitest';
import { createTabProvider, createTabRegistry } from './core/tab-provider-registry';
import type { TabHandle } from './core/tab-provider';
import { PaneStore } from './pane-store';

function setup() {
  const handles = new Map<string, TabHandle>();
  const provider = createTabProvider({ kind: 'page', resourceKey: (state: { id: string }) => state.id, initialize: (entry, handle) => { handles.set((entry.state as { id: string }).id, handle); return { dispose() {} }; }, dispose() {}, TabBarItem: () => null, TabBarItemDragPreview: () => null, TabContent: () => null });
  const pane = new PaneStore(createTabRegistry([provider]), { viewId: 'history-close' });
  pane.open('page', { id: 'folder' }, { intent: 'newTab' });
  const id = pane.resolvedActiveTabId!;
  return { pane, id, handles };
}

describe('page history is independent of closing and tab order', () => {
  it('back keeps the same context and forward pages', () => {
    const { pane, id } = setup();
    pane.navigate(id, 'page', { id: 'README' });
    pane.navigate(id, 'page', { id: 'config' });
    pane.go(id, -1);
    expect(pane.entries.get(id)?.state).toEqual({ id: 'README' });
    expect(pane.tabOrder).toEqual([id]);
    expect(pane.canGo(id, 1)).toBe(true);
    pane.goTo(id, 0);
    expect(pane.entries.get(id)?.state).toEqual({ id: 'folder' });
    pane.dispose();
  });
  it('closing an inactive tab does not navigate the visible context', () => {
    const { pane, id } = setup();
    pane.open('page', { id: 'other' }, { intent: 'newTab' });
    const other = pane.resolvedActiveTabId;
    pane.closeTab(id);
    expect(pane.resolvedActiveTabId).toBe(other);
    pane.dispose();
  });
  it('a stale page handle cannot close its replacement', async () => {
    const { pane, id, handles } = setup();
    const old = handles.get('folder')!;
    pane.navigate(id, 'page', { id: 'README' });
    await expect(old.close({ force: true })).resolves.toBe(false);
    expect(pane.entries.get(id)?.state).toEqual({ id: 'README' });
    pane.dispose();
  });
  it('a closed context reopens with its complete history and current index', () => {
    const { pane, id } = setup();
    pane.navigate(id, 'page', { id: 'README' });
    pane.closeTab(id);
    pane.reopenClosedTab();
    expect(pane.resolvedActiveTabId).toBe(id);
    pane.go(id, -1);
    expect(pane.entries.get(id)?.state).toEqual({ id: 'folder' });
    pane.dispose();
  });
});
