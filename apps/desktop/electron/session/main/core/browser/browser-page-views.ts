import { BaseWindow, BrowserWindow, WebContentsView, type Size, type WebContents } from 'electron';
import { getMainWindow } from '@main/app/window';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { AGENT_OVERLAY_WINDOW_NAME_PREFIX, AUX_WINDOW_NAME_PREFIX, agentOverlayOfFrame, type AgentOverlayPart } from '@shared/aux-window';
import { BROWSER_TAB_URL_OPTIONS, normalizeBrowserUrl, normalizeBrowserZoomFactor } from '@shared/browser';
import { BROWSER_PAGE_MEASURE_SCRIPT, parseBrowserPageLayout, type BrowserPageLayout } from '@shared/browser-page-layout';
import { browserCursorInput, type BrowserCursorInput } from '@shared/browser-cursor-input';
import {
  browserPageEventChannel,
  type BrowserPageEventType,
  type BrowserPageMode,
  type BrowserPageState,
} from '@shared/events/browserEvents';
import { BROWSER_PINCH_MAX_LEVEL } from '@shared/preview/pinch-zoom';
import { hardenWebPreferences } from '../../../../devtools-lock';
import {
  openWindowLayer,
  raiseWindowLayers,
  serveWindowLayers,
  WINDOW_LAYER_RANK,
  windowLayerOptions,
  type WindowLayerContent,
} from '../../../../window-layers';
import { wirePageDialogs, type PageDialogs } from './browser-page-dialogs';
import { browserWebContentsRegistry } from './browser-webcontents-registry';
import { isPreviewPageUrl, validateBrowserPageMount } from './webview-security';

/**
 * #7274 会话页浏览器页签里的网页:主进程持有的 `WebContentsView`,盖在咕咕窗口里页签那一块上。
 *
 * ## 为什么不是 `<webview>`
 *
 * `<webview>` 是嵌在咕咕页面里的内层 WebContents,和咕咕界面共用一棵焦点树。Chromium 收到任何一下按下
 * (真鼠标、CDP 合成、`sendInputEvent`,一视同仁)都会 `FocusOwningWebContents` 把这棵树的焦点挪进网页,
 * 咕咕界面随之失焦 —— 人在聊天框里正拼着的中文被强行结束、成了一串字母,后面打的字落进网页
 * (实测 exp8:四种点法 × 有无 focus emulation,宿主一律 blur + compositionend)。独立的 view 是窗口里另一个
 * 顶层 WebContents,agent 的点击只动它自己那棵树:宿主 0 事件、拼字不断、真键盘的下一个键照旧落在聊天框,
 * 网页那边点击仍是 isTrusted、输入框照常聚焦(exp8 / exp9)。VS Code 的内置浏览器同一个做法。
 *
 * ## 代价,与这里怎么接住
 *
 * - **网页画在界面之上**:页签那一块在界面里只是一个空的占位(browser-page-surface.tsx),它量好自己在窗口里的
 *   位置报过来,这里把 view 摆上去。咕咕自己的浮层(菜单、弹窗、起始页…)压到网页上时,页签报 `occluded`:
 *   view 收起、占位换成一张网页截图,浮层照常盖在上面。
 * - **agent 的鼠标与快捷消息按钮**是窗口里的两层(window-layers.ts);鼠标只在动作期间露出,消息按钮跟随页签。
 *   运行控制属于 Agent 会话。落在鼠标层上的真实鼠标输入原样交给网页,不暂停 agent。
 * - **不在屏上的网页停在「停放窗」里**:每扇咕咕窗口配一扇从不显示的窗,不在屏上(页签切走、会话藏起来、被浮层盖住)
 *   的网页挂到那里、大小照旧跟着页签。❌ 摘下来 / ❌ 挂着 setVisible(false):从没露过面的网页视口是 0×0,
 *   挂着隐藏的截图会卡死 —— agent 在后台操作它时截图、点击全不灵(exp11 / exp12 实测)。停在停放窗里平时不出帧;
 *   agent 连上时 Playwright 自己开的 focus emulation 让 Chromium 把它当作看得见(emulation_handler.cc
 *   IncrementCapturerCount),照常出帧、截得到图、点得着。网页弹的 JS 对话框 ❌ 挂到停放窗上(会把它排上屏幕),
 *   只出现在人正在看的页签上(browser-page-dialogs.ts)。
 * - **导航不抢焦点**:`focusOnNavigation: false`,网页换页时不把焦点拉过去(electron#42578 / #49425)。
 *
 * ⚠️ 网页销毁后不再碰它:对已销毁的 webContents 调方法会让整个 app 崩溃(见 agent-browser.ts 文件头)。
 */

type Rect = { x: number; y: number; width: number; height: number };

type PagePlace = 'host' | 'parked' | null;

/** Agent 鼠标与快捷消息层及其宿主:网页不在那扇窗上时收起。 */
type AgentLayer = { part: AgentOverlayPart; view: WebContentsView; contents: WebContents; host: BrowserWindow; size: Size | null };

type BrowserPage = {
  browserId: string;
  partition: string;
  view: WebContentsView;
  webContents: WebContents;
  host: BrowserWindow | null;
  /** 占位所在那扇窗的名字:主窗是空串,单独成窗的那几扇是 `gugu-aux:<id>`。 */
  windowName: string;
  /** 页签量来的位置(那扇窗内容区的 DIP)。 */
  rect: Rect | null;
  mode: BrowserPageMode;
  fullscreen: boolean;
  /** 此刻挂在哪:那扇窗上(人看得见)、它的停放窗里,或哪儿都没挂(还没有窗 / 窗关了)。 */
  place: PagePlace;
  ready: boolean;
  releaseTimer: ReturnType<typeof setTimeout> | null;
  /** 盖在网页上的鼠标与快捷消息层(记录宿主,每种每窗最多一层)。 */
  layers: AgentLayer[];
  /** 鼠标那层要不要露(agent 在操作、页签那边画着鼠标)。 */
  cursorShown: boolean;
  dialogs: PageDialogs | null;
};

/** 占位卸下(页签挪去别的窗、分栏重排)后,网页留这么久等它在新位置挂回来 —— 挪动 ❌ 重新载入网页。 */
const RELEASE_GRACE_MS = 5_000;

const pages = new Map<string, BrowserPage>();
const hostsWired = new WeakSet<BrowserWindow>();
/** 每扇咕咕窗口的停放窗(见文件头)。 */
const parkings = new WeakMap<BrowserWindow, BaseWindow>();

function emitPageEvent(page: BrowserPage, type: BrowserPageEventType, detail: Record<string, unknown> = {}): void {
  if (page.webContents.isDestroyed()) return;
  events.emit(browserPageEventChannel, { browserId: page.browserId, type, detail, state: pageState(page.webContents) });
}

function pageState(webContents: WebContents): BrowserPageState {
  return {
    url: webContents.getURL(),
    title: webContents.getTitle(),
    canGoBack: webContents.navigationHistory.canGoBack(),
    canGoForward: webContents.navigationHistory.canGoForward(),
  };
}

function resolveHost(windowName: string): BrowserWindow | null {
  if (!windowName.startsWith(AUX_WINDOW_NAME_PREFIX)) return getMainWindow();
  return (
    BrowserWindow.getAllWindows().find((window) => !window.isDestroyed() && window.webContents.mainFrame.name === windowName) ??
    null
  );
}

function wireHost(host: BrowserWindow): void {
  if (hostsWired.has(host)) return;
  hostsWired.add(host);
  const reposition = () => {
    syncParking(host);
    for (const page of pages.values()) {
      if (page.host !== host) continue;
      page.dialogs?.pageShown();
    }
  };
  host.on('move', reposition);
  host.on('resize', reposition);
  host.on('show', reposition);
  host.on('hide', reposition);
  host.on('minimize', reposition);
  host.on('restore', reposition);
  // 窗关了(单独成窗的那扇被关掉):上面的网页先放手、留一会儿 —— 页签挪回别的窗会接着用;没人要就关掉。
  host.on('closed', () => {
    for (const page of [...pages.values()]) {
      if (page.host !== host) continue;
      unplace(page);
      page.host = null;
      page.dialogs?.hostChanged();
      releaseBrowserPage(page.browserId);
    }
    const parking = parkings.get(host);
    parkings.delete(host);
    if (parking && !parking.isDestroyed()) parking.destroy();
  });
  // 界面整页重载 / 换页:画在上面的那些网页没了主人 —— 一并关掉,❌ 留一块没人管的网页盖在新界面上。
  host.webContents.on('did-start-navigation', (event) => {
    if (!event.isMainFrame || event.isSameDocument) return;
    for (const page of [...pages.values()]) if (page.host === host) destroyBrowserPage(page.browserId);
  });
}

/** 这扇窗的停放窗:从不显示、不能聚焦、和窗口内容区一样大(停在里面的网页摆在和页签同样的位置,视口和人看见时一样)。 */
function parkingFor(host: BrowserWindow): BaseWindow {
  let parking = parkings.get(host);
  if (!parking || parking.isDestroyed()) {
    parking = new BaseWindow({
      show: false,
      frame: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
    });
    parkings.set(host, parking);
    syncParking(host);
  }
  return parking;
}

function syncParking(host: BrowserWindow): void {
  const parking = parkings.get(host);
  if (!parking || parking.isDestroyed() || host.isDestroyed()) return;
  // 同一块屏上(缩放比一样)、内容区一样大。
  parking.setContentBounds(host.getContentBounds());
}

/** 挂到那扇窗上 / 它的停放窗里(先从原来的地方摘下)。 */
function placeOn(page: BrowserPage, where: 'host' | 'parked'): void {
  const host = page.host;
  if (!host || host.isDestroyed() || page.place === where) return;
  unplace(page);
  if (where === 'host') {
    host.contentView.addChildView(page.view);
    // 后挂上去的网页会压住窗口里的层(agent 的鼠标、构建角标):叠回去。
    raiseWindowLayers(host);
  } else parkingFor(host).contentView.addChildView(page.view);
  page.place = where;
}

function unplace(page: BrowserPage): void {
  const host = page.host;
  const place = page.place;
  page.place = null;
  if (!host || place === null) return;
  if (place === 'host') {
    if (!host.isDestroyed()) host.contentView.removeChildView(page.view);
    return;
  }
  const parking = parkings.get(host);
  if (parking && !parking.isDestroyed()) parking.contentView.removeChildView(page.view);
}

function contentRect(host: BrowserWindow): Rect {
  const [width, height] = host.getContentSize();
  return { x: 0, y: 0, width, height };
}

/** 照页签报的位置、样子摆好这张网页:露着就挂在窗口上页签那一块,否则停进停放窗(大小照旧)。 */
function applyLayout(page: BrowserPage): void {
  if (page.webContents.isDestroyed()) return;
  const host = page.host;
  if (!host || host.isDestroyed()) return;
  const sized = page.rect !== null && page.rect.width > 0 && page.rect.height > 0;
  const shown = page.fullscreen || (page.mode === 'shown' && sized);
  // 先定大小再挂上去:挂上的那一帧就在新位置。
  if (page.fullscreen) page.view.setBounds(contentRect(host));
  else if (sized) page.view.setBounds(page.rect as Rect);
  placeOn(page, shown ? 'host' : 'parked');
  placeAgentLayers(page);
  page.dialogs?.pageShown();
}

/** 人此刻看得见这张网页:挂在窗口上、那扇窗露着。 */
function onScreen(page: BrowserPage): boolean {
  const host = page.host;
  return page.place === 'host' && !!host && !host.isDestroyed() && host.isVisible() && !host.isMinimized();
}

export type MountBrowserPageResult =
  | { success: true; reused: boolean; ready: boolean; state: BrowserPageState }
  | { success: false; error: string };

/**
 * 页签的占位挂上了:还没有这张网页就建一张并载入 `url`;已经有(页签挪了位置、换了窗)就接着用,❌ 重新载入。
 */
export function mountBrowserPage(args: {
  browserId: string;
  partition: string;
  url: string;
  windowName: string;
}): MountBrowserPageResult {
  const validation = validateBrowserPageMount(
    { partition: args.partition, src: args.url },
    browserWebContentsRegistry.registeredPartitions
  );
  if (!validation.ok) return { success: false, error: validation.reason };
  if (!browserWebContentsRegistry.isRegistered(args.browserId, args.partition)) {
    return { success: false, error: 'unregistered-browser' };
  }

  let page = pages.get(args.browserId);
  if (page && (page.partition !== args.partition || page.webContents.isDestroyed())) {
    destroyBrowserPage(args.browserId);
    page = undefined;
  }
  if (page) {
    if (page.releaseTimer) clearTimeout(page.releaseTimer);
    page.releaseTimer = null;
    moveToHost(page, args.windowName);
    return { success: true, reused: true, ready: page.ready, state: pageState(page.webContents) };
  }

  const view = new WebContentsView({
    // 锁定态(生产包)下 DevTools 一并关掉,同咕咕别的窗口(devtools-lock.ts)。
    webPreferences: hardenWebPreferences({
      partition: args.partition,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      // 网页换页时 ❌ 把焦点拉过去(人可能正在聊天框里打字)。
      focusOnNavigation: false,
    }),
  });
  view.setBackgroundColor('#ffffff');
  const webContents = view.webContents;
  page = {
    browserId: args.browserId,
    partition: args.partition,
    view,
    webContents,
    host: null,
    windowName: args.windowName,
    rect: null,
    mode: 'background',
    fullscreen: false,
    place: null,
    ready: false,
    releaseTimer: null,
    layers: [],
    cursorShown: false,
    dialogs: null,
  };
  pages.set(args.browserId, page);
  const adopted = page;
  browserWebContentsRegistry.adoptPageWebContents(args.browserId, webContents, {
    window: () => (adopted.host && !adopted.host.isDestroyed() ? adopted.host : null),
    origin: () => (adopted.fullscreen ? { x: 0, y: 0 } : { x: adopted.rect?.x ?? 0, y: adopted.rect?.y ?? 0 }),
  });
  wirePage(page);
  moveToHost(page, args.windowName);
  webContents.loadURL(validation.url).catch(() => {
    // 载入失败由 did-fail-load 报给页签(画「打不开」那一页),这里不重复。
  });
  return { success: true, reused: false, ready: false, state: pageState(webContents) };
}

function moveToHost(page: BrowserPage, windowName: string): void {
  const host = resolveHost(windowName);
  const moved = page.host !== host;
  if (moved) {
    unplace(page);
    page.host = host;
    if (host) wireHost(host);
    // 换了窗:旧窗里的那几层收着(applyLayout),由旧窗那边的页签按名字关;新窗那边页签会在新窗里开 ——
    // ❌ 这里关:挪窗时两边的布局请求会来回交错几下,关了就把新窗刚开的也关了。
  }
  page.windowName = windowName;
  applyLayout(page);
  if (moved) page.dialogs?.hostChanged();
}

/** Browser Use can restore a saved tab without mounting its whole session UI or moving a live page to another window. */
export function ensureAgentBrowserPage(args: { browserId: string; partition: string; url: string }): MountBrowserPageResult {
  const page = livePage(args.browserId);
  if (page && page.partition === args.partition) {
    if (page.releaseTimer) clearTimeout(page.releaseTimer);
    page.releaseTimer = null;
    return { success: true, reused: true, ready: page.ready, state: pageState(page.webContents) };
  }
  const mounted = mountBrowserPage({ ...args, windowName: '' });
  const restored = livePage(args.browserId);
  // An unmounted session has no surface to report its bounds. Give the parked page a real viewport;
  // the actual pane reports its own geometry when the person opens the session again.
  if (mounted.success && restored?.host && !restored.rect) {
    restored.rect = contentRect(restored.host);
    applyLayout(restored);
  }
  return mounted;
}

function wirePage(page: BrowserPage): void {
  const { webContents } = page;
  page.dialogs = wirePageDialogs(webContents, {
    onScreen: () => onScreen(page),
    host: () => (page.host && !page.host.isDestroyed() ? page.host : null),
  });
  webContents.on('dom-ready', () => {
    page.ready = true;
    // 网页照 Chrome 那样能双指捏合放大(#6456)。Electron 默认关着;只开这一张网页的。每次 dom-ready 都设:换页可能换渲染进程。
    webContents.setVisualZoomLevelLimits(1, BROWSER_PINCH_MAX_LEVEL).catch((error: unknown) => {
      log.warn('could not enable pinch zoom on a browser page', { browserId: page.browserId, error: String(error) });
    });
    emitPageEvent(page, 'dom-ready');
  });
  webContents.on('did-start-loading', () => emitPageEvent(page, 'did-start-loading'));
  webContents.on('did-stop-loading', () => emitPageEvent(page, 'did-stop-loading'));
  webContents.on('did-navigate', (_event, url) => emitPageEvent(page, 'did-navigate', { url }));
  webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (isMainFrame) emitPageEvent(page, 'did-navigate-in-page', { url });
  });
  webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // 只认整页:页里某个子框架(广告、埋点)没载上,❌ 把整页换成「打不开」。
    if (isMainFrame) emitPageEvent(page, 'did-fail-load', { errorCode, errorDescription, validatedURL });
  });
  webContents.on('console-message', (event) => {
    const params = event as unknown as { level: string; message: string; lineNumber: number; sourceId: string };
    emitPageEvent(page, 'console-message', {
      level: CONSOLE_LEVELS[params.level] ?? 1,
      message: params.message,
      line: params.lineNumber,
      sourceId: params.sourceId,
    });
  });
  webContents.on('page-title-updated', (_event, title) => emitPageEvent(page, 'page-title-updated', { title }));
  webContents.on('page-favicon-updated', (_event, favicons) => emitPageEvent(page, 'page-favicon-updated', { favicons }));
  webContents.on('focus', () => emitPageEvent(page, 'focus'));
  webContents.on('blur', () => emitPageEvent(page, 'blur'));
  // 网页要全屏(视频):view 铺满整个窗口内容区,退出时回到页签那一块。
  webContents.on('enter-html-full-screen', () => {
    page.fullscreen = true;
    applyLayout(page);
    // 叠到最上面:分栏时别的网页 view 不能压着它(再挂一次就到最上层)。
    if (page.host && !page.host.isDestroyed() && page.place === 'host') {
      page.host.contentView.addChildView(page.view);
      raiseWindowLayers(page.host);
    }
  });
  webContents.on('leave-html-full-screen', () => {
    page.fullscreen = false;
    applyLayout(page);
  });
  webContents.once('destroyed', () => {
    if (pages.get(page.browserId) === page) {
      pages.delete(page.browserId);
      if (page.releaseTimer) clearTimeout(page.releaseTimer);
      closeAgentLayers(page);
    }
  });
}

/** Chromium 的日志级别 → 原先 `<webview>` 的 console-message 用的数字(0 verbose … 3 error)。 */
const CONSOLE_LEVELS: Record<string, number> = { debug: 0, info: 1, warning: 2, error: 3 };

/**
 * 页签量到的位置与样子。`rect` 是占位在那扇窗视口里的 CSS 像素,这里乘上界面自己的缩放换成窗口内容区的 DIP。
 */
export function layoutBrowserPage(args: {
  browserId: string;
  windowName: string;
  rect: Rect | null;
  mode: BrowserPageMode;
}): boolean {
  const page = pages.get(args.browserId);
  if (!page || page.webContents.isDestroyed()) return false;
  if (args.windowName !== page.windowName) moveToHost(page, args.windowName);
  const host = page.host;
  const zoom = host && !host.isDestroyed() ? host.webContents.getZoomFactor() : 1;
  page.rect = args.rect ? toDip(args.rect, zoom) : null;
  page.mode = args.mode;
  applyLayout(page);
  return true;
}

export function toDip(rect: Rect, zoom: number): Rect {
  const x = Math.round(rect.x * zoom);
  const y = Math.round(rect.y * zoom);
  return {
    x,
    y,
    width: Math.max(0, Math.round((rect.x + rect.width) * zoom) - x),
    height: Math.max(0, Math.round((rect.y + rect.height) * zoom) - y),
  };
}

/** 占位卸下了:网页先停进停放窗、留一会儿等它挂回来,过了还没人要就关掉。 */
export function releaseBrowserPage(browserId: string): void {
  const page = pages.get(browserId);
  if (!page) return;
  page.mode = 'background';
  applyLayout(page);
  if (page.releaseTimer) clearTimeout(page.releaseTimer);
  page.releaseTimer = setTimeout(() => destroyBrowserPage(browserId), RELEASE_GRACE_MS);
}

/** 页签关了(会话关了、页签被关):网页当场关掉。 */
export function destroyBrowserPage(browserId: string): void {
  const page = pages.get(browserId);
  if (!page) return;
  pages.delete(browserId);
  if (page.releaseTimer) clearTimeout(page.releaseTimer);
  closeAgentLayers(page);
  unplace(page);
  if (!page.webContents.isDestroyed()) page.webContents.close();
}

function livePage(browserId: string): BrowserPage | null {
  const page = pages.get(browserId);
  return page && !page.webContents.isDestroyed() ? page : null;
}

export function navigateBrowserPage(browserId: string, url: string): boolean {
  const page = livePage(browserId);
  if (!page) return false;
  if (!isPreviewPageUrl(url) && !normalizeBrowserUrl(url, BROWSER_TAB_URL_OPTIONS).ok) return false;
  page.webContents.loadURL(url).catch(() => {
    // 失败照 did-fail-load 报。
  });
  return true;
}

export type BrowserPageCommand = 'goBack' | 'goForward' | 'reload' | 'reloadIgnoringCache' | 'stop' | 'focus';

export function runBrowserPageCommand(browserId: string, command: BrowserPageCommand): boolean {
  const page = livePage(browserId);
  if (!page) return false;
  const { webContents } = page;
  switch (command) {
    case 'goBack':
      if (webContents.navigationHistory.canGoBack()) webContents.navigationHistory.goBack();
      return true;
    case 'goForward':
      if (webContents.navigationHistory.canGoForward()) webContents.navigationHistory.goForward();
      return true;
    case 'reload':
      webContents.reload();
      return true;
    case 'reloadIgnoringCache':
      webContents.reloadIgnoringCache();
      return true;
    case 'stop':
      webContents.stop();
      return true;
    case 'focus':
      webContents.focus();
      return true;
  }
}

export function setBrowserPageZoom(browserId: string, factor: number): boolean {
  const page = livePage(browserId);
  if (!page) return false;
  page.webContents.setZoomFactor(normalizeBrowserZoomFactor(factor));
  return true;
}

export async function measureBrowserPage(browserId: string): Promise<BrowserPageLayout | null> {
  const page = livePage(browserId);
  if (!page) return null;
  try {
    return parseBrowserPageLayout(await page.webContents.executeJavaScript(BROWSER_PAGE_MEASURE_SCRIPT));
  } catch {
    // 网页可能正被导航走 / 崩了。量不到就不缩(这条兜底本来就是「能改善就改善」)。
    return null;
  }
}

/** 网页此刻的样子(JPEG data URL):页签被浮层盖住时,占位上换成这张。 */
export async function snapshotBrowserPage(browserId: string): Promise<string | null> {
  const page = livePage(browserId);
  // 从没摆好过的网页(视口 0×0)截不出图,Chromium 会一直等。
  if (!page || page.place === null || !page.rect) return null;
  try {
    const image = await page.webContents.capturePage();
    if (page.webContents.isDestroyed() || image.isEmpty()) return null;
    return `data:image/jpeg;base64,${image.toJPEG(85).toString('base64')}`;
  } catch {
    return null;
  }
}

/**
 * 要当面问人一句(如选哪把通行密钥)时,这一页此刻挂在哪扇人看得见的窗上:挂在窗上、那扇窗露着且没最小化才算。
 * 停放着、窗收进托盘或最小化 ⇒ null —— 调用方据此不问,❌ 为了问一句把窗抢到前面(会打断人在别处打字)。
 * 不是内置浏览器的网页(没登记在这里)⇒ undefined,由调用方自己认;❌ 和 null 混成一个值 —— 停放着的网页
 * 再去按「谁拥有它」找窗,就会把对话框挂到一扇看不见这页的窗上。
 */
export function visibleHostOfPage(contents: WebContents): BrowserWindow | null | undefined {
  for (const page of pages.values()) {
    if (page.webContents !== contents) continue;
    const host = page.place === 'host' ? page.host : null;
    return host && !host.isDestroyed() && host.isVisible() && !host.isMinimized() ? host : null;
  }
  return undefined;
}

/**
 * 界面要把焦点拿回自己身上(人在网页里时按了 ⌘K、点了界面的「聚焦地址栏」…):界面 JS 的 `focus()` 只在
 * 它自己那棵树里挪,网页这个独立 view 拿着窗口焦点时挪不动 —— 先把窗口焦点交回界面那一层。
 */
export function focusBrowserHost(windowName: string): boolean {
  const host = resolveHost(windowName);
  if (!host || host.isDestroyed()) return false;
  host.webContents.focus();
  return true;
}

// ---------------------------------------------------------------------------------------------
// agent 的鼠标与小条:窗口里叠在网页上面的两层(window-layers.ts),由页签那边 window.open 开出来、界面同一个渲染进程
// 直接画进去;主进程这里只管它们摆在哪、露不露。

/** 小条底边离网页底边多远(小条那层四周留了一圈给阴影的透明边,这里扣掉)。 */
const BADGE_BOTTOM_GAP = 4;

/** 开着的层,按 window.open 的名字(每次开都不一样):页签那边不要了时按名字关。 */
const agentLayersByName = new Map<string, WebContentsView>();

serveWindowLayers(AGENT_OVERLAY_WINDOW_NAME_PREFIX, {
  accepts: (frameName) => agentOverlayOfFrame(frameName) !== null,
  options: (frameName) => windowLayerOptions({ enablePreferredSizeMode: agentOverlayOfFrame(frameName)?.part === 'badge' }),
  open: openAgentLayer,
});

function openAgentLayer(host: BrowserWindow, frameName: string, content: WindowLayerContent): void {
  const { webContents } = content;
  const overlay = agentOverlayOfFrame(frameName);
  const page = overlay ? livePage(overlay.browserId) : null;
  const view = openWindowLayer(host, content, overlay?.part === 'badge' ? WINDOW_LAYER_RANK.agentBadge : WINDOW_LAYER_RANK.agentCursor, {
    // 点到鼠标层是人在操作网页:键盘焦点给网页。小条那层交回界面(默认)。
    focusTarget: () => (overlay?.part === 'cursor' && page && page.host === host && !page.webContents.isDestroyed() ? page.webContents : null),
  });
  agentLayersByName.set(frameName, view);
  webContents.once('destroyed', () => {
    if (agentLayersByName.get(frameName) === view) agentLayersByName.delete(frameName);
  });
  // 没有这张网页:关掉(页签那边只在网页建好之后才开层)。
  if (!overlay || !page) {
    setImmediate(() => {
      if (!webContents.isDestroyed()) webContents.close();
    });
    return;
  }
  const layer: AgentLayer = { part: overlay.part, view, contents: webContents, host, size: null };
  // 同一扇窗同一种只留一层:页签那边重开时,旧的那层由新的换掉(请主进程关旧层的那一下可能晚到)。
  for (const previous of page.layers.filter((entry) => entry.part === layer.part && entry.host === host)) {
    removeAgentLayer(page, previous);
    if (!previous.contents.isDestroyed()) previous.contents.close();
  }
  page.layers.push(layer);
  if (layer.part === 'badge') {
    webContents.on('preferred-size-changed', (_event, preferred) => {
      const sized = Number.isFinite(preferred.width) && Number.isFinite(preferred.height) && preferred.width > 0 && preferred.height > 0;
      layer.size = sized ? { width: Math.ceil(preferred.width), height: Math.ceil(preferred.height) } : null;
      placeAgentLayers(page);
    });
  }
  webContents.once('destroyed', () => removeAgentLayer(page, layer));
  placeAgentLayers(page);
}

function removeAgentLayer(page: BrowserPage, layer: AgentLayer): void {
  const at = page.layers.indexOf(layer);
  if (at !== -1) page.layers.splice(at, 1);
}

/**
 * 层只在网页露在开它的那扇窗上(挂在窗口上、页签那一块看得见、不是全屏)时露:小条摆在网页底部正中;鼠标那层铺满网页,
 * agent 操作时才露 —— 收着时也先摆好大小,露出来的头一帧鼠标就画在对的地方。
 */
function placeAgentLayers(page: BrowserPage): void {
  const rect = page.rect;
  const shown = page.place === 'host' && page.mode === 'shown' && !page.fullscreen && !!rect && rect.width > 0 && rect.height > 0;
  for (const layer of page.layers) {
    if (layer.contents.isDestroyed()) continue;
    const here = shown && layer.host === page.host;
    if (layer.part === 'cursor') {
      if (here && rect) layer.view.setBounds(rect);
      layer.view.setVisible(here && page.cursorShown);
      continue;
    }
    const size = layer.size;
    if (here && rect && size) {
      layer.view.setBounds({
        x: rect.x + Math.round((rect.width - size.width) / 2),
        y: rect.y + rect.height - size.height - BADGE_BOTTOM_GAP,
        ...size,
      });
    }
    layer.view.setVisible(here && !!size);
  }
}

function closeAgentLayers(page: BrowserPage): void {
  const layers = page.layers.splice(0);
  for (const layer of layers) if (!layer.contents.isDestroyed()) layer.contents.close();
}

/**
 * 页签那边不要这几层了(agent 不用这个页签了、页签不在屏上、挪了位置):按名字关掉。界面那边 ❌ 自己 window.close —— 那会关掉
 * 整扇咕咕窗口(window-layers.ts)。紧接着新开的那几层名字不同,不受影响。
 */
export function closeAgentOverlayLayers(frameNames: readonly string[]): void {
  for (const frameName of frameNames) {
    const view = agentLayersByName.get(frameName);
    if (view && !view.webContents.isDestroyed()) view.webContents.close();
  }
}

/**
 * 页签那边要不要画 agent 的鼠标(agent 在操作这个页签、页签在屏上):要画时鼠标那层铺满网页露出来,
 * 不画时收起 —— 它盖着网页,人的点击、滚动由页签转交给网页。
 */
export function setAgentCursorShown(browserId: string, shown: boolean): void {
  const page = livePage(browserId);
  if (!page || page.cursorShown === shown) return;
  page.cursorShown = shown;
  placeAgentLayers(page);
}

/** A decorative native view cannot let input through; deliver the person's input to its page. */
export function forwardAgentCursorInput(browserId: string, input: BrowserCursorInput): boolean {
  const page = livePage(browserId);
  if (!page || page.place !== 'host' || page.mode !== 'shown' || !page.cursorShown || page.fullscreen) return false;
  const pointer = browserCursorInput(input);
  if (!pointer) return false;
  if (pointer.type === 'mouseDown') page.webContents.focus();
  page.webContents.sendInputEvent(pointer);
  return true;
}
