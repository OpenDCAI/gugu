import type { SessionTabContext } from '@renderer/features/tabs/core/session-tab-context';
import { TabViewPersistor } from '@renderer/features/tabs/tab-view-persistor';
import {
  isBuiltInTabKind,
  type TabDescriptor,
  type TabGroupsSnapshot,
  type SessionViewSnapshot,
} from '@shared/view-state';
import { resolveWorkspacePath } from './workspace-path';

/** Task-only normalization and migration; persistence itself is shared by all tab hosts. */
export function createSessionTabPersistor(ctx: SessionTabContext): TabViewPersistor {
  return new TabViewPersistor(`session:${ctx.viewId}`, {
    normalize: (snapshot) => normalizeTabGroupsSnapshot(snapshot, ctx.workspacePath),
    migrate: (aggregate) => migrateLegacyTabs(aggregate as SessionViewSnapshot | undefined),
  });
}

function normalizeTabGroupsSnapshot(
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
  if (persistedKind !== 'extension' && !isBuiltInTabKind(persistedKind)) {
    const { kind: extensionKind, tabId, isPreview, returnTo, ...state } = tab as unknown as TabDescriptor & {
      kind: string;
      tabId: string;
      isPreview: boolean;
      [key: string]: unknown;
    };
    return { kind: 'extension', extensionKind, tabId, isPreview, state, ...(returnTo ? { returnTo } : {}) };
  }
  if (tab.kind === 'file' && !tab.isExternal) {
    return { ...tab, path: resolveWorkspacePath(workspacePath, tab.path) };
  }
  if (tab.kind === 'diff' && tab.diffGroup !== 'pr') {
    return { ...tab, path: resolveWorkspacePath(workspacePath, tab.path) };
  }
  return tab;
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
              isPreview: false,
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
