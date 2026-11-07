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
  it.each([false, true])('keeps the viewed terminal node, focus and draft while recording a background pair (existing split: %s)', async (paired) => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const chat = createTabProvider({ ...provider, kind: 'conversation', conversation: true, keepMounted: true, TabContent: () => <textarea data-chat-input="" defaultValue="聊天草稿" /> });
    const terminal = createTabProvider({ ...provider, kind: 'terminal', keepMounted: true, TabContent: () => <textarea data-terminal-input="" /> });
    const output = createTabProvider({ ...provider, TabContent: () => <textarea data-output-input="" /> });
    const layout = new PaneLayoutStore(createTabRegistry([output, chat, terminal]), { viewId: 'background-pair-content' });
    const conversation = layout.open('conversation', { id: 'chat' }, { from: null, intent: 'newTab' })!;
    const terminalTab = layout.open('terminal', { id: 'terminal' }, { from: conversation, intent: paired ? 'beside' : 'newTab' })!;
    const originalPane = layout.focusedPane;
    const Surface = observer(() => <>{layout.groups.map((group) => <PaneContext.Provider key={group.paneId} value={{ paneId: group.paneId, pane: group.pane, isFocusedPane: layout.activePaneId === group.paneId }}><PaneContent hideTabBar /></PaneContext.Provider>)}</>);
    const flush = () => { for (const frame of frames.splice(0)) frame(0); };
    try {
      await act(async () => { root.render(<Surface />); });
      await act(async () => { flush(); });
      const input = dom.window.document.querySelector<HTMLTextAreaElement>('[data-terminal-input]')!;
      const chatInput = dom.window.document.querySelector<HTMLTextAreaElement>('[data-chat-input]')!;
      input.value = '正在终端输入的草稿'; input.scrollTop = 37; input.focus();
      const tree = layout.layout;
      let page: string | undefined;
      await act(async () => { page = layout.open('page', { id: 'example.com' }, { from: conversation, intent: 'beside', activate: false }); });
      await act(async () => { flush(); });
      expect(layout.pair).toEqual({ pinned: conversation, side: page });
      expect(layout.layout).toBe(tree);
      expect(layout.focusedPane).toBe(originalPane);
      expect(originalPane.resolvedActiveTabId).toBe(terminalTab);
      expect(dom.window.document.querySelector('[data-terminal-input]')).toBe(input);
      expect(input.value).toBe('正在终端输入的草稿');
      expect(input.scrollTop).toBe(37);
      expect(dom.window.document.activeElement).toBe(input);
      const oldHost = layout.mainGroup.pane;
      await act(async () => { oldHost.setActiveTab(page!); oldHost.focusActiveContent(); });
      await act(async () => { flush(); });
      expect(layout.isPairVisible).toBe(true);
      expect(dom.window.document.activeElement).toBe(dom.window.document.querySelector('[data-output-input]'));
      await act(async () => { oldHost.setActiveTab(conversation); oldHost.focusActiveContent(); });
      await act(async () => { flush(); });
      expect(dom.window.document.querySelector('[data-chat-input]')).toBe(chatInput);
      expect(chatInput.value).toBe('聊天草稿');
      expect(dom.window.document.activeElement).toBe(chatInput);
    } finally { layout.dispose(); }
  });

  it('pairs a beside request with activate false and leaves input focus in the chat', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const chat = createTabProvider({ ...provider, kind: 'conversation', conversation: true, TabContent: () => <input data-chat-input="" /> });
    const layout = new PaneLayoutStore(createTabRegistry([provider, chat]), { viewId: 'agent-beside-chat-focus' });
    const conversation = layout.open('conversation', { id: 'chat' }, { from: null, intent: 'newTab' })!;
    const main = layout.mainGroup;
    const Surface = observer(() => <>{layout.groups.map((group) => <PaneContext.Provider key={group.paneId} value={{ paneId: group.paneId, pane: group.pane, isFocusedPane: layout.activePaneId === group.paneId }}><PaneContent hideTabBar /></PaneContext.Provider>)}</>);
    const flush = () => { for (const frame of frames.splice(0)) frame(0); };
    try {
      await act(async () => { root.render(<Surface />); });
      await act(async () => { flush(); });
      const input = dom.window.document.querySelector<HTMLInputElement>('[data-chat-input]')!;
      input.focus();
      let page: string | undefined;
      await act(async () => { page = layout.open('page', { id: 'example.com' }, { from: conversation, intent: 'beside', activate: false }); });
      await act(async () => { flush(); });
      expect(layout.pair).toEqual({ pinned: conversation, side: page });
      expect(layout.focusedPane).toBe(main.pane);
      expect(layout.focusedPane.resolvedActiveTabId).toBe(conversation);
      expect(dom.window.document.activeElement).toBe(input);
    } finally { layout.dispose(); }
  });

  it('hands focus from the retained folder guest to the new page before history shortcuts are used', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const folder = createTabProvider({ ...provider, kind: 'folder', keepMounted: true,
      TabContent: () => <webview tabIndex={0} data-folder-guest="" /> });
    const file = createTabProvider({ ...provider, kind: 'file',
      TabContent: () => <div tabIndex={-1} data-browser-page="" /> });
    const layout = new PaneLayoutStore(createTabRegistry([folder, file]), { viewId: 'guest-focus-history' });
    const tabId = layout.open('folder', { id: 'folder' }, { from: null, intent: 'newTab' })!;
    layout.open('folder', { id: 'retained-folder' }, { from: tabId, intent: 'newTab' });
    layout.focusedPane.setActiveTab(tabId);
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

  it('focuses the new host page when a click navigates from a resident guest outside the pane', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const folder = createTabProvider({ ...provider, kind: 'folder', TabContent: () => <div data-folder-slot="" /> });
    const file = createTabProvider({ ...provider, kind: 'file', TabContent: () => <div tabIndex={-1} data-browser-page="" /> });
    const layout = new PaneLayoutStore(createTabRegistry([folder, file]), { viewId: 'resident-click-history' });
    const tabId = layout.open('folder', { id: 'folder' }, { from: null, intent: 'newTab' })!;
    const group = layout.groups[0];
    act(() => root.render(<PaneContext.Provider value={{ paneId: group.paneId, pane: group.pane, isFocusedPane: true }}><PaneContent hideTabBar /></PaneContext.Provider>));
    const flushFrames = () => { for (const frame of frames.splice(0)) frame(0); };
    flushFrames();
    // Electron delivers the file click through the App bridge. Its resident
    // webview is rooted outside PaneContent, so the pane's DOM-focus guard
    // cannot transfer focus. Keep that placement and use the real open route.
    const guest = dom.window.document.createElement('webview');
    guest.tabIndex = 0;
    dom.window.document.body.append(guest);
    guest.addEventListener('click', () => { layout.open('file', { id: 'f02.txt' }, { from: tabId, intent: 'navigate' }); });
    try {
      guest.focus();
      expect(dom.window.document.querySelector('[data-folder-slot]')!.contains(guest)).toBe(false);
      await act(async () => { guest.click(); });
      await act(async () => { flushFrames(); });
      expect(group.pane.entries.get(tabId)?.kind).toBe('file');
      expect(dom.window.document.activeElement).toBe(dom.window.document.querySelector('[data-browser-page]'));
      // No intervening click on the file body. Native Cmd+[ / Cmd+] is a
      // separate Electron acceptance cell; here use its existing commands.
      commandRegistry.setContext(dom.window.document.activeElement as HTMLElement);
      await act(async () => { expect(commandRegistry.dispatch('app.navigateBack')).toBe(true); });
      expect(group.pane.entries.get(tabId)?.kind).toBe('folder');
      await act(async () => { expect(commandRegistry.dispatch('app.navigateForward')).toBe(true); });
      expect(group.pane.entries.get(tabId)?.state).toEqual({ id: 'f02.txt' });
      expect(group.pane.tabOrder).toEqual([tabId]);
    } finally { guest.remove(); layout.dispose(); }
  });

  it('leaves host input focus alone for an inactive open', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    const layout = new PaneLayoutStore(createTabRegistry([provider]), { viewId: 'inactive-open-focus' });
    const tabId = layout.open('page', { id: 'folder' }, { from: null, intent: 'newTab' })!;
    const group = layout.groups[0];
    act(() => root.render(<PaneContext.Provider value={{ paneId: group.paneId, pane: group.pane, isFocusedPane: true }}><PaneContent hideTabBar /></PaneContext.Provider>));
    for (const frame of frames.splice(0)) frame(0);
    const input = dom.window.document.createElement('input'); dom.window.document.body.append(input); input.focus();
    try {
      await act(async () => { layout.open('page', { id: 'background' }, { from: tabId, intent: 'newTab', activate: false }); });
      for (const frame of frames.splice(0)) frame(0);
      expect(dom.window.document.activeElement).toBe(input);
      expect(group.pane.resolvedActiveTabId).toBe(tabId);
    } finally { input.remove(); layout.dispose(); }
  });

  it('does not take focus while a same-tab navigation is waiting for close confirmation', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
    let finish!: (allowed: boolean) => void;
    const confirm = new Promise<boolean>((resolve) => { finish = resolve; });
    const guarded = createTabProvider({ ...provider, onBeforeClose: () => confirm });
    const layout = new PaneLayoutStore(createTabRegistry([guarded]), { viewId: 'confirm-before-focus' });
    const tabId = layout.open('page', { id: 'current' }, { from: null, intent: 'newTab' })!;
    const focus = vi.fn(); layout.focusedPane.setContentFocuser(focus);
    try {
      layout.open('page', { id: 'next' }, { from: tabId, intent: 'navigate' });
      expect(focus).not.toHaveBeenCalled();
      finish(false); await confirm;
      expect(focus).not.toHaveBeenCalled();
      expect(layout.focusedPane.entries.get(tabId)?.state).toEqual({ id: 'current' });
    } finally { finish(false); layout.dispose(); }
  });

  it('dispatches the existing back/forward commands only into the pane that owns the focused element', async () => {
    const layout = new PaneLayoutStore(createTabRegistry([provider]), { viewId: 'pane-history-keys' });
    const a = layout.open('page', { id: 'folder' }, { from: null, intent: 'newTab' })!;
    const b = layout.open('page', { id: 'other' }, { from: null, intent: 'newTab' })!;
    layout.splitPane(layout.activePaneId, 'right', b);
    layout.open('page', { id: 'README' }, { from: a, intent: 'navigate' });
    const first = layout.groups.find((group) => group.pane.entries.has(a))!.pane;
    act(() => root.render(<>{layout.groups.map((group) => <PaneContext.Provider key={group.paneId} value={{ paneId: group.paneId, pane: group.pane, isFocusedPane: group.pane === first }}><PaneContent hideTabBar /></PaneContext.Provider>)}</>));
    commandRegistry.setContext(dom.window.document.querySelector<HTMLElement>(`[data-page="${a}"]`)!);
    await act(async () => { expect(commandRegistry.dispatch('app.navigateBack')).toBe(true); });
    expect(first.entries.get(a)?.state).toEqual({ id: 'folder' });
    expect(layout.groups.find((group) => group.pane.entries.has(b))!.pane.entries.get(b)?.state).toEqual({ id: 'other' });
    await act(async () => { expect(commandRegistry.dispatch('app.navigateForward')).toBe(true); });
    expect(first.entries.get(a)?.state).toEqual({ id: 'README' });
    layout.dispose();
  });

  it('a narrow open still pairs (owner 11-05: narrow keeps the pair, shows the clicked side); the strip goes back', async () => {
    const conversation = createTabProvider({ ...provider, kind: 'conversation', conversation: true });
    const layout = new PaneLayoutStore(createTabRegistry([provider, conversation]), { viewId: 'narrow-conversation-return' });
    const source = layout.open('conversation', { id: 'conversation' }, { from: null, intent: 'newTab' })!;
    layout.focusedPane.setDimensions(390, 620);
    layout.setViewActive(true);
    layout.setNarrow(true);
    const file = layout.open('page', { id: 'file' }, { from: source, intent: 'navigate' })!;
    expect(layout.pair).toEqual({ pinned: source, side: file });
    expect(layout.groups.filter(({ pane }) => pane.isVisible).map(({ pane }) => pane.resolvedActiveTabId)).toEqual([file]);
    const tree = JSON.stringify(layout.layout);
    act(() => layout.mainGroup.pane.setActiveTab(source));
    expect(layout.groups.filter(({ pane }) => pane.isVisible).map(({ pane }) => pane.resolvedActiveTabId)).toEqual([source]);
    expect(layout.pair).toEqual({ pinned: source, side: file });
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
