import { decodeTypedId } from '@gugu/core/shared/typedId.mjs';
import { readIdentityDirectoryBridge, type IdentityDirectoryBridge } from '@/lib/identityDirectoryBridge';
import { sessionAgentBindings } from '@renderer/features/sessions/stores/session-agent-bindings';
import type { ChatActor } from '@gugu/session-chat-ui';

/** Same identity directory and session roster as the existing message avatar. */
export function chatActor(address: string, bridge: IdentityDirectoryBridge | undefined = readIdentityDirectoryBridge(),
  ownerOf: (sessionId: string) => string | undefined = id => sessionAgentBindings.bindingFor(id)?.agentUserId): ChatActor | null {
  // Native history can refer to another machine's session before its local roster is known.
  // A session address is itself an agent identity (buildSessionDirectEnvelope); keep that
  // navigation target instead of requiring an unrelated identity.users cache entry.
  const session = /^session:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(address)
    ? { id: address, type: 'agent' as const, name: '' } : null;
  let id: string | undefined;
  if (!bridge) return session;
  let sessionOwner = false;
  if (/^(?:user|aid):[^:]+$/.test(address)) id = address.slice(address.indexOf(':') + 1);
  else if (/^session:[^:]+$/.test(address)) {
    id = ownerOf(decodeTypedId('session', address, 'activity recipient'));
    sessionOwner = !!id;
  } else if (/^gugu:[1-9][0-9]{0,8}$/.test(address)) {
    const number = Number(address.slice(5));
    const match = Object.values(bridge.getSnapshot() ?? {}).find(value => value.gugu_number === number);
    id = match?.id;
  }
  if (!id) return session;
  const identity = bridge.getSnapshot()?.[id];
  if (!identity) {
    bridge.ensure([id]);
    return sessionOwner ? { id: `user:${id}`, type: 'agent', name: '' } : null;
  }
  return { id: `user:${id}`, type: sessionOwner ? 'agent' : identity.type, name: identity.display_name };
}
