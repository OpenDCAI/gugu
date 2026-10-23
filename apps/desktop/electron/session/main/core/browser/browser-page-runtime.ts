import type { BrowserWindow, NativeImage, Rectangle, WebContents, WebContentsView } from 'electron';

export type BrowserPageLease = {
  ready: Promise<void>;
  setActive(active: boolean): void;
  capture(params: Record<string, unknown>): Promise<unknown>;
  dispose(): void;
};

const runtimes = new WeakMap<WebContents, BrowserPageRuntime>();
const OPERATION_TIMEOUT_MS = 10_000;

/** The page owns its contents; presentation and protocol connections only borrow it. */
export class BrowserPageRuntime {
  readonly contents: WebContents;
  host: BrowserWindow | null = null;
  private shown = false;
  private state: 'new' | 'initializing' | 'ready' | 'failed' | 'closed' = 'new';
  private throttled = true;
  private subscribed = false;
  private readonly lifetime = new AbortController();
  private readonly users = new Set<object>();
  private readonly active = new Set<object>();
  private boot: Promise<void> | null = null;
  private destination = 'about:blank';
  private destinationStarted = false;
  private captureTail: Promise<unknown> = Promise.resolve();
  private navigation = 0;
  private attached: (() => void) | null = null;
  private attachment = new Promise<void>(resolve => { this.attached = resolve; });

  constructor(readonly view: WebContentsView, private readonly onUnused: () => void = () => {}) {
    this.contents = view.webContents;
    view.setBounds({ x: 0, y: 0, width: 1024, height: 768 });
    view.setVisible(false);
    runtimes.set(this.contents, this);
    this.contents.once('destroyed', () => this.finish(false));
  }

  get inUse(): boolean { return this.users.size > 0; }
  get requestedUrl(): string { return this.destination; }
  get initializing(): boolean { return this.state === 'new' || this.state === 'initializing'; }
  get failed(): boolean { return this.state === 'failed'; }
  private get closed(): boolean { return this.state === 'closed'; }
  get ready(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('the browser tab was closed'));
    if (!this.boot || this.failed) {
      this.state = 'initializing';
      this.boot = this.initialize().then(() => {
        if (!this.closed) this.state = 'ready';
      }, error => {
        if (!this.closed) this.state = 'failed';
        throw error;
      });
    }
    return this.boot;
  }

  moveTo(host: BrowserWindow | null): void {
    if (this.closed || this.host === host) return;
    if (!this.contents.isDestroyed()) this.view.setVisible(false);
    if (this.host && !this.host.isDestroyed()) this.host.contentView.removeChildView(this.view);
    this.host = host;
    if (!host) this.attachment = new Promise<void>(resolve => { this.attached = resolve; });
    if (host && !host.isDestroyed()) {
      host.contentView.addChildView(this.view);
      this.view.setVisible(this.shown);
      this.attached?.();
      this.attached = null;
    }
  }

  layout(rect: Rectangle | null, shown: boolean): void {
    if (this.closed || this.contents.isDestroyed()) return;
    this.shown = shown;
    if (rect && rect.width > 0 && rect.height > 0) this.view.setBounds(rect);
    this.view.setVisible(shown);
  }

  /** Navigation cannot run site scripts until the native viewport exists. Newer requests supersede old ones. */
  async navigate(url: string): Promise<void> {
    this.destination = url;
    const revision = ++this.navigation;
    await this.ready;
    this.assertLive();
    if (revision !== this.navigation) return;
    this.destinationStarted = true;
    await this.contents.loadURL(url);
  }

  async reload(ignoringCache = false): Promise<void> {
    if (this.state !== 'ready' || !this.destinationStarted) return this.navigate(this.destination);
    this.assertLive();
    if (ignoringCache) this.contents.reloadIgnoringCache();
    else this.contents.reload();
  }

  raise(): void {
    if (!this.closed && !this.contents.isDestroyed() && this.host && !this.host.isDestroyed()) {
      this.host.contentView.addChildView(this.view);
    }
  }

  stop(): void {
    this.navigation += 1;
    if (!this.closed && !this.contents.isDestroyed()) this.contents.stop();
  }

  acquire(): BrowserPageLease {
    this.assertLive();
    const token = {};
    this.users.add(token);
    const lifetime = new AbortController();
    let disposed = false;
    return {
      ready: this.ready,
      setActive: active => {
        if (disposed || this.closed) return;
        if (active) this.active.add(token);
        else this.active.delete(token);
        this.syncThrottling();
      },
      capture: params => disposed
        ? Promise.reject(new Error('the browser connection was closed'))
        : this.capture(() => this.contents.debugger.sendCommand('Page.captureScreenshot', params), lifetime.signal),
      dispose: () => {
        if (disposed) return;
        disposed = true;
        lifetime.abort(new Error('the browser connection was closed'));
        this.active.delete(token);
        this.syncThrottling();
        this.release(token);
      },
    };
  }

  snapshot(): Promise<NativeImage> {
    return this.capture(() => this.contents.capturePage(undefined, { stayHidden: true }));
  }

  close(): void { this.finish(true); }

  private finish(closeContents: boolean): void {
    if (this.closed) return;
    this.state = 'closed';
    runtimes.delete(this.contents);
    this.lifetime.abort(new Error('the browser tab was closed'));
    this.stopFrames();
    this.active.clear();
    this.users.clear();
    if (!this.contents.isDestroyed()) {
      this.contents.setBackgroundThrottling(true);
      this.view.setVisible(false);
      if (this.host && !this.host.isDestroyed()) this.host.contentView.removeChildView(this.view);
    }
    this.host = null;
    if (closeContents && !this.contents.isDestroyed()) this.contents.close();
  }

  private async initialize(): Promise<void> {
    await this.bounded(this.attachment);
    this.assertLive();
    // Initialize the native viewport while the contents are still empty. This synchronous
    // transition cannot paint a destination page or add a bootstrap navigation to history.
    this.view.setVisible(true);
    this.view.setVisible(this.shown);
  }

  /** All image consumers share a queue. Frame production exists only for an outstanding capture. */
  private capture<T>(operation: () => Promise<T>, consumer?: AbortSignal): Promise<T> {
    if (this.closed || this.contents.isDestroyed()) return Promise.reject(new Error('the browser tab was closed'));
    const token = {};
    this.users.add(token);
    const signal = consumer ? AbortSignal.any([this.lifetime.signal, consumer]) : this.lifetime.signal;
    let started = false;
    const run = async () => {
      started = true;
      try {
        signal.throwIfAborted();
        this.assertLive();
        await this.bounded(this.ready, signal);
        await this.bounded(this.attachment, signal);
        this.assertLive();
        if (!this.host || this.host.isDestroyed()) throw new Error('the browser page host was closed');
        this.active.add(token);
        this.syncThrottling();
        const frame = new Promise<void>(resolve => {
          this.contents.beginFrameSubscription(true, image => { if (!image.isEmpty()) resolve(); });
          this.subscribed = true;
        });
        await this.bounded(frame, signal);
        return await this.bounded(operation(), signal, 120_000);
      } finally {
        this.stopFrames();
        this.active.delete(token);
        this.syncThrottling();
        this.release(token);
      }
    };
    const result = this.captureTail.then(run, run);
    this.captureTail = result.catch(() => {});
    return this.bounded(result, signal, 0).finally(() => { if (!started) this.release(token); });
  }

  private release(token: object): void {
    if (this.users.delete(token) && !this.inUse && !this.closed) this.onUnused();
  }

  private stopFrames(): void {
    if (!this.subscribed) return;
    this.subscribed = false;
    if (!this.contents.isDestroyed()) this.contents.endFrameSubscription();
  }

  private syncThrottling(): void {
    if (this.closed || this.contents.isDestroyed()) return;
    const throttled = this.active.size === 0;
    if (throttled === this.throttled) return;
    this.contents.setBackgroundThrottling(throttled);
    this.throttled = throttled;
  }

  private assertLive(): void {
    if (this.closed || this.contents.isDestroyed()) throw new Error('the browser tab was closed');
  }

  private bounded<T>(promise: Promise<T>, signal = this.lifetime.signal, timeoutMs = OPERATION_TIMEOUT_MS): Promise<T> {
    return new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
      const abort = () => { done(); reject(signal.reason); };
      const timer = timeoutMs > 0 && !signal.aborted ? setTimeout(() => { done(); reject(new Error('the browser page did not produce a frame in time')); }, timeoutMs) : undefined;
      // Observe the operation even when cancellation won before this wrapper was entered.
      promise.then(value => { done(); resolve(value); }, error => { done(); reject(error); });
      if (signal.aborted) { abort(); return; }
      timer?.unref?.();
      signal.addEventListener('abort', abort, { once: true });
    });
  }
}

export function acquireBrowserPage(contents: WebContents): BrowserPageLease | undefined {
  return runtimes.get(contents)?.acquire();
}
