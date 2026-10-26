import { hostEventHub, hostMembers } from '../../session/shared/extensions/host-calls';
import type { ExtensionHostEvent } from '../../session/shared/extensions/bridge-protocol';
import type { ExtensionAgentView } from '../../session/shared/extensions/bridge-protocol';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types';
import type { AppMessageReceipt } from '@gugu/session-core/session-record/contract';
import type { AssistantAppChange } from '../../session/shared/extensions/assistant-app';
import type { AssistantPanelReceipt } from '@gugu/core/cloud/assistantPanel';
import { libraryHost } from './assistant-library-client';
import type { AssistantMachine } from '../../session/renderer/features/assistant/assistant-machine-core';
import { rendererLogger } from '../../lib/log';
import { cachedDevicesAccount } from '../../store/devicesCache';
import { assistantPanelLibrary } from './assistant-panel-library';
import { ASSISTANT_PANEL_CHANGED } from './assistant-panel-events';

type ProgramNotification = { server: string; method: string; params?: unknown };
export type AssistantAppMachine = Pick<AssistantMachine, 'rpc' | 'panel'>;
type PanelAPI = {
  listAgents(): Promise<{ agents: ExtensionAgentView[]; unreached: unknown[] }>;
  dispatch(text: string, options: { to: { agent: string }; delivery: 'defer' }): Promise<AppMessageReceipt>;
  callProgram(name: string, args?: Record<string, unknown>, server?: string): Promise<CallToolResult>;
  onProgramNotification(listener: (event: ProgramNotification) => void): () => void;
};

/** Native React App surface, using the Extension API's member table and wire, without a second SDK. */
export function assistantAppClient(machine: AssistantAppMachine | null | undefined, expectedOwnerId = cachedDevicesAccount(), onHomeDevice = false) {
  if (machine?.panel) {
    const panel = machine.panel;
    const library = assistantPanelLibrary(panel);
    const result = (result: unknown): CallToolResult => ({ content: [{ type: 'text',text: JSON.stringify(result) }],structuredContent: { result } });
    return {
      async listAgents(): Promise<Awaited<ReturnType<PanelAPI['listAgents']>>> { throw new Error('Use the cloud assistant identity') },
      async dispatch(): Promise<AppMessageReceipt> { throw new Error('Panel saves use the durable cloud change queue') },
      async callProgram(name: string, args?: Record<string, unknown>): Promise<CallToolResult> {
        if (expectedOwnerId !== panel.ownerId) throw new Error('Assistant panel account changed');
        if (name === 'library_read') return result(args?.entry ? await library.entry(args.kind as 'capabilities' | 'devices',String(args.entry))
          : await library.volume(args?.kind as 'capabilities' | 'devices'));
        if (name === 'library_write') return result(await library.save(args as Parameters<typeof library.save>[0]));
        const path = `${panel.paths.memoryDir}/pending-work.json`;
        if (name === 'assistant_work_clear') { await panel.write(path,new TextEncoder().encode('{"version":1,"items":[]}'),'application/json'); return result({ version: 1,items: [] }); }
        if (name === 'assistant_work_list') { const text = await panel.text(path); return result(text === null ? { version: 1,items: [] } : JSON.parse(text)); }
        throw new Error('Unknown assistant panel program');
      },
      onProgramNotification(listener: (event: ProgramNotification) => void) {
        const changed = () => { for (const resource of ['capabilities','devices','pending-work']) listener({ server: 'assistant',method: 'notifications/resources/updated',params: { ownerId: panel.ownerId,resource } }); };
        window.addEventListener(ASSISTANT_PANEL_CHANGED,changed);
        return () => window.removeEventListener(ASSISTANT_PANEL_CHANGED,changed);
      },
      deliver: (_event: ExtensionHostEvent) => {},
    };
  }
  const hub = hostEventHub();
  const api = hostMembers('page', name => ['listAgents', 'dispatch', 'callProgram', 'onProgramNotification'].includes(name),
    async (verb, args) => {
      const host = onHomeDevice ? machine?.rpc?.app : libraryHost(machine);
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
  const { queueAssistantAppChange } = await import('./assistant-panel-cloud');
  return queueAssistantAppChange({ ...change, operationId: change.operationId ?? crypto.randomUUID() },assistantId,expectedOwnerId);
}

/** Call after a successful state mutation. A failed delivery must not turn a committed save into a fake save failure. */
export async function reportAssistantAppChange(
  machine: AssistantAppMachine | null | undefined, assistantId: string | undefined,
  change: Omit<AssistantAppChange, 'operationId'> & { operationId?: string },
  expectedOwnerId = cachedDevicesAccount(),
): Promise<void> {
  if (machine?.panel && change.resource !== 'pending-work') return;
  void publishAssistantAppChange(machine, change, assistantId, expectedOwnerId).catch(() => {
    rendererLogger('assistant/app').warn({ operationId: change.operationId }, 'Saved App change publication deferred');
  });
}
