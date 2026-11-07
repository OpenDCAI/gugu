// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const store = vi.hoisted(() => ({ claim: vi.fn(() => 1), release: vi.fn() }));
vi.mock('../../../apps/desktop/src/session/renderer/features/extensions/extension-view-store', () => ({ extensionViewStore: store }));
vi.mock('../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store', () => ({
  installedExtensionsStore: { isLoaded: false, residentTabContributions: [] },
}));

import { ClaimedPage } from '../../../apps/desktop/src/components/appSlot/ClaimedPage';

let root: Root;
let container: HTMLDivElement;
const page = (navigation: { canBack: boolean; canForward: boolean; backToConversation?: boolean }) =>
  <ClaimedPage slotId="slot" chatId="chat" kind="app.main" navigation={navigation} />;

beforeEach(() => {
  store.claim.mockClear();
  store.release.mockClear();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  HTMLElement.prototype.checkVisibility = () => true;
  HTMLElement.prototype.getBoundingClientRect = () => ({ width: 10, height: 10 }) as DOMRect;
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('a parent drawing the same navigation anew keeps the claim: a page told to hide and show on every render never settles', () => {
  act(() => root.render(page({ canBack: false, canForward: false })));
  act(() => root.render(page({ canBack: false, canForward: false })));
  expect(store.claim).toHaveBeenCalledTimes(1);
  expect(store.release).not.toHaveBeenCalled();
});

it('a navigation that says something else claims again with what it says', () => {
  act(() => root.render(page({ canBack: false, canForward: false })));
  act(() => root.render(page({ canBack: true, canForward: false })));
  expect(store.claim).toHaveBeenCalledTimes(2);
  expect(store.release).toHaveBeenCalledTimes(1);
  expect(store.claim).toHaveBeenLastCalledWith('app.main', expect.objectContaining({ navigation: { canBack: true, canForward: false } }));
});
