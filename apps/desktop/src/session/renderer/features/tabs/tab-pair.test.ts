import { afterEach, describe, expect, it } from 'vitest';
import { createTabProvider, createTabRegistry } from './core/tab-provider-registry';
import { PaneLayoutStore } from './pane-layout-store';
import { accountTabPlacementMemory, type TabPlacementMemory } from './tab-placement-memory';

// spec session-page「并排」+ owner 11-05 (msg:ca5125c2 / 55f789f7 / 374b785d / 00b090e9): one session = one tab strip;
// side by side = a pair in that strip; closing what pushed a page out brings it back.

const layouts: PaneLayoutStore[] = [];
afterEach(() => layouts.splice(0).forEach((layout) => layout.dispose()));

type Layout = PaneLayoutStore;

function setup(memory: TabPlacementMemory = { read: () => undefined, write() {} }) {
  const provider = (kind: string) => createTabProvider({
    kind,
    conversation: kind === 'conversation' || kind === 'topic',
    resourceKey: (state: { path: string }) => state.path,
    initialize: () => ({ dispose() {} }),
    dispose() {},
    TabBarItem: () => null,
    TabBarItemDragPreview: () => null,
    TabContent: () => null,
  });
  const layout = new PaneLayoutStore(createTabRegistry(['conversation', 'topic', 'file', 'folder'].map(provider)), { viewId: 'pair' }, undefined, { placementMemory: memory });
  layouts.push(layout);
  const conversation = layout.open('conversation', { path: 'conversation' }, { from: null, intent: 'newTab' })!;
  const open = (path: string, from = conversation, intent: 'navigate' | 'newTab' | 'beside' = 'navigate', kind = 'file') =>
    layout.open(kind, { path }, { from, intent })!;
  return { layout, conversation, open };
}

const pathOf = (layout: Layout, tabId: string) =>
  (layout.groups.map(({ pane }) => pane.entries.get(tabId)).find(Boolean)?.state as { path: string } | undefined)?.path;
const paths = (layout: Layout) => {
  const pair = layout.pair;
  return pair ? [pathOf(layout, pair.pinned), pathOf(layout, pair.side)] : [pathOf(layout, layout.mainGroup.pane.resolvedActiveTabId!)];
};
const close = (layout: Layout, tabId: string) => layout.groups.find(({ pane }) => pane.entries.has(tabId))!.pane.closeTab(tabId);
/** A click on a tab of the strip: it is brought forward by the pane that holds it. */
const activate = (layout: Layout, tabId: string) => layout.groups.find(({ pane }) => pane.entries.has(tabId))?.pane.setActiveTab(tabId);

/** The invariants of the model: one strip (the main pane's), at most one pair, the side pane holds exactly the side. */
function expectOneStrip(layout: Layout): void {
  expect(layout.groups.length).toBeLessThanOrEqual(2);
  const strips = layout.groups.filter(({ pane }) => !pane.isPairSide);
  expect(strips).toHaveLength(1);
  if (layout.groups.length === 2) {
    expect(layout.sideGroup!.pane.tabOrder.length).toBeGreaterThan(0);
    expect(layout.pair).not.toBeNull();
    expect(layout.stripTabIds.slice(layout.stripTabIds.indexOf(layout.pair!.pinned), layout.stripTabIds.indexOf(layout.pair!.pinned) + 2)).toEqual([layout.pair!.pinned, layout.pair!.side]);
  } else {
    expect(layout.sidePaneId).toBeNull();
  }
  const all = layout.groups.flatMap(({ pane }) => pane.tabOrder);
  expect(new Set(all).size).toBe(all.length);
}

describe('every side-by-side entry ends in one strip with one pair', () => {
  it('opening from the conversation pairs with it; a second one replaces the side, which goes back to the strip', () => {
    const { layout, conversation, open } = setup();
    const a = open('A.md');
    expect(layout.pair).toEqual({ pinned: conversation, side: a });
    const b = open('B.md');
    expect(layout.pair).toEqual({ pinned: conversation, side: b });
    expect(layout.stripTabIds).toEqual([conversation, b, a]);
    expectOneStrip(layout);
  });

  it('already open: shown again, never a second tab', () => {
    const { layout, open } = setup();
    const a = open('A.md');
    open('B.md');
    expect(open('A.md')).toBe(a);
    expect(layout.groups.flatMap(({ pane }) => pane.tabOrder)).toHaveLength(3);
    expect(paths(layout)).toEqual(['conversation', 'A.md']);
    expectOneStrip(layout);
  });

  it('clicking an ordinary tab of the strip replaces the side; the pinned page stays', () => {
    const { layout, conversation, open } = setup();
    const a = open('A.md');
    open('B.md');
    activate(layout, a);
    expect(layout.pair).toEqual({ pinned: conversation, side: a });
    expectOneStrip(layout);
  });

  it('向右分 / ⌘\\ pair the tab in front with the page looked at before it; ⌘\\ again separates', () => {
    const { layout, conversation, open } = setup();
    const folder = open('/', conversation, 'newTab', 'folder');
    activate(layout, folder);
    layout.splitRight();
    expect(layout.pair).toEqual({ pinned: conversation, side: folder });
    layout.splitRight();
    expect(layout.pair).toBeNull();
    expect(layout.mainGroup.pane.resolvedActiveTabId).toBe(folder);
    expectOneStrip(layout);
  });

  it('a page opened inside a paired page navigates in place, in its half', () => {
    const { layout, conversation, open } = setup();
    const folder = open('/', conversation, 'navigate', 'folder');
    const file = layout.open('file', { path: 'README.md' }, { from: folder, intent: 'navigate' });
    expect(file).toBe(folder);
    expect(paths(layout)).toEqual(['conversation', 'README.md']);
    expectOneStrip(layout);
  });

  it('narrow: the pair stays (only what is shown changes), widening shows it again', () => {
    const { layout, open } = setup();
    open('A.md');
    layout.setViewActive(true);
    const before = JSON.stringify(layout.snapshot);
    layout.setNarrow(true);
    expect(layout.groups.filter(({ pane }) => pane.isVisible)).toHaveLength(1);
    layout.setNarrow(false);
    expect(JSON.stringify(layout.snapshot)).toBe(before);
    expectOneStrip(layout);
  });

  it('a topic opens beside its group; a file from the topic pushes the group out: [topic | file]', () => {
    const { layout, conversation, open } = setup();
    const topic = open('topic-1', conversation, 'navigate', 'topic');
    expect(layout.pair).toEqual({ pinned: conversation, side: topic });
    const file = open('A.md', topic);
    expect(layout.pair).toEqual({ pinned: topic, side: file });
    expect(layout.stripTabIds).toContain(conversation);
    expectOneStrip(layout);
  });

  it('a companion file goes back to its conversation without discarding either tab', async () => {
    const { layout, conversation, open } = setup();
    const file = open('report.md');
    const side = layout.sideGroup!.pane;
    expect(side.entries.get(file)?.openerTabId).toBe(conversation);
    await expect(side.go(file, -1)).resolves.toBe(true);
    expect(layout.focusedPane).toBe(layout.mainGroup.pane);
    expect(layout.pair).toEqual({ pinned: conversation, side: file });
  });
});

describe('separate wins when anything says so (owner 11-05 §6.3)', () => {
  it('records a background pair while another page stays in front', () => {
    const { layout, conversation, open } = setup();
    const other = open('terminal', conversation, 'newTab');
    const output = layout.open('file', { path: 'output.md' }, { from: conversation, intent: 'beside', activate: false });
    expect(layout.pair).toEqual({ pinned: conversation, side: output });
    expect(layout.isPairVisible).toBe(false);
    expect(layout.groups).toHaveLength(1);
    expect(layout.stripTabIds.slice(0, 2)).toEqual([conversation, output]);
    expect(layout.focusedPane.resolvedActiveTabId).toBe(other);
  });

  it('keeps the viewed side of an existing pair when a background request arrives', () => {
    const { layout, conversation, open } = setup();
    const viewed = open('terminal');
    const side = layout.sideGroup!;
    const tree = layout.layout;
    const output = layout.open('file', { path: 'output.md' }, { from: conversation, intent: 'beside', activate: false });
    expect(layout.pair).toEqual({ pinned: conversation, side: output });
    expect(layout.sideGroup).toBe(side);
    expect(layout.sideGroup!.pane.resolvedActiveTabId).toBe(viewed);
    expect(side.pane.resolvedTabs.find((tab) => tab.tabId === viewed)?.pairRole).toBeUndefined();
    expect(layout.layout).toBe(tree);
    expect(layout.focusedPane.resolvedActiveTabId).toBe(viewed);
  });

  it('a page remembered as separate opens as a tab', () => {
    const { layout, open } = setup({ read: () => 'separate', write() {} });
    open('A.md');
    expect(layout.pair).toBeNull();
    expect(layout.mainGroup.pane.tabOrder).toHaveLength(2);
  });

  it('拆开 = this session stops pairing until the user splits again', () => {
    const { layout, open } = setup();
    open('A.md');
    layout.mainGroup.pane.separatePair();
    expect(layout.pair).toBeNull();
    const b = open('B.md');
    expect(layout.pair).toBeNull();
    expect(layout.mainGroup.pane.resolvedActiveTabId).toBe(b);
    layout.mainGroup.pane.splitTab(b);
    expect(layout.pairDeclined).toBe(false);
    open('C.md');
    expect(paths(layout)).toEqual(['conversation', 'C.md']);
  });

  it('new-tab intent is a tab of its own even when beside is remembered', () => {
    const { layout, open } = setup({ read: () => 'beside', write() {} });
    open('A.md', undefined, 'newTab');
    expect(layout.pair).toBeNull();
  });

  it.each(['session', 'resource'])('an inactive beside request respects the %s separate choice', (choice) => {
    const { layout, conversation, open } = setup(choice === 'resource' ? { read: () => 'separate', write() {} } : undefined);
    if (choice === 'session') { open('A.md'); layout.mainGroup.pane.separatePair(); }
    layout.mainGroup.pane.setActiveTab(conversation);
    layout.open('file', { path: 'B.md' }, { from: conversation, intent: 'beside', activate: false });
    expect(layout.pair).toBeNull();
    expect(layout.focusedPane.resolvedActiveTabId).toBe(conversation);
  });
});

describe('recorded pairs have their own identity and lifecycle', () => {
  it.each(['pinned', 'side'] as const)('selecting the %s member reveals the pair and focuses that pane', (member) => {
    const { layout, conversation, open } = setup();
    open('terminal', conversation, 'newTab');
    const output = layout.open('file', { path: 'output.md' }, { from: conversation, intent: 'beside', activate: false })!;
    const selected = member === 'pinned' ? conversation : output;
    activate(layout, selected);
    expect(layout.pair).toEqual({ pinned: conversation, side: output });
    expect(layout.isPairVisible).toBe(true);
    expect(layout.focusedPane.resolvedActiveTabId).toBe(selected);
    expectOneStrip(layout);
  });

  it('replaces the recorded pair without moving the old displayed pages, then reveals the new pair', () => {
    const { layout, conversation, open } = setup();
    const old = open('terminal');
    const side = layout.sideGroup!;
    const oldEntry = side.pane.entries.get(old);
    const next = layout.open('file', { path: 'output.md' }, { from: conversation, intent: 'beside', activate: false })!;
    expect(layout.pair).toEqual({ pinned: conversation, side: next });
    expect(side.pane.entries.get(old)).toBe(oldEntry);
    expect(side.pane.resolvedActiveTabId).toBe(old);
    expect(layout.focusedPane).toBe(side.pane);
    expect(layout.mainGroup.pane.resolvedTabs.filter((tab) => tab.pairRole).map((tab) => tab.tabId)).toEqual([conversation, next]);
    activate(layout, next);
    expect(layout.isPairVisible).toBe(true);
    expect(layout.focusedPane.resolvedActiveTabId).toBe(next);
    expect(layout.stripTabIds).toContain(old);
  });

  it('closing a newer background output restores its displaced pair without selecting it', () => {
    const { layout, conversation, open } = setup();
    const terminal = open('terminal', conversation, 'newTab');
    const a = layout.open('file', { path: 'A.md' }, { from: conversation, intent: 'beside', activate: false })!;
    const b = layout.open('file', { path: 'B.md' }, { from: conversation, intent: 'beside', activate: false })!;
    close(layout, b);
    expect(layout.pair).toEqual({ pinned: conversation, side: a });
    expect(layout.focusedPane.resolvedActiveTabId).toBe(terminal);
    expect(layout.sidePaneId).toBeNull();
  });

  it.each(['pinned', 'side'] as const)('closing a hidden %s member clears the recorded pair', (member) => {
    const { layout, conversation, open } = setup();
    const terminal = open('terminal', conversation, 'newTab');
    const output = layout.open('file', { path: 'output.md' }, { from: conversation, intent: 'beside', activate: false })!;
    close(layout, member === 'pinned' ? conversation : output);
    expect(layout.pair).toBeNull();
    expect(layout.snapshot.pair).toBeNull();
    expect(layout.focusedPane.resolvedActiveTabId).toBe(terminal);
  });

  it.each(['pinned', 'side'] as const)('windowing a hidden %s member clears the recorded pair', (member) => {
    const { layout, conversation, open } = setup();
    const terminal = open('terminal', conversation, 'newTab');
    const output = layout.open('file', { path: 'output.md' }, { from: conversation, intent: 'beside', activate: false })!;
    const windowId = layout.detachToWindow(member === 'pinned' ? conversation : output)!;
    expect(layout.pair).toBeNull();
    expect(layout.snapshot.pair).toBeNull();
    expect(layout.focusedPane.resolvedActiveTabId).toBe(terminal);
    layout.returnFromWindow(windowId, { activate: false });
    expect(layout.pair).toBeNull();
  });

  it('separating a hidden pair retains the current page and prevents another automatic pair', () => {
    const { layout, conversation, open } = setup();
    const terminal = open('terminal', conversation, 'newTab');
    layout.open('file', { path: 'A.md' }, { from: conversation, intent: 'beside', activate: false });
    layout.unpair({ declined: true });
    layout.open('file', { path: 'B.md' }, { from: conversation, intent: 'beside', activate: false });
    expect(layout.pair).toBeNull();
    expect(layout.focusedPane.resolvedActiveTabId).toBe(terminal);
  });

  it('restores an old paired snapshot without a pair field, preserving direction, sizes and active pane', () => {
    const { layout, conversation, open } = setup();
    const output = open('A.md');
    layout.pairWith(conversation, output, { edge: 'left' });
    layout.setPaneSizes([35, 65]);
    const { pair: _pair, ...legacy } = layout.snapshot;
    const { layout: restored } = setup();
    restored.restoreSnapshot(legacy);
    expect(restored.pair).toEqual({ pinned: conversation, side: output });
    expect(restored.paneSizes).toEqual([35, 65]);
    expect(restored.groups.map((group) => group.paneId)).toEqual(layout.groups.map((group) => group.paneId));
    expect(restored.focusedPane.resolvedActiveTabId).toBe(output);
  });

  it('restores a new background pair without switching the saved page', () => {
    const { layout, conversation, open } = setup();
    const terminal = open('terminal', conversation, 'newTab');
    const output = layout.open('file', { path: 'output.md' }, { from: conversation, intent: 'beside', activate: false })!;
    const { layout: restored } = setup();
    restored.restoreSnapshot(layout.snapshot);
    expect(restored.pair).toEqual({ pinned: conversation, side: output });
    expect(restored.focusedPane.resolvedActiveTabId).toBe(terminal);
    expect(restored.groups).toHaveLength(1);
    activate(restored, output);
    expect(restored.isPairVisible).toBe(true);
  });

  it('restores a pending pair while retaining the old split and focused terminal', () => {
    const { layout, conversation, open } = setup();
    const terminal = open('terminal');
    const output = layout.open('file', { path: 'output.md' }, { from: conversation, intent: 'beside', activate: false })!;
    const snapshot = layout.snapshot;
    const { layout: restored } = setup();
    restored.restoreSnapshot(snapshot);
    expect(restored.pair).toEqual({ pinned: conversation, side: output });
    expect(restored.focusedPane.resolvedActiveTabId).toBe(terminal);
    expect(restored.snapshot.layout).toEqual(snapshot.layout);
    expect(restored.isPairVisible).toBe(false);
  });

  it.each(['close', 'window'] as const)('clears a different hidden conversation on %s without changing the displayed split', (operation) => {
    const { layout, conversation, open } = setup();
    const otherChat = open('topic', conversation, 'newTab', 'topic');
    activate(layout, conversation);
    const terminal = open('terminal');
    layout.open('file', { path: 'output.md' }, { from: otherChat, intent: 'beside', activate: false });
    const tree = layout.layout;
    const active = layout.focusedPane;
    if (operation === 'close') close(layout, otherChat);
    else layout.detachToWindow(otherChat);
    expect(layout.pair).toBeNull();
    expect(layout.layout).toBe(tree);
    expect(layout.focusedPane).toBe(active);
    expect(active.resolvedActiveTabId).toBe(terminal);
  });

  it('preserves an old separate snapshot and its existing placement-memory keys', () => {
    const { layout, conversation, open } = setup();
    open('A.md', conversation, 'newTab');
    const { pair: _pair, ...legacy } = layout.snapshot;
    const { layout: restored } = setup({ read: () => 'separate', write() {} });
    restored.restoreSnapshot(legacy);
    restored.open('file', { path: 'A.md' }, { from: conversation, intent: 'beside', activate: false });
    expect(restored.pair).toBeNull();
    expect(restored.groups).toHaveLength(1);
  });

  it.each([null, { pinnedTabId: 'missing', sideTabId: 'missing-too' }])('never infers a different pair from an explicit cleared or invalid new snapshot', (pair) => {
    const { layout, open } = setup();
    const output = open('A.md');
    const { layout: restored } = setup();
    restored.restoreSnapshot({ ...layout.snapshot, pair });
    expect(restored.pair).toBeNull();
    expect(restored.snapshot.pair).toBeNull();
    expect(restored.focusedPane.resolvedActiveTabId).toBe(output);
  });
});

describe('closing one of the pair', () => {
  it('closing the side: the pinned page fills', () => {
    const { layout, conversation, open } = setup();
    const a = open('A.md');
    close(layout, a);
    expect(layout.pair).toBeNull();
    expect(layout.mainGroup.pane.resolvedActiveTabId).toBe(conversation);
    expectOneStrip(layout);
  });

  it('closing the pinned page: the side fills', () => {
    const { layout, open } = setup();
    const folder = open('/', undefined, 'newTab', 'folder');
    const a = open('A.md');
    activate(layout, folder);
    expect(layout.pair?.side).toBe(folder);
    close(layout, layout.pair!.pinned);
    expect(layout.pair).toBeNull();
    expect(layout.mainGroup.pane.resolvedActiveTabId).toBe(folder);
    expect(layout.stripTabIds).toContain(a);
    expectOneStrip(layout);
  });

  it('tearing the pinned page off into a window: the side fills', () => {
    const { layout, conversation, open } = setup();
    const a = open('A.md');
    layout.detachToWindow(conversation);
    expect(layout.pair).toBeNull();
    expect(layout.mainGroup.pane.resolvedActiveTabId).toBe(a);
    expectOneStrip(layout);
  });
});

// owner 11-05 §7 (msg:00b090e9): closing the tab that pushed one out of the pair brings that one back.
describe('closing what pushed a page out brings it back (§7)', () => {
  it('the rule: B pushed A out; closing B brings A back beside the conversation', () => {
    const { layout, conversation, open } = setup();
    const a = open('A.md');
    const b = open('B.md');
    close(layout, b);
    expect(layout.pair).toEqual({ pinned: conversation, side: a });
    expectOneStrip(layout);
  });

  it('1. A already closed: the remaining one fills; A’s own record is handed on', () => {
    const { layout, conversation, open } = setup();
    open('A.md');
    const b = open('B.md');
    const c = open('C.md');
    // C pushed B out, B pushed A out. Closing B hands C its record: C → A.
    close(layout, b);
    close(layout, c);
    expect(paths(layout)).toEqual(['conversation', 'A.md']);
    // A gone too: closing the side now just leaves the conversation.
    close(layout, layout.pair!.side);
    expect(layout.pair).toBeNull();
    expect(layout.mainGroup.pane.resolvedActiveTabId).toBe(conversation);
  });

  it('2. a chain unwinds one step per close: file2 → file1 → the group', () => {
    const { layout, conversation, open } = setup();
    const topic = open('topic', conversation, 'navigate', 'topic');
    const file1 = open('file1.md', topic);
    const file2 = open('file2.md', topic);
    expect(layout.pair).toEqual({ pinned: topic, side: file2 });
    close(layout, file2);
    expect(layout.pair).toEqual({ pinned: topic, side: file1 });
    close(layout, file1);
    expect(layout.pair).toEqual({ pinned: conversation, side: topic });
    expectOneStrip(layout);
  });

  it('3. closing the one that did not push: no restore, the other fills', () => {
    const { layout, conversation, open } = setup();
    const topic = open('topic', conversation, 'navigate', 'topic');
    const file = open('A.md', topic);
    close(layout, topic);
    expect(layout.pair).toBeNull();
    expect(layout.mainGroup.pane.resolvedActiveTabId).toBe(file);
  });

  it('4. what was pushed out is already on screen: not brought back twice (two records pointing at each other end)', () => {
    const { layout, conversation, open } = setup();
    const topic = open('topic', conversation, 'navigate', 'topic');
    const file = open('A.md');
    // file pushed the topic out; then the topic comes back as the pinned page (it pushes the conversation out).
    layout.pairWith(topic, file);
    expect(layout.pair).toEqual({ pinned: topic, side: file });
    close(layout, file);
    // file's record names the topic, which is on screen: no restore — the topic fills.
    expect(layout.pair).toBeNull();
    expect(layout.mainGroup.pane.resolvedActiveTabId).toBe(topic);
    expectOneStrip(layout);
  });

  it('5. what was pushed out went into a window: not brought back', () => {
    const { layout, conversation, open } = setup();
    const a = open('A.md');
    const b = open('B.md');
    layout.detachToWindow(a);
    close(layout, b);
    expect(layout.pair).toBeNull();
    expect(layout.mainGroup.pane.resolvedActiveTabId).toBe(conversation);
  });

  it('6. the user rearranging the pair (拆开, 向右分, a drag) clears its records', () => {
    const { layout, conversation, open } = setup();
    open('A.md');
    const b = open('B.md');
    layout.mainGroup.pane.separatePair();
    activate(layout, conversation);
    layout.mainGroup.pane.splitTab(b);
    expect(layout.pair).toEqual({ pinned: conversation, side: b });
    close(layout, b);
    expect(layout.pair).toBeNull();
  });

  it('7. navigating inside the one that pushed keeps the record', () => {
    const { layout, conversation, open } = setup();
    const a = open('A.md');
    const folder = open('/', conversation, 'navigate', 'folder');
    layout.open('file', { path: 'inside.md' }, { from: folder, intent: 'navigate' });
    expect(paths(layout)).toEqual(['conversation', 'inside.md']);
    close(layout, folder);
    expect(layout.pair).toEqual({ pinned: conversation, side: a });
  });

  it('8. records survive a restart (saved with the strip)', () => {
    const { layout, open } = setup();
    open('A.md');
    open('B.md');
    const saved = structuredClone(layout.snapshot);
    const { layout: restored } = setup();
    restored.restoreSnapshot(saved);
    expect(paths(restored)).toEqual(['conversation', 'B.md']);
    close(restored, restored.pair!.side);
    expect(paths(restored)).toEqual(['conversation', 'A.md']);
  });

  it('9. narrow: restoring only changes which page is shown; the pair stays', () => {
    const { layout, open } = setup();
    open('A.md');
    const b = open('B.md');
    layout.setNarrow(true);
    close(layout, b);
    expect(paths(layout)).toEqual(['conversation', 'A.md']);
    expectOneStrip(layout);
  });
});

it('1000 random steps keep one strip, at most one pair, and never bring back a closed or visible tab', () => {
  let seed = 7;
  const random = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
  let { layout, conversation } = setup();
  const closed = new Set<string>();
  let counter = 0;
  const all = () => layout.groups.flatMap(({ pane }) => pane.tabOrder);
  for (let step = 0; step < 1000; step++) {
    const tabs = all();
    const anyTab = tabs[random(tabs.length)];
    const op = random(9);
    const visibleBefore = new Set([layout.pair?.pinned, layout.pair?.side, layout.mainGroup.pane.resolvedActiveTabId]);
    if (op === 0 || op === 1) layout.open('file', { path: `f${counter++ % 12}.md` }, { from: conversation, intent: 'navigate' });
    else if (op === 2) {
      const topic = all().find((id) => layout.mainGroup.pane.entries.get(id)?.kind === 'topic' || layout.sideGroup?.pane.entries.get(id)?.kind === 'topic');
      layout.open(topic ? 'file' : 'topic', { path: topic ? `t${counter++ % 5}.md` : 'topic' }, { from: topic ?? conversation, intent: 'navigate' });
    } else if (op === 3 && anyTab !== conversation) {
      const pane = layout.groups.find(({ pane }) => pane.entries.has(anyTab))!.pane;
      const wasVisible = visibleBefore.has(anyTab);
      pane.closeTab(anyTab);
      closed.add(anyTab);
      // A restore brings back only an ordinary tab of the strip: never a closed one, never one already on screen.
      const pair = layout.pair;
      if (pair && wasVisible) {
        for (const id of [pair.pinned, pair.side]) expect(closed.has(id)).toBe(false);
      }
    } else if (op === 4) activate(layout, anyTab);
    else if (op === 5) layout.splitRight();
    else if (op === 6 && anyTab !== conversation && layout.windowPanes.size < 2) layout.detachToWindow(anyTab);
    else if (op === 7) {
      const saved = structuredClone(layout.snapshot);
      layout.dispose();
      ({ layout } = setup());
      layout.restoreSnapshot(saved);
      conversation = all().find((id) => layout.mainGroup.pane.entries.get(id)?.kind === 'conversation')!;
    } else if (op === 8) layout.setNarrow(random(2) === 0);
    expectOneStrip(layout);
    for (const id of all()) expect(closed.has(id)).toBe(false);
    if (layout.pair) expect(layout.pair.pinned).not.toBe(layout.pair.side);
  }
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
