import { rpc } from '@renderer/lib/ipc';
import { snapshotRegistry } from '@renderer/lib/stores/snapshot-registry';
import { viewStateCache } from '@renderer/lib/stores/view-state-cache';
import type { TabGroupsSnapshot } from '@shared/view-state';
import type { TabPersistenceAdapter } from './persistence';

/** Shared persistence for a namespaced view, e.g. `session:<id>` or `chat:<id>`. */
export class TabViewPersistor implements TabPersistenceAdapter {
  private readonly _key: string;

  constructor(
    private readonly _viewId: string,
    private readonly _options?: {
      normalize?: (snapshot: TabGroupsSnapshot) => TabGroupsSnapshot;
      migrate?: (aggregate: unknown) => TabGroupsSnapshot | null;
    },
  ) {
    this._key = `${_viewId}:tabs`;
  }

  load(fallback?: unknown): TabGroupsSnapshot | null {
    let snapshot = viewStateCache.peek(this._key) as TabGroupsSnapshot | undefined;
    if (!snapshot) {
      const migrated = this._options?.migrate?.(fallback ?? viewStateCache.peek(this._viewId));
      if (!migrated) return null;
      snapshot = migrated;
      viewStateCache.set(this._key, snapshot);
      void rpc.viewState.save(this._key, snapshot);
    }
    return this._options?.normalize?.(snapshot) ?? snapshot;
  }

  start(getSnapshot: () => TabGroupsSnapshot): () => void {
    return snapshotRegistry.register(this._key, getSnapshot);
  }
}
