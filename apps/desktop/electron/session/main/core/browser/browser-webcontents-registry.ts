import { showContentContextMenu, type ContentMenuEntry } from '../../../../content-context-menu';
import {
  clipboard,
  ClipboardItem,
  session,
  type BrowserWindow,
  type BrowserWindowConstructorOptions,
  type ClearDataOptions,
  type WebContents,
} from 'electron';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { PREVIEW_SCHEME } from '@shared/preview/preview-url';
import {
  browserProfilePartition,
  isNamedBrowserProfileId,
  normalizeBrowserUrl,
  type BrowserDataClearKind,
  type BrowsingDataKind,
} from '@shared/browser';
import type { AppSettings } from '@shared/core/app-settings';
import { browserAppShortcutChannel, tabNavigationShortcutChannel } from '@shared/events/appEvents';
import {
  browserFocusedChannel,
  browserLinkCopiedChannel,
  browserOpenInNewTabChannel,
} from '@shared/events/browserEvents';
import { COMMANDS, type CommandId } from '@shared/commands';
import { getElectronTabNavigationDirection, resolveDefaultHotkey,  } from '@shared/shortcuts';
import { isGoogleAuthUrl, userAgentForBrowserUrl } from './browser-user-agent';

type RegisteredBrowserSession = {
  browserId: string;
  partition: string;
  /** #7191 这个页签开在哪条会话里 —— 会话的 agent 只拿得到自己会话的页签。新建任务的草稿面板不带。 */
  sessionId?: string;
};

// OAuth popups become real child windows sharing the browser partition; they
// must stay as locked down as the webview that opened them.
const BROWSER_POPUP_WINDOW_OPTIONS: BrowserWindowConstructorOptions = {
  autoHideMenuBar: true,
  webPreferences: {
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    contextIsolation: true,
    sandbox: true,
    webviewTag: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
  },
};

// Electron's type union lags Chromium's supported `clearData` values.
const SITE_DATA_CLEAR_DATA_TYPES = [
  'backgroundFetch',
  'cacheStorage',
  'fileSystems',
  'indexedDB',
  'localStorage',
  'serviceWorkers',
  'webSQL',
] as unknown as NonNullable<ClearDataOptions['dataTypes']>;

export class BrowserWebContentsRegistry {
  private readonly sessionsByBrowserId = new Map<string, RegisteredBrowserSession>();
  private readonly webContentsByBrowserId = new Map<string, WebContents>();
  private readonly browserIdByWebContentsId = new Map<number, string>();
  private activeBrowserId: string | null = null;
  /** #7191 每个页签最近一次被看着的时刻:会话有好几个页签时,agent 拿人最近看的那个。 */
  private readonly lastActiveAt = new Map<string, number>();
  /** 返回 true = 这一下是 agent 自己合成的点击。 */
  private mouseDownObserver: ((browserId: string, webContents: WebContents) => boolean) | null = null;
  private browserShortcuts = getBrowserShortcuts();

  registerSession(input: RegisteredBrowserSession): void {
    this.sessionsByBrowserId.set(input.browserId, input);
  }

  unregisterSession(browserId: string): void {
    const webContents = this.webContentsByBrowserId.get(browserId);
    if (webContents) {
      this.browserIdByWebContentsId.delete(webContents.id);
    }
    this.sessionsByBrowserId.delete(browserId);
    this.webContentsByBrowserId.delete(browserId);
    this.lastActiveAt.delete(browserId);
    if (this.activeBrowserId === browserId) {
      this.activeBrowserId = null;
    }
  }

  setKeyboardSettings(keyboard: AppSettings['keyboard']): void {
    this.browserShortcuts = getBrowserShortcuts(keyboard);
  }

  get registeredPartitions(): ReadonlySet<string> {
    const partitions = new Set<string>();
    for (const registered of this.sessionsByBrowserId.values()) {
      partitions.add(registered.partition);
    }
    return partitions;
  }

  /** 这个页签登记过、用的是这份配置(建网页之前核对:网页只开在登记过的页签与配置里)。 */
  isRegistered(browserId: string, partition: string): boolean {
    return this.sessionsByBrowserId.get(browserId)?.partition === partition;
  }

  /**
   * #7274 页签的网页(主进程建的 WebContentsView,见 browser-page-views.ts)建好了:收紧它、认作这个页签的网页。
   * `origin`:网页左上角在窗口内容区里的位置 —— 右键菜单的坐标是网页自己的,弹到窗口上要加上它。
   */
  adoptPageWebContents(
    browserId: string,
    webContents: WebContents,
    placement: { window: () => BrowserWindow | null; origin: () => { x: number; y: number } }
  ): void {
    const webContentsId = webContents.id;
    this.hardenBrowserWebContents(webContents, placement);

    // 用户在这一页里按下了鼠标 = 点进了这一页(两个网页并排时页签焦点跟过来;不据此暂停 agent)。
    webContents.on('before-mouse-event', (_event, mouse) => {
      if (mouse.type !== 'mouseDown') return;
      const boundBrowserId = this.browserIdByWebContentsId.get(webContentsId);
      if (!boundBrowserId) return;
      // agent 自己合成的点击(#7274)不算人点进了这一页:页签焦点不跟过去,❌ 把人正看着的页签换掉。
      if (this.mouseDownObserver?.(boundBrowserId, webContents) === true) return;
      events.emit(browserFocusedChannel, { browserId: boundBrowserId });
    });

    webContents.once('destroyed', () => {
      const boundBrowserId = this.browserIdByWebContentsId.get(webContentsId);
      if (boundBrowserId === undefined) return;
      this.browserIdByWebContentsId.delete(webContentsId);
      if (this.webContentsByBrowserId.get(boundBrowserId) === webContents) {
        this.webContentsByBrowserId.delete(boundBrowserId);
      }
      if (this.activeBrowserId === boundBrowserId) this.activeBrowserId = null;
    });

    const previous = this.webContentsByBrowserId.get(browserId);
    if (previous && previous.id !== webContentsId) this.browserIdByWebContentsId.delete(previous.id);
    this.webContentsByBrowserId.set(browserId, webContents);
    this.browserIdByWebContentsId.set(webContentsId, browserId);
    // Creating/restoring a background page is not the person selecting it.
  }

  /**
   * #7191 这条会话里开着的浏览器页签(已经有活的网页),人最近看过的排在前面。
   * agent 只能操作这里面的 —— 宿主界面、别的会话的页签都不在里面。
   */
  browsersOfSession(sessionId: string): { browserId: string; webContents: WebContents }[] {
    const found: { browserId: string; webContents: WebContents; at: number }[] = [];
    for (const [browserId, registered] of this.sessionsByBrowserId) {
      if (registered.sessionId !== sessionId) continue;
      const webContents = this.webContentsByBrowserId.get(browserId);
      if (!webContents || webContents.isDestroyed()) continue;
      found.push({ browserId, webContents, at: this.lastActiveAt.get(browserId) ?? 0 });
    }
    return found.sort((a, b) => b.at - a.at).map(({ browserId, webContents }) => ({ browserId, webContents }));
  }

  /** Persisted registrations outlive their webContents; retain the person's last selection during unloading. */
  preferredBrowserOfSession(sessionId: string): string | undefined {
    return [...this.sessionsByBrowserId.values()]
      .filter((entry) => entry.sessionId === sessionId)
      .sort((a, b) => (this.lastActiveAt.get(b.browserId) ?? 0) - (this.lastActiveAt.get(a.browserId) ?? 0))[0]?.browserId;
  }

  /** #7191 某个页签里按下了鼠标(agent 据此知道人接管了;它认出是自己合成的点击就回 true)。只有一个观察者:agent-browser。 */
  setMouseDownObserver(observer: ((browserId: string, webContents: WebContents) => boolean) | null): void {
    this.mouseDownObserver = observer;
  }

  /** #6264 这个 webContents 是哪个浏览器页签(远端页签的 localhost 请求据此认出是哪台机器)。 */
  browserIdFor(webContentsId: number): string | null {
    return this.browserIdByWebContentsId.get(webContentsId) ?? null;
  }

  setActiveBrowser(browserId: string | null): void {
    if (browserId !== null && !this.sessionsByBrowserId.has(browserId)) return;
    this.activeBrowserId = browserId;
    if (browserId !== null) this.lastActiveAt.set(browserId, Date.now());
  }

  getActiveBrowser(): string | null {
    return this.activeBrowserId;
  }

  openDevTools(browserId: string): boolean {
    const webContents = this.webContentsByBrowserId.get(browserId);
    if (!webContents || webContents.isDestroyed()) return false;
    webContents.openDevTools({ mode: 'detach' });
    return true;
  }

  async captureScreenshotToClipboard(browserId: string): Promise<boolean> {
    const webContents = this.webContentsByBrowserId.get(browserId);
    if (!webContents || webContents.isDestroyed()) throw new Error('Browser is no longer available');
    const image = await webContents.capturePage();
    if (image.isEmpty()) throw new Error('Browser screenshot is empty');
    // @@@electron44-clipboard (#4394) — electron 44 用 W3C ClipboardItem 取代了 clipboard.writeImage。
    // 必须 await:旧的同步 writeImage 一返回就保证系统剪贴板已写好,而新 API 的 promise 没落地前
    // 剪贴板还是旧内容——不 await 就会「截图成功但粘出来是上一张」。
    // new Uint8Array(...) 不是多余的一步:toPNG() 给的是 Node Buffer(底层可能是 SharedArrayBuffer),
    // 而 BlobPart 只收 ArrayBuffer 支撑的视图 —— 直接塞 Buffer 编译不过。
    await clipboard.write([
      new ClipboardItem({
        'image/png': new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' }),
      }),
    ]);
    return true;
  }

  async clearData(browserId: string, kind: BrowserDataClearKind = 'storage'): Promise<boolean> {
    const registered = this.sessionsByBrowserId.get(browserId);
    if (!registered) return false;
    const partitionSession = session.fromPartition(registered.partition);
    switch (kind) {
      case 'storage':
        await partitionSession.clearStorageData();
        break;
      case 'cookies':
        await partitionSession.clearStorageData({ storages: ['cookies'] });
        break;
      case 'cache':
        await partitionSession.clearCache();
        break;
    }
    return true;
  }

  async clearProfileStorage(profileId: string): Promise<boolean> {
    if (!isNamedBrowserProfileId(profileId)) return false;
    await session.fromPartition(browserProfilePartition(profileId)).clearData();
    return true;
  }

  /**
   * Clears a category of browsing data across the given partitions. Used by the
   * global "Browsing data" settings controls, which target every browser
   * profile rather than a single open tab.
   */
  async clearBrowsingData(kind: BrowsingDataKind, partitions: readonly string[]): Promise<boolean> {
    await Promise.all(partitions.map((partition) => clearPartitionBrowsingData(partition, kind)));
    return true;
  }

  private hardenBrowserWebContents(
    webContents: WebContents,
    placement: { window: () => BrowserWindow | null; origin: () => { x: number; y: number } }
  ): void {
    webContents.setWindowOpenHandler((details) => {
      if (!isSupportedBrowserNavigationUrl(details.url)) {
        return { action: 'deny' };
      }
      if (details.disposition === 'new-window' && isAllowedAuthPopupUrl(details.url)) {
        // window.open popups (OAuth sign-in flows) need a real child window in
        // the same partition so window.opener/postMessage keep working.
        return { action: 'allow', overrideBrowserWindowOptions: BROWSER_POPUP_WINDOW_OPTIONS };
      }
      const sourceBrowserId = this.browserIdByWebContentsId.get(webContents.id);
      if (sourceBrowserId && isExternalHttpUrl(details.url)) {
        events.emit(browserOpenInNewTabChannel, { sourceBrowserId, url: details.url });
      }
      return { action: 'deny' };
    });

    webContents.on('before-input-event', (event, input) => {
      const tabNavigationDirection = getElectronTabNavigationDirection(input);
      if (tabNavigationDirection) {
        const browserId = this.browserIdByWebContentsId.get(webContents.id);
        if (browserId) {
          event.preventDefault();
          events.emit(tabNavigationShortcutChannel, {
            source: { kind: 'browser', browserId },
            direction: tabNavigationDirection,
          });
          return;
        }
      }

      const commandId = getBrowserShortcutKey(input, this.browserShortcuts);
      if (commandId === null) return;

      if (commandId !== 'session.browserCopyUrl') {
        const browserId = this.browserIdByWebContentsId.get(webContents.id);
        if (!browserId) return;
        event.preventDefault();
        events.emit(browserAppShortcutChannel, {
          source: { kind: 'browser', browserId },
          commandId,
        });
        return;
      }

      const normalized = normalizeBrowserUrl(webContents.getURL(), { allowSearchQueries: false });
      if (!normalized.ok || !isExternalHttpUrl(normalized.url)) return;
      event.preventDefault();
      copyTextThenNotify(normalized.url, () =>
        events.emit(browserLinkCopiedChannel, { kind: 'url', url: normalized.url }),
      );
    });

    webContents.on('context-menu', (event, params) => {
      event.preventDefault();
      const selectionText = (params.selectionText ?? '').trim();
      if (!selectionText) {
        clearWebviewSelection(webContents);
      }

      const target = getBrowserContextTarget(params);
      const template: ContentMenuEntry[] = [
        ...(selectionText
          ? [
              {
                id: 'copy', label: 'Copy',
                click: () => copyTextThenNotify(selectionText),
              },
              { type: 'separator' as const },
            ]
          : []),
        {
          id: 'copy-link', label: target?.kind === 'image' ? 'Copy Image URL' : 'Copy Link',
          enabled: target !== null,
          click: () => {
            if (!target) return;
            copyTextThenNotify(target.url, () =>
              events.emit(browserLinkCopiedChannel, { kind: target.kind, url: target.url }),
            );
          },
        },
        {
          id: 'open-link', label: target?.kind === 'image' ? 'Open Image' : 'Open Link',
          enabled: target !== null,
          click: () => {
            if (target) void webContents.loadURL(target.url);
          },
        },
        {
          id: 'open-tab', label: target?.kind === 'image' ? 'Open Image in New Tab' : 'Open Link in New Tab',
          enabled: target !== null,
          click: () => {
            const sourceBrowserId = this.browserIdByWebContentsId.get(webContents.id);
            if (sourceBrowserId && target) {
              events.emit(browserOpenInNewTabChannel, { sourceBrowserId, url: target.url });
            }
          },
        },
        { type: 'separator' },
        { id: 'reload', label: 'Reload', click: () => webContents.reload() },
      ];

      // 右键的坐标是网页自己的;菜单弹在网页所在的窗口上,换成窗口内容区的坐标。
      const window = placement.window();
      const origin = placement.origin();
      showContentContextMenu(template, {
        ...(window ? { window } : {}),
        x: origin.x + params.x,
        y: origin.y + params.y,
      });
    });

    webContents.on('did-create-window', (window) => {
      hardenBrowserPopupWindow(window);
    });

    webContents.on('will-navigate', (event, url) => {
      // #6264 别的机器上的网页里点到同一目录的另一页:同一份预览里的导航照走(见 isSamePreviewNavigation)。
      if (isSamePreviewNavigation(webContents.getURL(), url)) return;
      if (!isSupportedBrowserNavigationUrl(url)) {
        event.preventDefault();
      }
    });

    installBrowserUserAgentSwitch(webContents);
  }
}

export const browserWebContentsRegistry = new BrowserWebContentsRegistry();

async function clearPartitionBrowsingData(
  partition: string,
  kind: BrowsingDataKind
): Promise<void> {
  const partitionSession = session.fromPartition(partition);
  switch (kind) {
    case 'all':
      // No options clears every data type, more thoroughly than clearStorageData.
      await partitionSession.clearData();
      return;
    case 'cookies':
      await partitionSession.clearData({ dataTypes: ['cookies'] });
      return;
    case 'siteData':
      await partitionSession.clearData({
        dataTypes: SITE_DATA_CLEAR_DATA_TYPES,
      });
      return;
    case 'cache':
      await partitionSession.clearData({ dataTypes: ['cache'] });
      return;
  }
}

/**
 * @@@electron44-clipboard (#4394) — electron 44 起 clipboard.writeText 返回 Promise。
 * 下面这些调用点都在**同步**的事件/菜单回调里,整条链改 async 代价过大;但两件事不能将就:
 *   · 顺序 —— 「已复制」的广播必须等写入真的落地再发,先 emit 会让 UI 报了成功而剪贴板还是旧内容;
 *   · rejection —— 裸调用的失败会变成 unhandled rejection,一声不响。
 * 所以统一走这里:成功才跑 onCopied,失败记 error。
 */
function copyTextThenNotify(text: string, onCopied?: () => void): void {
  void clipboard.writeText(text).then(
    () => onCopied?.(),
    (error: unknown) => {
      log.error('clipboard.writeText failed', { error: String(error) });
    },
  );
}

function hardenBrowserPopupWindow(window: BrowserWindow): void {
  const webContents = window.webContents;

  webContents.setWindowOpenHandler(({ url, disposition }) => {
    if (!isSupportedBrowserNavigationUrl(url)) {
      return { action: 'deny' };
    }
    if (disposition === 'new-window' && isAllowedAuthPopupUrl(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: BROWSER_POPUP_WINDOW_OPTIONS };
    }
    return { action: 'deny' };
  });

  webContents.on('did-create-window', (child) => {
    hardenBrowserPopupWindow(child);
  });

  webContents.on('will-navigate', (event, url) => {
    if (!isSupportedBrowserNavigationUrl(url)) {
      event.preventDefault();
    }
  });

  installBrowserUserAgentSwitch(webContents);
}

function installBrowserUserAgentSwitch(webContents: WebContents): void {
  // Google auth pages also probe navigator.userAgent, so the per-contents user
  // agent has to switch around auth navigations, not just the request header.
  webContents.on('did-start-navigation', (_event, url, _isInPlace, isMainFrame) => {
    if (!isMainFrame) return;
    const target = userAgentForBrowserUrl(url, webContents.session.getUserAgent());
    if (webContents.getUserAgent() !== target) {
      webContents.setUserAgent(target);
    }
  });
}

/**
 * 页签里正开着的是一份 `gugu-preview://<id>/` 网页(#6264 别的机器上的会话做的网页),要去的地址是**同一份**
 * 预览里的另一页 ⇒ 放行。同源 = 同一个登记 = 同一道围栏(会话工作目录),取不到这份预览以外的东西;
 * 别的预览、别的 scheme 照旧按下面那条判。
 */
export function isSamePreviewNavigation(currentUrl: string, targetUrl: string): boolean {
  try {
    const current = new URL(currentUrl);
    const target = new URL(targetUrl);
    return (
      current.protocol === `${PREVIEW_SCHEME}:` &&
      target.protocol === current.protocol &&
      target.hostname !== '' &&
      target.hostname === current.hostname
    );
  } catch {
    return false;
  }
}

function isSupportedBrowserNavigationUrl(url: string): boolean {
  return normalizeBrowserUrl(url, { allowSearchQueries: false }).ok;
}

function isExternalHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isAllowedAuthPopupUrl(url: string): boolean {
  if (isGoogleAuthUrl(url)) return true;
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() !== 'github.com') return false;
    return parsed.pathname === '/login' || parsed.pathname === '/login/oauth/authorize';
  } catch {
    return false;
  }
}

function getBrowserContextTarget(
  params: Electron.ContextMenuParams
): { kind: 'link' | 'image'; url: string } | null {
  if (params.mediaType === 'image' && isExternalHttpUrl(params.srcURL)) {
    return { kind: 'image', url: params.srcURL };
  }
  if (isExternalHttpUrl(params.linkURL)) return { kind: 'link', url: params.linkURL };
  return null;
}

type ParsedShortcut = {
  key: string;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  control: boolean;
};

function getBrowserShortcuts(
  keyboard?: AppSettings['keyboard']
): Map<CommandId, ParsedShortcut> {
  const shortcuts = new Map<CommandId, ParsedShortcut>();
  for (const commandId of Object.keys(COMMANDS) as CommandId[]) {
    if (commandId === 'app.closeModal' || COMMANDS[commandId].ignoreWhenBrowserFocused) {
      continue;
    }

    const configured = keyboard?.[commandId];
    if (configured === null) continue;

    const fallback = resolveDefaultHotkey(COMMANDS[commandId]) ?? null;
    const hotkey = configured ?? fallback;
    if (hotkey === null) continue;

    const parsed = parseShortcut(hotkey);
    if (parsed) {
      shortcuts.set(commandId, parsed);
      continue;
    }

    if (configured) {
      const parsedFallback = fallback ? parseShortcut(fallback) : null;
      if (parsedFallback) shortcuts.set(commandId, parsedFallback);
      log.warn('Invalid browser app shortcut, falling back to default', {
        commandId,
        shortcut: configured,
      });
    }
  }
  return shortcuts;
}

function getBrowserShortcutKey(
  input: Electron.Input,
  shortcuts: ReadonlyMap<CommandId, ParsedShortcut>
): CommandId | null {
  if (input.type !== 'keyDown') return null;
  for (const [commandId, parsed] of shortcuts) {
    if (
      normalizeInputKey(input.key) === parsed.key &&
      Boolean(input.shift) === parsed.shift &&
      Boolean(input.alt) === parsed.alt &&
      Boolean(input.meta) === parsed.meta &&
      Boolean(input.control) === parsed.control
    ) {
      return commandId;
    }
  }
  return null;
}

function parseShortcut(shortcut: string): {
  key: string;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  control: boolean;
} | null {
  const parts = shortcut
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  const key = parts.pop();
  if (!key) return null;
  const modifiers = { shift: false, alt: false, meta: false, control: false };
  for (const part of parts) {
    switch (part.toLowerCase()) {
      case 'shift':
        modifiers.shift = true;
        break;
      case 'alt':
      case 'option':
        modifiers.alt = true;
        break;
      case 'meta':
      case 'cmd':
      case 'command':
        modifiers.meta = true;
        break;
      case 'ctrl':
      case 'control':
        modifiers.control = true;
        break;
      case 'mod':
        if (process.platform === 'darwin') modifiers.meta = true;
        else modifiers.control = true;
        break;
      default:
        return null;
    }
  }
  return { key: normalizeInputKey(key), ...modifiers };
}

function normalizeInputKey(key: string): string {
  return key.toLowerCase();
}

function clearWebviewSelection(webContents: WebContents): void {
  if (webContents.isDestroyed()) return;
  void webContents
    .executeJavaScript('window.getSelection()?.removeAllRanges();', true)
    .catch(() => {});
}
