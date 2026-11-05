import { afterEach, describe, expect, it } from 'vitest';
import { createTabProvider, createTabRegistry } from './core/tab-provider-registry';
import { PaneLayoutStore } from './pane-layout-store';

const layouts: PaneLayoutStore[] = [];
afterEach(() => layouts.splice(0).forEach((layout) => layout.dispose()));

function setup(allowClose: () => boolean | Promise<boolean> = () => true) {
  const provider = (kind: string) => createTabProvider({
    kind,
    resourceKey: (state: { path: string }) => state.path,
    initialize: () => ({ dispose() {} }),
    dispose() {},
    onBeforeClose: allowClose,
    TabBarItem: () => null,
    TabBarItemDragPreview: () => null,
    TabContent: () => null,
  });
  const layout = new PaneLayoutStore(createTabRegistry([provider('folder'), provider('file')]), { viewId: 'history' });
  layouts.push(layout);
  layout.open('folder', { path: '/' }, { from: null, intent: 'newTab' });
  const pane = layout.focusedPane;
  const id = pane.resolvedActiveTabId!;
  const open = (path: string) => layout.open('file', { path }, { from: id, intent: 'navigate' });
  return { layout, pane, id, open };
}

describe('a tab owns its page history', () => {
  it('restores the folder state and discards forward pages after a different navigation', () => {
    const { pane, id, open } = setup();
    pane.setPageViewState(id, { scrollTop: 420, picked: ['config.json'], folder: 'docs' });
    open('README.md');
    open('config.json');
    pane.go(id, -1);
    expect(pane.entries.get(id)?.state).toEqual({ path: 'README.md' });
    pane.go(id, -1);
    expect(pane.navigationOf(id)?.pages[0].viewState).toEqual({ scrollTop: 420, picked: ['config.json'], folder: 'docs' });
    pane.go(id, 1);
    open('notes.md');
    expect(pane.navigationOf(id)?.pages.map((page) => page.state)).toEqual([{ path: '/' }, { path: 'README.md' }, { path: 'notes.md' }]);
    expect(pane.tabOrder).toEqual([id]);
  });

  it('persists history and index independently of provider state', () => {
    const { layout, pane, id, open } = setup();
    open('README.md');
    open('config.json');
    pane.go(id, -1);
    const saved = JSON.parse(JSON.stringify(layout.snapshot));
    layout.restoreSnapshot(saved);
    const restored = layout.focusedPane;
    expect(restored.entries.get(id)?.state).toEqual({ path: 'README.md' });
    expect(restored.navigationOf(id)?.index).toBe(1);
    restored.go(id, 1);
    expect(restored.entries.get(id)?.state).toEqual({ path: 'config.json' });
    restored.go(id, -1);
    restored.go(id, -1);
    expect(restored.entries.get(id)?.kind).toBe('folder');
  });

  it('keeps the page and forward history when an unsaved-change confirmation is refused', async () => {
    let proceed = true;
    const { pane, id, open } = setup(() => Promise.resolve(proceed));
    open('README.md');
    await Promise.resolve();
    proceed = false;
    open('config.json');
    await Promise.resolve();
    expect(pane.entries.get(id)?.state).toEqual({ path: 'README.md' });
    expect(pane.navigationOf(id)?.pages).toHaveLength(2);
    pane.go(id, -1);
    await Promise.resolve();
    expect(pane.entries.get(id)?.state).toEqual({ path: 'README.md' });
  });

  it('does not let a delayed confirmation replace a newer page', async () => {
    let confirm: ((proceed: boolean) => void) | undefined;
    const { pane, id, open } = setup(() => new Promise<boolean>((resolve) => { confirm = resolve; }));
    open('README.md');
    const first = confirm!;
    open('config.json');
    confirm!(true);
    await Promise.resolve();
    first(true);
    await Promise.resolve();
    expect(pane.entries.get(id)?.state).toEqual({ path: 'config.json' });
  });

  it('keeps the latest request even if the older confirmation finishes first', async () => {
    const confirmations: Array<(proceed: boolean) => void> = [];
    const { pane, id, open } = setup(() => new Promise<boolean>((resolve) => { confirmations.push(resolve); }));
    open('README.md');
    open('config.json');
    confirmations[0](true);
    await Promise.resolve();
    expect(pane.entries.get(id)?.state).toEqual({ path: '/' });
    confirmations[1](true);
    await Promise.resolve();
    expect(pane.entries.get(id)?.state).toEqual({ path: 'config.json' });
  });

  it('keeps persistent history when the current page is runtime-only', () => {
    const persistent = createTabProvider({ kind: 'persistent', resourceKey: (s: { path: string }) => s.path, initialize: () => ({ dispose() {} }), dispose() {}, TabBarItem: () => null, TabBarItemDragPreview: () => null, TabContent: () => null });
    const temporary = createTabProvider({ ...persistent, kind: 'temporary', isPersistent: () => false });
    const layout = new PaneLayoutStore(createTabRegistry([persistent, temporary]), { viewId: 'history-persistence' }); layouts.push(layout);
    layout.open('persistent', { path: 'folder' }, { from: null, intent: 'newTab' });
    const pane = layout.focusedPane; const id = pane.resolvedActiveTabId!;
    pane.navigate(id, 'temporary', { path: 'message' });
    expect(pane.snapshot.tabs).toHaveLength(1);
    expect(pane.snapshot.tabs[0]).toMatchObject({ extensionKind: 'persistent', state: { path: 'folder' }, history: { index: 0, pages: [{ kind: 'persistent', state: { path: 'folder' } }] } });
  });

  it('does not add duplicate history entries for the current resource', () => {
    const { pane, id, open } = setup();
    open('README.md');
    open('README.md');
    expect(pane.navigationOf(id)?.pages).toHaveLength(2);
  });

  it('tells each kind a tab held that the tab is gone on close, never on navigation', async () => {
    const closed: string[] = [];
    const provider = (kind: string) => createTabProvider({
      kind,
      resourceKey: (state: { path: string }) => state.path,
      initialize: () => ({ dispose() {} }),
      dispose() {},
      closed: (tabId: string) => { closed.push(`${kind}:${tabId}`); },
      TabBarItem: () => null,
      TabBarItemDragPreview: () => null,
      TabContent: () => null,
    });
    const layout = new PaneLayoutStore(createTabRegistry([provider('folder'), provider('file')]), { viewId: 'history-closed' });
    layouts.push(layout);
    layout.open('folder', { path: '/' }, { from: null, intent: 'newTab' });
    const pane = layout.focusedPane;
    const id = pane.resolvedActiveTabId!;
    layout.open('file', { path: 'README.md' }, { from: id, intent: 'navigate' });
    pane.go(id, -1);
    pane.go(id, 1);
    expect(closed).toEqual([]);
    pane.closeTab(id);
    expect(closed.sort()).toEqual([`file:${id}`, `folder:${id}`]);
  });
});
