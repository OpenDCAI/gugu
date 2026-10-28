// @@@task-web-host / #6264 会话页宿主协议(照 VS Code Agent Host Protocol:本机是进程内 IPC,远端是同一套
// 帧走一条连接)的宿主一侧,与「帧怎么过线」无关。
//
// 一条连接 = 一个 sender(id 从 1_000_000 起,不与 Electron webContents.id 撞)。协议见
// src/session/shared/lib/ipc/host-ws-protocol.ts。传输有两种:
//   · WebSocket(浏览器形态 / dev 口,host-ws/server.ts)
//   · 设备连接(别的桌面经 SSH 或咕咕云连进来,host-ws/device-session-host.ts)
// 两种都只实现 FrameSocket;请求分发、wire 端口、事件订阅只有这一份。
import type { MessagePortMainLike } from '@gugu/session-wire/api';
import {
  decodeHostWsMessage,
  encodeHostWsMessage,
  HOST_WS_HEARTBEAT_MS,
  HOST_WS_PROTOCOL_VERSION,
  serializeHostWsError,
  type HostWsClientMessage,
  type HostWsServerMessage,
} from '@shared/lib/ipc/host-ws-protocol';
import type { HostIpc, HostIpcInvokeEvent, HostIpcMain } from '../lib/host-ipc';
import { log } from '../lib/logger';
import type { RemotePtyPacer } from './remote-pty-pacer';

type InvokeListener = (event: HostIpcInvokeEvent, ...args: unknown[]) => unknown;
type EventListener = (event: HostIpcInvokeEvent, ...args: unknown[]) => void;

/** 一条已经连上的线。帧是编码好的(文本或带二进制体的帧)。 */
export type FrameSocket = {
  send(frame: string | Uint8Array): void;
  /** 本端判它已死(心跳丢了 / 协议错)时主动断开。 */
  close(reason: string): void;
  onFrame(cb: (frame: string | Uint8Array) => void): void;
  onClose(cb: () => void): void;
  /** 传输自己有 ping/pong(WebSocket)就给;没有时靠对端的 hb 帧判活。 */
  ping?(onPong: () => void): void;
};

/**
 * 对端连进来之后可以调什么。本机窗口与浏览器形态不设限;别的桌面连进来时,只给那些「在这台机器上做才有意义」的
 * (窗口、剪贴板、对话框、内置浏览器这类属于看界面的那台电脑,❌ 让别的电脑遥控这台机器的界面)。
 */
export type FrameInvokePolicy = (channel: string, args?: readonly unknown[]) => boolean;

const FIRST_SENDER_ID = 1_000_000;
/**
 * sender id 全进程只发一次:几个宿主(设备连接、网页 WebSocket)的线共用一张会话页路由表,
 * 表里按 sender 记的东西(订阅归谁)不能被另一个宿主的同号线拆掉。
 */
let nextSenderId = FIRST_SENDER_ID;

/** port1(宿主侧,PortLike):postMessage 走线,收到的 pm 帧以 {data} 事件派发给 portTransport。 */
class HostPort implements MessagePortMainLike {
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  private connection: Connection | null = null;
  private pending: unknown[] = [];
  private closed = false;
  readonly handle: Readonly<{ sessionHostWsPort: number }>;

  constructor(readonly id: number) {
    this.handle = Object.freeze({ sessionHostWsPort: id });
  }

  bind(connection: Connection): void {
    this.connection = connection;
    connection.ports.set(this.id, this);
    for (const message of this.pending) this.postMessage(message);
    this.pending = [];
  }

  postMessage(message: unknown): void {
    if (this.closed) return;
    if (!this.connection) {
      this.pending.push(message);
      return;
    }
    this.connection.send({ t: 'pm', port: this.id, msg: message });
  }

  on(event: string, cb: (...args: unknown[]) => void): void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(cb);
  }

  off(event: string, cb: (...args: unknown[]) => void): void {
    this.listeners.get(event)?.delete(cb);
  }

  removeListener(event: string, cb: (...args: unknown[]) => void): void {
    this.off(event, cb);
  }

  start(): void {}

  /** 本端主动关:通知对端并断开。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connection?.send({ t: 'pc', port: this.id });
    this.connection?.ports.delete(this.id);
    this.emit('close');
  }

  receive(message: unknown): void {
    if (this.closed) return;
    this.emit('message', { data: message });
  }

  /** 对端关了或连接断了:只本地收尾,不再往线上写。 */
  detach(): void {
    if (this.closed) return;
    this.closed = true;
    this.connection?.ports.delete(this.id);
    this.emit('close');
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const cb of this.listeners.get(event) ?? []) cb(...args);
  }
}

class Connection {
  readonly ports = new Map<number, HostPort>();
  readonly sender: HostIpcInvokeEvent['sender'];
  /** 只推对端明确订阅的频道,包括还没完成开窗的连接。 */
  private readonly subscriptions = new Set<string>();

  constructor(
    readonly id: number,
    private readonly socket: FrameSocket,
    private readonly host: FrameSessionHost,
    /** 这条线往外发的每一帧先过它(别的电脑经设备连接时:终端输出合帧限速,remote-pty-pacer.ts)。 */
    private readonly outgoing?: RemotePtyPacer
  ) {
    this.sender = {
      id,
      postMessage: (channel, _message, transfer) => {
        const handle = transfer?.[0];
        const port = this.host.takePendingPort(handle);
        if (!port) {
          throw new Error(`[session-host] postMessage(${channel}) 没有带可识别的端口句柄`);
        }
        port.bind(this);
        this.send({ t: 'port', channel, port: port.id });
      },
    };
  }

  wants(channel: string): boolean {
    return this.subscriptions.has(channel);
  }

  subscribe(channel: string): void {
    this.subscriptions.add(channel);
  }

  unsubscribe(channel: string): void {
    this.subscriptions.delete(channel);
    this.outgoing?.unsubscribe(channel);
  }

  send(message: HostWsServerMessage): void {
    if (this.outgoing) this.outgoing.outgoing(message, (paced) => this.write(paced));
    else this.write(message);
  }

  private write(message: HostWsServerMessage): void {
    try {
      this.socket.send(encodeHostWsMessage(message));
    } catch (error) {
      log.warn('[session-host] send failed', { sender: this.id, error: String(error) });
    }
  }

  event(): HostIpcInvokeEvent {
    return { sender: this.sender };
  }

  dispose(): void {
    this.outgoing?.dispose();
    for (const port of [...this.ports.values()]) port.detach();
    this.ports.clear();
  }
}

export class FrameSessionHost implements HostIpc {
  constructor(
    private readonly options: {
      heartbeatMs?: number;
      /** hello 帧里报的宿主版本(对端据此判「这台机器太旧」)。 */
      appVersion?: () => string;
      label?: string;
    } = {}
  ) {}

  /**
   * 路由表之外、由宿主进程(咕咕壳的主进程)自己应答的那几条(平台模型目录、会话重载、壳的身份口):
   * 本机窗口直接问 Electron 的 ipcMain;别的电脑连进来时经这里问同一个 handler。
   */
  private fallback: ((channel: string) => InvokeListener | undefined) | null = null;

  setFallback(lookup: ((channel: string) => InvokeListener | undefined) | null): void {
    this.fallback = lookup;
  }

  private readonly handlers = new Map<string, InvokeListener>();
  private readonly closeListeners = new Set<(senderId: number) => void>();
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly connections = new Set<Connection>();
  private readonly pendingPorts = new Map<object, HostPort>();
  private nextPortId = 1;

  readonly ipcMain: HostIpcMain = {
    handle: (channel, listener) => {
      if (this.handlers.has(channel)) {
        throw new Error(`[session-host] handler already registered for ${channel}`);
      }
      this.handlers.set(channel, listener);
    },
    removeHandler: (channel) => {
      this.handlers.delete(channel);
    },
    on: (channel, listener) => {
      let set = this.listeners.get(channel);
      if (!set) this.listeners.set(channel, (set = new Set()));
      set.add(listener);
    },
    removeListener: (channel, listener) => {
      this.listeners.get(channel)?.delete(listener);
    },
  };

  get connectionCount(): number {
    return this.connections.size;
  }

  /**
   * 一问一答、不开窗口:窗口里同一张路由表、同一条 policy,跑一次就完。这一问的 sender 用完即弃 ——
   * 它名下若记了东西(订阅),当场按「线断了」收掉:推送只走窗口,❌ 留一条没人收的订阅。
   */
  async invokeOnce(channel: string, args: unknown[], policy?: FrameInvokePolicy): Promise<unknown> {
    const handler = policy && !policy(channel, args) ? undefined : (this.handlers.get(channel) ?? this.fallback?.(channel));
    if (!handler) throw new Error(`No handler registered for '${channel}'`);
    const id = nextSenderId++;
    const sender: HostIpcInvokeEvent['sender'] = {
      id,
      postMessage: () => {
        throw new Error('[session-host] 一问一答没有窗口,带不了端口');
      },
    };
    try {
      return await handler({ sender }, ...args);
    } finally {
      for (const listener of [...this.closeListeners]) {
        try {
          listener(id);
        } catch (error) {
          log.warn('[session-host] close listener threw', { sender: id, error: String(error) });
        }
      }
    }
  }

  /** 一条线断了(别的电脑关了窗口 / 心跳丢了):挂在这条线上的订阅就此作废。返回退订。 */
  onConnectionClosed(listener: (senderId: number) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** 只推给一条线(它订的是「我这一个」的东西,❌ 广播给每台看着的电脑)。线不在了 = false。 */
  sendTo(senderId: number, channel: string, data: unknown): boolean {
    for (const connection of this.connections) {
      if (connection.id !== senderId) continue;
      connection.send({ t: 'event', channel, data });
      return true;
    }
    return false;
  }

  broadcast(channel: string, data: unknown): void {
    for (const connection of this.connections) {
      if (connection.wants(channel)) connection.send({ t: 'event', channel, data });
    }
  }

  createMessageChannel(): { port1: MessagePortMainLike; port2: unknown } {
    const port = new HostPort(this.nextPortId++);
    this.pendingPorts.set(port.handle, port);
    return { port1: port, port2: port.handle };
  }

  takePendingPort(handle: unknown): HostPort | null {
    if (typeof handle !== 'object' || handle === null) return null;
    const port = this.pendingPorts.get(handle) ?? null;
    if (port) this.pendingPorts.delete(handle);
    return port;
  }

  /** 接上一条线。返回断开它的函数。 */
  attach(socket: FrameSocket, options: { remote?: string; policy?: FrameInvokePolicy; outgoing?: RemotePtyPacer } = {}): () => void {
    const remote = options.remote ?? '?';
    const label = this.options.label ?? 'task-host';
    const connection = new Connection(nextSenderId++, socket, this, options.outgoing);
    this.connections.add(connection);
    log.info(`[${label}] client connected`, { sender: connection.id, remote });
    connection.send({
      t: 'hello',
      v: HOST_WS_PROTOCOL_VERSION,
      sender: connection.id,
      ...(this.options.appVersion ? { app: this.options.appVersion() } : {}),
    });
    // 心跳:hb 帧喂对端的看门狗;传输自带 ping 就顺带判活,没有就看对端的 hb。
    // 连续两拍什么都没收到 = 对端已死,主动断开,别让一条死连接占着 sender id 和端口表。
    let alive = true;
    const heartbeat = setInterval(() => {
      if (!alive) {
        log.warn(`[${label}] heartbeat lost, closing`, { sender: connection.id, remote });
        socket.close('heartbeat lost');
        return;
      }
      alive = false;
      if (socket.ping) socket.ping(() => (alive = true));
      connection.send({ t: 'hb' });
    }, this.options.heartbeatMs ?? HOST_WS_HEARTBEAT_MS);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      log.info(`[${label}] client closed`, { sender: connection.id, remote });
      this.connections.delete(connection);
      connection.dispose();
      for (const listener of [...this.closeListeners]) {
        try {
          listener(connection.id);
        } catch (error) {
          log.warn(`[${label}] close listener threw`, { sender: connection.id, error: String(error) });
        }
      }
    };
    socket.onFrame((frame) => {
      alive = true;
      const decoded = decodeHostWsMessage(frame);
      if (!decoded) {
        log.warn(`[${label}] protocol error, closing`, { sender: connection.id });
        socket.close('protocol error');
        return;
      }
      void this.dispatch(connection, decoded as HostWsClientMessage, options.policy);
    });
    socket.onClose(close);
    return () => {
      socket.close('detached');
      close();
    };
  }

  private async dispatch(
    connection: Connection,
    message: HostWsClientMessage,
    policy: FrameInvokePolicy | undefined
  ): Promise<void> {
    switch (message.t) {
      case 'invoke': {
        const handler =
          policy && !policy(message.channel, message.args)
            ? undefined
            : (this.handlers.get(message.channel) ?? this.fallback?.(message.channel));
        if (!handler) {
          connection.send({
            t: 'result',
            id: message.id,
            ok: false,
            error: { name: 'Error', message: `No handler registered for '${message.channel}'` },
          });
          return;
        }
        try {
          const value = await handler(connection.event(), ...message.args);
          connection.send({ t: 'result', id: message.id, ok: true, value: value ?? null });
        } catch (error) {
          connection.send({ t: 'result', id: message.id, ok: false, error: serializeHostWsError(error) });
        }
        return;
      }
      case 'send': {
        for (const listener of this.listeners.get(message.channel) ?? []) {
          try {
            listener(connection.event(), message.data);
          } catch (error) {
            log.warn('[session-host] event listener threw', { channel: message.channel, error: String(error) });
          }
        }
        return;
      }
      case 'sub':
        connection.subscribe(message.channel);
        return;
      case 'unsub':
        connection.unsubscribe(message.channel);
        return;
      case 'pm':
        connection.ports.get(message.port)?.receive(message.msg);
        return;
      case 'pc':
        connection.ports.get(message.port)?.detach();
        return;
      default:
        return;
    }
  }

  closeAll(): void {
    for (const connection of this.connections) connection.dispose();
    this.connections.clear();
  }
}
