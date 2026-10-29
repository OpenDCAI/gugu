import WebSocket from 'ws';

/**
 * #7199 云浏览器:到云电脑上那一个 Chrome 的唯一一条 CDP 连接(浏览器级 websocket,`flatten` 会话)。
 * agent 的页签(page-transport.ts)、人看的画面与接管(live-server.ts)、交还前的密码脱敏(browser-passwords.ts)都从这一条上分会话走 ——
 * ❌ 各自再连一条:Chrome 每条连接都要自己的 Target 发现,彼此看不到对方 attach 的会话。
 */
export type CdpEvent = { method: string; params: Record<string, unknown>; sessionId?: string };

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; method: string };

export class CdpError extends Error {
  constructor(
    readonly method: string,
    message: string
  ) {
    super(`${method}: ${message}`);
    this.name = 'CdpError';
  }
}

/** 测试与生产共用的那一点 socket 形状(ws 的 WebSocket 满足它)。 */
export interface CdpSocket {
  send(data: string): void;
  close(): void;
  on(event: 'message', listener: (data: WebSocket.RawData) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export class CdpHub {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(event: CdpEvent) => void>();
  private readonly closeListeners = new Set<(reason: string) => void>();
  private closedReason: string | null = null;

  constructor(private readonly socket: CdpSocket) {
    socket.on('message', (data) => this.receive(String(data)));
    socket.on('close', () => this.finish('the browser connection closed'));
    socket.on('error', (error) => this.finish(`the browser connection failed: ${error.message}`));
  }

  /** 连上 Chrome 的浏览器级 websocket(DevToolsActivePort 里那条路径)。 */
  static connect(url: string, timeoutMs = 10_000): Promise<CdpHub> {
    return new Promise((resolve, reject) => {
      // 画面帧一张可达几 MB;❌ 压缩(本机回环,压缩只多花 CPU)。
      const socket = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error(`could not connect to the browser within ${timeoutMs} ms`));
      }, timeoutMs);
      socket.once('open', () => {
        clearTimeout(timer);
        resolve(new CdpHub(socket));
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  get closed(): boolean {
    return this.closedReason !== null;
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.closedReason) return Promise.reject(new CdpError(method, this.closedReason));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, method });
      try {
        this.socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        reject(new CdpError(method, (error as Error).message));
      }
    });
  }

  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: (reason: string) => void): () => void {
    if (this.closedReason) {
      listener(this.closedReason);
      return () => {};
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): void {
    if (this.closedReason) return;
    try {
      this.socket.close();
    } catch {
      // closing a socket that already failed: finish() below says why
    }
    this.finish('closed');
  }

  private receive(raw: string): void {
    let message: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof message.id === 'number') {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new CdpError(waiter.method, message.error.message ?? 'failed'));
      else waiter.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method !== 'string') return;
    const event: CdpEvent = { method: message.method, params: message.params ?? {}, ...(message.sessionId ? { sessionId: message.sessionId } : {}) };
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // one listener's bug must not starve the others of events
      }
    }
  }

  private finish(reason: string): void {
    if (this.closedReason) return;
    this.closedReason = reason;
    for (const [, waiter] of this.pending) waiter.reject(new CdpError(waiter.method, reason));
    this.pending.clear();
    for (const listener of [...this.closeListeners]) listener(reason);
    this.closeListeners.clear();
    this.listeners.clear();
  }
}
