import { rpc, rpcOn } from '@renderer/lib/ipc';
import type {
  ImportLocalSessionParams,
  ImportLocalSessionResult,
  ListLocalSessionsParams,
  ListLocalSessionsResult,
  LocalSessionPreview,
  PreviewLocalSessionParams,
} from '@shared/core/session-import/session-import';

// #6264「导入会话」按机器切换:面板长相与本机完全一样,只是问的是所选那台机器。
// 这一层把「问谁」收成一个口 —— 同一组动词,本机走会话页 IPC,别的机器走那台机器的连接。
// ❌ 面板里到处 `if (remote)`:列表、预览、导入三处各分一次岔,漏一处就是「列的是 d22、导进本机」。

/** 选择器里「本机」那一项的 id(设备表里的本机行不进会话页,见 remote-hosts.ts)。 */
export const LOCAL_IMPORT_DEVICE = 'local';

export type SessionImportSource = {
  /** LOCAL_IMPORT_DEVICE 或那台机器的设备 id。 */
  deviceId: string;
  isLocal: boolean;
  list(params: ListLocalSessionsParams): Promise<ListLocalSessionsResult>;
  preview(params: PreviewLocalSessionParams): Promise<LocalSessionPreview>;
  importSession(params: ImportLocalSessionParams): Promise<ImportLocalSessionResult>;
  /** 导入的会话落在哪种展示里:终端(编程)或聊天(通用)。 */
  sessionView: 'code' | 'general';
};

export const localImportSource: SessionImportSource = {
  deviceId: LOCAL_IMPORT_DEVICE,
  isLocal: true,
  list: (params) => rpc.sessionImport.listLocalSessions(params),
  preview: (params) => rpc.sessionImport.previewLocalSession(params),
  importSession: (params) => rpc.sessionImport.importLocalSession(params),
  sessionView: 'code',
};

/**
 * 那台机器上的导入:与本机同一组 `sessionImport.*` 动词,rpc 送到那台机器(会话建在**那台机器**上:原件在哪台,会话就归哪台)。
 * directTerminal:这台机器是用 SSH 装上的(有真终端)。false = 只经远程隧道连着:会话接进聊天腿(通用),❌ 建一条打不开的终端会话。
 */
export function machineImportSource(deviceId: string, directTerminal: boolean): SessionImportSource {
  const machine = rpcOn(deviceId).sessionImport;
  return {
    deviceId,
    isLocal: false,
    list: (params) => machine.listLocalSessions(params),
    preview: (params) => machine.previewLocalSession(params),
    importSession: (params) => machine.importLocalSession(directTerminal ? params : { ...params, sessionView: 'general' }),
    sessionView: directTerminal ? 'code' : 'general',
  };
}

/** 所选的是本机 → 本机;否则那台机器。 */
export function resolveImportSource(deviceId: string, directTerminal = false): SessionImportSource {
  if (deviceId === LOCAL_IMPORT_DEVICE) return localImportSource;
  return machineImportSource(deviceId, directTerminal);
}
