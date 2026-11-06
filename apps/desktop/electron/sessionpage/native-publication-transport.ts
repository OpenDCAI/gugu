import { readCachedDeviceId } from '@gugu/core/cloud/deviceRuntime';
import { localAgentForSession } from './sessionpage-session-agent';
import { makeChatClient } from '../supabase';
import type { SessionpageIdentityAuthSnapshot } from './sessionpage-identity-host';
import type { NativePublication, NativePublicationContext } from '../session/main/core/sessions/native-publication-journal';

export function createNativePublicationTransport(deps: {
  getAuth(): Promise<SessionpageIdentityAuthSnapshot | null>;
  resolveDeviceId(): Promise<string | null>;
  ensureAgentAddress(input: { sessionId: string; projectId: string }): Promise<{ chatId: string; agentUserId: string }>;
  env: NodeJS.ProcessEnv;
}) {
  const context = async (sessionId: string): Promise<NativePublicationContext | null> => {
    const auth = await deps.getAuth();
    if (!auth) return null;
    // Admission must work offline for an already registered device. This owner/tier-scoped cache
    // preserves its actual identity; publication still revalidates that identity on the server.
    const deviceId = await readCachedDeviceId(deps.env, auth.userId).catch(async error => {
      if (!String(error).includes('device.json missing')) throw error;
      return deps.resolveDeviceId();
    });
    if (!deviceId) throw new Error('Native personal-message device is unavailable');
    const agent = await localAgentForSession(sessionId, deps.env, auth.userId);
    if ((await deps.getAuth())?.userId !== auth.userId) throw new Error('Native publication account changed during admission');
    return { ownerUserId: auth.userId, deviceId, ...(agent?.gugu_user_id ? { agentUserId: agent.gugu_user_id } : {}) };
  };
  const requireContext = async (entry: NativePublication) => {
    const current = await context(entry.sessionId);
    if (!current || current.ownerUserId !== entry.ownerUserId || current.deviceId !== entry.deviceId
      || entry.agentUserId && current.agentUserId !== entry.agentUserId) throw new Error('Native publication owner or binding changed');
  };
  return {
    context,
    async address(entry: NativePublication) {
      await requireContext(entry);
      const address = await deps.ensureAgentAddress(entry);
      await requireContext({ ...entry, ...address });
      return address;
    },
    async publish(entry: NativePublication & { chatId: string; agentUserId: string }) {
      await requireContext(entry);
      const auth = await deps.getAuth();
      if (auth?.userId !== entry.ownerUserId) throw new Error('Native publication account changed before publishing');
      const { data, error } = await makeChatClient(auth.accessToken).rpc('publish_native_conversation_message', {
        p_device_id: entry.deviceId, p_agent_user_id: entry.agentUserId, p_session_id: entry.sessionId,
        p_message_id: entry.id, p_chat_id: entry.chatId, p_occurred_at: entry.occurredAt,
      });
      if (error) throw new Error(`Native personal-message publication failed: ${error.message}`);
      if (!data || data.chat_id !== entry.chatId || typeof data.already !== 'boolean'
        || typeof data.account_revision !== 'string' || !/^(0|[1-9][0-9]*)$/.test(data.account_revision)) throw new Error('Invalid native publication receipt');
      return { accountRevision: data.account_revision as string, already: data.already as boolean };
    },
  };
}
