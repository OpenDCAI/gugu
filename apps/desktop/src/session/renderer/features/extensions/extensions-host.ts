// #6264 资源库 → 扩展看的是**哪一台咕咕**。本机:原样走 `rpc.extensions` 与全局那份清单(tab 菜单也读它);
// 另一台咕咕桌面:经那台机器的会话页宿主调同一个 `extensionsController`,清单另起一份(按机器缓存),
// 改动后由那台机器自己的窗口补上 / 撤下 tab(它收到 `extensionsInventoryChangedChannel`)。
// 咕咕 server 没有窗口,扩展在它上面跑不起来 —— 那种机器不走这里(资源库那一格如实说一句)。
import { onMachineEvent, rpc, rpcOn } from '@renderer/lib/ipc';
import { InstalledExtensionsStore, installedExtensionsStore } from './installed-extensions-store';

export type ExtensionsApi = Pick<
  typeof rpc.extensions,
  | 'list'
  | 'revoked'
  | 'market'
  | 'marketEntry'
  | 'marketUpdates'
  | 'marketRefresh'
  | 'marketReadme'
  | 'marketHistory'
  | 'installFromMarket'
  | 'installFromFolder'
  | 'setPermissionGranted'
  | 'setEnabled'
  | 'setAutoUpdate'
  | 'setDisclosure'
  | 'appPlaces'
  | 'setAppPlaces'
  | 'uninstall'
  | 'agentStatus'
  | 'agentTools'
>;

export type ExtensionsHost = {
  key: string;
  api: ExtensionsApi;
  /** 这台机器上装着的那份清单。本机是全局那一份(tab 菜单、侧栏徽标都读它)。 */
  store: InstalledExtensionsStore;
  /** 这台机器主进程推的事件(下载进度);别的机器只在那次调用进行中转过来。返回退订。 */
  onEvent<T>(event: { name: string; _data?: T }, listener: (data: T) => void): () => void;
  /** 本机:装 / 卸 / 开关之后要在**这个窗口**里补上 / 撤下 tab。别的机器:它自己的窗口跟进,这里不碰。 */
  local: boolean;
  /** 「从文件夹安装」挑的是哪台机器上的文件夹。 */
  pickFolder(options: { title: string; message: string }): Promise<string | null | undefined>;
};

export const LOCAL_EXTENSIONS_HOST: ExtensionsHost = {
  key: 'local',
  api: rpc.extensions,
  store: installedExtensionsStore,
  // 只听本机推的(下载进度、市场刷新):别的机器的在它自己那一页上按机器订。
  onEvent: (event, listener) => onMachineEvent(null, event, listener),
  local: true,
  pickFolder: (options) => rpc.app.openSelectDirectoryDialog(options),
};

/** 别的机器的清单按机器留一份:换机器再换回来不必从骨架重来(与本机那份同一个「先画旧的、后台重读」)。 */
const remoteStores = new Map<string, InstalledExtensionsStore>();

export function createRemoteExtensionsHost(
  deviceId: string,
  pickFolder: (deviceId: string, initialPath: string) => Promise<string | null>
): ExtensionsHost {
  const api = rpcOn(deviceId).extensions as ExtensionsApi;
  let store = remoteStores.get(deviceId);
  if (!store) {
    store = new InstalledExtensionsStore(api);
    remoteStores.set(deviceId, store);
  }
  return {
    key: `remote:${deviceId}`,
    api,
    store,
    onEvent: (event, listener) => onMachineEvent(deviceId, event, listener),
    local: false,
    pickFolder: () => pickFolder(deviceId, '~'),
  };
}
