import { getRendererSession } from '@/lib/sessionPublication';
import { log } from '@renderer/utils/logger';

export type TabPlacement = 'separate' | 'beside';
export interface TabPlacementMemory {
  read(resourceId: string): TabPlacement | undefined;
  write(resourceId: string, placement: TabPlacement): void;
}

/** Read on a user's open/close, never on startup; account switches cannot reuse an in-memory table. */
export function accountTabPlacementMemory(
  account: () => string | undefined = () => getRendererSession()?.user.id,
  storage: () => Pick<Storage, 'getItem' | 'setItem'> | undefined = () => globalThis.localStorage,
): TabPlacementMemory {
  const table = (store: Pick<Storage, 'getItem' | 'setItem'>, key: string): Record<string, unknown> => {
    const saved = store.getItem(key);
    if (!saved) return {};
    try {
      const value: unknown = JSON.parse(saved);
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    } catch (error) {
      log.warn('Unable to read tab placement preferences', error);
      return {};
    }
  };
  return {
    read(resourceId) {
      const id = account();
      const store = id ? storage() : undefined;
      if (!store || !id) return undefined;
      const value = table(store, `gugu.tab-placement.v1:${id}`)[resourceId];
      return value === 'separate' || value === 'beside' ? value : undefined;
    },
    write(resourceId, placement) {
      const id = account();
      const store = id ? storage() : undefined;
      if (!store || !id) return;
      const key = `gugu.tab-placement.v1:${id}`;
      store.setItem(key, JSON.stringify({ ...table(store, key), [resourceId]: placement }));
    },
  };
}
