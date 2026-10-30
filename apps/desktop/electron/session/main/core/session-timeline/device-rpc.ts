import type { DeviceRpcHandlers } from '@gugu/core/cloud/deviceRpcResponder';
import { SUBSCRIPTION_IDLE_MS } from '@gugu/session-core/session-record';
import { createSessionHostDeviceRpcHandlers } from '../../host-ws/device-session-host';
import { createMessagePreviewHost, type MessagePreviewHostDeps } from './preview-rpc';
import { createSessionpageProjectionDeviceHost, type ProjectionDeviceFactoryOptions } from '../extensions/projection-device-factory';

/**
 * 这台机器在设备 RPC 上应答的会话页动词。
 *
 * 会话页本身(时间线、发送、审批、新建……)走 `taskhost.*`:手机和别的电脑都开一条窗口,问会话页路由表
 * (见 host-ws/device-session-host.ts);主进程 agent 的跨机器动作也问同一张表(`taskhost.call`)。这里另外只剩消息预览。
 */

/** 预览订阅的清扫节拍。单测里注入 now/interval 把它钉死。 */
export const SUBSCRIPTION_SWEEP_INTERVAL_MS = 30_000;

export function createSessionpageSessionDeviceRpcHandlers(options?: {
  now?: () => number;
  sweepIntervalMs?: number;
  idleMs?: number;
  /** MessagePreview(#6357);不给 = 不接 `taskpage.preview.*`。 */
  preview?: Omit<MessagePreviewHostDeps, 'now' | 'idleMs'>;
  /** Only the real authenticated cloud responder supplies this. SSH has no private asker proof. */
  projection?: ProjectionDeviceFactoryOptions;
}): {
  handlers: DeviceRpcHandlers;
  dispose: () => Promise<void> | void;
  /** 测试钩子:立刻做一次清扫,返回被拆掉的订阅 id。 */
  sweep: () => string[];
} {
  const now = options?.now ?? (() => Date.now());
  const previewHost = options?.preview
    ? createMessagePreviewHost({ ...options.preview, now, idleMs: options?.idleMs ?? SUBSCRIPTION_IDLE_MS })
    : null;
  const sweep = (): string[] => previewHost?.sweep() ?? [];
  const sweepTimer = previewHost ? setInterval(sweep, options?.sweepIntervalMs ?? SUBSCRIPTION_SWEEP_INTERVAL_MS) : null;
  sweepTimer?.unref?.();

  // #6264 别的桌面、手机经这条频道用这台机器的整套会话页宿主(一套工作台,见 host-ws/device-session-host.ts)。
  const sessionHost = createSessionHostDeviceRpcHandlers();
  const projection = options?.projection ? createSessionpageProjectionDeviceHost(options.projection) : null;

  const handlers: DeviceRpcHandlers = {
    ...sessionHost.handlers,
    ...previewHost?.handlers,
    ...projection?.handlers,
  };

  return {
    handlers,
    sweep,
    dispose: () => {
      sessionHost.dispose();
      if (sweepTimer) clearInterval(sweepTimer);
      previewHost?.dispose();
      return projection?.dispose();
    },
  };
}
