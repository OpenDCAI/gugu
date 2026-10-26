import { panelItemKey, type PanelItem } from './chat-panel-item';

/** What closing a tab hands back to whoever opened it (a link's message, a topic's attachment): kept with the window, not the tab. */
const restores = new Map<string, () => void>();
const restoreKey = (chatId: string, item: PanelItem) => `${chatId}\0${panelItemKey(item)}`;

export function keepRestore(chatId: string, item: PanelItem, restore: () => void): void {
  restores.set(restoreKey(chatId, item), restore);
}

/** The restore kept for this item, taken once: called as its tab closes. */
export function takeRestore(chatId: string, item: PanelItem): (() => void) | undefined {
  const key = restoreKey(chatId, item);
  const restore = restores.get(key);
  restores.delete(key);
  return restore;
}
