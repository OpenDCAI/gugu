import { randomUUID } from 'node:crypto';
import type { BrowserWindow, IpcMain, WebContents } from 'electron';
import { CONTENT_CONTEXT_MENU_ACTION, CONTENT_CONTEXT_MENU_OPEN, type ContentContextMenu, type ContentMenuAction, type ContentMenuEntry } from '../src/session/shared/content-context-menu';

const pending = new WeakMap<WebContents, { requestId: string; items: ContentMenuEntry[]; onClose?: () => void }>();
const observed = new WeakSet<WebContents>();

/** Actions and selection snapshots stay in the trusted host, scoped to the requesting window. */
export function showContentContextMenu(items: ContentMenuEntry[], position: { window?: BrowserWindow; x: number; y: number }, onClose?: () => void): void {
  const target = position.window?.webContents;
  if (!target || target.isDestroyed()) throw new Error('Content menu host window is unavailable');
  if (!observed.has(target)) {
    observed.add(target);
    target.on('render-process-gone', () => {
      pending.get(target)?.onClose?.();
      pending.delete(target);
      if (!target.isDestroyed()) target.setIgnoreMenuShortcuts(false);
    });
  }
  const requestId = randomUUID();
  pending.get(target)?.onClose?.();
  pending.set(target, { requestId, items, onClose });
  // The application Edit menu must not consume a shortcut before the themed menu can use its snapshot.
  target.setIgnoreMenuShortcuts(true);
  const model: ContentContextMenu = {
    requestId, x: position.x, y: position.y,
    items: items.map(({ click: _click, ...item }) => item),
  };
  target.send(CONTENT_CONTEXT_MENU_OPEN, model);
}

export function registerContentContextMenus(ipc: IpcMain): void {
  ipc.handle(CONTENT_CONTEXT_MENU_ACTION, async (event, input: ContentMenuAction) => {
    const menu = pending.get(event.sender);
    if (!menu || menu.requestId !== input?.requestId) return;
    pending.delete(event.sender);
    event.sender.setIgnoreMenuShortcuts(false);
    try {
      if (!input.actionId) return;
      const item = menu.items.find(item => item.type !== 'separator' && item.id === input.actionId);
      if (item?.type !== 'separator' && item?.enabled !== false) await item?.click?.();
    } finally {
      menu.onClose?.();
    }
  });
}
