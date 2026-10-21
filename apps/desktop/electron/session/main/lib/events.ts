import { createEventEmitter, type EmitterAdapter } from '@shared/lib/ipc/events';
import { getHostIpc, type HostIpcInvokeEvent } from './host-ipc';

// @@@task-web-host — 宿主↔渲染层事件不再直连 electron:渲染层可能是 Electron 窗口,也可能是
// 一条 WebSocket 连接。两个方向都从 HostIpc 走(见 host-ipc.ts)。
type BroadcastTap = (channel: string, data: unknown) => void;
const taps = new Set<BroadcastTap>();

/**
 * 旁听主进程推给渲染层的每一条事件(#6264):别的桌面经设备 RPC 调这台机器时,调用进行中的那几条事件
 * (如 GitHub 设备码)要转给它 —— 这台机器上没有窗口,`broadcast` 推出去没人收。返回退订。
 */
export function tapMainEvents(tap: BroadcastTap): () => void {
  taps.add(tap);
  return () => {
    taps.delete(tap);
  };
}

function createMainAdapter(): EmitterAdapter {
  return {
    emit: (eventName: string, data: unknown, topic?: string) => {
      const channel = topic ? `${eventName}.${topic}` : eventName;
      for (const tap of taps) {
        try {
          tap(channel, data);
        } catch {
          /* 旁听者出错不影响本机推送。 */
        }
      }
      getHostIpc().broadcast(channel, data);
    },
    on: (eventName: string, cb: (data: unknown) => void, topic?: string) => {
      const channel = topic ? `${eventName}.${topic}` : eventName;
      const handler = (_e: HostIpcInvokeEvent, data: unknown) => cb(data);
      const { ipcMain } = getHostIpc();
      ipcMain.on(channel, handler);
      return () => ipcMain.removeListener(channel, handler);
    },
  };
}

export const events = createEventEmitter(createMainAdapter());
