// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExtensionTabPane } from './extension-tab-pane';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  bindSurface: vi.fn(async () => ({ success: true })),
  retargetSurface: vi.fn(async () => ({ success: true })),
  reportLayout: vi.fn(async () => undefined),
  activate: vi.fn(async () => ({ success: true, data: { partition: 'persist:app', entryUrl: 'gugu-ext://app/index.html' } })),
}));

vi.mock('@renderer/lib/ipc', () => ({ rpc: { extensions: h } }));
vi.mock('@/lib/taskConversation', () => ({ useTaskConversation: () => null, useTaskProjectChat: () => null }));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));
vi.mock('./extension-tab-toolbar', () => ({ ExtensionTabToolbar: () => null }));

let root: Root;
let host: HTMLDivElement;

const pane = (tabId: string, filePath: string) => (
  <ExtensionTabPane extensionId="app" tabKind="app.file" sessionId="task" tabId={tabId} filePath={filePath} />
);
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

// Tabs of one kind share one pane and one webview: dom-ready fires once, so another tab has to move that live guest.
it('moves the loaded page to the file of the tab it now draws', async () => {
  act(() => root.render(pane('tab-a', '/w/a.md')));
  await settle();
  const webview = host.querySelector('webview') as HTMLElement & { getWebContentsId: () => number; setZoomFactor: (factor: number) => void };
  webview.getWebContentsId = () => 7;
  // The host zooms an App's page (#1816): the page gets its zoom on dom-ready.
  webview.setZoomFactor = vi.fn();
  await act(async () => { webview.dispatchEvent(new Event('dom-ready')); });
  await settle();
  expect(h.bindSurface).toHaveBeenCalledWith(expect.objectContaining({ webContentsId: 7, tabId: 'tab-a', filePath: '/w/a.md' }));

  act(() => root.render(pane('tab-b', '/w/b.md')));
  await settle();

  expect(host.querySelector('webview')).toBe(webview);
  expect(h.retargetSurface).toHaveBeenCalledWith(expect.objectContaining({ webContentsId: 7, tabId: 'tab-b', filePath: '/w/b.md' }));
  // Retargeting keeps the live page and its zoom binding: zoom was applied once, by the one dom-ready.
  expect(webview.setZoomFactor).toHaveBeenCalledTimes(1);
});
