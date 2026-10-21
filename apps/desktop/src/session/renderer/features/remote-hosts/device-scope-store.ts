// #6264 分机器的模块各自的机器选择(owner:「整个资源库或者其他的都是分设备的」)。
//
// 一个窗口、一个账号;资源库、已安排、存储这类模块里的东西都是**某一台机器的**,模块顶上一个选择器,默认本机。
// 选的是**整个模块**看哪台机器 —— 资源库里切到 d22,提示词、智能体、集成、扩展全是 d22 的;❌ 按页各选各的。
//
// 记在这个窗口的 sessionStorage 里(每个模块一格):同一个窗口刷新后还停在那台机器上;❌ 不跟账号走
// (另一台电脑、另一个窗口各看各的)。选着的那台不在名下了(被移除 / 换了账号)就回落本机,❌ 停在一台不存在的机器上。
import { makeAutoObservable } from 'mobx';
import { localMachineChoice, machineChoiceFromHost, type MachineChoice } from './machine-choice';
import type { HostConnectionState } from '@renderer/features/remote-hosts/connection-status';
import type { RemoteHostDevice } from '@/session/shared/remote-hosts';

/** 「本机」那一行的 id(本机不在 remoteHostsStore 里)。 */
export const LOCAL_DEVICE_SCOPE = 'local';

type SessionStore = Pick<Storage, 'getItem' | 'setItem'>;

function windowSessionStorage(): SessionStore | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export class DeviceScopeStore {
  /** 用户选的那一台(可能此刻不在名下 —— 桥还没装好、或已被移除;读 `effective` 才是在用的那台)。 */
  selected: string;

  constructor(
    private readonly storageKey: string,
    private readonly storage: SessionStore | null = windowSessionStorage()
  ) {
    let stored: string | null = null;
    try {
      stored = storage?.getItem(storageKey) ?? null;
    } catch {
      stored = null;
    }
    this.selected = stored || LOCAL_DEVICE_SCOPE;
    makeAutoObservable<DeviceScopeStore, 'storage' | 'storageKey'>(this, { storage: false, storageKey: false });
  }

  select(deviceId: string): void {
    this.selected = deviceId || LOCAL_DEVICE_SCOPE;
    try {
      this.storage?.setItem(this.storageKey, this.selected);
    } catch {
      /* 存不下(隐私模式等)就只在这次打开里记着。 */
    }
  }

  /** 在用的那台:选的是本机,或选的那台还在名下;否则本机。❌ 不改写 `selected`(桥晚装好时它会回来)。 */
  effective(isKnown: (deviceId: string) => boolean): string {
    if (this.selected === LOCAL_DEVICE_SCOPE) return LOCAL_DEVICE_SCOPE;
    return isKnown(this.selected) ? this.selected : LOCAL_DEVICE_SCOPE;
  }
}

/** 资源库(提示词、智能体、集成、扩展一起跟着它)。 */
export const libraryDeviceStore = new DeviceScopeStore('gugu.library.device');
/** 已安排:列的、建的、跑的都是这台机器上的,由这台机器自己的调度器按时跑。 */
export const automationsDeviceStore = new DeviceScopeStore('gugu.automations.device');
/** 设置(通用 → 默认 tmux、仓库):左栏列头下一个选择,整个设置一起跟;界面、浏览器两页跟着这个窗口。 */
export const settingsDeviceStore = new DeviceScopeStore('gugu.settings.device');

/**
 * 选择器里的那几行:本机在前,然后名下别的机器(排序由选择器自己做,各入口同一份 `orderMachines`)。
 * 离线的照样列着、写「离线 · X 前」。个人助理住的那台不列(#7199 owner 10-15:用户看不到它住在哪)。
 */
export function deviceScopeTrayDevices(
  localLabel: string,
  hosts: ReadonlyArray<{ device: RemoteHostDevice; connection: HostConnectionState | null }>
): MachineChoice[] {
  return [
    localMachineChoice(LOCAL_DEVICE_SCOPE, localLabel),
    ...hosts.filter(({ device }) => !device.assistantHome).map(({ device, connection }) => machineChoiceFromHost(device, connection)),
  ];
}
