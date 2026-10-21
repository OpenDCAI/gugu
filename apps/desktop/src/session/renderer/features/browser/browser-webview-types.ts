export type BrowserWebviewEventMap = {
  'dom-ready': Event;
  'did-start-loading': Event;
  'did-stop-loading': Event;
  'did-navigate': { url: string };
  'did-navigate-in-page': { url: string };
  'did-fail-load': { errorCode: number; errorDescription: string; validatedURL: string };
  'console-message': { level: number; message: string; line: number; sourceId: string };
  'page-title-updated': { title: string };
  'page-favicon-updated': { favicons: string[] };
};

export type BrowserWebviewElement = HTMLElement & {
  canGoBack(): boolean;
  canGoForward(): boolean;
  getURL(): string;
  getTitle(): string;
  getWebContentsId(): number;
  goBack(): void;
  goForward(): void;
  reload(): void;
  reloadIgnoringCache(): void;
  stop(): void;
  loadURL(url: string): Promise<void> | void;
  setZoomFactor(factor: number): void;
  /** 双指捏合(visual zoom)的上下限。Electron 默认关着,开它只作用于这个客体(#6456)。 */
  setVisualZoomLevelLimits(minimumLevel: number, maximumLevel: number): Promise<void>;
  /**
   * 在内嵌页里求值。这里只用来**量**页面(browser-page-fit.ts):它有没有 viewport meta、
   * 100% 下自己要多宽 —— 宿主这边量不到,那是另一个渲染进程里的排版结果。
   */
  executeJavaScript(code: string): Promise<unknown>;
  /**
   * Injects a stylesheet into the embedded document and removes it again by the
   * returned key. Used by extension surfaces (#2374) to hand an extension the
   * host's theme variables — this type is what `<webview>` refs resolve to
   * app-wide (see types/webview.d.ts), so both features read the same shape.
   */
  insertCSS(css: string): Promise<string>;
  removeInsertedCSS(key: string): Promise<void>;
  addEventListener<K extends keyof BrowserWebviewEventMap>(
    type: K,
    listener: (event: BrowserWebviewEventMap[K]) => void
  ): void;
  removeEventListener<K extends keyof BrowserWebviewEventMap>(
    type: K,
    listener: (event: BrowserWebviewEventMap[K]) => void
  ): void;
};

export type BrowserWebviewAdapter = {
  canGoBack(): boolean;
  canGoForward(): boolean;
  currentUrl(): string;
  title(): string;
  goBack(): void;
  goForward(): void;
  reload(): void;
  reloadIgnoringCache(): void;
  stop(): void;
  loadUrl(url: string): Promise<void>;
  setZoomFactor(factor: number): void;
  focus(): void;
};

export function createBrowserWebviewAdapter(webview: BrowserWebviewElement): BrowserWebviewAdapter {
  return {
    canGoBack: () => webview.canGoBack(),
    canGoForward: () => webview.canGoForward(),
    currentUrl: () => webview.getURL(),
    title: () => webview.getTitle(),
    goBack: () => webview.goBack(),
    goForward: () => webview.goForward(),
    reload: () => webview.reload(),
    reloadIgnoringCache: () => webview.reloadIgnoringCache(),
    stop: () => webview.stop(),
    loadUrl: async (url: string) => {
      await webview.loadURL(url);
    },
    setZoomFactor: (factor: number) => webview.setZoomFactor(factor),
    focus: () => webview.focus(),
  };
}
