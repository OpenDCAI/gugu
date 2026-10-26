import { hostEventHub, hostMembers } from '../../session/shared/extensions/host-calls';
import type { ExtensionHostEvent } from '../../session/shared/extensions/bridge-protocol';
import type { ExtensionAgentView } from '../../session/shared/extensions/bridge-protocol';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types';
import type { AppMessageReceipt } from '@gugu/session-core/session-record/contract';
import type { AssistantAppChange } from '../../session/shared/extensions/assistant-app';
import type { AssistantPanelReceipt } from '@gugu/core/cloud/assistantPanel';
import { libraryHost } from './assistant-library-client';
import { queueAssistantAppChange } from './assistant-panel-cloud';
import type { AssistantMachine } from '../../session/renderer/features/assistant/assistant-machine-core';
import { rendererLogger } from '../../lib/log';
import { cachedDevicesAccount } from '../../store/devicesCache';

type ProgramNotification = { server: string; method: string; params?: unknown };
export type AssistantAppMachine = Pick<AssistantMachine, 'rpc'>;
type PanelAPI = {
  listAgents(): Promise<{ agents: ExtensionAgentView[]; unreached: unknown[] }>;
  dispatch(text: string, options: { to: { agent: string }; delivery: 'defer' }): Promise<AppMessageReceipt>;
  callProgram(name: string, args?: Record<string, unknown>, server?: string): Promise<CallToolResult>;
  onProgramNotification(listener: (event: ProgramNotification) => void): () => void;
};

/** Native React App surface, using the Extension API's member table and wire, without a second SDK. */
export function assistantAppClient(machine: AssistantAppMachine | null | undefined, expectedOwnerId = cachedDevicesAccount(), onHomeDevice = false) {
  const hub = hostEventHub();
  const api = hostMembers('page', name => ['listAgents', 'dispatch', 'callProgram', 'onProgramNotification'].includes(name),
    async (verb, args) => {
      const host = onHomeDevice ? machine?.rpc.app : libraryHost(machine);
      if (!host) throw new Error('Assistant App host is unavailable');
      return host.assistantAppCall(verb, args, expectedOwnerId);
    }, hub.on) as unknown as PanelAPI;
  return { ...api, deliver: (event: ExtensionHostEvent) => hub.deliver(event) };
}

export async function assistantAppProgram<T>(machine: AssistantAppMachine | null | undefined, name: string, args?: Record<string, unknown>, expectedOwnerId = cachedDevicesAccount()): Promise<T> {
  const result = await assistantAppClient(machine, expectedOwnerId).callProgram(name, args);
  if (result.isError) throw new Error(result.content.filter(block => block.type === 'text').map(block => block.text).join('\n'), { cause: result });
  if (!result.structuredContent || !('result' in result.structuredContent)) throw new Error('Assistant App program did not return a result');
  return result.structuredContent.result as T;
}

export async function publishAssistantAppChange(
  machine: AssistantAppMachine | null | undefined,
  change: Omit<AssistantAppChange, 'operationId'> & { operationId?: string },
  assistantId: string | undefined = undefined,
  expectedOwnerId = cachedDevicesAccount(),
): Promise<AssistantPanelReceipt | null> {
  return queueAssistantAppChange({ ...change, operationId: change.operationId ?? crypto.randomUUID() },assistantId,expectedOwnerId);
}

/** Call after a successful state mutation. A failed delivery must not turn a committed save into a fake save failure. */
export async function reportAssistantAppChange(
  machine: AssistantAppMachine | null | undefined, assistantId: string | undefined,
  change: Omit<AssistantAppChange, 'operationId'> & { operationId?: string },
  expectedOwnerId = cachedDevicesAccount(),
): Promise<void> {
  void publishAssistantAppChange(machine, change, assistantId, expectedOwnerId).catch(() => {
    rendererLogger('assistant/app').warn({ operationId: change.operationId }, 'Saved App change publication deferred');
  });
}
