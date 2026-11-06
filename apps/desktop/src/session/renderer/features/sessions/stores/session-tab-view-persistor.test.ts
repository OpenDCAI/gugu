import { describe, expect, it, vi } from 'vitest';
import type { TabGroupsSnapshot } from '@shared/view-state';

vi.mock('@renderer/features/tabs/tab-view-persistor', () => ({ TabViewPersistor: class {} }));
const { normalizeTabGroupsSnapshot } = await import('./session-tab-view-persistor');

const snapshot = (tabs: unknown[]): TabGroupsSnapshot =>
  ({ groups: [{ groupId: 'g', tabManager: { tabs, activeTabId: undefined } }], activeGroupId: 'g', paneSizes: [100] }) as TabGroupsSnapshot;
const tabsOf = (result: TabGroupsSnapshot) => result.groups[0]!.tabManager.tabs;

describe('a saved layout keeps its file tabs', () => {
  it('a non-text file tab becomes the file preview tab, a text one the folder App tab, same tab id', () => {
    const result = normalizeTabGroupsSnapshot(snapshot([
      { kind: 'file', tabId: 'pdf', path: 'docs/a.pdf' },
      { kind: 'file', tabId: 'ts', path: 'src/a.ts' },
    ]), '/repo');
    expect(tabsOf(result)).toEqual([
      { kind: 'file-view', tabId: 'pdf', path: '/repo/docs/a.pdf' },
      { kind: 'extension', extensionKind: 'workspace.file', tabId: 'ts', state: { filePath: '/repo/src/a.ts' } },
    ]);
  });

  it('a file outside the workspace keeps its path as saved', () => {
    const result = normalizeTabGroupsSnapshot(snapshot([{ kind: 'file', tabId: 'x', path: '/tmp/a.png', isExternal: true }]), '/repo');
    expect(tabsOf(result)).toEqual([{ kind: 'file-view', tabId: 'x', path: '/tmp/a.png', isExternal: true }]);
  });

  it('pages in a tab\'s history move too, other kinds untouched', () => {
    const history = { index: 1, pages: [{ kind: 'file', state: { path: '/repo/a.pdf' } }, { kind: 'browser', state: { url: 'x' } }] };
    const result = normalizeTabGroupsSnapshot(snapshot([{ kind: 'file', tabId: 't', path: '/repo/a.ts', history }]), '/repo');
    expect(tabsOf(result)[0]!.history!.pages.map((page) => page.kind)).toEqual(['file-view', 'browser']);
  });
});
