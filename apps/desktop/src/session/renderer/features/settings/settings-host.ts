// #6264 设置里**跟机器走**的那几组(默认 tmux、仓库)看的是哪台机器(owner 2026-09-24:「那是那台机器的行为」)。
// 默认本机:照旧走本机的 `rpc.appSettings` 与全局那份设置缓存。选了别的机器:读写送到那台机器上
// 同一个 `appSettingsController`(界面只把跟机器走的那几组画在机器选择之下);缓存另起一份键,❌ 盖本机的。
// 自动批准、自动起名、界面、浏览器、通知跟着这个窗口,不在这里。
import { createContext, useContext } from 'react';
import { rpc, rpcOn } from '@renderer/lib/ipc';
import type { AppSettingsKey } from '@shared/core/app-settings';

export type RemoteSettingsKey = 'project' | 'localProject';

export type SettingsApi = {
  getWithMeta(key: AppSettingsKey): Promise<unknown>;
  update(key: AppSettingsKey, value: unknown): Promise<void>;
  reset(key: AppSettingsKey): Promise<void>;
  resetField(key: AppSettingsKey, field: string): Promise<void>;
};

export type SettingsRemoteDevice = {
  deviceId: string;
  deviceLabel: string;
  online: boolean;
  lastSeenAt: string | null;
};

export type SettingsHost = {
  key: string;
  /** null = 本机(走全局那份设置缓存)。 */
  remote: SettingsRemoteDevice | null;
  api: SettingsApi;
};

export const LOCAL_SETTINGS_HOST: SettingsHost = {
  key: 'local',
  remote: null,
  api: {
    getWithMeta: (key) => rpc.appSettings.getWithMeta(key),
    update: (key, value) => rpc.appSettings.update(key, value as never),
    reset: (key) => rpc.appSettings.reset(key),
    resetField: (key, field) => rpc.appSettings.resetField(key, field),
  },
};

/** 别的机器:同一个 `appSettingsController`,rpc 送到那台机器;缓存另起一份键,❌ 盖本机的。 */
export function createMachineSettingsHost(device: SettingsRemoteDevice): SettingsHost {
  const settings = rpcOn(device.deviceId).appSettings;
  return {
    key: `remote:${device.deviceId}`,
    remote: device,
    api: {
      getWithMeta: (key) => settings.getWithMeta(key),
      update: (key, value) => settings.update(key, value as never),
      reset: (key) => settings.reset(key),
      resetField: (key, field) => settings.resetField(key, field),
    },
  };
}

const SettingsHostContext = createContext<SettingsHost>(LOCAL_SETTINGS_HOST);

export const SettingsHostProvider = SettingsHostContext.Provider;

/** 跟机器走的那几行里 = 选的那台;其余任何地方 = 本机。 */
export function useSettingsHost(): SettingsHost {
  return useContext(SettingsHostContext);
}
