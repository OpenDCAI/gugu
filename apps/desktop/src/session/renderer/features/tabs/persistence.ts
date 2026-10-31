import type { TabGroupsSnapshot } from '@shared/view-state';

/**
 * Loads and persists a tab layout for a single view. TabViewPersistor provides
 * the shared implementation; hosts supply any domain-specific normalization.
 */
export interface TabPersistenceAdapter {
  /**
   * Synchronously load a saved snapshot.
   *
   * @param fallback - An optional blob already held by the caller (e.g. the
   *   aggregate task view-state).  The adapter interprets this as needed for
   *   backwards-compatible migration; `features/tabs` treats it as opaque.
   * @returns The snapshot to restore, or `null` when nothing is saved.
   */
  load(fallback?: unknown): TabGroupsSnapshot | null;

  /**
   * Start watching `getSnapshot()` and persisting changes.
   *
   * Call this after `load()` so the baseline does not trigger a spurious save.
   * @returns A disposer — call it to stop persistence.
   */
  start(getSnapshot: () => TabGroupsSnapshot): () => void;
}
