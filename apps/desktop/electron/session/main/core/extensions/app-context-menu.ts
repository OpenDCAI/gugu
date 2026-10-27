import { BrowserWindow, webContents } from 'electron';
import { showContentContextMenu } from '../../../../content-context-menu';
import { appContextMenuOf } from '@shared/extensions/app-context-menu';

/** Show an App's actions in the host's shared content menu, at the App-local point. */
export async function showAppContextMenu(pageId: number, args: Record<string, unknown>): Promise<string | null> {
  const menu = appContextMenuOf(args);
  const page = webContents.fromId(pageId);
  if (!page || page.isDestroyed()) throw new Error('App menu page is unavailable');
  const host = page.hostWebContents;
  const window = host ? BrowserWindow.fromWebContents(host) : null;
  if (!host || !window) throw new Error('App menu host window is unavailable');
  const offset = await host.mainFrame.executeJavaScript(`(() => {
    const view=[...document.querySelectorAll('webview')].find(view=>view.getWebContentsId()===${pageId});
    return view?.getBoundingClientRect().toJSON();
  })()`) as { x: number; y: number } | undefined;
  if (!offset) throw new Error('App menu page is no longer attached');
  return new Promise(resolve => showContentContextMenu(menu.items.map(item => item.type === 'separator' ? item : {
    ...item, click: () => resolve(item.id),
  }), { window, x: offset.x + menu.x, y: offset.y + menu.y }, () => resolve(null)));
}
