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

  it('does not add duplicate history entries for the current resource', () => {
    const { pane, id, open } = setup();
    open('README.md');
    open('README.md');
    expect(pane.navigationOf(id)?.pages).toHaveLength(2);
  });
});
