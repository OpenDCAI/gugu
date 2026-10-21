import type { Session } from 'electron';

type ClearableSession = Pick<Session, 'clearCache' | 'clearStorageData'> & { clearData?: unknown };

/**
 * ELECTRON-28 API GAP SHIM。会话页后端的 browser-webcontents-registry 调 `Session.clearData(...)`(Electron 37 才有),
 * 宿主的 Electron 28 没有 → 用 clearStorageData + clearCache 拼一个尽力而为的版本。返回 true = 装了 polyfill。
 *
 * 装在 Session 的**原型**上(与原生 API 同一处);但没有 Electron 的宿主(咕咕 server / 网页版无头宿主)里
 * defaultSession 是个普通对象,原型就是 Object.prototype —— 往那上面挂 = 给进程里每个对象加一个可枚举属性,
 * Supabase Realtime 的 `for (key in stateChangeCallbacks)` 把它当回调表 .filter,server 起来 30 秒整个崩掉
 * (#6264)。所以:实例上已经有就不动;原型不是真 Session 原型时只挂在实例上,❌ 永远不碰 Object.prototype。
 */
export function installClearDataPolyfill(defaultSession: ClearableSession): boolean {
  if (typeof defaultSession.clearData === 'function') return false;
  const proto = Object.getPrototypeOf(defaultSession) as object | null;
  const target = (proto && proto !== Object.prototype ? proto : defaultSession) as ClearableSession;
  (target as { clearData: (options?: { dataTypes?: string[] }) => Promise<void> }).clearData =
    async function clearDataShim(this: ClearableSession, options?: { dataTypes?: string[] }): Promise<void> {
      const dataTypes = options?.dataTypes;
      if (!dataTypes) {
        // No options = clear everything (the 'all' / 'storage' path).
        await this.clearCache();
        await this.clearStorageData();
        return;
      }
      if (dataTypes.includes('cache')) await this.clearCache();
      const wantsSiteData = dataTypes.some((t) => t !== 'cache' && t !== 'cookies');
      if (wantsSiteData) {
        // Site-data types have no 1:1 clearStorageData mapping → clear all storage as a safe superset.
        await this.clearStorageData();
      } else if (dataTypes.includes('cookies')) {
        await this.clearStorageData({ storages: ['cookies'] });
      }
    };
  return true;
}
