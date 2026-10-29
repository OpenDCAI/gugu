import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { noteTunnelActivity, quietTunnelPort } from '@gugu/core/cloud/remoteTunnel';
import { log } from '@main/lib/logger';
import {
  CLOUD_BROWSER_PROTOCOL,
  CLOUD_BROWSER_TICKET_PREFIX,
  parseCloudBrowserClientMessage,
  type CloudBrowserClientMessage,
  type CloudBrowserServerMessage,
  type CloudBrowserSnapshot,
  type CloudBrowserState,
} from '@shared/cloud-browser';
import type { CdpEvent, CdpHub } from './cdp-hub';
import { cloudBrowser, type CloudBrowser } from './cloud-browser';
import { removedVaultRequest } from './removed-vault-request';

/**
 * #7199 云浏览器的实时画面与接管(`/v1/browser/{target}/stream`):云电脑本机回环上的一个 websocket,
 * 桌面经远程隧道转一个本机端口过来连。
 *
 * - 画面 = 那个页签的 `Page.startScreencast`(JPEG,有变化才出帧);每个看的人按自己要的帧率收、画完回 ack 才给下一张
 *   (pacing:ack)。没人看的页签不出帧。
 * - 接管是独占的(cloud-browser.ts):只有拿着控制权的那个连接发的点击 / 键盘 / 文字 / 切换关闭标签页才交给 Chrome。
 * - Protocol-13 credential submissions are refused immediately; see removed-vault-request.ts.
 * 凭证 = 每次进程启动随机的一串,经 `cloudBrowser.status` 交给本人(设备 RPC 只有本人收得到)。
 */

type Frame = { tabId: string; data: string; width: number; height: number; viewportWidth: number; viewportHeight: number; at: number };

type Client = {
  id: string;
  socket: WebSocket;
  framesEnabled: boolean;
  maxFps: number;
  maxWidth: number;
  maxHeight: number;
  tabId: string | null;
  seq: number;
  awaitingAck: { seq: number; at: number } | null;
  lastSentAt: number;
  pending: Frame | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
  lastState: string;
};

type Cast = { tabId: string; session: string; maxWidth: number; maxHeight: number; running: boolean };

/** 回 ack 等太久(那头卡了 / 丢了)就当它回过了,❌ 让画面就此停住。 */
const ACK_STALE_MS = 5_000;
const PING_MS = 20_000;
/**
 * 人做的决定,不要求先接管 —— 收到就算「在用」(远程隧道据此判断云电脑别睡)。接管后的输入在控制权检查之后另记;
 * 只看画面(config / ack / keepalive)不算:助理在用浏览器干活时,管家有「助理在干活就不睡」兜着。
 */
const PERSON_ACTIONS = new Set<CloudBrowserClientMessage['type']>([
  'control_acquire',
  'control_release',
  'automation_stop',
  'automation_resume',
]);
const SCREENCAST_QUALITY = 60;

/** JPEG 的宽高(SOF 段);读不出 = null。 */
export function jpegSize(base64: string): { width: number; height: number } | null {
  const bytes = Buffer.from(base64.slice(0, 64 * 1024), 'base64');
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1]!;
    const length = bytes.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    }
    i += 2 + length;
  }
  return null;
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class CloudBrowserLiveServer {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private listening: Promise<{ port: number; token: string }> | null = null;
  private readonly token = randomBytes(24).toString('base64url');
  private readonly clients = new Map<string, Client>();
  private readonly casts = new Map<string, Cast>();
  private readonly viewerSessions = new Map<string, Promise<string>>();
  private readonly latest = new Map<string, Frame>();
  private hubBound: CdpHub | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private unquiet: (() => void) | null = null;

  constructor(private readonly browser: CloudBrowser) {
    browser.onChange(() => this.onBrowserChange());
    this.bindHub(browser.hub());
  }

  /** 开着就回端口与凭证;第一次调用时才开。 */
  ensure(): Promise<{ port: number; token: string }> {
    this.listening ??= this.listen().catch((error: unknown) => {
      this.listening = null;
      throw error;
    });
    return this.listening;
  }

  private listen(): Promise<{ port: number; token: string }> {
    const server = http.createServer((_req, res) => {
      res.writeHead(404).end();
    });
    const wss = new WebSocketServer({
      server,
      path: '/live',
      perMessageDeflate: false,
      maxPayload: 64 * 1024,
      handleProtocols: (protocols) => (protocols.has(CLOUD_BROWSER_PROTOCOL) ? CLOUD_BROWSER_PROTOCOL : false),
      verifyClient: ({ req }: { req: http.IncomingMessage }) => {
        const offered = String(req.headers['sec-websocket-protocol'] ?? '')
          .split(',')
          .map((p) => p.trim());
        const ticket = offered.find((p) => p.startsWith(CLOUD_BROWSER_TICKET_PREFIX))?.slice(CLOUD_BROWSER_TICKET_PREFIX.length);
        return !!ticket && sameSecret(ticket, this.token);
      },
    });
    wss.on('connection', (socket) => this.accept(socket));
    // ws 遇到超长帧 / 协议错误会在连接上发 'error':没人接 = 未捕获异常,整个账号进程跟着退出。
    wss.on('error', (error) => log.warn('Cloud browser: the live server failed', { error: String(error) }));
    this.server = server;
    this.wss = wss;
    this.pingTimer = setInterval(() => {
      for (const client of this.clients.values()) {
        const alive = (client.socket as WebSocket & { guguAlive?: boolean }).guguAlive;
        if (alive === false) {
          client.socket.terminate();
          continue;
        }
        (client.socket as WebSocket & { guguAlive?: boolean }).guguAlive = false;
        client.socket.ping();
      }
    }, PING_MS);
    this.pingTimer.unref?.();
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ port: 0, host: '127.0.0.1' }, () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        if (!port) return reject(new Error('the live browser server got no port'));
        // 桌面经隧道转到这个端口:画面帧、ack、保活一直在走,不能让它们把云电脑一直顶着不睡 ——
        // 端口登记成「安静」,只有人的操作(handle 里)才记「在用」。端口经 status 交出去之前就登记好。
        this.unquiet = quietTunnelPort(port);
        log.info('Cloud browser: live server listening', { port });
        server.off('error', reject);
        server.on('error', (error) => log.warn('Cloud browser: the live server failed', { error: String(error) }));
        resolve({ port, token: this.token });
      });
    });
  }

  close(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.unquiet?.();
    this.unquiet = null;
    for (const client of this.clients.values()) client.socket.terminate();
    this.wss?.close();
    this.server?.close();
  }

  watching(sessionId?: string): boolean {
    const tabId = sessionId === undefined ? null : this.browser.tabIdForSession(sessionId);
    return [...this.clients.values()].some((client) => client.framesEnabled
      && (sessionId === undefined ? !!this.viewedTab(client) : !!tabId && this.viewedTab(client) === tabId));
  }

  // ── 连接 ──────────────────────────────────────────────────────────────────

  private accept(socket: WebSocket): void {
    const client: Client = {
      id: randomUUID(),
      socket,
      framesEnabled: false,
      maxFps: 1,
      maxWidth: 640,
      maxHeight: 360,
      tabId: null,
      seq: 0,
      awaitingAck: null,
      lastSentAt: 0,
      pending: null,
      flushTimer: null,
      lastState: '',
    };
    this.clients.set(client.id, client);
    (socket as WebSocket & { guguAlive?: boolean }).guguAlive = true;
    socket.on('error', (error) => log.warn('Cloud browser: a viewer connection failed', { error: String(error) }));
    socket.on('pong', () => {
      (socket as WebSocket & { guguAlive?: boolean }).guguAlive = true;
    });
    socket.on('message', (data) => {
      const raw = String(data);
      const removed = removedVaultRequest(raw);
      if (removed) return this.send(client, { type: 'vault_result', requestId: removed.requestId, ok: false, reason: 'gone', code: 'feature_removed', message: 'Saving website passwords has been removed. Update Gugu, or take control and log in on the page.' });
      const message = parseCloudBrowserClientMessage(raw);
      if (!message) return this.send(client, { type: 'error', code: 'invalid_message', message: 'unrecognized message' });
      void this.handle(client, message).catch((error: unknown) => {
        log.warn('Cloud browser: a viewer message failed', { type: message.type, error: String(error) });
        this.send(client, { type: 'error', code: 'failed', message: error instanceof Error ? error.message : String(error) });
      });
    });
    socket.on('close', () => {
      this.clients.delete(client.id);
      if (client.flushTimer) clearTimeout(client.flushTimer);
      // 拿着控制权的那个人断开了 = 交还(❌ 让 agent 一直被挡着)。
      void this.browser.releaseControl(client.id);
      void this.syncCasts();
    });
    this.pushState(client);
  }

  private send(client: Client, message: CloudBrowserServerMessage): void {
    if (client.socket.readyState !== client.socket.OPEN) return;
    client.socket.send(JSON.stringify(message));
  }

  private stateFor(client: Client): CloudBrowserState {
    const status = this.browser.status(null);
    return {
      type: 'state',
      running: status.running,
      tabs: status.tabs,
      activeTabId: status.activeTabId,
      automation: status.automation,
      completed: status.completed,
      control: this.browser.controlFor(client.id),
    };
  }

  private pushState(client: Client): void {
    const state = this.stateFor(client);
    const json = JSON.stringify(state);
    if (json === client.lastState) return;
    client.lastState = json;
    this.send(client, state);
  }

  private onBrowserChange(): void {
    const hub = this.browser.hub();
    if (hub !== this.hubBound) this.bindHub(hub);
    for (const tabId of [...this.viewerSessions.keys()]) {
      if (this.browser.hasTab(tabId)) continue;
      this.viewerSessions.delete(tabId);
      this.casts.delete(tabId);
      this.latest.delete(tabId);
    }
    for (const client of this.clients.values()) {
      if (client.tabId && !this.browser.hasTab(client.tabId)) client.tabId = null;
      this.pushState(client);
    }
    void this.syncCasts();
  }

  private bindHub(hub: CdpHub | null): void {
    this.hubBound = hub;
    this.casts.clear();
    this.viewerSessions.clear();
    this.latest.clear();
    if (!hub) return;
    hub.onEvent((event) => this.onCdpEvent(event));
  }

  // ── 消息 ──────────────────────────────────────────────────────────────────

  private async handle(client: Client, message: CloudBrowserClientMessage): Promise<void> {
    if (PERSON_ACTIONS.has(message.type)) noteTunnelActivity();
    switch (message.type) {
      case 'config': {
        client.framesEnabled = message.framesEnabled;
        client.maxFps = message.maxFps;
        client.maxWidth = message.maxWidth;
        client.maxHeight = message.maxHeight;
        client.tabId = message.tabId && this.browser.hasTab(message.tabId) ? message.tabId : null;
        const latest = this.latest.get(this.viewedTab(client) ?? '');
        if (client.framesEnabled && latest) {
          client.pending = latest;
          this.flush(client);
        }
        await this.syncCasts();
        return;
      }
      case 'ack':
        if (client.awaitingAck && message.seq >= client.awaitingAck.seq) client.awaitingAck = null;
        this.flush(client);
        return;
      case 'keepalive':
        return;
      case 'control_acquire':
        this.browser.acquireControl(client.id);
        return;
      case 'control_release':
        await this.browser.releaseControl(client.id);
        return;
      case 'automation_stop':
        this.browser.stopAutomation();
        return;
      case 'automation_resume':
        this.browser.resumeAutomation();
        return;
      default:
        break;
    }
    // 以下都要拿着控制权。
    if (!this.browser.isHolder(client.id)) {
      if (message.type === 'input_text') this.send(client, { type: 'input_result', id: message.id, ok: false });
      return;
    }
    noteTunnelActivity();
    const hub = this.browser.hub();
    if (!hub) return;
    switch (message.type) {
      case 'tab_select': {
        if (!this.browser.hasTab(message.tabId)) return;
        client.tabId = message.tabId;
        this.browser.markActive(message.tabId);
        await hub.send('Target.activateTarget', { targetId: message.tabId });
        const latest = this.latest.get(message.tabId);
        if (latest) {
          client.pending = latest;
          this.flush(client);
        }
        await this.syncCasts();
        return;
      }
      case 'tab_close': {
        let closed = false;
        try {
          ({ success: closed } = await hub.send<{ success: boolean }>('Target.closeTarget', { targetId: message.tabId }));
        } catch {
          closed = false;
        }
        this.send(client, { type: 'tab_close_result', tabId: message.tabId, closed });
        return;
      }
      case 'input_mouse': {
        const session = await this.viewerSession(hub, this.viewedTab(client));
        if (!session) return;
        await hub.send(
          'Input.dispatchMouseEvent',
          {
            type: message.eventType,
            x: message.x,
            y: message.y,
            button: message.button,
            buttons: message.buttons,
            clickCount: message.clickCount,
            modifiers: message.modifiers,
            ...(message.eventType === 'mouseWheel' ? { deltaX: message.deltaX ?? 0, deltaY: message.deltaY ?? 0 } : {}),
          },
          session
        );
        return;
      }
      case 'input_keyboard': {
        const session = await this.viewerSession(hub, this.viewedTab(client));
        if (!session) return;
        await hub.send(
          'Input.dispatchKeyEvent',
          {
            type: message.eventType === 'keyUp' ? 'keyUp' : message.text ? 'keyDown' : 'rawKeyDown',
            key: message.key,
            code: message.code,
            windowsVirtualKeyCode: message.windowsVirtualKeyCode,
            nativeVirtualKeyCode: message.windowsVirtualKeyCode,
            modifiers: message.modifiers,
            ...(message.text ? { text: message.text, unmodifiedText: message.text } : {}),
          },
          session
        );
        return;
      }
      case 'input_text': {
        const session = await this.viewerSession(hub, this.viewedTab(client));
        if (!session) return this.send(client, { type: 'input_result', id: message.id, ok: false });
        try {
          await hub.send('Input.insertText', { text: message.text }, session);
          this.send(client, { type: 'input_result', id: message.id, ok: true });
        } catch {
          this.send(client, { type: 'input_result', id: message.id, ok: false });
        }
        return;
      }
      default:
        return;
    }
  }

  private viewedTab(client: Client): string | null {
    if (client.tabId && this.browser.hasTab(client.tabId)) return client.tabId;
    return this.browser.status(null).activeTabId;
  }

  // ── 画面 ──────────────────────────────────────────────────────────────────

  /** 每个页签一条看画面 / 发输入用的会话(与 agent 那一条分开)。 */
  private viewerSession(hub: CdpHub, tabId: string | null): Promise<string | null> {
    if (!tabId || !this.browser.hasTab(tabId)) return Promise.resolve(null);
    let session = this.viewerSessions.get(tabId);
    if (!session) {
      session = hub
        .send<{ sessionId: string }>('Target.attachToTarget', { targetId: tabId, flatten: true })
        .then(async ({ sessionId }) => {
          await hub.send('Page.enable', {}, sessionId);
          return sessionId;
        });
      session.catch(() => this.viewerSessions.delete(tabId));
      this.viewerSessions.set(tabId, session);
    }
    return session.catch(() => null);
  }

  /** 照「谁在看哪个页签、要多大」开 / 关 / 调每个页签的 screencast。 */
  private async syncCasts(): Promise<void> {
    const hub = this.browser.hub();
    if (!hub) return;
    const wanted = new Map<string, { maxWidth: number; maxHeight: number }>();
    for (const client of this.clients.values()) {
      if (!client.framesEnabled) continue;
      const tabId = this.viewedTab(client);
      if (!tabId) continue;
      const prior = wanted.get(tabId);
      wanted.set(tabId, { maxWidth: Math.max(prior?.maxWidth ?? 0, client.maxWidth), maxHeight: Math.max(prior?.maxHeight ?? 0, client.maxHeight) });
    }
    for (const [tabId, cast] of [...this.casts]) {
      if (wanted.has(tabId)) continue;
      this.casts.delete(tabId);
      void hub.send('Page.stopScreencast', {}, cast.session).catch(() => undefined);
    }
    for (const [tabId, size] of wanted) {
      const cast = this.casts.get(tabId);
      if (cast && cast.maxWidth === size.maxWidth && cast.maxHeight === size.maxHeight) continue;
      const session = await this.viewerSession(hub, tabId);
      if (!session) continue;
      this.casts.set(tabId, { tabId, session, ...size, running: true });
      await hub
        .send('Page.startScreencast', { format: 'jpeg', quality: SCREENCAST_QUALITY, maxWidth: size.maxWidth, maxHeight: size.maxHeight, everyNthFrame: 1 }, session)
        .catch((error: unknown) => log.warn('Cloud browser: screencast did not start', { tabId, error: String(error) }));
    }
  }

  private onCdpEvent(event: CdpEvent): void {
    if (event.method !== 'Page.screencastFrame' || !event.sessionId) return;
    const hub = this.browser.hub();
    void hub?.send('Page.screencastFrameAck', { sessionId: event.params.sessionId }, event.sessionId).catch(() => undefined);
    const cast = [...this.casts.values()].find((c) => c.session === event.sessionId);
    if (!cast) return;
    const data = String(event.params.data ?? '');
    const metadata = (event.params.metadata ?? {}) as { deviceWidth?: number; deviceHeight?: number };
    const size = jpegSize(data);
    if (!size || !metadata.deviceWidth || !metadata.deviceHeight) return;
    const frame: Frame = { tabId: cast.tabId, data, ...size, viewportWidth: metadata.deviceWidth, viewportHeight: metadata.deviceHeight, at: Date.now() };
    this.latest.set(cast.tabId, frame);
    for (const client of this.clients.values()) {
      if (!client.framesEnabled || this.viewedTab(client) !== cast.tabId) continue;
      client.pending = frame;
      this.flush(client);
    }
  }

  private flush(client: Client): void {
    if (!client.pending || !client.framesEnabled) return;
    const now = Date.now();
    if (client.awaitingAck && now - client.awaitingAck.at < ACK_STALE_MS) return;
    const wait = client.lastSentAt + 1000 / client.maxFps - now;
    if (wait > 0) {
      client.flushTimer ??= setTimeout(() => {
        client.flushTimer = null;
        this.flush(client);
      }, wait);
      return;
    }
    const frame = client.pending;
    client.pending = null;
    client.seq += 1;
    client.awaitingAck = { seq: client.seq, at: now };
    client.lastSentAt = now;
    this.send(client, {
      type: 'frame',
      seq: client.seq,
      tabId: frame.tabId,
      data: frame.data,
      width: frame.width,
      height: frame.height,
      viewportWidth: frame.viewportWidth,
      viewportHeight: frame.viewportHeight,
    });
  }

  /** 一张小图(手机、还没连上实时画面时的小窗)。在投画面的页签就用最近一帧,❌ 再截一张。 */
  async snapshot(tabId: string | null, maxWidth: number): Promise<CloudBrowserSnapshot | null> {
    const hub = this.browser.hub();
    const target = tabId && this.browser.hasTab(tabId) ? tabId : this.browser.status(null).activeTabId;
    if (!hub || !target) return null;
    const latest = this.latest.get(target);
    if (latest && Date.now() - latest.at < 2_000 && latest.width <= maxWidth * 1.5) {
      return { tabId: target, data: latest.data, width: latest.width, height: latest.height, viewportWidth: latest.viewportWidth, viewportHeight: latest.viewportHeight };
    }
    const session = await this.viewerSession(hub, target);
    if (!session) return null;
    const metrics = await hub.send<{ cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number } }>('Page.getLayoutMetrics', {}, session);
    const view = metrics.cssVisualViewport;
    const scale = Math.min(1, maxWidth / Math.max(1, view.clientWidth));
    const shot = await hub.send<{ data: string }>(
      'Page.captureScreenshot',
      { format: 'jpeg', quality: 55, clip: { x: view.pageX, y: view.pageY, width: view.clientWidth, height: view.clientHeight, scale } },
      session
    );
    const size = jpegSize(shot.data) ?? { width: Math.round(view.clientWidth * scale), height: Math.round(view.clientHeight * scale) };
    return { tabId: target, data: shot.data, ...size, viewportWidth: view.clientWidth, viewportHeight: view.clientHeight };
  }
}

let liveInstance: CloudBrowserLiveServer | null = null;

export function cloudBrowserLive(): CloudBrowserLiveServer {
  liveInstance ??= new CloudBrowserLiveServer(cloudBrowser());
  return liveInstance;
}
