// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { extensionViewStore, residentPageKey, residentPlace } from './extension-view-store';
import { ExtensionPage } from './extension-view-layer';

const focusHost = vi.hoisted(() => vi.fn(async () => ({ success: true })));
vi.mock('@renderer/lib/ipc', () => ({ rpc: { browser: { focusHost }, extensions: { activate: async () => ({ success: true, data: { partition: 'test', entryUrl: 'about:blank' } }) } } }));
vi.mock('./installed-extensions-store', () => ({ installedExtensionsStore: { manifestFor: () => undefined } }));
vi.mock('./extension-surface-store', () => ({ extensionSurfaceStore: { setWebContentsId() {}, forgetShared() {} } }));
vi.mock('./app-settings-page', () => ({ AppSettingsPage: () => null }));

let root: Root;
let host: HTMLDivElement;
let slot: HTMLDivElement;
const kind = 'workspace.main';
const target = { sessionId: 'root-focus', tabId: 'folder' };
let token: number;
beforeEach(() => {
  focusHost.mockClear();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1280, 900));
  Object.defineProperty(HTMLElement.prototype, 'checkVisibility', { configurable: true, value: () => true });
  host = document.createElement('div'); slot = document.createElement('div');
  document.body.append(slot, host); root = createRoot(host);
  token = extensionViewStore.claim(kind, { ...target, element: slot });
});
afterEach(() => { act(() => root.unmount()); extensionViewStore.release(kind, token); host.remove(); slot.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function mount() {
  const layer = createRef<HTMLDivElement>(); layer.current = host;
  await act(async () => root.render(<ExtensionPage kind={kind} extensionId="workspace" layerRef={layer} pageKey={residentPageKey(kind, residentPlace(target))} />));
  const guest = host.querySelector<HTMLElement>('webview')!;
  expect(guest).not.toBeNull(); guest.tabIndex = 0;
  // Resident guests really live outside their claiming pane, not inside it.
  expect(slot.contains(guest)).toBe(false);
  return guest;
}
it('releases focus from the real root resident guest when its folder claim is released', async () => {
  const guest = await mount(); guest.focus();
  expect(document.activeElement).toBe(guest);
  await act(async () => extensionViewStore.release(kind, token));
  expect(guest.isConnected).toBe(true);
  expect(host.querySelector<HTMLElement>('[data-extension-view]')!.style.visibility).toBe('hidden');
  expect(document.activeElement).toBe(document.body);
  expect(focusHost).toHaveBeenCalledOnce();
});
it('does not blur another host input while the resident folder is hidden', async () => {
  await mount(); const input = document.createElement('input'); document.body.appendChild(input); input.focus();
  try { await act(async () => extensionViewStore.release(kind, token)); expect(document.activeElement).toBe(input); expect(focusHost).not.toHaveBeenCalled(); }
  finally { input.remove(); }
});
