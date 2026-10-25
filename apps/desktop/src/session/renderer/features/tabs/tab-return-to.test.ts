import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TabEntry } from './core/tab-provider';
import { createTabProvider, createTabRegistry } from './core/tab-provider-registry';
import { PaneLayoutStore } from './pane-layout-store';

const layouts: PaneLayoutStore[] = [];
afterEach(() => layouts.splice(0).forEach((layout) => layout.dispose()));

function setup() {
  const dispose = vi.fn();
  const initialize = vi.fn((_entry: TabEntry<{ path: string }>) => ({ dispose: () => {} }));
  const provider = (kind: string) => createTabProvider({
    kind,
    mount: 'single',
    resourceKey: (state: { path: string }) => state.path,
    initialize,
    dispose,
    TabBarItem: () => null,
    TabBarItemDragPreview: () => null,
    TabContent: () => null,
  });
  const layout = new PaneLayoutStore(createTabRegistry([provider('file'), provider('app.page')]), {
    viewId: 'chat:c1', place: { kind: 'chat', chatId: 'c1' },
  }, undefined, { singleStrip: true });
  layouts.push(layout);
  const pane = layout.focusedPane;
  const open = (path: string, config?: Parameters<typeof layout.open>[2], kind = 'app.page') => {
    layout.open(kind, { path }, config);
    return [...pane.entries.values()].find((entry) => (entry.state as { path: string }).path === path)!.tabId;
  };
  return { layout, pane, open, dispose, initialize };
}

describe('tab return navigation', () => {
  it('returns to the previous page rather than the neighboring tab', () => {
    const { pane, open, initialize } = setup();
    const origin = open('origin');
    open('neighbor');
    const child = open('child', { returnTo: { tabId: origin, message: 'm1' } });
    expect(pane.returnToOf(child)).toEqual({ tabId: origin, message: 'm1' });
    expect(initialize.mock.calls.at(-1)?.[0].state).toEqual({ path: 'child' });
    pane.closeTab(child);
    expect(pane.activeTabId).toBe(origin);
  });

  it('does not navigate when a hidden tab is closed', () => {
    const { pane, open } = setup();
    const origin = open('origin');
    const child = open('child', { returnTo: { tabId: origin } });
    const active = open('active');
    pane.closeTab(child);
    expect(pane.activeTabId).toBe(active);
  });

  it('keeps the neighbor rule when the previous page is no longer open', () => {
    const { pane, open } = setup();
    const origin = open('origin');
    const neighbor = open('neighbor');
    const child = open('child', { returnTo: { tabId: origin } });
    pane.closeTab(origin);
    pane.closeTab(child);
    expect(pane.activeTabId).toBe(neighbor);
  });

  it.each(['right', 'left', 'top', 'bottom'] as const)('replaces the paired side on close, keeping its %s placement', (edge) => {
    const { pane, open, dispose } = setup();
    const anchor = open('anchor');
    const previous = open('previous');
    const child = open('child', { preview: true, returnTo: { tabId: previous } });
    pane.setActiveTab(anchor);
    pane.splitBeside(child, edge);
    pane.setPairRatio(0.3);
    pane.closeTab(child);
    expect(pane.activeTabId).toBe(previous);
    expect(pane.livePair).toEqual({ anchor, side: previous, sideAt: edge, ratio: 0.3 });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('returns to the anchor as a single page when closing its paired side', () => {
    const { pane, open } = setup();
    const anchor = open('anchor');
    const child = open('child', { returnTo: { tabId: anchor } });
    pane.setActiveTab(anchor);
    pane.splitBeside(child, 'right');
    pane.closeTab(child);
    expect(pane.shownTabIds).toEqual([anchor]);
    expect(pane.livePair).toBeNull();
  });

  it.each(['file', 'app.page'])('keeps %s navigation separate from domain state through restore and reopen', (kind) => {
    const { layout, pane, open } = setup();
    const origin = open('origin');
    const child = open('child', { returnTo: { tabId: origin, message: 'm2' } }, kind);
    const snapshot = layout.snapshot;
    expect(snapshot.groups[0].tabManager.tabs.find((tab) => tab.tabId === child)?.returnTo).toEqual({ tabId: origin, message: 'm2' });
    layout.restoreSnapshot(snapshot);
    const restored = layout.focusedPane;
    expect(restored.returnToOf(child)).toEqual({ tabId: origin, message: 'm2' });
    expect(restored.entries.get(child)?.state).toEqual({ path: 'child' });
    restored.closeTab(child);
    restored.reopenClosedTab();
    expect(restored.returnToOf(child)).toEqual({ tabId: origin, message: 'm2' });
    expect(pane.ctx.place).toEqual({ kind: 'chat', chatId: 'c1' });
  });

  it('updates navigation when the same page is opened from a different previous page', () => {
    const { pane, open } = setup();
    const first = open('first');
    const second = open('second');
    const child = open('child', { returnTo: { tabId: first } });
    expect(open('child', { returnTo: { tabId: second } })).toBe(child);
    expect(pane.returnToOf(child)).toEqual({ tabId: second });
  });

  it('keeps the previous page when an already-open tab is opened directly', () => {
    const { pane, open } = setup();
    const origin = open('origin');
    const child = open('child', { returnTo: { tabId: origin } });
    expect(open('child')).toBe(child);
    expect(pane.returnToOf(child)).toEqual({ tabId: origin });
  });

  it('retargets a preview with the new resource and its own previous page', () => {
    const { pane, open } = setup();
    const first = open('first');
    const second = open('second');
    const preview = open('a', { preview: true, returnTo: { tabId: first } });
    expect(open('b', { preview: true, returnTo: { tabId: second } })).toBe(preview);
    expect(pane.returnToOf(preview)).toEqual({ tabId: second });
    pane.closeTab(preview);
    expect(pane.activeTabId).toBe(second);
  });

  it('carries navigation when moving the entry into a separate window and back', () => {
    const { layout, open } = setup();
    const origin = open('origin');
    const child = open('child', { returnTo: { tabId: origin } });
    const windowId = layout.detachToWindow(child);
    expect(windowId).toBeTruthy();
    const windowPane = layout.windowPanes.get(windowId!)!.pane;
    expect(windowPane.returnToOf(child)).toEqual({ tabId: origin });
    layout.returnFromWindow(windowId!);
    expect(layout.focusedPane.returnToOf(child)).toEqual({ tabId: origin });
  });
});
