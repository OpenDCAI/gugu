import type { Hotkey } from '@tanstack/hotkeys';

export const CONTENT_CONTEXT_MENU_OPEN = 'content-context-menu:open';
export const CONTENT_CONTEXT_MENU_ACTION = 'content-context-menu:action';

export type ContentMenuItem =
  | { type: 'separator' }
  | { type?: 'item'; id: string; label: string; enabled?: boolean; hotkey?: Hotkey; icon?: 'quote' | 'file' };

export type ContentMenuEntry = ContentMenuItem & { click?: () => void | Promise<void> };

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
