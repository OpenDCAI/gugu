import { afterEach, describe, expect, it } from 'vitest';
import { createTabProvider, createTabRegistry } from './core/tab-provider-registry';
import { PaneLayoutStore } from './pane-layout-store';

const layouts: PaneLayoutStore[] = [];
afterEach(() => layouts.splice(0).forEach((layout) => layout.dispose()));

function setup(viewId: string) {
  const provider = (kind: string) => createTabProvider({
    kind,
    resourceKey: (state: { path: string }) => state.path,
    initialize: () => ({ dispose() {} }),
    dispose() {},
    TabBarItem: () => null,
    TabBarItemDragPreview: () => null,
    TabContent: () => null,
  });
  const layout = new PaneLayoutStore(createTabRegistry([
    provider('conversation'), provider('folder'), provider('file'),
  ]), { viewId });
  layouts.push(layout);
  const pane = layout.focusedPane;
  const open = (kind: string, path: string, from: string | null, intent: string) => {
    // The same request reaches the old engine on the parent. It opens the file,
    // but loses the source navigation context: the assertion below must fail.
    const request = { from, intent } as unknown as Parameters<typeof layout.open>[2];
    layout.open(kind, { path }, request);
  };
  open('conversation', 'conversation', null, 'newTab');
  const conversation = pane.resolvedActiveTabId!;
  open('folder', '/', conversation, 'newTab');
  const folder = pane.resolvedActiveTabId!;
  return { layout, pane, open, conversation, folder };
}

describe.each(['task:v3', 'chat:direct-v3', 'chat:group-v3'])('v3 navigation in %s', (viewId) => {
  it('V1 keeps a separate folder tab, its order and layout when opening README inside it', () => {
    const { layout, pane, open, folder } = setup(viewId);
    const beforeIds = [...pane.tabOrder];
    const beforeLayout = JSON.stringify(layout.layout);
    open('file', 'README.md', folder, 'navigate');
    // Positive control: this is a parsed, registered file open, not a fixture error.
    expect([...pane.entries.values()].some((entry) =>
      (entry.state as { path: string }).path === 'README.md')).toBe(true);
    expect(pane.resolvedActiveTabId).toBe(folder);
    expect(pane.tabOrder).toEqual(beforeIds);
    expect(JSON.stringify(layout.layout)).toBe(beforeLayout);
    expect(pane.shownTabIds).toEqual([folder]);
  });

  it('keeps separate conversation and folder roots before navigation', () => {
    const { layout, pane, conversation, folder } = setup(viewId);
    expect(pane.tabOrder).toEqual([conversation, folder]);
    expect(pane.shownTabIds).toEqual([folder]);
    expect(layout.groups).toHaveLength(1);
  });
});
