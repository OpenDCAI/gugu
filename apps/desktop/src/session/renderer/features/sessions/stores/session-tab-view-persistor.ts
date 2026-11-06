import type { SessionTabContext } from '@renderer/features/tabs/core/session-tab-context';
import { TabViewPersistor } from '@renderer/features/tabs/tab-view-persistor';
import {
  isBuiltInTabKind,
  type TabDescriptor,
  type TabGroupsSnapshot,
  type SessionViewSnapshot,
  type TabPageSnapshot,
} from '@shared/view-state';
import { fileTabTarget } from '../file-view/file-view-kinds';
import { resolveWorkspacePath } from './workspace-path';

/** Task-only normalization and migration; persistence itself is shared by all tab hosts. */
export function createSessionTabPersistor(ctx: SessionTabContext): TabViewPersistor {
  return new TabViewPersistor(`session:${ctx.viewId}`, {
    normalize: (snapshot) => normalizeTabGroupsSnapshot(snapshot, ctx.workspacePath),
    migrate: (aggregate) => migrateLegacyTabs(aggregate as SessionViewSnapshot | undefined),
  });
}

export function normalizeTabGroupsSnapshot(
  snapshot: TabGroupsSnapshot,
  workspacePath: string | undefined
): TabGroupsSnapshot {
  return {
    ...snapshot,
    groups: snapshot.groups.map((group) => ({
      ...group,
      tabManager: {
        ...group.tabManager,
        tabs: group.tabManager.tabs.map((tab) => normalizeTabDescriptor(tab, workspacePath)),
      },
    })),
  };
}

function normalizeTabDescriptor(
  tab: TabDescriptor,
  workspacePath: string | undefined
): TabDescriptor {
  const persistedKind = (tab as { kind: string }).kind;
  // A layout saved before the old file tab went: the tab stays, with the same id, in the tab its file opens in now.
  if (persistedKind === 'file') {
    const old = tab as unknown as { path: string; isExternal?: boolean };
    return migratedFileTab(tab, old.isExternal ? old.path : resolveWorkspacePath(workspacePath, old.path), old.isExternal);
  }
  if (persistedKind !== 'extension' && !isBuiltInTabKind(persistedKind)) {
    const { kind: extensionKind, tabId, history, openerTabId, companionPaneId: _companionPaneId, isPreview: _isPreview, returnTo: _returnTo, ...state } = tab as unknown as TabDescriptor & {
      kind: string;
      tabId: string;
      isPreview: boolean;
      [key: string]: unknown;
    };
    return { kind: 'extension', extensionKind, tabId, state, ...(history ? { history } : {}), ...(openerTabId ? { openerTabId } : {}) };
  }
  if (tab.kind === 'file-view' && !tab.isExternal) {
    return { ...tab, path: resolveWorkspacePath(workspacePath, tab.path) };
  }
  if (tab.kind === 'diff' && tab.diffGroup !== 'pr') {
    return { ...tab, path: resolveWorkspacePath(workspacePath, tab.path) };
  }
  return tab;
}

function migratedPage(page: TabPageSnapshot): TabPageSnapshot {
  const { path, isExternal } = (page.state ?? {}) as { path?: unknown; isExternal?: boolean };
  if (page.kind !== 'file' || typeof path !== 'string') return page;
  const target = fileTabTarget(path, isExternal);
  return { ...page, kind: target.kind, state: target.kind === 'file-view' ? { path, ...(isExternal ? { isExternal } : {}) } : target.args };
}

function migratedFileTab(tab: TabDescriptor, path: string, isExternal?: boolean): TabDescriptor {
  const { tabId, history, openerTabId } = tab;
  const kept = { ...(history ? { history: { ...history, pages: history.pages.map(migratedPage) } } : {}), ...(openerTabId ? { openerTabId } : {}) };
  const target = fileTabTarget(path, isExternal);
  return target.kind === 'file-view'
    ? { kind: 'file-view', tabId, path, ...(isExternal ? { isExternal } : {}), ...kept }
    : { kind: 'extension', extensionKind: target.kind, tabId, state: target.args, ...kept };
}

/**
 * Extract a `TabGroupsSnapshot` from a legacy aggregate snapshot, supporting
 * all three historical formats.
 */
function migrateLegacyTabs(aggregate: SessionViewSnapshot | undefined): TabGroupsSnapshot | null {
  if (!aggregate) return null;

  if (aggregate.tabGroups) {
    return aggregate.tabGroups;
  }

  if (aggregate.tabManager) {
    return {
      groups: [{ groupId: crypto.randomUUID(), tabManager: aggregate.tabManager }],
      activeGroupId: '',
      paneSizes: [100],
    };
  }

  if (aggregate.sessions?.tabOrder?.length) {
    return {
      groups: [
        {
          groupId: crypto.randomUUID(),
          tabManager: {
            tabs: aggregate.sessions.tabOrder.map((id) => ({
              kind: 'session' as const,
              tabId: crypto.randomUUID(),
              sessionId: id,
            })),
            activeTabId: undefined,
          },
        },
      ],
      activeGroupId: '',
      paneSizes: [100],
    };
  }

  return null;
}
