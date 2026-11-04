// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { createReactHarness } from '../../../support/testHarness';

const state = vi.hoisted(() => ({
  event: undefined as ((event: unknown) => void) | undefined,
  frame: {} as { reloadKey?: number; subscribeChanges?: (changed: (paths?: readonly string[]) => void) => () => void },
}));
vi.mock('@/components/preview/HtmlPreviewFrame', () => ({ HtmlPreviewFrame: (props: typeof state.frame) => { state.frame = props; return null; } }));
vi.mock('@/components/preview/html-preview-registration', () => ({ registerHtmlPreview: vi.fn() }));
vi.mock('@renderer/features/tabs/pane-context', () => ({ usePaneContext: () => ({ pane: { open: vi.fn() } }) }));
vi.mock('@renderer/features/sessions/session-view-context', () => ({ useSessionViewContext: () => ({ projectId: 'p' }), useWorkspaceId: () => 'w', useWorkspace: () => ({ path: '/w' }) }));
vi.mock('@renderer/lib/monaco/model-status-overlay', () => ({ ModelStatusOverlay: () => null }));
vi.mock('@renderer/lib/monaco/monaco-model-registry', () => ({ modelRegistry: { bufferVersions: new Map() } }));
vi.mock('@renderer/lib/monaco/use-model', () => ({ useModelStatus: () => 'ready' }));
vi.mock('@renderer/features/browser/browser-toolbar-actions', () => ({ openBrowserUrlExternally: vi.fn() }));
vi.mock('@renderer/features/sessions/workspace-backend/workspace-backend', () => ({ workspaceEvents: { on: (_channel: unknown, callback: typeof state.event) => { state.event = callback; return vi.fn(); } }, workspaceRpc: vi.fn(), workspaceBackend: vi.fn() }));
import { HtmlContentRenderer } from '@renderer/lib/editor/html-renderer';

const harnesses: Array<ReturnType<typeof createReactHarness>> = [];
afterEach(() => { harnesses.splice(0).forEach(harness => harness.cleanup()); state.event = undefined; });
it.each([
  { kind: 'incremental', changes: [{ path: '/w/noise.md' }, { path: '/w/sub/shot.png' }] },
  { kind: 'resync' },
])('does not turn $kind into a blind reload before checking fetched resources', async update => {
  const harness = createReactHarness(); harnesses.push(harness);
  await harness.render(createElement(HtmlContentRenderer, { filePath: '/w/index.html', rawContent: 'page' }));
  const changed = vi.fn(); state.frame.subscribeChanges?.(changed);
  await act(async () => state.event?.({ workspaceId: 'w', update }));
  expect(state.frame.reloadKey).toBeUndefined();
  expect(changed).toHaveBeenCalledExactlyOnceWith(update.kind === 'resync' ? undefined : update.changes?.map(change => change.path));
});
