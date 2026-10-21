import { agentConfigContract } from '@gugu/session-core/workspace-server/agent-config';
import {
  awaitWirePort,
  client,
  connect,
  domPortTransport,
  type DomPortLike,
} from '@gugu/session-wire';
import { electronApi } from '../electron-api';
import { machineWireTransport } from '../machine-clients';

const AGENT_CONFIG_WIRE_CHANNEL = 'agent-config-wire';

export type AgentConfigRuntimeRpcClient = ReturnType<typeof createAgentConfigClientForPort>;

/** 本机一个,别的机器每台一个(#6264:登录、登录状态、模型凭据都问那台机器)。 */
const clientPromises = new Map<string, Promise<AgentConfigRuntimeRpcClient>>();

/** machine:null = 本机。 */
export function getAgentConfigRuntimeClient(machine: string | null = null): Promise<AgentConfigRuntimeRpcClient> {
  const key = machine ?? 'local';
  let promise = clientPromises.get(key);
  if (!promise) {
    promise = machine ? createRemoteAgentConfigRuntimeClient(machine) : createAgentConfigRuntimeClient();
    clientPromises.set(key, promise);
    promise.catch(() => clientPromises.delete(key));
  }
  return promise;
}

export function resetAgentConfigRuntimeClient(): void {
  clientPromises.clear();
}

async function createAgentConfigRuntimeClient(): Promise<AgentConfigRuntimeRpcClient> {
  const portPromise = awaitWirePort(window, { channel: AGENT_CONFIG_WIRE_CHANNEL });
  await electronApi().requestWirePort(AGENT_CONFIG_WIRE_CHANNEL);
  const port = (await portPromise) as DomPortLike;
  return createAgentConfigClientForPort(port);
}

async function createRemoteAgentConfigRuntimeClient(deviceId: string): Promise<AgentConfigRuntimeRpcClient> {
  return client(agentConfigContract, connect(machineWireTransport(deviceId, AGENT_CONFIG_WIRE_CHANNEL)));
}

function createAgentConfigClientForPort(port: DomPortLike) {
  const transport = domPortTransport(port);
  return client(agentConfigContract, connect(transport));
}
