import { i18n } from '@/i18n';
import { messageForUser } from '@/lib/userFacingError';
import { hostEventHub, hostMembers } from '../../session/shared/extensions/host-calls';
import type { ExtensionHostEvent } from '../../session/shared/extensions/bridge-protocol';
import type { ExtensionAgentView } from '../../session/shared/extensions/bridge-protocol';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types';
import type { AppMessageReceipt } from '@gugu/session-core/session-record/contract';
import { assistantAppChangeText, type AssistantAppChange } from '../../session/shared/extensions/assistant-app';
import { libraryHost } from './assistant-library-client';
import { readAssistantShellBridge } from '../../lib/assistantShellBridge';
import type { AssistantMachine } from '../../session/renderer/features/assistant/assistant-machine-core';
import { toast } from '../../session/renderer/lib/hooks/use-toast';
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
  assistantId = readAssistantShellBridge()?.getSnapshot()?.assistant?.id,
  expectedOwnerId = cachedDevicesAccount(),
): Promise<AppMessageReceipt | null> {
  const app = assistantAppClient(machine, expectedOwnerId);
  if (!assistantId) {
    const listed = await app.listAgents();
    assistantId = listed.agents[0]?.agentId.replace(/^user:/, '');
    if (!assistantId && listed.unreached.length) throw new Error('Personal assistant device could not be read');
    if (!assistantId) return null;
  }
  return app.dispatch(assistantAppChangeText({ ...change, operationId: change.operationId ?? crypto.randomUUID() }),
    { to: { agent: `user:${assistantId}` }, delivery: 'defer' });
}

/** Call after a successful state mutation. A failed delivery must not turn a committed save into a fake save failure. */
export async function reportAssistantAppChange(
  machine: AssistantAppMachine | null | undefined, assistantId: string | undefined,
  change: Omit<AssistantAppChange, 'operationId'> & { operationId?: string },
  expectedOwnerId = cachedDevicesAccount(),
): Promise<void> {
  try { await publishAssistantAppChange(machine, change, assistantId, expectedOwnerId); }
  catch (error) {
    rendererLogger('assistant/app').error({ error: String(error), operationId: change.operationId }, 'App state message delivery unconfirmed');
    toast({ title: i18n.t('library.savedNotificationFailed', { ns: 'assistant' }), description: messageForUser(error), tier: 'warning' });
  }
}
