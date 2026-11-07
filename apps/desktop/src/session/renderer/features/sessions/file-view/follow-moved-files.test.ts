import { describe, expect, it, vi } from 'vitest';
import { followMovedFiles } from './follow-moved-files';

const tab = (tabId: string, kind: string, resource: object) => ({ tabId, kind, resource: resource as never });
function layoutWith(...tabs: ReturnType<typeof tab>[]) {
  const closeTab = vi.fn();
  const open = vi.fn();
  return { layout: { groups: [{ pane: { resolvedTabs: tabs, closeTab } }], open }, closeTab, open };
}

describe('tabs follow a file of the working copy', () => {
  it('a rename moves the tab showing it, and those under a renamed folder; a neighbour with the same prefix stays', () => {
    const { layout, closeTab, open } = layoutWith(
      tab('a', 'workspace.file', { filePath: '/r/docs/a.md' }),
      tab('b', 'file-view', { path: '/r/docs/sub/b.png' }),
      tab('c', 'workspace.file', { filePath: '/r/docs-old/c.md' }),
    );
    followMovedFiles(layout, '/r', 'docs', 'notes');
    expect(closeTab.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
    expect(open.mock.calls.map(([kind, args]) => [kind, args])).toEqual([
      ['workspace.file', { filePath: '/r/notes/a.md' }],
      ['file-view', { path: '/r/notes/sub/b.png' }],
    ]);
  });

  it('a delete closes it and opens nothing', () => {
    const { layout, closeTab, open } = layoutWith(tab('a', 'file-view', { path: '/r/a.png' }));
    followMovedFiles(layout, '/r', 'a.png', null);
    expect(closeTab).toHaveBeenCalledWith('a');
    expect(open).not.toHaveBeenCalled();
  });

  it('a tab holding unsaved edits stays, and other kinds of tab are not looked at', () => {
    const { layout, closeTab, open } = layoutWith(
      tab('dirty', 'workspace.file', { filePath: '/r/a.md', holdsUnsaved: true }),
      tab('diff', 'diff', { path: '/r/a.md' }),
    );
    followMovedFiles(layout, '/r', 'a.md', 'b.md');
    expect(closeTab).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});
