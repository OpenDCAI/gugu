import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase';
import { userIdFromSupabaseAccessToken } from '@gugu/core';
import { pickAssistant, type AssistantProvisionRow } from '@gugu/core/shared/assistantProvision';
import { listAgentsForExtension } from '@main/core/extensions/extension-agents';
import { currentAccountAccessToken } from '@main/core/extensions/account-token';
import { messageAgentFromHostApp, AppSendError } from '@main/core/extensions/extension-send';
import { notifyFromNativeProgram } from '@main/core/extensions/extension-programs';
import { ASSISTANT_PANEL_APP, ASSISTANT_PANEL_SERVER } from '@shared/extensions/assistant-app';
import { LIBRARY_TOOL_DEFS } from '../../../../mcp/gugu-library-tool';
import { runLibraryAgentAction, isLibraryAgentAction, writeUserLibraryEntry, onUserLibraryChanged } from './user-library';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types';
import { z } from 'zod';
import { assistantWorkForAgent, onAssistantWorkChanged } from '../../../../sessionpage/assistant-work';

async function account() {
  const token = await currentAccountAccessToken();
  const ownerId = token ? userIdFromSupabaseAccessToken(token) : null;
  if (!token || !ownerId) throw new AppSendError('failed', 'Not signed in');
  return { token, ownerId };
}

/** Native first-party App host, using the same verbs and delivery as an extension page.
 * Its only message recipient is this account's personal assistant, never a task Agent.
 */
export async function callAssistantApp(verb: string, input: unknown, expectedOwnerId?: string | null): Promise<unknown> {
  const { token, ownerId } = await account();
  if (expectedOwnerId && ownerId !== expectedOwnerId) throw new AppSendError('denied', 'Account changed');
  const args = input as Record<string, unknown> | null;
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new AppSendError('invalid', 'App arguments must be an object');
  if (!expectedOwnerId && (verb === 'dispatch' || (verb === 'callProgram' && ['library_write', 'assistant_work_clear'].includes(String(args.name))))) {
    throw new AppSendError('denied', 'The App view is not bound to an account');
  }
  if (verb === 'dispatch' || verb === 'listAgents') {
    const client = createGuguSupabaseClient({ schema: 'identity', headers: { Authorization: `Bearer ${token}` } });
    const { data, error } = await client.from('agent_provisions').select('agent_user_id, device_id, member_key, phase, created_at')
      .eq('owner_user_id', ownerId).eq('member_key', 'assistant');
    if (error) throw new AppSendError('failed', 'Could not verify the personal assistant');
    const personal = pickAssistant((data ?? []) as AssistantProvisionRow[]);
    if ((await account()).ownerId !== ownerId) throw new AppSendError('denied', 'Account changed');
    if (verb === 'listAgents') {
      if (!personal) return { agents: [], unreached: [] };
      const listed = await listAgentsForExtension({ scope: 'all-machines', extensionId: ASSISTANT_PANEL_APP.extensionId });
      if ((await account()).ownerId !== ownerId) throw new AppSendError('denied', 'Account changed');
      const agents = listed.agents.filter(agent => agent.agentId === `user:${personal.agentId}`);
      if (!agents.length) throw new AppSendError('failed', 'The personal assistant is not addressable on its device');
      return { agents, unreached: listed.unreached };
    }
    if (args.delivery !== 'defer' || args.key !== undefined || args.draft !== undefined || args.refs !== undefined) {
      throw new AppSendError('invalid', 'Assistant state messages are dispatched with delivery defer, no key, draft or refs');
    }
    const agentId = String((args.to as { agent?: unknown } | null)?.agent ?? '').replace(/^user:/, '');
    if (personal?.agentId !== agentId) throw new AppSendError('denied', 'This App only messages your personal assistant');
    if ((await account()).ownerId !== ownerId) throw new AppSendError('denied', 'Account changed');
    const receipt = await messageAgentFromHostApp(ASSISTANT_PANEL_APP, 'all-machines', { agentId: `user:${agentId}`, text: args.text, defer: true });
    return { to: { agent: `user:${agentId}` }, ...receipt };
  }
  if (verb === 'callProgram') {
    if (args.server !== undefined && args.server !== ASSISTANT_PANEL_SERVER) throw new AppSendError('invalid', 'Unknown assistant App program');
    if (args.name === 'assistant_work_list' || args.name === 'assistant_work_clear') {
      z.object({}).strict().parse(args.arguments ?? {});
      const client = createGuguSupabaseClient({ schema: 'identity', headers: { Authorization: `Bearer ${token}` } });
      const { data, error } = await client.from('agent_provisions').select('agent_user_id, device_id, member_key, phase, created_at')
        .eq('owner_user_id', ownerId).eq('member_key', 'assistant');
      if (error) throw new AppSendError('failed', 'Could not verify the personal assistant');
      const personal = pickAssistant((data ?? []) as AssistantProvisionRow[]);
      if ((await account()).ownerId !== ownerId) throw new AppSendError('denied', 'Account changed');
      const store = personal ? assistantWorkForAgent(personal.agentId) : null;
      if (!store) throw new AppSendError('failed', 'Personal assistant recovery state is not available on this device');
      if (args.name === 'assistant_work_clear') store.clear();
      const result = { version: 1, items: store.list() };
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { result } } satisfies CallToolResult;
    }
    const tool = LIBRARY_TOOL_DEFS.find(tool => tool.name === args.name);
    if (!tool) throw new AppSendError('invalid', 'Unknown assistant App tool');
    const parsed = tool.schema.parse(args.arguments ?? {}) as Record<string, unknown>;
    if (parsed.device_id !== undefined) throw new AppSendError('invalid', 'Call the App on the resource device');
    const action = { ...parsed, action: tool.action };
    if (!isLibraryAgentAction(action)) throw new AppSendError('invalid', 'Unknown library action');
    if ((await account()).ownerId !== ownerId) throw new AppSendError('denied', 'Account changed');
    const result = action.action === 'library_write'
      ? await writeUserLibraryEntry(action, undefined, 'ui', ownerId) : await runLibraryAgentAction(action);
    if ((await account()).ownerId !== ownerId) throw new AppSendError('denied', 'Account changed');
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { result } } satisfies CallToolResult;
  }
  throw new AppSendError('denied', 'This verb is not offered by the assistant App');
}

/** The same programNotification event an extension page receives. State remains in the resource store. */
export function notifyAssistantApp(ownerId: string, resource: string): void {
  notifyFromNativeProgram({ ...ASSISTANT_PANEL_APP, server: ASSISTANT_PANEL_SERVER }, {
    method: 'notifications/resources/updated', params: { ownerId, resource },
  });
}

onUserLibraryChanged(notifyAssistantApp);
onAssistantWorkChanged(() => { void account().then(({ ownerId }) => notifyAssistantApp(ownerId, 'pending-work')).catch(() => undefined); });
