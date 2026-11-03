import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { MessageFilePreviewPanel } from '@/components/chat/MessageFilePreviewPanel';
import { PaneContext } from '@renderer/features/tabs/pane-context';
import { PaneLayoutStore } from '@renderer/features/tabs/pane-layout-store';
import { createTabProvider, createTabRegistry } from '@renderer/features/tabs/core/tab-provider-registry';
import '@gugu/session-ui/styles/global';
import '@gugu/session-ui/theme/theme.css';
import '@gugu/session-ui/theme/semantic.css';
import '@gugu/session-ui/styles/base.css';
import '@/styles/tokens.css';
import '@renderer/index.css';

vi.mock('@/components/markdown/Markdown', () => ({ Markdown: () => null }));
vi.mock('@/components/chat/DocumentPreviewContent', () => ({ DocumentPreviewContent: () => null }));
const host = document.createElement('div');
document.body.appendChild(host);
const root = createRoot(host);
let layout: PaneLayoutStore;
afterEach(() => { root.render(null); layout?.dispose(); document.body.classList.remove('gugu-skin'); });

it.each([250, 390])('keeps the real file toolbar and return button inside a %spx pane below its strip', async (width) => {
  await page.viewport(1100, 800);
  document.body.classList.add('gugu-skin');
  const provider = (kind: string, conversation = false) => createTabProvider({ kind, conversation, resourceKey: (s: { id: string }) => s.id, initialize: () => ({ dispose() {} }), dispose() {}, TabBarItem: () => null, TabBarItemDragPreview: () => null, TabContent: () => null });
  layout = new PaneLayoutStore(createTabRegistry([provider('conversation', true), provider('file')]), { viewId: 'file-toolbar-geometry' });
  layout.focusedPane.setDimensions(width, 620);
  const source = layout.open('conversation', { id: 'chat' }, { from: null, intent: 'newTab' })!;
  layout.open('file', { id: 'group-notes.txt' }, { from: source, intent: 'navigate' });
  Object.assign(host.style, { position: 'absolute', left: '210px', top: '45px', width: `${width}px`, height: '620px' });
  await act(async () => root.render(<PaneContext.Provider value={{ pane: layout.focusedPane, paneId: layout.activePaneId, isFocusedPane: true }}><MessageFilePreviewPanel fill tabbed file={{ fileName: 'group-notes.txt', mimeType: 'text/plain', sizeBytes: 38 }} kind="text" content="File body" loading={false} onClose={() => {}} /></PaneContext.Provider>));
  await until('the shared file toolbar is mounted', () => host.querySelector('[data-file-toolbar]') !== null);
  const toolbar = host.querySelector<HTMLElement>('[data-file-toolbar]')!;
  const box = host.getBoundingClientRect();
  expect(host.querySelectorAll('[role="toolbar"]')).toHaveLength(1);
  for (const button of toolbar.querySelectorAll('button')) {
    const rect = button.getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(box.left);
    expect(rect.right).toBeLessThanOrEqual(box.right + 1);
    expect(rect.top).toBeGreaterThanOrEqual(box.top);
  }
  expect(toolbar.scrollWidth).toBeLessThanOrEqual(toolbar.clientWidth + 1);
  expect(host.querySelector('pre')!.getBoundingClientRect().top - box.top).toBeLessThanOrEqual(48);
});
