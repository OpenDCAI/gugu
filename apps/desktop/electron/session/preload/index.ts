import { requestWirePort } from '@gugu/session-wire/api';
import * as ElectronNS from 'electron';
import { contextBridge, ipcRenderer } from 'electron';

// @@@task-fusion (#2802) — 宿主是 electron 28,类型里没有 `webUtils`(≥30 才有)。做法与咕咕
// 自己的 preload 一致:运行时特性探测,拿不到就回落到已废弃的 File.path,而不是在类型层假装它存在。
const webUtils = (ElectronNS as { webUtils?: { getPathForFile(file: File): string } }).webUtils

// Expose protected methods that allow the renderer process to use
contextBridge.exposeInMainWorld('electronAPI', {
  // Generic invoke for the typed RPC client (createRPCClient)
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  // Generic event bridge for the typesafe event emitter (createEventEmitter)
  eventSend: (channel: string, data: unknown) => ipcRenderer.send(channel, data),
  eventOn: (channel: string, cb: (data: unknown) => void) => {
    const wrapped = (_: Electron.IpcRendererEvent, data: unknown) => cb(data);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  getPathForFile: (file: File) => {
    try {
      if (webUtils) return webUtils.getPathForFile(file);
      return (file as unknown as { path?: string }).path ?? '';
    } catch {
      return '';
    }
  },
  requestWirePort: (channel: string) => requestWirePort({ ipcRenderer, window }, { channel }),
});
