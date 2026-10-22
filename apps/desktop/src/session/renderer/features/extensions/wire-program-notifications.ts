import { onMachineEvent, rpc } from '@renderer/lib/ipc';
import { onEachMachine } from '@renderer/lib/machine-clients';
import { log } from '@renderer/utils/logger';
import { extensionProgramNotifiedChannel } from '@shared/extensions/marketEvents';

/**
 * 别的机器上 App 程序的通知,送回这台桌面上绑在那台机器会话上的页面(owner 10-16「程序跟着数据」):每台连着的机器上各订一份
 * `extensions.program.notified`(本机推的不管,本机主进程已经直接送了),交给本机主进程按会话所在的机器送达。
 */
export function wireProgramNotifications(): void {
  onEachMachine((deviceId) =>
    onMachineEvent(deviceId, extensionProgramNotifiedChannel, (notification) => {
      void rpc.extensions.programNotifiedElsewhere({ deviceId, ...notification }).catch((error: unknown) => {
        log.warn('A program notification from another machine was not handed on:', error);
      });
    })
  );
}
