import type { Hotkey } from '@tanstack/hotkeys';

export const CONTENT_CONTEXT_MENU_OPEN = 'content-context-menu:open';
export const CONTENT_CONTEXT_MENU_ACTION = 'content-context-menu:action';

export type ContentMenuItem =
  | { type: 'separator' }
  | { type?: 'item'; id: string; label: string; enabled?: boolean; hotkey?: Hotkey; icon?: 'quote' | 'file'; items?: ContentMenuItem[] };

/** An item with `items` opens them beside it; only leaves are actions. */
export type ContentMenuEntry =
  ({ type: 'separator' } | (Omit<Exclude<ContentMenuItem, { type: 'separator' }>, 'items'> & { items?: ContentMenuEntry[] }))
  & { click?: () => void | Promise<void> };

/** The leaf picked by id, at any depth. */
export function findContentMenuItem<T extends ContentMenuItem | ContentMenuEntry>(items: readonly T[], id: string): Exclude<T, { type: 'separator' }> | undefined {
  for (const item of items) {
    if (item.type === 'separator') continue;
    const found = item.items ? findContentMenuItem(item.items as T[], id) : item.id === id ? item : undefined;
    if (found) return found as Exclude<T, { type: 'separator' }>;
  }
  return undefined;
}

export interface ContentContextMenu {
  requestId: string;
  x: number;
  y: number;
  items: ContentMenuItem[];
}

export interface ContentMenuAction {
  requestId: string;
  /** Omitted when the menu is dismissed. */
  actionId?: string;
}
