import type { GitChangeStatus, GitObjectRef } from '@gugu/session-core/git';
import type { TabEntry, TabHandle, TabProvider, TabViewContext } from '@renderer/features/tabs/core/tab-provider';
import { createTabProvider } from '@renderer/features/tabs/core/tab-provider-registry';
import { registeredTabView } from '@renderer/features/tabs/core/tab-views';
import type { SessionTabContext } from '@renderer/features/tabs/core/session-tab-context';
import type { ActiveFile } from '@shared/view-state';
import { resolveWorkspacePath } from '../stores/workspace-path';
import { DiffTabBarItem, DiffTabBarItemDragPreview } from './diff-tab-item';
import { getDiffTabManager } from './stores/diff-tab-manager';
import type { DiffPayload } from './stores/diff-tab-resource';
import { DiffTabResource } from './stores/diff-tab-resource';

export interface DiffOpenArgs {
  activeFile: ActiveFile;
  status?: GitChangeStatus;
}

function refKey(ref: GitObjectRef): string {
  switch (ref.kind) {
    case 'branch':
      return `branch:${ref.branch.type === 'remote' ? `${ref.branch.remote.name}/${ref.branch.branch}` : ref.branch.branch}`;
    case 'commit':
      return `commit:${ref.sha}`;
    case 'tag':
      return `tag:${ref.name}`;
  }
}

function diffResourceKey(s: DiffPayload): string {
  const base = `${s.path}|${s.diffGroup}`;
  if (s.diffGroup === 'disk' || s.diffGroup === 'staged') return base;
  const origKey = refKey(s.originalRef);
  const modKey = s.modifiedRef ? refKey(s.modifiedRef) : '';
  return `${base}|${origKey}|${modKey}`;
}

function activeFileToDiffPayload(
  activeFile: ActiveFile,
  status: GitChangeStatus | undefined,
  workspacePath: string | undefined
): DiffPayload {
  const path =
    activeFile.group === 'pr'
      ? activeFile.path
      : resolveWorkspacePath(workspacePath, activeFile.path);
  return {
    path,
    diffGroup: activeFile.group,
    originalRef: activeFile.originalRef,
    modifiedRef: activeFile.modifiedRef,
    prNumber: activeFile.prNumber,
    prBaseOid: activeFile.prBaseOid,
    prHeadOid: activeFile.prHeadOid,
    commitOriginalSha: activeFile.commitOriginalSha,
    commitModifiedSha: activeFile.commitModifiedSha,
    status,
  };
}

export const diffTabProvider: TabProvider<'diff', DiffPayload, DiffTabResource, DiffOpenArgs> =
  createTabProvider({
    kind: 'diff',
    mount: 'single',
    resourceKey: diffResourceKey,

    onBeforeOpen(args: DiffOpenArgs, ctx: TabViewContext): DiffPayload | null {
      return activeFileToDiffPayload(
        args.activeFile,
        args.status,
        (ctx as SessionTabContext).workspacePath
      );
    },

    initialize(
      entry: TabEntry<DiffPayload>,
      handle: TabHandle,
      ctx: TabViewContext
    ): DiffTabResource {
      const sessionCtx = ctx as SessionTabContext;
      return new DiffTabResource(
        entry.tabId,
        entry.state,
        getDiffTabManager(sessionCtx.workspaceId),
        handle
      );
    },

    dispose(_entry: TabEntry<DiffPayload>, resource: DiffTabResource): void {
      resource.dispose();
    },

    TabBarItem: DiffTabBarItem,
    TabBarItemDragPreview: DiffTabBarItemDragPreview,
    TabContent: registeredTabView('diff'),
  });

export function diffGroupSuffix(diffGroup: DiffPayload['diffGroup']): string {
  switch (diffGroup) {
    case 'disk':
      return '(Working Tree)';
    case 'staged':
      return '(Index)';
    case 'pr':
      return '(PR)';
    case 'git':
      return '(Git)';
  }
}
