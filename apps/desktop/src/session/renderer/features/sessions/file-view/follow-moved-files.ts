import type { TabResource } from '@renderer/features/tabs/core/tab-provider';
import { resolveWorkspacePath } from '../stores/workspace-path';
import { FOLDER_APP_FILE_TAB, fileTabTarget } from './file-view-kinds';

type FollowingTab = { tabId: string; kind: string; resource: TabResource };
type FollowingPane = { resolvedTabs: readonly FollowingTab[]; closeTab(tabId: string): unknown };
type FollowingLayout = {
  groups: readonly { pane: FollowingPane }[];
  open(kind: string, args: Record<string, unknown>, config: { from: string | null; intent: 'newTab' }): unknown;
};

const isWithin = (path: string, parent: string) => path === parent || path.startsWith(`${parent}/`);

function fileOf(tab: FollowingTab): string | undefined {
  const resource = tab.resource as { path?: string; filePath?: string };
  return tab.kind === 'file-view' ? resource.path : tab.kind === FOLDER_APP_FILE_TAB ? resource.filePath : undefined;
}

/** A working copy's file moved or was deleted: the tabs showing it follow to its new path, or close. Unsaved edits stay put. */
export function followMovedFiles(layout: FollowingLayout, workspacePath: string | undefined, from: string, to: string | null): void {
  const moved = resolveWorkspacePath(workspacePath, from);
  const now = to === null ? null : resolveWorkspacePath(workspacePath, to);
  for (const { pane } of layout.groups) {
    for (const tab of pane.resolvedTabs) {
      const file = fileOf(tab);
      if (!file || !isWithin(file, moved) || (tab.resource as { holdsUnsaved?: boolean }).holdsUnsaved) continue;
      void pane.closeTab(tab.tabId);
      if (now === null) continue;
      const target = fileTabTarget(now + file.slice(moved.length));
      layout.open(target.kind, target.args, { from: null, intent: 'newTab' });
    }
  }
}
