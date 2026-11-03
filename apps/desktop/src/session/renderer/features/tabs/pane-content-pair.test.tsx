import { DndContext } from '@dnd-kit/core';
import { JSDOM } from 'jsdom';
import { observer } from 'mobx-react-lite';
import React, { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabContentProps } from './core/tab-provider';
import { createTabProvider, createTabRegistry } from './core/tab-provider-registry';
import { PaneContent } from './pane-content';
import { PaneContext } from './pane-context';
import { PaneLayoutStore } from './pane-layout-store';
import { tabFullscreen } from './tab-fullscreen';
import { commandRegistry } from '@renderer/lib/commands/registry';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let dom: JSDOM;
const mounts = new Map<string, number>();
function Page({ id }: { id: string }) { useEffect(() => { mounts.set(id, (mounts.get(id) ?? 0) + 1); }, [id]); return <div data-page={id} />; }
const Content = observer(({ host }: TabContentProps) => <>{host.resolvedTabs.map((tab) => <Page key={tab.tabId} id={tab.tabId} />)}</>);
const provider = createTabProvider({ kind: 'page', resourceKey: (s: { id: string }) => s.id, initialize: () => ({ dispose() {} }), dispose() {}, TabBarItem: () => null, TabBarItemDragPreview: () => null, TabContent: Content });

beforeEach(() => {
  mounts.clear(); dom = new JSDOM('<div id="root"></div>');
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document); vi.stubGlobal('navigator', dom.window.navigator); vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  // Fixture tab ids are UUIDs, already valid CSS identifiers.
  vi.stubGlobal('CSS', { escape: (id: string) => id });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  root = createRoot(dom.window.document.getElementById('root')!);
});
afterEach(() => { act(() => { tabFullscreen.exit(); root.unmount(); }); vi.unstubAllGlobals(); });

describe('each actual pane owns its content', () => {
  it('hands focus from the retained folder guest to the new page before history shortcuts are used', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const folder = createTabProvider({ ...provider, kind: 'folder', keepMounted: true,
      TabContent: () => <webview tabIndex={0} data-folder-guest="" /> });
    const file = createTabProvider({ ...provider, kind: 'file',
      TabContent: () => <div tabIndex={-1} data-browser-page="" /> });
    const layout = new PaneLayoutStore(createTabRegistry([folder, file]), { viewId: 'guest-focus-history' });
    const tabId = layout.open('folder', { id: 'folder' }, { from: null, intent: 'newTab' })!;
    const group = layout.groups[0];
    act(() => root.render(<PaneContext.Provider value={{ paneId: group.paneId, pane: group.pane, isFocusedPane: true }}><PaneContent hideTabBar /></PaneContext.Provider>));
    const guest = dom.window.document.querySelector<HTMLElement>('[data-folder-guest]')!;
    guest.focus();
    expect(dom.window.document.activeElement).toBe(guest);
    await act(async () => { layout.open('file', { id: 'notes.txt' }, { from: tabId, intent: 'navigate' }); });
    expect(dom.window.document.querySelector('[data-folder-guest]')).toBe(guest);
    expect(dom.window.document.activeElement).toBe(dom.window.document.querySelector('[data-browser-page]'));
    commandRegistry.setContext(dom.window.document.activeElement as HTMLElement);
    await act(async () => { expect(commandRegistry.dispatch('app.navigateBack')).toBe(true); });
    expect(group.pane.entries.get(tabId)?.kind).toBe('folder');
    layout.dispose();
  });

  it('dispatches the existing back/forward commands only into the pane that owns the focused element', async () => {
    const layout = new PaneLayoutStore(createTabRegistry([provider]), { viewId: 'pane-history-keys' });
    const a = layout.open('page', { id: 'folder' }, { from: null, intent: 'newTab' })!;
    const b = layout.open('page', { id: 'other' }, { from: null, intent: 'newTab' })!;
    layout.splitPane(layout.activePaneId, 'right', b);
    layout.open('page', { id: 'README' }, { from: a, intent: 'navigate' });
    const first = layout.groups.find((group) => group.pane.entries.has(a))!.pane;
    act(() => root.render(<>{layout.groups.map((group) => <PaneContext.Provider key={group.paneId} value={{ paneId: group.paneId, pane: group.pane, isFocusedPane: true }}><PaneContent hideTabBar /></PaneContext.Provider>)}</>));
    commandRegistry.setContext(dom.window.document.querySelector<HTMLElement>(`[data-page="${a}"]`)!);
    await act(async () => { expect(commandRegistry.dispatch('app.navigateBack')).toBe(true); });
    expect(first.entries.get(a)?.state).toEqual({ id: 'folder' });
    expect(layout.groups.find((group) => group.pane.entries.has(b))!.pane.entries.get(b)?.state).toEqual({ id: 'other' });
    await act(async () => { expect(commandRegistry.dispatch('app.navigateForward')).toBe(true); });
    expect(first.entries.get(a)?.state).toEqual({ id: 'README' });
    layout.dispose();
  });

  it('offers an explicit return to the conversation after a narrow open without changing the layout', async () => {
    const conversation = createTabProvider({ ...provider, kind: 'conversation', conversation: true });
    const layout = new PaneLayoutStore(createTabRegistry([provider, conversation]), { viewId: 'narrow-conversation-return' });
    const source = layout.open('conversation', { id: 'conversation' }, { from: null, intent: 'newTab' })!;
    layout.focusedPane.setDimensions(390, 620);
    const tree = JSON.stringify(layout.layout);
    const file = layout.open('page', { id: 'file' }, { from: source, intent: 'navigate' })!;
    expect(layout.groups).toHaveLength(1);
    expect(layout.focusedPane.tabOrder).toEqual([source, file]);
    const group = layout.groups[0];
    act(() => root.render(<DndContext><PaneContext.Provider value={{ paneId: group.paneId, pane: group.pane, isFocusedPane: true }}><PaneContent /></PaneContext.Provider></DndContext>));
    const back = dom.window.document.querySelector<HTMLButtonElement>('[data-testid="tab-return-conversation"]');
    expect(back).not.toBeNull();
    expect(back!.closest('[data-tabbar-actions]')).not.toBeNull();
    await act(async () => { back!.click(); });
    expect(layout.focusedPane.resolvedActiveTabId).toBe(source);
    expect(layout.focusedPane.tabOrder).toEqual([source, file]);
    expect(JSON.stringify(layout.layout)).toBe(tree);
    layout.dispose();
  });

  it('fullscreen preserves both mounted page resources and the actual split', () => {
    const layout = new PaneLayoutStore(createTabRegistry([provider]), { viewId: 'real-pane-content' });
    const a = layout.open('page', { id: 'a' }, { from: null, intent: 'newTab' })!;
    const b = layout.open('page', { id: 'b' }, { from: null, intent: 'newTab' })!;
    layout.splitPane(layout.activePaneId, 'right', b);
    act(() => root.render(<>{layout.groups.map((group) => <PaneContext.Provider key={group.paneId} value={{ paneId: group.paneId, pane: group.pane, isFocusedPane: true }}><PaneContent hideTabBar /></PaneContext.Provider>)}</>));
    const before = JSON.stringify(layout.snapshot);
    expect([mounts.get(a), mounts.get(b)]).toEqual([1, 1]);
    act(() => tabFullscreen.toggle(layout.focusedPane, b));
    expect(dom.window.document.querySelector<HTMLElement>('[data-tab-fullscreen]')?.style.position).toBe('fixed');
    act(() => tabFullscreen.exit());
    expect(JSON.stringify(layout.snapshot)).toBe(before);
    expect([mounts.get(a), mounts.get(b)]).toEqual([1, 1]);
    layout.dispose();
  });
});
