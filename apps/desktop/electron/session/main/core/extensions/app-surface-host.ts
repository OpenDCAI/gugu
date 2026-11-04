import { BrowserWindow, screen, type WebPreferences } from 'electron';
import { log } from '@main/lib/logger';
import { extensionPartition, extensionResourceUrl } from '@shared/extensions/partition';
import { surfaceScreenSchema, type AppSurfaceBounds, type AppSurfaceScreen } from '@shared/extensions/app-surface';
import { ExtensionAppSurfaces } from './extension-app-surfaces';
import { extensionsService } from './extensions-root';
import { configureExtensionSession } from './extension-session';
import { resolveExtensionBridgePreload } from './bridge-preload-path';
import { hardenExtensionWebviewPreferences, isAllowedExtensionNavigation } from './extension-webview-security';
import { sessionEvents } from '../sessions/session-events';
import { projectEvents } from '../projects/project-events';
import { presentAppSurface } from './app-surface-presentation';

function displayBounds(bounds: AppSurfaceBounds): AppSurfaceBounds {
  const display = screen.getDisplayMatching(bounds).workArea;
  const width = Math.min(bounds.width, display.width), height = Math.min(bounds.height, display.height);
  return { x: Math.round(Math.max(display.x, Math.min(bounds.x, display.x + display.width - width))),
    y: Math.round(Math.max(display.y, Math.min(bounds.y, display.y + display.height - height))), width, height };
}

/** Native display mechanics only. The App selects its target and computes its own content placement. */
export function appSurfaceScreen(args: unknown): AppSurfaceScreen {
  if (process.env.GUGU_SERVER_MODE === '1') throw new Error('This host has no desktop screen');
  const options = surfaceScreenSchema.parse(args);
  if (options.space === 'windows-screen-pixels' && process.platform !== 'win32') throw new Error('Windows screen pixels are only available on Windows');
  const bounds = options.space === 'windows-screen-pixels' ? screen.screenToDipRect(null, options.bounds) : options.bounds;
  const display = screen.getDisplayMatching(bounds);
  return { bounds, workArea: display.workArea, scaleFactor: display.scaleFactor };
}

/** A sandboxed App document; no target, pause/stop logic, driver, or authorization decision in this container. */
export const extensionAppSurfaces = new ExtensionAppSurfaces(extensionId => {
  const service = extensionsService(); service.get(extensionId);
  if (!service.isEnabled(extensionId) || !service.hasCapability(extensionId, 'agents:tools')) throw new Error('App surface access was revoked');
}, async sessionId => (await import('./projection-task')).projectionTaskProject(sessionId),
async ({ id, extensionId, sessionId, options, signal, closed }) => {
  if (process.env.GUGU_SERVER_MODE === '1') throw new Error('This host has no desktop surface');
  const installed = extensionsService().get(extensionId), service = extensionsService();
  const preload = resolveExtensionBridgePreload(__dirname);
  if (!preload) throw new Error('App bridge preload is missing from this build');
  configureExtensionSession({ extensionId, apiVersion: installed.manifest.apiVersion, rootDir: installed.rootDir,
    networkHosts: service.grantedHosts(extensionId), declaredHosts: installed.manifest.permissions?.network ?? [] });
  signal.throwIfAborted();
  const preferences: WebPreferences = { partition: extensionPartition(extensionId) };
  hardenExtensionWebviewPreferences(preferences);
  preferences.preload = preload;
  preferences.focusOnNavigation = false;
  const win = new BrowserWindow({ ...displayBounds(options.bounds), show: false, frame: false,
    transparent: true, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, focusable: false, hasShadow: false,
    ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}), webPreferences: preferences });
  const contents = win.webContents, pageId = contents.id;
  let stopped = false;
  const close = () => { if (stopped) return; stopped = true; if (!win.isDestroyed()) win.destroy(); };
  const abort = () => close();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    const bridge = await import('./extension-bridge');
    signal.throwIfAborted();
    if (options.decorative) {
      // The window is still hidden and contains no App script. Failure closes it, never a blocking fallback.
      win.setIgnoreMouseEvents(true);
      win.setFocusable(false);
      contents.on('before-input-event', event => event.preventDefault());
    }
    win.setContentProtection(true);
    // NSPanel's native level must be reset explicitly even if Electron reports false.
    win.setAlwaysOnTop(false);
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, url) => { if (!isAllowedExtensionNavigation(url, extensionId)) event.preventDefault(); });
    contents.once('destroyed', () => { bridge.unbindExtensionSurface(pageId); closed('App surface page closed'); });
    contents.once('render-process-gone', () => { close(); closed('App surface renderer exited'); });
    // Main owns both identity and task binding, before the App's first script can run.
    await bridge.bindExtensionSurface({ webContentsId: pageId, extensionId, tabId: id, tabKind: `${extensionId}.surface`,
      workspace: `session:${sessionId}`, surface: { id, data: options.data, decorative: options.decorative } });
    signal.throwIfAborted();
    await win.loadURL(extensionResourceUrl(extensionId, options.entry));
    signal.throwIfAborted();
    let presentation = { visible: options.visible, relativeTo: options.relativeTo, decorative: options.decorative }, failure: string | undefined;
    const present = () => {
      const result = presentAppSurface(win, presentation); failure = result.reason;
      if (failure) log.warn('App surface presentation failed', { error: String(result.error) });
    };
    present();
    const reportLayout = () => {
      const bounds = win.getContentBounds();
      bridge.updateExtensionSurfaceLayout(pageId, { visible: win.isVisible(), width: bounds.width, height: bounds.height });
    };
    reportLayout();
    return { pageId, shown: () => !win.isDestroyed() && win.isVisible(), reason: () => failure, close,
      update(update) {
        if (win.isDestroyed()) throw new Error('App surface window closed');
        try {
          if (update.bounds) win.setBounds(displayBounds(update.bounds));
          presentation = { ...presentation, ...(update.visible === undefined ? {} : { visible: update.visible }),
            ...(update.relativeTo === undefined ? {} : { relativeTo: update.relativeTo }) };
          present();
        } catch (error) {
          win.hide(); failure = 'display-unavailable'; log.warn('App surface update failed', { error: String(error) });
        }
        reportLayout();
        if (Object.hasOwn(update, 'data')) bridge.updateAppSurfaceData(pageId, id, update.data);
      } };
  } catch (error) { close(); throw error; }
  finally { signal.removeEventListener('abort', abort); }
}, error => log.warn('App surface could not be displayed or closed', { error: String(error) }));

sessionEvents.on('session:archived', sessionId => extensionAppSurfaces.closeScope({ sessionId }));
projectEvents.on('project:deleted', projectId => extensionAppSurfaces.closeScope({ projectId }));
