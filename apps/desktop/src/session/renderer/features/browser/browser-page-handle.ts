import { rpc } from '@renderer/lib/ipc';
import type { BrowserPageLayout } from '@shared/browser-page-layout';
import type { BrowserPageEvent, BrowserPageState } from '@shared/events/browserEvents';
import type { BrowserWebviewAdapter, BrowserWebviewEventMap } from './browser-webview-types';

/**
 * #7274 页签里那张网页在界面这边的代理。网页本身是主进程持有的 WebContentsView(browser-page-views.ts),
 * 界面读不到它:导航状态随主进程报来的每一条网页事件更新一份镜像(`state`),操作一律经 RPC 交给主进程。
 * 事件名与字段沿用原先 `<webview>` 的(did-navigate 带 url、did-fail-load 带 errorCode…),绑事件的那边不必分两套。
 */
export class BrowserPageHandle {
  private readonly target = new EventTarget();
  private state: BrowserPageState = { url: '', title: '', canGoBack: false, canGoForward: false };
  /** 网页的文档已经就绪过(dom-ready 来过):页签挪了位置、接着用原来那张网页时,挂上就是就绪的。 */
  ready = false;

  constructor(
    readonly browserId: string,
    /** 界面里那块占位(量宽度、定位用)。 */
    readonly element: HTMLElement
  ) {}

  /** 主进程挂好网页时回的那份:接着用原来那张网页时带着它此刻的状态。 */
  mounted(result: { ready: boolean; state: BrowserPageState }): void {
    this.state = result.state;
    if (result.ready) this.ready = true;
  }

  /** 主进程报来一条网页事件:先更新镜像,再按 `<webview>` 的样子派发出去。 */
  apply(event: BrowserPageEvent): void {
    this.state = event.state;
    if (event.type === 'dom-ready') this.ready = true;
    this.target.dispatchEvent(Object.assign(new Event(event.type), event.detail));
  }

  addEventListener<K extends keyof BrowserPageHandleEventMap>(type: K, listener: (event: BrowserPageHandleEventMap[K]) => void): void {
    this.target.addEventListener(type, listener as unknown as EventListener);
  }

  removeEventListener<K extends keyof BrowserPageHandleEventMap>(type: K, listener: (event: BrowserPageHandleEventMap[K]) => void): void {
    this.target.removeEventListener(type, listener as unknown as EventListener);
  }

  canGoBack(): boolean {
    return this.state.canGoBack;
  }

  canGoForward(): boolean {
    return this.state.canGoForward;
  }

  getURL(): string {
    return this.state.url;
  }

  getTitle(): string {
    return this.state.title;
  }

  goBack(): void {
    void rpc.browser.pageCommand({ browserId: this.browserId, command: 'goBack' });
  }

  goForward(): void {
    void rpc.browser.pageCommand({ browserId: this.browserId, command: 'goForward' });
  }

  reload(): void {
    void rpc.browser.pageCommand({ browserId: this.browserId, command: 'reload' });
  }

  reloadIgnoringCache(): void {
    void rpc.browser.pageCommand({ browserId: this.browserId, command: 'reloadIgnoringCache' });
  }

  stop(): void {
    void rpc.browser.pageCommand({ browserId: this.browserId, command: 'stop' });
  }

  /** 把窗口焦点交给网页(人点了页签、要在网页里打字)。 */
  focus(): void {
    void rpc.browser.pageCommand({ browserId: this.browserId, command: 'focus' });
  }

  async loadURL(url: string): Promise<void> {
    await rpc.browser.navigatePage({ browserId: this.browserId, url });
  }

  setZoomFactor(factor: number): void {
    void rpc.browser.setPageZoom({ browserId: this.browserId, factor });
  }

  /** 量网页的排版(browser-page-fit.ts):量是在网页自己的进程里量,主进程代跑。 */
  async measureLayout(): Promise<BrowserPageLayout | null> {
    return (await rpc.browser.measurePage(this.browserId)).layout;
  }

  /** 占位在界面里的位置与大小 —— 网页就摆在这一块上。 */
  getBoundingClientRect(): DOMRect {
    return this.element.getBoundingClientRect();
  }
}

/** 与 `<webview>` 同名的那几条事件,外加窗口焦点进出网页(focus / blur)。 */
export type BrowserPageHandleEventMap = BrowserWebviewEventMap & { focus: Event; blur: Event };

export function createBrowserPageAdapter(page: BrowserPageHandle): BrowserWebviewAdapter {
  return {
    canGoBack: () => page.canGoBack(),
    canGoForward: () => page.canGoForward(),
    currentUrl: () => page.getURL(),
    title: () => page.getTitle(),
    goBack: () => page.goBack(),
    goForward: () => page.goForward(),
    reload: () => page.reload(),
    reloadIgnoringCache: () => page.reloadIgnoringCache(),
    stop: () => page.stop(),
    loadUrl: (url: string) => page.loadURL(url),
    setZoomFactor: (factor: number) => page.setZoomFactor(factor),
    focus: () => page.focus(),
  };
}
