import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTabProvider, createTabRegistry } from './core/tab-provider-registry';
import { PaneLayoutStore } from './pane-layout-store';
import { tabFullscreen } from './tab-fullscreen';

const layouts: PaneLayoutStore[] = [];
afterEach(() => { tabFullscreen.exit(); layouts.splice(0).forEach((layout) => layout.dispose()); });
function setup() {
  const initialize = vi.fn(() => ({ dispose: vi.fn() }));
  const dispose = vi.fn();
  const provider = (kind: string) => createTabProvider({ kind, conversation: kind === 'chat', resourceKey: (s: { id: string }) => s.id, initialize, dispose, TabBarItem: () => null, TabBarItemDragPreview: () => null, TabContent: () => null });
  const memory = new Map<string, 'separate' | 'beside'>();
  const layout = new PaneLayoutStore(createTabRegistry(['chat', 'folder', 'file', 'term'].map(provider)), { viewId: 'layout-v3' }, undefined, { placementMemory: { read: (id) => memory.get(id), write: (id, value) => memory.set(id, value) } });
  layouts.push(layout);
  const chat = layout.open('chat', { id: 'conversation' }, { from: null, intent: 'newTab' })!;
  const folder = layout.open('folder', { id: '/' }, { from: chat, intent: 'newTab' })!;
  return { layout, pane: layout.focusedPane, chat, folder, initialize, dispose, memory };
}

describe('real pane navigation and placement', () => {
  it('inserts only the explicitly requested new tab after its source', () => {
    const { layout, pane, folder } = setup();
    const terminal = layout.open('term', { id: 'shell' }, { from: null, intent: 'newTab' })!;
    const file = layout.open('file', { id: 'README.md' }, { from: folder, intent: 'newTab' })!;
    expect(pane.tabOrder).toEqual([pane.tabOrder[0], folder, file, terminal]);
    expect(pane.entries.get(folder)?.kind).toBe('folder');
    expect(layout.groups).toHaveLength(1);
  });
  it('opening the same resource explicitly creates independent navigation contexts', () => {
    const { layout, pane, folder } = setup();
    const first = layout.open('file', { id: 'README.md' }, { from: folder, intent: 'newTab' });
    const second = layout.open('file', { id: 'README.md' }, { from: folder, intent: 'newTab' });
    expect(first).not.toBe(second);
    pane.go(first!, -1);
    expect(pane.resolvedActiveTabId).toBe(folder);
    expect(pane.entries.get(second!)?.state).toEqual({ id: 'README.md' });
  });
  it('a stale origin cannot navigate whichever page happens to have focus', () => {
    const { layout } = setup();
    const before = JSON.stringify(layout.snapshot);
    expect(layout.open('file', { id: 'README.md' }, { from: 'closed-source', intent: 'navigate' })).toBeUndefined();
    expect(JSON.stringify(layout.snapshot)).toBe(before);
  });
  it('dragging moves one resource without initialize/dispose into the side of the pair', () => {
    const { layout, pane, folder, chat, initialize, dispose } = setup();
    const resource = pane._resources.get(folder);
    initialize.mockClear(); dispose.mockClear();
    expect(layout.splitPane(layout.activePaneId, 'right', folder)).toBe(true);
    expect(layout.groups).toHaveLength(2);
    expect(layout.pair).toEqual({ pinned: chat, side: folder });
    expect(layout.focusedPane._resources.get(folder)).toBe(resource);
    expect(initialize).not.toHaveBeenCalled(); expect(dispose).not.toHaveBeenCalled();
  });
  it('narrowing and widening change visibility without changing tree, order or histories', () => {
    const { layout, folder } = setup();
    layout.splitPane(layout.activePaneId, 'right', folder);
    layout.setViewActive(true);
    const before = JSON.stringify(layout.snapshot);
    layout.setNarrow(true);
    expect(layout.groups.filter(({ pane }) => pane.isVisible)).toHaveLength(1);
    layout.setNarrow(false);
    expect(layout.groups.every(({ pane }) => pane.isVisible)).toBe(true);
    expect(JSON.stringify(layout.snapshot)).toBe(before);
  });
  it('fullscreen preserves the actual split and history', () => {
    const { layout, folder } = setup();
    layout.splitPane(layout.activePaneId, 'right', folder);
    const before = JSON.stringify(layout.snapshot);
    tabFullscreen.toggle(layout.focusedPane, folder);
    tabFullscreen.exit();
    expect(JSON.stringify(layout.snapshot)).toBe(before);
  });
  it('the page opened beside the conversation in full screen: going back leaves full screen, focus on the conversation', async () => {
    const { layout, chat } = setup();
    const file = layout.open('file', { id: 'notes.md' }, { from: chat, intent: 'newTab' })!;
    layout.splitPane(layout.activePaneId, 'right', file);
    const side = layout.groups.find(({ pane }) => pane.entries.has(file))!.pane;
    side.tabFill(file)!.toggle();
    expect(tabFullscreen.isOn(side, file)).toBe(true);
    expect(await side.go(file, -1)).toBe(true);
    expect(tabFullscreen.target).toBeNull();
    expect(layout.focusedPane.entries.has(chat)).toBe(true);
  });
  it('full screen on a page ends when another page of the layout is brought forward, whichever pane held the focus before', () => {
    const { layout, chat } = setup();
    const file = layout.open('file', { id: 'notes.md' }, { from: chat, intent: 'newTab' })!;
    layout.splitPane(layout.activePaneId, 'right', file);
    const side = layout.groups.find(({ pane }) => pane.entries.has(file))!.pane;
    const main = layout.groups.find(({ pane }) => pane.entries.has(chat))!.pane;
    layout.setActiveGroup(layout.groups.find(({ pane }) => pane === main)!.paneId);
    side.tabFill(file)!.toggle();
    expect(tabFullscreen.isOn(side, file)).toBe(true);
    main.setActiveTab(chat);
    expect(tabFullscreen.target).toBeNull();
  });
  it('a detached context keeps its resource and history when returned', () => {
    const { layout, pane, folder } = setup();
    layout.open('file', { id: 'README.md' }, { from: folder, intent: 'navigate' });
    const resource = pane._resources.get(folder);
    const windowPane = layout.detachToWindow(folder)!;
    expect(layout.windowPanes.get(windowPane)?.pane._resources.get(folder)).toBe(resource);
    layout.returnFromWindow(windowPane);
    const restored = layout.groups.find(({ pane }) => pane.entries.has(folder))!.pane;
    restored.go(folder, -1);
    expect(restored.entries.get(folder)?.kind).toBe('folder');
  });
  it('a legacy companion field in a save is ignored', () => {
    const { layout, chat } = setup();
    const saved = JSON.parse(JSON.stringify(layout.snapshot));
    saved.groups[0].tabManager.tabs[0].companionPaneId = 'removed-pane';
    layout.restoreSnapshot(saved);
    expect(layout.groups).toHaveLength(1);
    expect(JSON.stringify(layout.snapshot)).not.toContain('companionPaneId');
    expect(layout.focusedPane.entries.has(chat)).toBe(true);
  });
});
