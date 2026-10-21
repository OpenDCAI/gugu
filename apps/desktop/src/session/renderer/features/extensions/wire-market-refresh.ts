import { onMachineEvent, rpc } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import { marketRefreshedChannel } from '@shared/extensions/marketEvents';
import { installedExtensionsStore } from './installed-extensions-store';

/**
 * 本机的「有新版 / 被撤回 / 已弃用」跟着手上那份市场目录走(market-snapshot.ts):启动时先从手上那份查一次,同时让主进程去
 * 下载站取一趟;之后不论哪一趟(启动这趟、打开 App 页、安装时现取)取回来变了,都再查一次 —— 和市场页读的永远是同一份。
 * ❌ 轮询:去取只在启动、打开 App 页、安装时。失败只进日志(checkUpdates 自己兜底)。
 */
export function wireMarketRefresh(): void {
  onMachineEvent(null, marketRefreshedChannel, (refreshed) => {
    if (refreshed.outcome === 'changed') void installedExtensionsStore.checkUpdates();
  });
  void installedExtensionsStore.checkUpdates();
  void rpc.extensions.marketRefresh().catch((error: unknown) => {
    log.warn('App market refresh at startup not asked:', error);
  });
}
