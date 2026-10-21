// #6264 「已安排」看的是**哪一台机器**(owner:「整个资源库或者其他的都是分设备的」——「或者其他的」)。
//
// 已安排是某一台机器上的东西:它存在那台机器的库里,由**那台机器自己的调度器**按时跑,跑出来的会话也在那台机器上。
// 页面顶上一个机器选择器,默认本机;选了别的机器,列表、新建、改、立即运行、停止、删除都送到那台机器上
// 本机那一页用的同一个控制器(`automationsController`)。界面组件一个都不认它,照旧渲染同一套控件。
import { createContext, useContext } from 'react';
import { rpc, rpcOn } from '@renderer/lib/ipc';

type AutomationsApi = typeof rpc.automations;

/** 已安排那一页用到的全部(与本机 `rpc.automations.*` 同名同参)。 */
export type AutomationsRpc = Pick<
  AutomationsApi,
  | 'listAutomations'
  | 'createAutomation'
  | 'updateAutomationSettings'
  | 'renameAutomation'
  | 'setAutomationEnabled'
  | 'toggleAutomationEnabled'
  | 'listAutomationRuns'
  | 'countAutomationRunsByStatus'
  | 'getLatestRun'
  | 'getNextScheduledRun'
  | 'runAutomation'
  | 'stopRun'
  | 'getRun'
  | 'deleteAutomation'
  | 'listSessionSchedules'
>;

export type AutomationsRemoteDevice = {
  deviceId: string;
  deviceLabel: string;
  online: boolean;
  lastSeenAt: string | null;
};

export type AutomationsHost = {
  /** 缓存键里区分机器的那一段:本机 `local`,别的机器 `remote:<deviceId>`。 */
  key: string;
  api: AutomationsRpc;
  /** null = 本机。 */
  remote: AutomationsRemoteDevice | null;
};

export const LOCAL_AUTOMATIONS_HOST: AutomationsHost = {
  key: 'local',
  api: rpc.automations,
  remote: null,
};

/** 别的机器上的「已安排」:与本机同一个控制器、同一组动词,rpc 送到那台机器(项目、工作区都是那台机器项目表里的)。 */
export function createMachineAutomationsHost(device: AutomationsRemoteDevice): AutomationsHost {
  return { key: `remote:${device.deviceId}`, api: rpcOn(device.deviceId).automations, remote: device };
}

const AutomationsHostContext = createContext<AutomationsHost>(LOCAL_AUTOMATIONS_HOST);

export const AutomationsHostProvider = AutomationsHostContext.Provider;

/** 「已安排」里选了别的机器 = 那台;其余任何地方(会话页上的运行胶囊)= 本机。 */
export function useAutomationsHost(): AutomationsHost {
  return useContext(AutomationsHostContext);
}

/**
 * 缓存键:本机保持原样(会话页上的运行胶囊等处按 `['automations', …]` 读写同一份);
 * 别的机器在 `automations` 后插一段机器,两份互不覆盖,按前缀失效也只失效那台的。
 */
export function automationsQueryKey(host: AutomationsHost, ...parts: unknown[]): unknown[] {
  return host.remote ? ['automations', host.key, ...parts] : ['automations', ...parts];
}
