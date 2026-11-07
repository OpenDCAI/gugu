import { messageItemFromRow, MESSAGES_VIEW_SELECT, type RawMessageRow } from '@gugu/core/cloud/messageItem';
import type { MessageItem } from '@gugu/core/shared/types/chat';
import { chatDb, identityDb } from '@/lib/supabase';
import { getRendererSession } from '@/lib/sessionPublication';
import { currentAuthSessionSignal } from '@/lib/authSessionLoss';
import { readDisplayIdentities } from '@/lib/identityReadAdapter';
import { rpcOn } from '@/session/renderer/lib/ipc';
import { machineRegistry } from '@/session/renderer/lib/machine-routing';
import type { DisplayIdentity } from '@/lib/displayIdentity';

const PAGE_SIZE = 60;
type DmRow = { id: string; public_id: number; name: string | null; created_at: string; last_message_at: string | null; members: { user_id: string }[] };
export type LegacyDm = { id: string; publicId: number; name: string | null; updatedAt: string; agent: DisplayIdentity | null };
export type LegacyDmScope = { ownerUserId: string; agentUserId?: string };

function ownerSignal(ownerUserId: string): AbortSignal {
  if (!ownerUserId || getRendererSession()?.user.id !== ownerUserId) throw new Error('Legacy history account changed');
  return currentAuthSessionSignal();
}

/** RLS is always evaluated using the current person's token, never an agent/service-role token. */
async function identify(rows: readonly DmRow[], scope: LegacyDmScope): Promise<LegacyDm[]> {
  const signal = ownerSignal(scope.ownerUserId);
  // Removed seats are hidden by member RLS; resolve retained identities through the existing owner-scoped history RPC.
  rows = await Promise.all(rows.map(async row => {
    if (row.members.length !== 1 || row.members[0]?.user_id !== scope.ownerUserId) return row;
    const historical = await chatDb.rpc('historical_dm_peer', { p_chat_id: row.id }).abortSignal(signal);
    if (historical.error) throw new Error(historical.error.message);
    return { ...row, members: [...row.members, ...((historical.data ?? []) as { user_id: string }[]).map(peer => ({ user_id: peer.user_id }))] };
  }));
  const peerIds = rows.flatMap(row => row.members.map(member => member.user_id)).filter(id => id !== scope.ownerUserId);
  const [identities, markers] = await Promise.all([
    readDisplayIdentities(peerIds, signal),
    identityDb.from('agent_provisions').select('agent_user_id').eq('owner_user_id', scope.ownerUserId)
      .eq('member_key', 'assistant').abortSignal(signal),
  ]);
  if (markers.error) throw new Error(markers.error.message);
  ownerSignal(scope.ownerUserId);
  const assistants = new Set((markers.data ?? []).map(row => row.agent_user_id));
  return rows.flatMap(row => {
    const members = [...new Set(row.members.map(member => member.user_id))];
    if (!members.includes(scope.ownerUserId) || members.length > 2) return [];
    const peerId = members.find(id => id !== scope.ownerUserId);
    const peer = identities.find(identity => identity.id === peerId) ?? null;
    if (peer?.type === 'human' || assistants.has(peerId ?? '')) return [];
    if (peer && (peer.type !== 'agent' || peer.owner_user_id !== scope.ownerUserId)) return [];
    if (scope.agentUserId && (peerId !== scope.agentUserId || !peer)) return [];
    return [{ id: row.id, publicId: row.public_id, name: row.name ?? peer?.display_name ?? null,
      updatedAt: row.last_message_at ?? row.created_at, agent: peer }];
  });
}

const DM_SELECT = 'id,public_id,name,created_at,last_message_at,members:chat_members(user_id)';

/** The archive is a separate paginated read, never a conversation-store entry. A chat without a message is no history. */
export async function readLegacyDmList(scope: LegacyDmScope, after?: string, query = '') {
  const signal = ownerSignal(scope.ownerUserId);
  for (;;) {
    let request = chatDb.from('chats').select(DM_SELECT).eq('kind', 'dm').not('last_message_at', 'is', null).order('id').limit(PAGE_SIZE);
    if (after) request = request.gt('id', after);
    if (query.trim()) {
      if (/^\d+$/.test(query.trim())) request = request.eq('public_id', Number(query.trim()));
      else request = request.ilike('name', `%${query.trim().replace(/[\\%_]/g, '\\$&')}%`);
    }
    const { data, error } = await request.abortSignal(signal);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as unknown as DmRow[];
    const identified = await identify(rows, scope);
    after = rows.length === PAGE_SIZE ? rows.at(-1)!.id : undefined;
    // Ownership is decided after the read, so a page can hold none of this scope's chats without being the last.
    if (identified.length > 0 || !after) return { rows: identified, after: after ?? null };
  }
}

/** The scope of a session's own agent, on the machine that holds it; a session with no verifiable identity has no history to read. */
export async function readSessionLegacyScope(ownerUserId: string, sessionId: string): Promise<LegacyDmScope | null> {
  const binding = await rpcOn(machineRegistry.machineOf(sessionId)).sessionHistory.legacyDmBinding({ ownerUserId, sessionId });
  return binding && { ownerUserId, agentUserId: binding.agentUserId };
}

export async function hasLegacyDmHistory(ownerUserId: string, sessionId: string): Promise<boolean> {
  const scope = await readSessionLegacyScope(ownerUserId, sessionId);
  return scope !== null && (await readLegacyDmList(scope)).rows.length > 0;
}

export async function readLegacyDmMessages(scope: LegacyDmScope, chatId: string, beforeSeq?: number) {
  const signal = ownerSignal(scope.ownerUserId);
  // Recheck membership and ownership for every page; a stale local hint is never authority.
  const chat = await chatDb.from('chats').select(DM_SELECT).eq('id', chatId).eq('kind', 'dm').abortSignal(signal).single();
  if (chat.error) throw new Error(chat.error.message);
  if ((await identify([chat.data as unknown as DmRow], scope)).length !== 1) throw new Error('This legacy DM is not owned by the signed-in account');
  let request = chatDb.from('messages_view').select(MESSAGES_VIEW_SELECT).eq('chat_id', chatId)
    .is('deleted_at', null).not('deleted_for_user_ids', 'cs', JSON.stringify([scope.ownerUserId]));
  if (beforeSeq !== undefined) request = request.lt('seq', beforeSeq);
  const { data, error } = await request.order('seq', { ascending: false }).limit(PAGE_SIZE + 1).abortSignal(signal);
  if (error) throw new Error(error.message);
  ownerSignal(scope.ownerUserId);
  const raw = (data ?? []) as RawMessageRow[];
  const page = raw.slice(0, PAGE_SIZE);
  const rows = page.map(row => {
    const message = messageItemFromRow(row, scope.ownerUserId);
    if (!message) throw new Error('A legacy message could not be decoded');
    return message;
  }).reverse();
  return { rows, beforeSeq: raw.length > PAGE_SIZE ? rows[0].seq : null };
}

export function mergeLegacyMessages(older: readonly MessageItem[], current: readonly MessageItem[]): MessageItem[] {
  return [...new Map([...older, ...current].map(message => [message.id, message])).values()].sort((a, b) => a.seq - b.seq);
}
