import { acpApiContract, type StartSessionInput } from '@gugu/session-core/acp/client';
import {
  awaitWirePort,
  client,
  reconnectingTransport,
  domPortTransport,
  type DomPortLike,
  type WireTransport,
} from '@gugu/session-wire';
import { electronApi } from '../electron-api';
import { machineWireTransport } from '../machine-clients';
import { connectAcpLiveState } from './acp-live-connection';

const ACP_WIRE_CHANNEL = 'acp-wire';

export type AcpRuntimeRpcClient = ReturnType<typeof createAcpClientForPort>;

/** 本机一个,别的机器每台一个(#6264 一套工作台:会话在哪台机器,就连哪台机器的 ACP 运行时)。 */
const clientPromises = new Map<string, Promise<AcpRuntimeRpcClient>>();
const clientTransports = new Set<WireTransport>();
export type { StartSessionInput };

/** machine:null = 本机;否则是会话所在的那台机器(machineRegistry.machineOf(conversationId))。 */
export function getAcpRuntimeClient(machine: string | null = null): Promise<AcpRuntimeRpcClient> {
  const key = machine ?? 'local';
  let promise = clientPromises.get(key);
  if (!promise) {
    promise = machine ? createRemoteAcpRuntimeClient(machine) : createAcpRuntimeClient();
    clientPromises.set(key, promise);
    promise.catch(() => clientPromises.delete(key));
  }
  return promise;
}

export function resetAcpRuntimeClient(): void {
  for (const transport of clientTransports) transport.close?.();
  clientTransports.clear();
  clientPromises.clear();
}

async function createAcpRuntimeClient(): Promise<AcpRuntimeRpcClient> {
  return createAcpClientForPort(await requestAcpWirePort());
}

async function requestAcpWirePort(): Promise<DomPortLike> {
  const portPromise = awaitWirePort(window, { channel: ACP_WIRE_CHANNEL });
  await electronApi().requestWirePort(ACP_WIRE_CHANNEL);
  return (await portPromise) as DomPortLike;
}

/** 别的机器:wire 走那台机器的设备连接,断了自己重开、重挂订阅(session-wire 的 reconnectingTransport)。 */
async function createRemoteAcpRuntimeClient(deviceId: string): Promise<AcpRuntimeRpcClient> {
  return createAcpClient(machineWireTransport(deviceId, ACP_WIRE_CHANNEL));
}

function createAcpClientForPort(port: DomPortLike) {
  let initial: DomPortLike | null = port;
  const transport = reconnectingTransport(async () => {
    const current = initial ?? await requestAcpWirePort();
    initial = null;
    return domPortTransport(current);
  });
  return createAcpClient(transport);
}

function createAcpClient(transport: WireTransport) {
  clientTransports.add(transport);
  return client(acpApiContract, connectAcpLiveState(transport));
}
