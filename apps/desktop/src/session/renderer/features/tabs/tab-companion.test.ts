import { afterEach, describe, expect, it } from 'vitest';
import { createTabProvider, createTabRegistry } from './core/tab-provider-registry';
import { PaneLayoutStore } from './pane-layout-store';
import { accountTabPlacementMemory, type TabPlacementMemory } from './tab-placement-memory';

const layouts: PaneLayoutStore[] = [];
afterEach(() => layouts.splice(0).forEach((layout) => layout.dispose()));

function setup(memory: TabPlacementMemory = { read: () => undefined, write() {} }) {
  const provider = (kind: string) => createTabProvider({
    kind,
    conversation: kind === 'conversation',
    resourceKey: (state: { path: string }) => state.path,
    initialize: () => ({ dispose() {} }),
    dispose() {},
    TabBarItem: () => null,
    TabBarItemDragPreview: () => null,
    TabContent: () => null,
  });
  const layout = new PaneLayoutStore(createTabRegistry([provider('conversation'), provider('file'), provider('folder')]), { viewId: 'companion' }, undefined, { placementMemory: memory });
  layouts.push(layout);
  layout.open('conversation', { path: 'conversation' }, { from: null, intent: 'newTab' });
  const conversation = layout.focusedPane.resolvedActiveTabId!;
  const conversationPane = layout.focusedPane;
  const open = (path: string, intent: 'navigate' | 'newTab' | 'beside' = 'navigate') => layout.open('file', { path }, { from: conversation, intent });
  return { layout, conversation, conversationPane, open };
}

describe('a conversation explicitly owns its companion pane', () => {
  it('reuses one pane and one navigation context, clears a closed companion and recreates it', () => {
    const { layout, conversation, conversationPane, open } = setup();
    open('A.md');
    const firstPane = layout.focusedPane;
    const tabId = firstPane.resolvedActiveTabId!;
    const companion = conversationPane.entries.get(conversation)?.companionPaneId;
    expect(layout.groups).toHaveLength(2);
    expect(companion).toBe(layout.activePaneId);
    open('B.md');
    expect(layout.groups).toHaveLength(2);
    expect(firstPane.tabOrder).toEqual([tabId]);
    expect(firstPane.entries.get(tabId)?.state).toEqual({ path: 'B.md' });
    firstPane.go(tabId, -1);
    expect(firstPane.entries.get(tabId)?.state).toEqual({ path: 'A.md' });
    layout.closePane(companion!);
    expect(conversationPane.entries.get(conversation)?.companionPaneId).toBeUndefined();
    open('C.md');
    expect(layout.groups).toHaveLength(2);
    expect(layout.activePaneId).not.toBe(companion);
  });

  it('degrades into a new tab when narrow and does not split on widening', () => {
    const { layout, conversationPane, open } = setup();
    conversationPane.setDimensions(390, 620);
    const tree = JSON.stringify(layout.layout);
    open('A.md');
    expect(layout.groups).toHaveLength(1);
    expect(conversationPane.tabOrder).toHaveLength(2);
    conversationPane.setDimensions(1280, 900);
    expect(JSON.stringify(layout.layout)).toBe(tree);
    expect(layout.groups).toHaveLength(1);
  });

  it('new-tab intent overrides a remembered beside placement', () => {
    const { layout, conversationPane, open } = setup({ read: () => 'beside', write() {} });
    open('A.md', 'newTab');
    expect(layout.groups).toHaveLength(1);
    expect(conversationPane.tabOrder).toHaveLength(2);
  });

  it('a remembered separate placement suppresses conversation splitting', () => {
    const { layout, conversationPane, open } = setup({ read: () => 'separate', write() {} });
    open('A.md');
    expect(layout.groups).toHaveLength(1);
    expect(conversationPane.tabOrder).toHaveLength(2);
  });
});

it('persists only the shape, isolates accounts and does no storage work during construction', () => {
  const values = new Map<string, string>();
  let account = 'A';
  let reads = 0;
  const storage = { getItem: (key: string) => { reads++; return values.get(key) ?? null; }, setItem: (key: string, value: string) => { values.set(key, value); } };
  const memory = accountTabPlacementMemory(() => account, () => storage);
  expect(reads).toBe(0);
  memory.write('folder:/docs', 'separate');
  account = 'B';
  expect(memory.read('folder:/docs')).toBeUndefined();
  memory.write('folder:/docs', 'beside');
  account = 'A';
  expect(memory.read('folder:/docs')).toBe('separate');
  const restarted = accountTabPlacementMemory(() => account, () => storage);
  expect(restarted.read('folder:/docs')).toBe('separate');
  expect([...values.values()].map((value) => JSON.parse(value))).toEqual([{ 'folder:/docs': 'separate' }, { 'folder:/docs': 'beside' }]);
});
