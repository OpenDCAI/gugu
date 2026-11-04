// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createReactHarness } from '../../../support/testHarness';

const state = vi.hoisted(() => ({
  text: '<p>long page</p>',
  files: {
    createPreview: vi.fn(),
    setPreviewDocument: vi.fn(async () => ({ success: true })),
    releasePreview: vi.fn(async () => ({ success: true })),
    previewAssetsChanged: vi.fn(async () => ({ success: true, data: false })),
  },
  pane: { open: vi.fn() },
}));
vi.mock('@/platform', () => ({ platform: { kind: 'electron' } }));
vi.mock('@/session/renderer/lib/ipc', () => ({ rpc: { workspace: { files: state.files } } }));
vi.mock('@renderer/features/tabs/pane-context', () => ({ usePaneContext: () => ({ pane: state.pane }) }));
vi.mock('@renderer/features/sessions/session-view-context', () => ({ useSessionViewContext: () => ({ projectId: 'p' }), useWorkspaceId: () => 'w', useWorkspace: () => ({ path: '/w' }) }));
vi.mock('@renderer/lib/monaco/model-status-overlay', () => ({ ModelStatusOverlay: () => null }));
vi.mock('@renderer/lib/monaco/monaco-model-registry', () => ({ modelRegistry: { bufferVersions: new Map(), getText: () => state.text, dirtyUris: new Set() } }));
vi.mock('@renderer/lib/monaco/use-model', () => ({ useModelStatus: () => 'ready' }));
vi.mock('@renderer/features/browser/browser-toolbar-actions', () => ({ openBrowserUrlExternally: vi.fn() }));
vi.mock('@renderer/features/sessions/workspace-backend/workspace-backend', () => ({ workspaceEvents: { on: () => vi.fn() }, workspaceRpc: () => ({ files: state.files }), workspaceBackend: vi.fn() }));

import { HtmlRenderer } from '@renderer/lib/editor/html-renderer';
import { FileTabResource } from '@renderer/features/sessions/editor/stores/file-tab-resource';

let harness: ReturnType<typeof createReactHarness>;
beforeEach(() => {
  harness = createReactHarness();
  vi.clearAllMocks();
  state.text = '<p>long page</p>';
  let id = 0;
  state.files.createPreview.mockImplementation(async () => {
    const previewId = String(++id);
    return { success: true, data: { previewId, url: `gugu-preview://${previewId}/index.html` } };
  });
});
afterEach(() => harness.cleanup());
const draw = (tab: FileTabResource) => harness.render(tab.viewMode === 'preview'
  ? createElement(HtmlRenderer, { tab }) : createElement('div', {}, 'source editor'));

it.each([false, true])('restores the same file tab after switching to source and back (edited=%s)', async edited => {
  const tab = new FileTabResource({ path: '/w/index.html' });
  await draw(tab);
  const first = harness.container.querySelector('iframe')!;
  await act(async () => window.dispatchEvent(new MessageEvent('message', {
    source: first.contentWindow, data: { type: 'gugu-preview-scroll', x: 12, y: 7000 },
  })));
  tab.setViewMode('source');
  await draw(tab);
  expect(state.files.releasePreview).toHaveBeenCalledTimes(1);
  if (edited) state.text = '<p>edited but still long enough</p>';
  tab.setViewMode('preview');
  await draw(tab);
  const restored = harness.container.querySelector('iframe')!;
  expect(restored).not.toBe(first);
  const post = vi.spyOn(restored.contentWindow!, 'postMessage');
  await act(async () => restored.dispatchEvent(new Event('load')));
  expect(post).toHaveBeenCalledWith({ type: 'gugu-preview-restore-scroll', x: 12, y: 7000 }, '*');
  expect(state.files.createPreview).toHaveBeenLastCalledWith('p', 'w', '/w/index.html', state.text);
});

it('isolates positions by open tab and ignores messages from a released preview', async () => {
  const original = new FileTabResource({ path: '/w/index.html' });
  await draw(original);
  const first = harness.container.querySelector('iframe')!;
  const oldWindow = first.contentWindow;
  await act(async () => window.dispatchEvent(new MessageEvent('message', {
    source: oldWindow, data: { type: 'gugu-preview-scroll', x: 0, y: 7000 },
  })));
  original.setViewMode('source'); await draw(original);
  // A new tab for even the same path starts at the top instead of sharing global path memory.
  const other = new FileTabResource({ path: '/w/index.html' });
  await draw(other);
  const second = harness.container.querySelector('iframe')!;
  const secondPost = vi.spyOn(second.contentWindow!, 'postMessage');
  await act(async () => second.dispatchEvent(new Event('load')));
  expect(secondPost).toHaveBeenCalledWith({ type: 'gugu-preview-restore-scroll', x: 0, y: 0 }, '*');
  await act(async () => window.dispatchEvent(new MessageEvent('message', {
    source: second.contentWindow, data: { type: 'gugu-preview-scroll', x: 0, y: 500 },
  })));
  other.setViewMode('source'); await draw(other);
  original.setViewMode('preview'); await draw(original);
  const returned = harness.container.querySelector('iframe')!;
  const post = vi.spyOn(returned.contentWindow!, 'postMessage');
  await act(async () => window.dispatchEvent(new MessageEvent('message', {
    source: oldWindow, data: { type: 'gugu-preview-scroll', x: 0, y: 3 },
  })));
  await act(async () => returned.dispatchEvent(new Event('load')));
  expect(post).toHaveBeenCalledWith({ type: 'gugu-preview-restore-scroll', x: 0, y: 7000 }, '*');
});
