import { createRoot, type Root } from 'react-dom/client';
import { act, type ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@/styles/tokens.css';
import '@renderer/index.css';

// Keep the real file view and resizable groups; only replace editor contents and services.
vi.mock('@renderer/features/sessions/editor/editor-provider', () => ({
  EditorProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@renderer/features/sessions/editor/file-content-renderer', () => ({ FileContentRenderer: () => null }));
vi.mock('@renderer/features/sessions/editor/file-content-preview', () => ({ FileContentPreview: () => null }));
vi.mock('@renderer/features/sessions/editor/editor-file-tree', () => ({ EditorFileTree: () => <div>Files</div> }));
vi.mock('@renderer/features/sessions/editor/file-content-types', () => ({
  FILE_CONTENT_TYPES: { text: { editable: true } },
}));
vi.mock('@renderer/features/sessions/editor/file-content-toolbar', () => ({
  FileContentToolbar: ({ onTreeVisibleChange }: { onTreeVisibleChange: (shown: boolean) => void }) => (
    <button onClick={() => onTreeVisibleChange(true)}>Show files</button>
  ),
}));
vi.mock('@renderer/features/sessions/workspace-backend/workspace-backend', () => ({ workspaceBackend: vi.fn() }));
vi.mock('@renderer/lib/monaco/monaco-model-registry', () => ({ modelRegistry: { deletedOnDisk: new Set() } }));
vi.mock('@renderer/localization/use-session-messages', () => ({
  useSessionMessages: () => ({ translate: (key: string) => key }),
}));

const { TabContent } = await import('@renderer/features/sessions/editor/file-tab-view');
const hostFor = (path: string) => ({
  resolvedTabs: [{ tabId: path, kind: 'file', isActive: true,
    resource: { path, isExternal: true, contentType: 'text', viewMode: 'source' } }],
});
const alpha = hostFor('Alpha.md');
const charlie = hostFor('Charlie.md');
let container: HTMLDivElement;
let root: Root;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

it('keeps an open file tree and a newly paired file in independent resizable groups', async () => {
  await page.viewport(1200, 700);
  container = document.createElement('div');
  container.className = 'gugu-skin';
  document.body.appendChild(container);
  root = createRoot(container);
  const draw = (paired: boolean) => act(() => root.render(
    <div style={{ display: 'flex', width: 1000, height: 400 }}>
      <div style={{ width: paired ? '50%' : '100%' }}>
        <TabContent host={alpha as never} ctx={{} as never} />
      </div>
      {paired && <div style={{ width: '50%' }}><TabContent host={charlie as never} ctx={{} as never} /></div>}
    </div>
  ));
  draw(false);
  await page.getByRole('button', { name: 'Show files' }).click();
  const groups = () => [...container.querySelectorAll<HTMLElement>('[data-slot=resizable-panel-group]')];
  const panels = (group: HTMLElement) => [...group.querySelectorAll<HTMLElement>('[data-slot=resizable-panel]')];
  await until('file tree has a measured width', () => groups()[0] !== undefined && panels(groups()[0]).length === 2 && panels(groups()[0])[1].offsetWidth > 0);
  draw(true);
  await until('both file views have painted', () => groups().length === 2 && panels(groups()[1])[0]?.offsetWidth > 0);
  // ResizeObserver must use each group's own layout, including when their panel counts differ.
  container.style.width = '999px';
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  expect(groups().map((group) => panels(group).length)).toEqual([2, 1]);
  expect(groups()[0].id).not.toBe(groups()[1].id);
  expect(panels(groups()[1])[0].getBoundingClientRect().width).toBeCloseTo(500, 0);
});
