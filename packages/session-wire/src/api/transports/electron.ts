import type { Unsubscribe } from '@gugu/session-shared';
import type { Controller } from '../controller';
import { createWireSessionHub, type WireSessionHub } from '../sessions';
import { portTransport, type PortLike } from './port';

export type MessagePortMainLike = PortLike & {
  start?(): void;
  close?(): void;
};

export type WebContentsLike = {
  id: number;
  postMessage(channel: string, message: unknown, transfer?: unknown[]): void;
};

export type IpcMainInvokeEventLike = {
  sender: WebContentsLike;
};

export type IpcMainLike = {
  handle(channel: string, listener: (event: IpcMainInvokeEventLike) => unknown): void;
  removeHandler?(channel: string): void;
};

export type IpcRendererLike = {
  invoke(channel: string): Promise<unknown> | unknown;
  once(channel: string, listener: (event: { ports?: unknown[] }, value: unknown) => void): void;
  off?(channel: string, listener: (event: { ports?: unknown[] }, value: unknown) => void): void;
};

export type WindowLike = {
  postMessage(message: unknown, targetOrigin: string, transfer?: unknown[]): void;
  addEventListener(
    event: string,
    listener: (event: { data?: unknown; ports?: unknown[] }) => void
  ): void;
  removeEventListener?(
    event: string,
    listener: (event: { data?: unknown; ports?: unknown[] }) => void
  ): void;
};

// The invoking event is handed to the factory so a composite host (several IPC transports behind one
// registrar) can mint the port pair on the transport the request actually arrived on. Plain Electron
// callers ignore the argument.
export type MessageChannelFactory = (event: IpcMainInvokeEventLike) => {
  port1: MessagePortMainLike;
  port2: unknown;
};

export type ExposeWireOptions = {
  channel?: string;
};

type WindowPortRecord = {
  port: MessagePortMainLike;
  disposeMapCleanup: Unsubscribe;
};

/**
 * `source` is resolved on every connect, so the first renderer connect is what starts the backing
 * (e.g. a lazy worker), and a connect after a failed start is a fresh attempt. A failed resolve rejects
 * that connect with the original error. A new source gets its own controller and closes the windows
 * served by the previous one.
 */
export function exposeWireToWindows<Source>(
  deps: { ipcMain: IpcMainLike; createMessageChannel: MessageChannelFactory },
  source: () => Source | Promise<Source>,
  controllerFor: (source: Source) => Controller,
  options: ExposeWireOptions = {}
): Unsubscribe {
  const channel = options.channel ?? 'wire';
  const connectChannel = `${channel}:connect`;
  const portChannel = `${channel}:port`;
  const ports = new Map<number, WindowPortRecord>();
  let served: { source: Source; hub: WireSessionHub } | null = null;

  function closeAll(): void {
    served?.hub.dispose();
    served = null;
    for (const record of ports.values()) record.disposeMapCleanup();
    ports.clear();
  }

  deps.ipcMain.handle(connectChannel, async (event) => {
    const resolved = await source();
    if (served?.source !== resolved) {
      closeAll();
      served = { source: resolved, hub: createWireSessionHub(controllerFor(resolved)) };
    }
    const { hub } = served;
    const { port1, port2 } = deps.createMessageChannel(event);
    const existing = ports.get(event.sender.id);
    existing?.port.close?.();
    existing?.disposeMapCleanup();
    ports.delete(event.sender.id);

    const transport = portTransport(port1);
    const disposeMapCleanup = transport.onDisconnect(() => {
      const current = ports.get(event.sender.id);
      if (current?.port !== port1) return;
      current.disposeMapCleanup();
      ports.delete(event.sender.id);
    });
    ports.set(event.sender.id, { port: port1, disposeMapCleanup });
    hub.open(event.sender.id, transport);
    port1.start?.();
    event.sender.postMessage(portChannel, null, [port2]);
    return undefined;
  });

  return () => {
    deps.ipcMain.removeHandler?.(connectChannel);
    closeAll();
  };
}

export async function requestWirePort(
  deps: { ipcRenderer: IpcRendererLike; window: WindowLike },
  options: ExposeWireOptions = {}
): Promise<void> {
  const channel = options.channel ?? 'wire';
  const portChannel = `${channel}:port`;
  const connectChannel = `${channel}:connect`;
  await new Promise<void>((resolve, reject) => {
    const listener = (event: { ports?: unknown[] }, value: unknown): void => {
      try {
        const port = event.ports?.[0] ?? value;
        deps.window.postMessage({ kind: portChannel }, '*', [port]);
        resolve();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    deps.ipcRenderer.once(portChannel, listener);
    Promise.resolve(deps.ipcRenderer.invoke(connectChannel)).catch((error: unknown) => {
      deps.ipcRenderer.off?.(portChannel, listener);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

export function awaitWirePort(
  windowLike: WindowLike,
  options: ExposeWireOptions = {}
): Promise<unknown> {
  const channel = options.channel ?? 'wire';
  const portChannel = `${channel}:port`;
  return new Promise((resolve) => {
    const listener = (event: { data?: unknown; ports?: unknown[] }): void => {
      if (!isWirePortMessage(event.data, portChannel)) return;
      windowLike.removeEventListener?.('message', listener);
      resolve(event.ports?.[0]);
    };
    windowLike.addEventListener('message', listener);
  });
}

function isWirePortMessage(value: unknown, channel: string): value is { kind: string } {
  return (
    typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === channel
  );
}
