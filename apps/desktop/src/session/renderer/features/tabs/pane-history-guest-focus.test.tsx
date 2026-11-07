// @vitest-environment jsdom
import React, { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { observer } from 'mobx-react-lite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTabProvider, createTabRegistry } from './core/tab-provider-registry';
import type { TabContentProps } from './core/tab-provider';
import { PaneContent } from './pane-content';
import { PaneContext } from './pane-context';
import { PaneLayoutStore } from './pane-layout-store';
import { ExtensionSharedSlot } from '../extensions/extension-shared-slot';
import { ExtensionPage } from '../extensions/extension-view-layer';
import { extensionViewStore } from '../extensions/extension-view-store';
import { CommandShortcutBinder } from '@renderer/lib/commands/command-shortcut-binder';
import { commandRegistry } from '@renderer/lib/commands/registry';
import { rpc } from '@renderer/lib/ipc';

const native = vi.hoisted(() => ({ guest: null as HTMLElement | null, focusHost: vi.fn() }));
vi.mock('@renderer/lib/ipc', () => ({ rpc: {
  browser: { focusHost: native.focusHost },
  extensions: {
    activate: async () => ({ success: true, data: { partition: 'test', entryUrl: 'about:blank' } }),
    bindSurface: vi.fn(async () => ({ success: true })), retargetSurface: vi.fn(async () => ({ success: true })),
    reportLayout: async () => ({ success: true }),
  },
} }));
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({ useAppSettingsKey: () => ({ value: {} }) }));
vi.mock('@tanstack/react-hotkeys', async (original) => ({ ...await original<typeof import('@tanstack/react-hotkeys')>(), detectPlatform: () => 'mac' }));
vi.mock('../extensions/installed-extensions-store', () => ({ installedExtensionsStore: { manifestFor: () => undefined } }));
vi.mock('../extensions/extension-surface-store', () => ({ extensionSurfaceStore: { setWebContentsId() {}, forgetShared() {} } }));
vi.mock('../extensions/app-settings-page', () => ({ AppSettingsPage: () => null }));
vi.mock('../extensions/extension-tab-toolbar', () => ({ ExtensionTabToolbar: () => null }));
vi.mock('@/lib/taskConversation', () => ({ useTaskConversation: () => null, useTaskProjectChat: () => null }));
vi.mock('@/components/appSlot/AppPeekSlot', () => ({ AppPeekSlot: ({ children }: { children: React.ReactNode }) => children }));

const kind = 'workspace.main';
const Folder = observer(({ host }: TabContentProps) => {
  const tab = host.resolvedTabs.find(tab => tab.isActive && tab.kind === kind);
  const history = tab && host.navigationOf(tab.tabId);
  return tab ? <ExtensionSharedSlot tabKind={kind} sessionId="focus-history" tabId={tab.tabId}
    viewState={history?.pages[history.index]?.viewState}
    navigation={{ canBack: history!.index > 0, canForward: history!.index < history!.pages.length - 1 }} /> : null;
});
const base = { resourceKey: (s: { id: string }) => s.id, initialize: () => ({ dispose() {} }), dispose() {}, TabBarItem: () => null, TabBarItemDragPreview: () => null };
let root: Root;
let mount: HTMLDivElement;
let layout: PaneLayoutStore;
let frames: FrameRequestCallback[];
let nextGuestId: number;
const globalBack = vi.fn();
const globalForward = vi.fn();
let removeGlobal: () => void;
const Guests = observer(() => <>{[...extensionViewStore.residentPages.values()].filter(page => page.kind === kind).map(page => {
  const ref = createRef<HTMLDivElement>(); ref.current = mount;
  return <ExtensionPage key={page.key} kind={kind} extensionId="workspace" layerRef={ref} pageKey={page.key} />;
})}</>);

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
  frames = []; nextGuestId = 40; native.guest = null;
  native.focusHost.mockReset().mockImplementation(async () => { native.guest = null; return { success: true }; });
  globalBack.mockReset(); globalForward.mockReset();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('CSS', { escape: (text: string) => text });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1000, 800));
  Object.defineProperty(HTMLElement.prototype, 'checkVisibility', { configurable: true, value: () => true });
  mount = document.createElement('div'); document.body.append(mount); root = createRoot(mount);
  layout = new PaneLayoutStore(createTabRegistry([
    createTabProvider({ ...base, kind, TabContent: Folder }),
    createTabProvider({ ...base, kind: 'file', TabContent: () => <div data-file-page="" tabIndex={-1} /> }),
  ]), { viewId: 'resident-key-cycles' }, undefined, { placementMemory: { read: () => undefined, write() {} } });
  removeGlobal = commandRegistry.register({ scopeId: 'app', getCommands: () => [
    { id: 'app.navigateBack', execute: globalBack }, { id: 'app.navigateForward', execute: globalForward },
  ] });
});
afterEach(() => {
  act(() => { root.unmount(); layout.dispose(); extensionViewStore.forgetOpened(kind); removeGlobal(); });
  mount.remove(); commandRegistry.setContext(document.body); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function settle() { await act(async () => { for (const frame of frames.splice(0)) frame(0); }); }
async function render() {
  const group = layout.groups[0];
  await act(async () => root.render(<><CommandShortcutBinder /><PaneContext.Provider value={{ paneId: group.paneId, pane: group.pane, isFocusedPane: true }}><PaneContent hideTabBar /></PaneContext.Provider><Guests /></>));
  await settle();
}
async function readyGuest() {
  const guest = [...mount.querySelectorAll<HTMLElement>('webview')].find(el => el.closest<HTMLElement>('[data-extension-view]')!.style.visibility === 'visible')!;
  expect(guest).toBeDefined(); guest.tabIndex = 0;
  if (!('getWebContentsId' in guest)) {
    const id = nextGuestId++;
    Object.defineProperty(guest, 'getWebContentsId', { configurable: true, value: () => id });
    // The host zooms an App page on its dom-ready (zoom B); a jsdom element has no Electron webview methods.
    Object.defineProperty(guest, 'setZoomFactor', { configurable: true, value: () => {} });
    await act(async () => guest.dispatchEvent(new Event('dom-ready')));
  }
  const claim = [...extensionViewStore.claims.values()].find(claim => claim.element.isConnected)!;
  expect(extensionViewStore.surfaceFor(claim.token), 'the actual bindSurface route is bound').toBe((guest as HTMLElement & { getWebContentsId(): number }).getWebContentsId());
  return guest;
}
async function clickFile(guest: HTMLElement, tabId: string) {
  const open = () => layout.open('file', { id: 'f02.txt' }, { from: tabId, intent: 'navigate' });
  // DOM blur alone does not return Electron's native input owner. Only the
  // existing host-focus RPC does. Native acceptance still uses real Electron.
  native.guest = guest; guest.focus(); guest.addEventListener('click', open, { once: true });
  await act(async () => guest.click()); await settle();
}
async function press(key: '[' | ']', tabId: string, page: string) {
  const received = vi.fn(); document.addEventListener('keydown', received, true);
  try {
    const target = native.guest ?? document.activeElement!;
    // A key in the guest is in another document and cannot bubble into host.
    if (!native.guest) await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key, code: key === '[' ? 'BracketLeft' : 'BracketRight', metaKey: true, bubbles: true, cancelable: true })));
    await settle();
    expect(received, `host keydown ${key}`).toHaveBeenCalledOnce();
    expect(document.activeElement?.tagName, 'host activeElement after the key').not.toBe('WEBVIEW');
    expect(layout.focusedPane.resolvedActiveTabId).toBe(tabId);
    expect(layout.focusedPane.entries.get(tabId)?.kind).toBe(page);
    expect(layout.focusedPane.navigationOf(tabId)?.pages.map(page => page.kind)).toEqual([kind, 'file']);
    expect(layout.focusedPane.navigationOf(tabId)?.index).toBe(page === kind ? 0 : 1);
    expect(globalBack).not.toHaveBeenCalled(); expect(globalForward).not.toHaveBeenCalled();
  } finally { document.removeEventListener('keydown', received, true); }
}
it('keeps host key routing, tab identity and forward history through four keys and a close/reopen cycle', async () => {
  let tabId = layout.open(kind, { id: 'folder' }, { from: null, intent: 'newTab' })!;
  await render();
  let guest = await readyGuest();
  await clickFile(guest, tabId);
  for (const key of ['[', ']', '[', ']'] as const) await press(key, tabId, key === '[' ? kind : 'file');
  await press('[', tabId, kind);
  const restoredGuest = await readyGuest();
  expect(restoredGuest, 'a genuinely bound guest survives history').toBe(guest);
  guest = restoredGuest;
  native.guest = guest; guest.focus();
  expect(document.activeElement, 'the visible folder guest before closing').toBe(guest);
  expect(extensionViewStore.claims.size, 'one visible folder claim before closing').toBe(1);
  await act(async () => layout.focusedPane.requestCloseTab(tabId)); await settle();
  expect(native.guest).toBeNull();
  expect(document.activeElement?.tagName, 'closed guest cannot own host focus').not.toBe('WEBVIEW');
  expect(extensionViewStore.claims.size).toBe(0);
  expect(guest.closest<HTMLElement>('[data-extension-view]')?.style.visibility).toBe('hidden');
  const closed = tabId;
  await act(async () => { tabId = layout.open(kind, { id: 'folder' }, { from: null, intent: 'newTab' })!; });
  await settle(); guest = await readyGuest();
  expect(tabId).not.toBe(closed);
  await clickFile(guest, tabId);
  expect(layout.focusedPane.tabOrder).toEqual([tabId]);
  for (const key of ['[', ']', '[', ']'] as const) await press(key, tabId, key === '[' ? kind : 'file');
});

it('ignores a retained unfocused pane even when the command context still points into it', async () => {
  const old = new PaneLayoutStore(layout.focusedPane.registry, { viewId: 'retained-old' });
  const oldId = old.open('file', { id: 'old-a' }, { from: null, intent: 'newTab' })!;
  old.open('file', { id: 'old-b' }, { from: oldId, intent: 'navigate' });
  const id = layout.open('file', { id: 'current-a' }, { from: null, intent: 'newTab' })!;
  layout.open('file', { id: 'current-b' }, { from: id, intent: 'navigate' });
  const previous = old.groups[0], current = layout.groups[0];
  try {
    await act(async () => root.render(<><CommandShortcutBinder />
      <div data-retained-old=""><PaneContext.Provider value={{ paneId: previous.paneId, pane: previous.pane, isFocusedPane: false }}><PaneContent hideTabBar /></PaneContext.Provider></div>
      <PaneContext.Provider value={{ paneId: current.paneId, pane: current.pane, isFocusedPane: true }}><PaneContent hideTabBar /></PaneContext.Provider></>));
    const stale = mount.querySelector<HTMLElement>('[data-retained-old] [data-file-page]')!;
    // Blurring into BODY does not emit focusin, so the existing binder retains
    // the previous DOM command context. A hidden pane must not answer it.
    await act(async () => { stale.focus(); stale.blur(); });
    expect(commandRegistry.contextElement).toBe(stale);
    await act(async () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '[', code: 'BracketLeft', metaKey: true, bubbles: true, cancelable: true })));
    expect(current.pane.entries.get(id)?.state).toEqual({ id: 'current-a' });
    expect(previous.pane.entries.get(oldId)?.state).toEqual({ id: 'old-b' });
  } finally { old.dispose(); }
});

it('rejects a closed guest source and distinguishes fresh navigation from saved separate placement', async () => {
  const saved = new Map<string, 'separate' | 'beside'>();
  const remembered = new PaneLayoutStore(layout.focusedPane.registry, { viewId: 'close-placement' }, undefined, {
    placementMemory: { read: key => saved.get(key), write: (key, value) => { saved.set(key, value); } },
  });
  try {
    const closed = remembered.open(kind, { id: 'folder' }, { from: null, intent: 'newTab' })!;
    remembered.open('file', { id: 'f02.txt' }, { from: closed, intent: 'navigate' });
    expect(remembered.focusedPane.tabOrder).toEqual([closed]);
    await remembered.focusedPane.go(closed, -1);
    remembered.focusedPane.closeTab(closed);
    const folder = remembered.open(kind, { id: 'folder' }, { from: null, intent: 'newTab' })!;
    expect(remembered.open('file', { id: 'stale.txt' }, { from: closed, intent: 'navigate' })).toBeUndefined();
    const before = [...remembered.focusedPane.tabOrder];
    // Closing the single pane's history records separate for its resources.
    // A saved placement intentionally overrides navigation; this is distinct
    // from an old guest directing a request through a no-longer-live tab id.
    const file = remembered.open('file', { id: 'f02.txt' }, { from: folder, intent: 'navigate' })!;
    expect(file).not.toBe(folder);
    expect(remembered.focusedPane.tabOrder).toEqual([...before, file]);
    remembered.focusedPane.setActiveTab(folder);
    const fresh = remembered.open('file', { id: 'fresh.txt' }, { from: folder, intent: 'navigate' });
    expect(fresh).toBe(folder);
    expect(remembered.focusedPane.entries.get(folder)?.state).toMatchObject({ id: 'fresh.txt' });
  } finally { remembered.dispose(); }
});

it.each(['forward', 'close'] as const)('returns host activeElement to the owning pane after %s from a bound guest', async action => {
  const id = layout.open(kind, { id: 'folder' }, { from: null, intent: 'newTab' })!;
  await render();
  const guest = await readyGuest();
  expect(rpc.extensions.bindSurface).toHaveBeenCalled();
  await clickFile(guest, id);
  await act(async () => { await layout.focusedPane.go(id, -1); }); await settle();
  expect(await readyGuest()).toBe(guest);
  // Electron restores its guest input owner when the folder is shown. Set up
  // that actual DOM focus, then exercise the real history/close lifecycle.
  guest.focus(); expect(document.activeElement).toBe(guest);
  if (action === 'forward') await act(async () => { await layout.focusedPane.go(id, 1); });
  else await act(async () => { layout.focusedPane.requestCloseTab(id); });
  await settle();
  const content = mount.querySelector<HTMLElement>('[data-pane-content]')!;
  expect(content.contains(document.activeElement), `host activeElement belongs to the pane after ${action}`).toBe(true);
  expect(document.activeElement).not.toBe(guest);
  if (action === 'forward') {
    expect(layout.focusedPane.resolvedActiveTabId).toBe(id);
    expect(layout.focusedPane.entries.get(id)?.kind).toBe('file');
    expect(layout.focusedPane.navigationOf(id)?.index).toBe(1);
  } else {
    expect(layout.focusedPane.entries.has(id)).toBe(false);
    expect(extensionViewStore.claims.size).toBe(0);
  }
});
