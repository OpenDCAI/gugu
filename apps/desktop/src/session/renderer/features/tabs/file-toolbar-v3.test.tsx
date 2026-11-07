// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { PaneContext } from '@renderer/features/tabs/pane-context';
import { PaneLayoutStore } from '@renderer/features/tabs/pane-layout-store';
import { createTabProvider, createTabRegistry } from '@renderer/features/tabs/core/tab-provider-registry';
import { MessageFilePreviewPanel } from '@/components/chat/MessageFilePreviewPanel';

vi.mock('react-i18next', async (original) => ({ ...await original<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));
vi.mock('@/components/markdown/Markdown', () => ({ Markdown: () => null }));
vi.mock('@/components/chat/DocumentPreviewContent', () => ({ DocumentPreviewContent: () => null }));
const host = document.createElement('div');
document.body.appendChild(host);
const root = createRoot(host);
let layout: PaneLayoutStore;
afterEach(() => { act(() => root.render(null)); layout?.dispose(); });
function mount(fromConversation: boolean, narrow = true) {
  const provider = (kind: string, conversation = false) => createTabProvider({ kind, conversation, resourceKey: (s: { id: string }) => s.id, initialize: () => ({ dispose() {} }), dispose() {}, TabBarItem: () => null, TabBarItemDragPreview: () => null, TabContent: () => null });
  layout = new PaneLayoutStore(createTabRegistry([provider('conversation', true), provider('file')]), { viewId: 'file-toolbar' });
  layout.focusedPane.setDimensions(390, 620);
  layout.setNarrow(narrow);
  const source = layout.open(fromConversation ? 'conversation' : 'file', { id: 'source' }, { from: null, intent: 'newTab' })!;
  const file = layout.open('file', { id: 'file' }, { from: source, intent: 'navigate' })!;
  // From a conversation the file is the side of a pair (kept even when narrow, owner 11-05); else it is in place.
  const pane = layout.focusedPane;
  act(() => root.render(<PaneContext.Provider value={{ pane, paneId: layout.activePaneId, isFocusedPane: true }}><MessageFilePreviewPanel tabbed fill file={{ fileName: 'group-notes.txt', sizeBytes: 38, mimeType: 'text/plain' }} kind="text" content="notes" loading={false} onClose={() => {}} /></PaneContext.Provider>));
  return { source, file, pane };
}
it('returns to its own conversation from the file toolbar without changing tab ids or layout', async () => {
  const { source, pane } = mount(true);
  const ids = [...pane.tabOrder], tree = JSON.stringify(layout.layout);
  const back = host.querySelector<HTMLButtonElement>('[data-testid="tab-return-conversation"]');
  expect(back).not.toBeNull();
  expect(back!.closest('[data-tab-content-toolbar]')).not.toBeNull();
  await act(async () => back!.click());
  expect(layout.focusedPane.resolvedActiveTabId).toBe(source);
  expect(pane.tabOrder).toEqual(ids);
  expect(JSON.stringify(layout.layout)).toBe(tree);
});
it('has no way back while the conversation it came from is beside it', () => {
  mount(true, false);
  expect(host.querySelector('[data-file-toolbar]')).not.toBeNull();
  expect(host.querySelector('[data-testid="tab-return-conversation"]')).toBeNull();
});
it('uses the shared file toolbar for an unclaimed group file with read-only editing and navigation', async () => {
  const { pane } = mount(false);
  const toolbar = host.querySelector('[data-file-toolbar]');
  expect(toolbar).not.toBeNull();
  const labels = [...toolbar!.querySelectorAll('button')].map((button) => button.getAttribute('aria-label'));
  // One mode toggle (owner 11-06): reading, it is ✎ (edit) — disabled for a read-only file.
  expect(labels).toEqual(['tabs.back', 'tabs.edit', 'tabs.more']);
  expect(toolbar!.querySelector<HTMLButtonElement>('[aria-label="tabs.edit"]')!.disabled).toBe(true);
  await act(async () => toolbar!.querySelector<HTMLButtonElement>('[aria-label="tabs.back"]')!.click());
  expect(pane.navigationOf(pane.resolvedActiveTabId!)?.index).toBe(0);
});
