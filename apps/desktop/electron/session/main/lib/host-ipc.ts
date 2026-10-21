// @@@task-web-host — 会话页宿主对"渲染层在哪"的唯一抽象。
//
// 宿主代码从前直接 import electron 的 ipcMain / BrowserWindow / MessageChannelMain,等于把
// "渲染层就是本进程里的 Electron 窗口"焊死。现在三件事都从这里拿:
//   ipcMain               请求/应答 + 渲染层→宿主事件(registerRPCRouter 与 events.ts 用)
//   broadcast             宿主→所有渲染层推事件(events.ts 用)
//   createMessageChannel  wire 双工端口的一对(exposeWireToWindows 用)
// 实现有三种:Electron 原生(桌面 app)、WebSocket(浏览器形态,见 host-ws/server.ts)、
// 以及把多个合成一个的 composite(桌面 app 同时对浏览器开口时用)。
// ❌ 会话页宿主的其他文件不得再 import electron 的 ipcMain / MessageChannelMain。

import type { IpcMainInvokeEventLike, MessagePortMainLike } from '@gugu/session-wire/api';

export type HostIpcInvokeEvent = IpcMainInvokeEventLike & {
  /** Electron 原生事件带 senderFrame(file-logger 用来校验来源);WebSocket 侧为 null。 */
  senderFrame?: unknown;
};

export type HostIpcMain = {
  handle(
    channel: string,
    listener: (event: HostIpcInvokeEvent, ...args: unknown[]) => unknown
  ): void;
  removeHandler(channel: string): void;
  on(channel: string, listener: (event: HostIpcInvokeEvent, ...args: unknown[]) => void): void;
  removeListener(
    channel: string,
    listener: (event: HostIpcInvokeEvent, ...args: unknown[]) => void
  ): void;
};

export type HostMessageChannel = { port1: MessagePortMainLike; port2: unknown };

export type HostIpc = {
  readonly ipcMain: HostIpcMain;
  broadcast(channel: string, data: unknown): void;
  createMessageChannel(event?: HostIpcInvokeEvent): HostMessageChannel;
  /**
   * 一条连进来的线断了(别的电脑 / 手机关了窗口、心跳丢了):挂在它名下的东西(订阅)就此作废。返回退订。
   * 只有经网络连进来的传输有(WebSocket、设备连接);本机 Electron 窗口不报。
   */
  onConnectionClosed?(listener: (senderId: number) => void): () => void;
};

let current: HostIpc | null = null;

export function setHostIpc(ipc: HostIpc): void {
  current = ipc;
}

export function getHostIpc(): HostIpc {
  if (!current) {
    throw new Error('[session-host] HostIpc 未安装:boot 必须先 setHostIpc() 再触碰 IPC');
  }
  return current;
}

// ---- Electron 原生实现 ------------------------------------------------------------------------

type ElectronLike = {
  ipcMain: HostIpcMain;
  BrowserWindow: {
    getAllWindows(): Array<{
      isDestroyed(): boolean;
      webContents: { send(channel: string, data: unknown): void };
    }>;
  };
  MessageChannelMain: new () => { port1: MessagePortMainLike; port2: unknown };
};

export function createElectronHostIpc(electron: ElectronLike): HostIpc {
  return {
    ipcMain: electron.ipcMain,
    broadcast(channel, data) {
      for (const win of electron.BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue;
        win.webContents.send(channel, data);
      }
    },
    createMessageChannel() {
      const channel = new electron.MessageChannelMain();
      return { port1: channel.port1, port2: channel.port2 };
    },
  };
}

// ---- 合成:一个注册器,多个传输 -------------------------------------------------------------------

const eventOrigin = new WeakMap<object, HostIpc>();

/** 把同一份 handler 注册到每个传输上;事件按它到达的那个传输造端口、广播则全体。 */
export function composeHostIpc(transports: readonly HostIpc[]): HostIpc {
  if (transports.length === 0) throw new Error('[session-host] composeHostIpc 需要至少一个传输');
  if (transports.length === 1) return transports[0];
  type Tagged = (event: HostIpcInvokeEvent, ...args: unknown[]) => unknown;
  const wrapped = new WeakMap<object, Map<HostIpc, Tagged>>();
  const tag =
    (ipc: HostIpc, listener: (event: HostIpcInvokeEvent, ...args: unknown[]) => unknown) =>
    (event: HostIpcInvokeEvent, ...args: unknown[]) => {
      eventOrigin.set(event, ipc);
      return listener(event, ...args);
    };
  return {
    ipcMain: {
      handle(channel, listener) {
        for (const ipc of transports) ipc.ipcMain.handle(channel, tag(ipc, listener));
      },
      removeHandler(channel) {
        for (const ipc of transports) ipc.ipcMain.removeHandler(channel);
      },
      on(channel, listener) {
        const perIpc = new Map<HostIpc, Tagged>();
        for (const ipc of transports) {
          const tagged = tag(ipc, listener);
          perIpc.set(ipc, tagged);
          ipc.ipcMain.on(channel, tagged);
        }
        wrapped.set(listener, perIpc);
      },
      removeListener(channel, listener) {
        const perIpc = wrapped.get(listener);
        if (!perIpc) return;
        for (const [ipc, tagged] of perIpc) ipc.ipcMain.removeListener(channel, tagged);
        wrapped.delete(listener);
      },
    },
    broadcast(channel, data) {
      for (const ipc of transports) ipc.broadcast(channel, data);
    },
    createMessageChannel(event) {
      const origin = event ? eventOrigin.get(event) : undefined;
      return (origin ?? transports[0]).createMessageChannel(event);
    },
    onConnectionClosed(listener) {
      const offs = transports.map((ipc) => ipc.onConnectionClosed?.(listener));
      return () => offs.forEach((off) => off?.());
    },
  };
}
