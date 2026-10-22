// #6264 每台别的机器一个会话页宿主客户端(帧走那台机器的设备连接:远程 SSH → SSH,远程隧道 → 咕咕云)。
// 线由咕咕壳经 remote-hosts 桥给(`openSessionHost`);客户端本身与本机网页形态同一份(session-host-client.ts)。
//
// 成本:连着的每台机器双向各一拍心跳(20s);断了按 1s→60s 退避重连,那台机器重新上线 / 刚登上时当场重连。
import { findRemoteHostsBridge } from '@shared/remote-hosts';
import {
  createSessionHostClient,
  SESSION_HOST_CLIENT_HEARTBEAT_MS,
  type SessionHostClient,
  type SessionHostConnectionState,
} from '@shared/lib/ipc/session-host-client';
import { HOST_WS_PROTOCOL_VERSION } from '@shared/lib/ipc/host-ws-protocol';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { log } from '@renderer/utils/logger';
import { reconnectingTransport, type WireTransport } from '@gugu/session-wire';
import { machineCodec, machineRegistry } from './machine-routing';

export type MachineLinkState = SessionHostConnectionState | 'tooOld' | 'unavailable';

type Entry = {
  client: SessionHostClient;
  tooOld: boolean;
  listeners: Set<() => void>;
};

const entries = new Map<string, Entry>();
const createdListeners = new Set<(deviceId: string) => void>();

function notify(entry: Entry): void {
  for (const listener of [...entry.listeners]) listener();
}

/** 那台机器的客户端(懒建;桥还没装 = 拿不到,调用方按「连不上」处理)。 */
export function machineClient(deviceId: string): SessionHostClient | null {
  const existing = entries.get(deviceId);
  if (existing) return existing.client;
  const bridge = findRemoteHostsBridge();
  if (!bridge?.openSessionHost) return null;
  const entry: Entry = {
    tooOld: false,
    listeners: new Set(),
    client: createSessionHostClient(bridge.openSessionHost(deviceId), {
      subscribeEvents: true,
      heartbeatMs: SESSION_HOST_CLIENT_HEARTBEAT_MS,
      retryMaxMs: 60_000,
      // 连不上 / 断了时调用方拿到的那句话(界面可能原样摆出来):说哪台机器此刻连不上,❌ 英文的传输层原文。
      messages: () => {
        const device = bridge.listDevices().find((d) => d.id === deviceId)?.label ?? deviceId;
        const text = translateSessionMessage('deviceScope.unreachable', { device });
        return {
          hostNotConnected: text,
          hostConnectionLost: text,
          hostUnreachable: text,
          hostTooOld: translateSessionMessage('deviceScope.serverTooOld', { device }),
          clientTooOld: translateSessionMessage('deviceScope.thisTooOld', { device }),
        };
      },
      warn: (message, detail) => log.warn(`[machine:${deviceId.slice(0, 8)}] ${message}`, detail),
      onOpenFailed: (error) => {
        const tooOld = error instanceof Error && error.name === 'SessionHostTooOldError';
        if (tooOld !== entry.tooOld) {
          entry.tooOld = tooOld;
          notify(entry);
        }
      },
    }),
  };
  entry.client.onStateChange(() => {
    const hello = entry.client.hello();
    if (entry.client.state() === 'open') entry.tooOld = !!hello && hello.protocol < HOST_WS_PROTOCOL_VERSION;
    notify(entry);
  });
  entries.set(deviceId, entry);
  for (const listener of [...createdListeners]) listener(deviceId);
  return entry.client;
}

/**
 * 每台连着的机器(此刻的与以后连上的)各跑一次 setup,返回全部退订。给真要听**每台**机器的那几种低频事件用
 * (项目清单变了、项目分组、App 程序通知、会话开户改名);项目里的事件按项目所在的机器订(onMachineEvent)。
 */
export function onEachMachine(setup: (deviceId: string) => () => void): () => void {
  const offs = new Map<string, () => void>();
  for (const deviceId of entries.keys()) offs.set(deviceId, setup(deviceId));
  const listener = (deviceId: string) => offs.set(deviceId, setup(deviceId));
  createdListeners.add(listener);
  return () => {
    createdListeners.delete(listener);
    for (const off of offs.values()) off();
  };
}

export function machineLinkState(deviceId: string): MachineLinkState {
  const entry = entries.get(deviceId);
  if (!entry) return findRemoteHostsBridge()?.openSessionHost ? 'closed' : 'unavailable';
  if (entry.tooOld) return 'tooOld';
  return entry.client.state();
}

export function subscribeMachineLink(deviceId: string, listener: () => void): () => void {
  machineClient(deviceId);
  const entry = entries.get(deviceId);
  if (!entry) return () => undefined;
  entry.listeners.add(listener);
  return () => entry.listeners.delete(listener);
}

/** 那台机器刚上线 / 刚登上:别等退避。 */
export function reconnectMachine(deviceId: string): void {
  entries.get(deviceId)?.client.reconnectNow();
}

/** 那台机器被移除 / 换了账号:关掉它的线。 */
export function closeMachineClient(deviceId: string): void {
  const entry = entries.get(deviceId);
  if (!entry) return;
  entries.delete(deviceId);
  entry.client.close();
  notify(entry);
}

/**
 * 那台机器上某个 wire(ACP / agent-config 运行时)的传输:断了自己重开、重挂订阅;
 * 进出的消息过一遍机器边界的换名(与 rpc 同一个,见 machine-routing.ts 末尾)。
 */
export function machineWireTransport(deviceId: string, channel: string): WireTransport {
  const host = machineClient(deviceId);
  if (!host) throw new Error(`[machine] 连不上 ${deviceId.slice(0, 8)} 的任务页宿主`);
  const codec = machineCodec(deviceId);
  const inner = reconnectingTransport(() => host.openWireTransport(channel));
  return {
    post: (message) => inner.post(codec.outbound(message)),
    onMessage: (cb) =>
      inner.onMessage((message) => {
        const local = codec.inbound(message);
        machineRegistry.absorb(deviceId, local);
        cb(local);
      }),
    onDisconnect: (cb) => inner.onDisconnect(cb),
    onReconnect: (cb) => inner.onReconnect(cb),
    close: () => inner.close(),
  };
}
