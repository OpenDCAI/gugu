import type { SessionTabContext } from '@renderer/features/tabs/core/session-tab-context';
import type { TabPersistenceAdapter } from '@renderer/features/tabs/persistence';
import { rpc } from '@renderer/lib/ipc';
import { snapshotRegistry } from '@renderer/lib/stores/snapshot-registry';
import { viewStateCache } from '@renderer/lib/stores/view-state-cache';
import {
  isBuiltInTabKind,
  type TabDescriptor,
  type TabGroupsSnapshot,
  type SessionViewSnapshot,
} from '@shared/view-state';
import { resolveWorkspacePath } from './workspace-path';

/**
 * Persistence adapter for a single session's tab layout.
 *
 * Writes to a dedicated key `session:${viewId}:tabs` so the tab state is
 * independent of the aggregate `session:${viewId}` blob. On first load it falls
 * back to the legacy aggregate and eager-writes the dedicated key so that
 * existing users keep their tabs after upgrading.
 */
export class SessionTabViewPersistor implements TabPersistenceAdapter {
  private readonly _key: string;
  private readonly _legacyKey: string;

  constructor(private readonly _ctx: SessionTabContext) {
    this._key = `session:${_ctx.viewId}:tabs`;
    this._legacyKey = `session:${_ctx.viewId}`;
  }

  load(fallback?: unknown): TabGroupsSnapshot | null {
    // Prefer the dedicated key when already populated.
    const dedicated = viewStateCache.peek(this._key);
    if (dedicated) {
      return normalizeTabGroupsSnapshot(dedicated as TabGroupsSnapshot, this._ctx.workspacePath);
    }

    // Fall back to the legacy aggregate for users migrating from an older build.
    const aggregate = (fallback ?? viewStateCache.peek(this._legacyKey)) as
      | SessionViewSnapshot
      | undefined;

    const migrated = migrateLegacyTabs(aggregate);
    if (!migrated) return null;

    // Eager-write so the dedicated key is populated before the next aggregate
    // save (which no longer includes tabGroups).
    viewStateCache.set(this._key, migrated);
    void rpc.viewState.save(this._key, migrated);

    return normalizeTabGroupsSnapshot(migrated, this._ctx.workspacePath);
  }

  start(getSnapshot: () => TabGroupsSnapshot): () => void {
    return snapshotRegistry.register(this._key, getSnapshot);
  }
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
    const { kind: extensionKind, tabId, isPreview, ...state } = tab as unknown as {
      kind: string;
      tabId: string;
      isPreview: boolean;
      [key: string]: unknown;
    };
    return { kind: 'extension', extensionKind, tabId, isPreview, state };
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
