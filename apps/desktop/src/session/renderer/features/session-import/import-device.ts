import type { RemoteHostDevice } from '@/session/shared/remote-hosts';
import { TOO_OLD_CODES, type Translate } from '@renderer/features/remote-hosts/connection-status';
import { remoteErrorCode } from '@renderer/features/remote-hosts/remote-failure-copy';
import {
  localMachineChoice,
  machineChoiceFromHost,
  type MachineChoice,
} from '@renderer/features/remote-hosts/machine-choice';
import { humanizeRpcError } from './humanize-error';
import { LOCAL_IMPORT_DEVICE, type SessionImportSource } from './import-source';

// #6264「导入会话」的机器选择:与各处同一个选择器(MachinePicker),本机第一、在线的、
// 离线的灰掉并写「上次在线 X」。纯函数,翻译注入,判据都有单测。

/** 选择器里的机器表:本机 + 名下别的机器(桥给的);个人助理住的那台不列(#7199,用户看不到它住在哪)。 */
export function importDeviceChoices(
  localLabel: string,
  hosts: readonly RemoteHostDevice[],
  notResponding: (deviceId: string) => boolean = () => false
): MachineChoice[] {
  return [
    localMachineChoice(LOCAL_IMPORT_DEVICE, localLabel),
    ...hosts.filter((device) => !device.assistantHome).map((device) => machineChoiceFromHost(device, notResponding(device.id) ? 'reconnecting' : null)),
  ];
}

/**
 * 面板里生效的是哪台:用户选的那台还在名下且在线才算数;离线了 / 不在名下了(被移除)→ 仍停在它上面,
 * 由调用方按 `blocked` 说清楚,❌ 静默跳回本机(人会以为扫的是那台、导进的却是这台)。
 */
export function importDeviceState(
  selectedId: string,
  choices: readonly MachineChoice[]
): { device: MachineChoice | null; blocked: 'offline' | 'gone' | 'waking' | null } {
  const device = choices.find((choice) => choice.id === selectedId) ?? null;
  if (!device) return { device: null, blocked: 'gone' };
  // #7199 云电脑没醒着:选了它就在叫醒它,醒了才列得出来(❌ 说离线)。
  if (device.cloudComputer) return { device, blocked: 'waking' };
  if (!device.isOnline) return { device, blocked: 'offline' };
  return { device, blocked: null };
}

/**
 * 列表 / 预览 / 导入失败时给人看的那一句(已经是整句,调用方不再套前缀)。
 *  · 本机:主进程给的就是人话,剥掉 IPC 的壳原样说;
 *  · 别的机器太旧(不认 `taskpage.sessionImport.*`):说版本太旧、空闲会自己升级;
 *  · 那台机器上没接上扫描器:说那台机器上用不了;
 *  · 没有业务码 = 传输层没问到(超时、断线):说没连上那台机器;
 *  · 其余:那台机器报的人话原样说。
 */
export function describeImportFailure(
  error: unknown,
  source: Pick<SessionImportSource, 'isLocal'>,
  deviceLabel: string,
  kind: 'list' | 'preview' | 'import',
  translate: Translate
): string {
  const unknown = translate('sessionImport.unknownError');
  const wrap = (message: string) =>
    kind === 'list'
      ? translate('sessionImport.listFailed', { error: message })
      : kind === 'preview'
        ? translate('sessionImport.previewFailed', { error: message })
        : message;
  if (source.isLocal) return wrap(humanizeRpcError(error, unknown));
  const code = remoteErrorCode(error);
  if (code && TOO_OLD_CODES.has(code)) return translate('sessionImport.serverTooOld', { device: deviceLabel });
  if (code === 'import_unavailable') return translate('sessionImport.remoteUnavailable', { device: deviceLabel });
  if (!code) return translate('sessionImport.remoteUnreachable', { device: deviceLabel });
  return wrap(humanizeRpcError(error, unknown));
}
