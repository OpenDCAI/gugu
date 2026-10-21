import { BROWSER_DEFAULT_URL, normalizeBrowserZoomFactor } from '@shared/browser';
import { browserDiagnosticsStore } from './browser-diagnostics-store';
import { fitBrowserPageToPane, resetAutoBrowserZoom } from './browser-page-fit';
import { browserSessionStore } from './browser-session-store';
import type { BrowserPageHandle } from './browser-page-handle';

/**
 * 页签里那张网页的事件 → 页签的状态(地址、标题、前进后退、加载中、加载失败、诊断日志)。
 * 网页是主进程持有的 view(#7274),事件经 handle 转来,名字与字段同原先的 `<webview>`。
 */
export function bindBrowserPageEvents(
  browserId: string,
  webview: BrowserPageHandle,
  options: { onDomReady?: () => void } = {}
): () => void {
  let isDomReady = false;
  const historySyncTimers = new Set<ReturnType<typeof setTimeout>>();

  const syncHistoryState = () => {
    if (!isDomReady) return;
    const currentUrl = webview.getURL() || BROWSER_DEFAULT_URL;
    browserSessionStore.updateSession(browserId, {
      currentUrl,
      title: webview.getTitle(),
      canGoBack: webview.canGoBack(),
      canGoForward: webview.canGoForward(),
    });
  };

  const scheduleHistoryStateSync = () => {
    for (const timer of historySyncTimers) clearTimeout(timer);
    historySyncTimers.clear();

    for (const delay of [0, 50, 200]) {
      const timer = setTimeout(() => {
        historySyncTimers.delete(timer);
        syncHistoryState();
      }, delay);
      historySyncTimers.add(timer);
    }
  };

  const scheduleHistoryStateSyncOnce = () => {
    const timer = setTimeout(() => {
      historySyncTimers.delete(timer);
      syncHistoryState();
    }, 0);
    historySyncTimers.add(timer);
  };

  const applySessionZoom = () => {
    const session = browserSessionStore.getSession(browserId);
    if (session?.zoomFactor === undefined) return;
    webview.setZoomFactor(normalizeBrowserZoomFactor(session.zoomFactor));
  };

  const onDomReady = () => {
    isDomReady = true;
    // 双指捏合(#6456)由主进程在网页每次 dom-ready 时打开(browser-page-views.ts)。
    applySessionZoom();
    syncHistoryState();
    options.onDomReady?.();
  };

  const onStartLoading = () => {
    browserSessionStore.updateSession(browserId, {
      faviconUrl: null,
      isLoading: true,
      loadError: null,
    });
  };

  const onStopLoading = () => {
    if (!isDomReady) return;
    const currentUrl = webview.getURL() || BROWSER_DEFAULT_URL;
    browserSessionStore.updateSession(browserId, {
      isLoading: false,
      currentUrl,
      title: webview.getTitle(),
      canGoBack: webview.canGoBack(),
      canGoForward: webview.canGoForward(),
    });
    applySessionZoom();
    scheduleHistoryStateSyncOnce();
    // 加载完才量得到这一页要多宽。没有 viewport meta 且比面板宽,就整幅缩进面板 ——
    // 为什么这条兜底存在、边界在哪,见 browser-page-fit.ts。
    void fitBrowserPageToPane(browserId, webview, { remeasure: true });
  };

  const syncNavigation = (event: { url: string }) => {
    browserSessionStore.updateSession(browserId, {
      currentUrl: event.url,
      canGoBack: webview.canGoBack(),
      canGoForward: webview.canGoForward(),
      loadError: null,
    });
  };

  const onNavigate = (event: { url: string }) => {
    if (!isDomReady) return;
    syncNavigation(event);
    // 换页了:上一页算出来的自动缩放对这一页无效,先收回 100%,再由 did-stop-loading 重新量。
    // ⚠️ 必须排在 applySessionZoom 之前 —— 它读的就是这里刚写回去的那个值。
    resetAutoBrowserZoom(browserId, webview);
    applySessionZoom();
    scheduleHistoryStateSync();
  };

  /** 页内跳转(锚点、history.pushState)**还是同一张页面** —— ❌ 不收回自动缩放:
   *  收了就得重量一次,而这一页的宽度并没有变,用户看到的是无端一闪。 */
  const onNavigateInPage = (event: { url: string }) => {
    if (!isDomReady) return;
    syncNavigation(event);
    applySessionZoom();
    scheduleHistoryStateSync();
  };

  const onFailLoad = (event: {
    errorCode: number;
    errorDescription: string;
    validatedURL: string;
  }) => {
    if (event.errorCode === -3) return;
    browserSessionStore.updateSession(browserId, {
      isLoading: false,
      loadError: {
        code: event.errorCode,
        description: event.errorDescription,
        url: event.validatedURL,
      },
    });
    browserDiagnosticsStore.append({
      browserId,
      level: 'error',
      source: 'navigation',
      message: event.errorDescription,
      url: event.validatedURL,
    });
  };

  const onConsoleMessage = (event: {
    level: number;
    message: string;
    line: number;
    sourceId: string;
  }) => {
    if (!shouldRecordConsoleDiagnostic(event)) return;
    browserDiagnosticsStore.append({
      browserId,
      level: consoleLevelToDiagnosticsLevel(event.level),
      source: 'console',
      message: event.message,
      url: event.sourceId,
      line: event.line,
    });
  };

  const onTitle = (event: { title: string }) => {
    browserSessionStore.updateSession(browserId, { title: event.title });
  };

  const onFavicon = (event: { favicons: string[] }) => {
    browserSessionStore.updateSession(browserId, { faviconUrl: event.favicons[0] });
  };

  webview.addEventListener('dom-ready', onDomReady);
  webview.addEventListener('did-start-loading', onStartLoading);
  webview.addEventListener('did-stop-loading', onStopLoading);
  webview.addEventListener('did-navigate', onNavigate);
  webview.addEventListener('did-navigate-in-page', onNavigateInPage);
  webview.addEventListener('did-fail-load', onFailLoad);
  webview.addEventListener('console-message', onConsoleMessage);
  webview.addEventListener('page-title-updated', onTitle);
  webview.addEventListener('page-favicon-updated', onFavicon);

  // 页签挪了位置、接着用原来那张网页:它早就绪了,不会再来一次 dom-ready。
  if (webview.ready) onDomReady();

  return () => {
    for (const timer of historySyncTimers) clearTimeout(timer);
    historySyncTimers.clear();
    webview.removeEventListener('dom-ready', onDomReady);
    webview.removeEventListener('did-start-loading', onStartLoading);
    webview.removeEventListener('did-stop-loading', onStopLoading);
    webview.removeEventListener('did-navigate', onNavigate);
    webview.removeEventListener('did-navigate-in-page', onNavigateInPage);
    webview.removeEventListener('did-fail-load', onFailLoad);
    webview.removeEventListener('console-message', onConsoleMessage);
    webview.removeEventListener('page-title-updated', onTitle);
    webview.removeEventListener('page-favicon-updated', onFavicon);
  };
}

function consoleLevelToDiagnosticsLevel(level: number) {
  if (level >= 3) return 'error';
  if (level === 2) return 'warning';
  return 'info';
}

function shouldRecordConsoleDiagnostic(event: { message: string; sourceId: string }): boolean {
  if (!event.sourceId.startsWith('node:electron/')) return true;
  return !event.message.includes('Electron Security Warning');
}
