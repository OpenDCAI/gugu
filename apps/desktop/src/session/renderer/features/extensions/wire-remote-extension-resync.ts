import { events } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import { extensionsInventoryChangedChannel } from '@shared/extensions/marketEvents';
import { resyncInstalledExtensionTabs } from './register-extension-tabs';

/** #6264 别的桌面在资源库里切到这台机器、装 / 卸 / 开关了扩展:这个窗口重读清单并跟着补上 / 撤下 tab。 */
export function wireRemoteExtensionResync(): void {
  events.on(extensionsInventoryChangedChannel, () => {
    void resyncInstalledExtensionTabs().catch((error: unknown) => {
      log.warn('Extension resync after a remote change failed:', error);
    });
  });
}
