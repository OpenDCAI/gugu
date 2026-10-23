import type { RpcRouter } from '@main/rpc';
import { createEventEmitter, type EmitterAdapter } from '@shared/lib/ipc/events';
import { createRPCClient } from '@shared/lib/ipc/rpc';
import type { SessionHostBridgeApi } from '@shared/lib/ipc/session-host-client';
import { findSessionHostBridge, type SessionHostBridge } from './electron-api';
import { machineClient } from './machine-clients';
import { machineCodec as codecOf, machineOfChannel, machineRegistry } from './machine-routing';

// @@@task-fusion (#2802) / @@@task-web-host — 桥的解析在 electron-api.ts(桌面 preload 或网页版
// WebSocket 桥)。**按调用时解析,不在模块求值时定死**:网页版里这个 bundle 可能被预热加载,那时
// 壳还没把 WebSocket 桥装上(MBP 实测:app.getAppVersion 在模块求值时就找不到桥)。
// 取不到(SSR/测试)才落到下面那组 fail-loud 桩。
const unavailable: SessionHostBridge = ({
        invoke: (channel: string) => {
          throw new Error(`electronAPI.invoke is unavailable for ${channel}`);
        },
        eventSend: (channel: string) => {
          throw new Error(`electronAPI.eventSend is unavailable for ${channel}`);
        },
        eventOn: () => () => {},
        getPathForFile: () => '',
      } as unknown as SessionHostBridge);

const electronAPI: SessionHostBridge = {
  invoke: (channel, ...args) => (findSessionHostBridge() ?? unavailable).invoke(channel, ...args),
  eventSend: (channel, data) => (findSessionHostBridge() ?? unavailable).eventSend(channel, data),
  eventOn: (channel, cb) => (findSessionHostBridge() ?? unavailable).eventOn(channel, cb),
  getPathForFile: (file) => (findSessionHostBridge() ?? unavailable).getPathForFile(file),
  requestWirePort: (channel) => (findSessionHostBridge() ?? unavailable).requestWirePort(channel),
};

// #6264 一套工作台:同一个 `rpc` / `events`,每次按它说的是哪台机器上的东西选线(machine-routing.ts)。
// 本机 = 上面那座桥;别的机器 = 它的会话页宿主客户端(machine-clients.ts)。

class MachineUnreachableError extends Error {
  constructor(deviceId: string) {
    super(`[machine] ${deviceId} 的任务页宿主连不上(桥没装)`);
    this.name = 'MachineUnreachableError';
  }
}

function remoteApi(deviceId: string): SessionHostBridgeApi {
  const client = machineClient(deviceId);
  if (!client) throw new MachineUnreachableError(deviceId);
  return client.api;
}

/** 从那台机器收进来的一份数据:固定 id 换成这边的别名,里面的实体 id 记到它名下。 */
function receiveFrom(deviceId: string, value: unknown): unknown {
  const local = codecOf(deviceId).inbound(value);
  machineRegistry.absorb(deviceId, local);
  return local;
}

async function invokeOn(deviceId: string, channel: string, args: unknown[]): Promise<unknown> {
  // 发过去的参数与拿回来的结果里出现的实体 id 都记到那台机器名下(新建的任务 / 会话从此认得出)。
  machineRegistry.absorb(deviceId, args);
  const result = await remoteApi(deviceId).invoke(channel, ...codecOf(deviceId).outbound(args));
  return receiveFrom(deviceId, result);
}

export const rpc = createRPCClient<RpcRouter>((channel, ...args) => {
  const deviceId = machineRegistry.route(channel, args);
  return deviceId ? invokeOn(deviceId, channel, args) : electronAPI.invoke(channel, ...args);
});

/**
 * 不在路由表里的那几条宿主通道(平台模型目录、会话重载、壳的身份口)按机器调:null = 本机。
 * 那台机器由它的主进程应答(与本机同一个 handler,见 device-session-host.ts 的兜底)。
 */
export function invokeOnMachine(machine: string | null, channel: string, ...args: unknown[]): Promise<unknown> {
  return machine ? invokeOn(machine, channel, args) : electronAPI.invoke(channel, ...args);
}

const localRpc = createRPCClient<RpcRouter>((channel, ...args) => electronAPI.invoke(channel, ...args));

/**
 * 机器级的调用(那台机器的设置、资源库、模型目录……):调用点指明机器。null / 'local' = 本机 —— 真的是本机:
 * 参数里出现别的机器上的 id 也不改道(挂父会话:child 在本机、父会话在别的机器上,这一步只能在 child 这台做)。
 */
export function rpcOn(machine: string | null | undefined): typeof rpc {
  if (!machine || machine === 'local') return localRpc;
  return createRPCClient<RpcRouter>((channel, ...args) => invokeOn(machine, channel, args));
}

function channelOf(eventName: string, topic?: string): string {
  return topic ? `${eventName}.${topic}` : eventName;
}

function createRendererAdapter(): EmitterAdapter {
  return {
    emit: (eventName: string, data: unknown, topic?: string) => {
      const channel = channelOf(eventName, topic);
      const deviceId = topic ? machineRegistry.machineOf(topic) : machineRegistry.route(eventName, [data]);
      if (deviceId) {
        const codec = codecOf(deviceId);
        remoteApi(deviceId).eventSend(codec.outboundChannel(channel), codec.outbound(data));
      } else electronAPI.eventSend(channel, data);
    },
    on: (eventName: string, cb: (data: unknown) => void, topic?: string) => {
      // 事件总线只给拼好的频道(`<事件>.<topic>`),topic 参数通常是空的:按频道认机器。
      const channel = channelOf(eventName, topic);
      const deviceId = machineOfChannel(machineRegistry, channel);
      if (deviceId) {
        return remoteApi(deviceId).eventOn(codecOf(deviceId).outboundChannel(channel), (data) =>
          cb(receiveFrom(deviceId, data))
        );
      }
      return electronAPI.eventOn(channel, cb);
    },
  };
}

export const events = createEventEmitter(createRendererAdapter());

/**
 * 在某一台机器上订一种不带 topic 的事件(null = 本机)。事件跟请求走同一条线:订阅方知道自己说的是哪台机器上的东西
 * (项目、会话、资源库切到的那台),就只在那台机器上订。❌ 不带机器的 `events.on` 去听别的机器 —— 那只听本机。
 */
export function onMachineEvent<T>(
  machine: string | null,
  event: { name: string; _data?: T },
  cb: (data: T) => void
): () => void {
  if (!machine) return events.on(event as never, cb);
  return remoteApi(machine).eventOn(codecOf(machine).outboundChannel(event.name), (data) =>
    cb(receiveFrom(machine, data) as T)
  );
}
