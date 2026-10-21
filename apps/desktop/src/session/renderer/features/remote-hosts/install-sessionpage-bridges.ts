import {
  installSessionpageNewSessionBridge,
  installSessionpageReconnectBridge,
  type NewSessionBridgeWindow,
  type ReconnectBridgeWindow,
} from '@/lib/sessionpageNewSessionBridge';
import { remoteHostsStore } from './remote-hosts-store';

/**
 * #6264 宿主 → 会话页的两座桥(放在入口热更新早返回之前:桥要指向新求值出来的那份 store)。
 * · 设置里装好一台机器后「在这台机器上新建任务」:记下意图、切到新建页(新建页接住它、预选那台机器);
 * · 设置 → 设备「重新连接」:这台机器的会话列表与开着的会话立刻重来(侧栏机器名不再有菜单)。
 */
export function installRemoteHostSessionpageBridges(w: Window, openNewSessionPage: () => void): void {
  installSessionpageNewSessionBridge(w as unknown as NewSessionBridgeWindow, (deviceId) => {
    remoteHostsStore.requestNewSession(deviceId, null);
    openNewSessionPage();
  });
  installSessionpageReconnectBridge(w as unknown as ReconnectBridgeWindow, (deviceId) => remoteHostsStore.reconnect(deviceId));
}
