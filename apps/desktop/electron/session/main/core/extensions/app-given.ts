import { userIdFromSupabaseAccessToken } from '@gugu/core';
import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase';
import { fetchInChunks } from '@gugu/core/shared/inChunks';
import { extensionsService } from '@main/core/extensions/extensions-root';
import { currentAccountAccessToken } from '@main/core/extensions/account-token';
import { appIdentityOf, appKey, type AppIdentity } from '@shared/extensions/app-identity';
import { enablementChatOf, readEnablements, setEnablement } from '@shared/extensions/app-enablements-core';
import { log } from '@main/lib/logger';
import { GROUP_FACES, givesAgentTools, hereGives, isHerePlace, placesOfChats, type PlaceChat, type PlaceIdentity } from '@shared/extensions/app-places';
import { HERE_ALL, type EnablePlace, type InstallGrant } from '@shared/extensions/host-actions';
import type { ExtensionManifest } from '@shared/extensions/manifest';
import { listProjectGroupIds } from '../../../../sessionpage/sessionpage-project-groups';

/**
 * D-30 「给哪些 agent」, two layers (App architecture §4, owner 10-27): this computer's half is kept with the install
 * (`givenHere`: every agent here, or not); a chat's is the person's own row (`chat.app_enablements`), named on the App's row
 * in 「App」 only, one change at a time (`changeAppPlaces`). An install writes this computer's half alone (`recordInstallGrant`):
 * a first install here gives every agent here, one installed already keeps what it gives; an agent installing for a chat
 * adds that one row. Nothing here is read by an App's verbs (125 10-05).
 */

async function me(): Promise<{ token: string; userId: string }> {
  const token = await currentAccountAccessToken();
  const userId = token ? userIdFromSupabaseAccessToken(token) : null;
  if (!token || !userId) throw new Error('Not signed in, so which agents get an App cannot be read or changed');
  return { token, userId };
}

/**
 * The person's chats as the chat list draws them (their groups, their private chats, the topics grown out of them), the
 * faces of a group's first members and each private chat's other one — who is an agent of theirs among them (`agentOf`).
 */
async function placeChats(token: string, userId: string): Promise<{ chats: PlaceChat[]; identities: Record<string, PlaceIdentity> }> {
  const chat = createGuguSupabaseClient({ schema: 'chat', headers: { Authorization: `Bearer ${token}` } });
  const mine = await chat.from('chat_members').select('chat_id').eq('user_id', userId);
  if (mine.error) throw new Error(mine.error.message);
  const ids = [...new Set(((mine.data as { chat_id: string }[] | null) ?? []).map((row) => row.chat_id))];
  type Row = { id: string; kind: PlaceChat['kind']; status: PlaceChat['status']; name: string | null; avatar_url: string | null; last_message_at: string | null; source_chat_id: string | null };
  const rows = await fetchInChunks(ids, async (chunk) => {
    const { data, error } = await chat.from('chats').select('id, kind, status, name, avatar_url, last_message_at, source_chat_id').in('id', chunk);
    if (error) throw new Error(error.message);
    return (data as Row[] | null) ?? [];
  });
  const drawn = rows.filter((row) => row.status === 'active' && (row.kind === 'group' || row.kind === 'dm')).map((row) => row.id);
  const members = await fetchInChunks(drawn, async (chunk) => {
    const { data, error } = await chat.from('chat_members').select('chat_id, user_id').in('chat_id', chunk);
    if (error) throw new Error(error.message);
    return (data as { chat_id: string; user_id: string }[] | null) ?? [];
  });
  const memberIds = new Map<string, string[]>();
  for (const row of members) memberIds.set(row.chat_id, [...(memberIds.get(row.chat_id) ?? []), row.user_id]);
  const chats: PlaceChat[] = rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    status: row.status,
    name: row.name ?? '',
    avatar: row.avatar_url,
    member_user_ids: memberIds.get(row.id) ?? [],
    last_message_at: row.last_message_at,
    source_chat_id: row.source_chat_id,
    peer_user_id: row.kind === 'dm' ? (memberIds.get(row.id) ?? []).find((id) => id !== userId) ?? null : null,
  }));
  const faces = [...new Set(chats.flatMap((one) => (one.kind === 'dm' ? [one.peer_user_id ?? ''] : (one.member_user_ids ?? []).slice(0, GROUP_FACES))).filter(Boolean))];
  const identity = createGuguSupabaseClient({ schema: 'identity', headers: { Authorization: `Bearer ${token}` } });
  const users = await fetchInChunks(faces, async (chunk) => {
    const { data, error } = await identity.from('users').select('id, display_name, avatar, type, owner_user_id').in('id', chunk);
    if (error) throw new Error(error.message);
    return (data as { id: string; display_name: string | null; avatar: string | null; type: string | null; owner_user_id: string | null }[] | null) ?? [];
  });
  const identities: Record<string, PlaceIdentity> = {};
  for (const user of users) {
    identities[user.id] = { display_name: user.display_name ?? user.id.slice(0, 8), avatar: user.avatar, agentOf: user.type === 'agent' ? user.owner_user_id : null };
  }
  return { chats, identities };
}

/** The places an App can be given at on its row in 「App」, ticked where it is given now (none recorded here: every agent). */
export async function appPlaces(extensionId: string): Promise<EnablePlace[]> {
  const { token, userId } = await me();
  const identity = extensionsService().identityOf(extensionId);
  const on = new Set<string>(identity ? hereGivenOf(identity) : [HERE_ALL]);
  if (identity) for (const row of await readEnablements(token, userId)) if (appKey(row.app) === appKey(identity)) on.add(row.chatId);
  const projects = new Set((await listProjectGroupIds(userId)).map((entry) => entry.chatId));
  const { chats, identities } = await placeChats(token, userId);
  return placesOfChats(chats, identities, { me: userId, enabled: on, projects, here: true });
}

/** This computer's places for an App; none recorded (installed before anyone chose) is every agent here (`hereGives`). */
function hereGivenOf(identity: AppIdentity): string[] {
  return extensionsService().givenHere(identity) ?? [HERE_ALL];
}

/**
 * What installing an App gives here, only for an App giving agents tools (125 10-05): a first install here, every agent here;
 * an install again for a chat (an agent's app_install with chat_id, a card's install; a topic goes by the chat it grew out of)
 * where this computer does not give every agent already and the chat is not given yet, that chat. Anything else changes
 * nothing — null, and the sheet says nothing about agents. Only that last case reads the account: a first install works offline.
 */
export async function installGrant(
  manifest: Pick<ExtensionManifest, 'permissions' | 'contributes'>,
  firstInstall: boolean,
  chatId: string | undefined,
  identity: AppIdentity | null,
): Promise<InstallGrant | null> {
  if (!givesAgentTools(manifest)) return null;
  if (firstInstall) return { first: true };
  if (!identity || !chatId || hereGives(hereGivenOf(identity))) return null;
  const { token, userId } = await me();
  const chat = await enablementChatOf(token, chatId);
  if (!chat) return null;
  const given = (await readEnablements(token, userId, [chat.id])).some((row) => appKey(row.app) === appKey(identity));
  return given ? null : { first: false, chat };
}

/**
 * After the install landed: what it gives (`installGrant`) is written — every agent here for a first install, the chat's row
 * for one asked for a chat. Nothing else is written, so an install never takes away what another computer or the App page gave.
 * The chat's row is the account's, written over the network: when that fails the App is installed all the same (this computer's
 * half is what decides here) and the failure is logged, never a failed install that can no longer be retried as a first one.
 */
export async function recordInstallGrant(extensionId: string, grant: InstallGrant | null): Promise<void> {
  if (!grant) return;
  const identity = extensionsService().identityOf(extensionId);
  if (!identity) return;
  if (grant.first) {
    extensionsService().setGivenHere(identity, [HERE_ALL]);
    return;
  }
  try {
    const { token, userId } = await me();
    await setEnablement(token, userId, grant.chat.id, identity, true);
  } catch (error) {
    log.warn({ extensionId, chatId: grant.chat.id, error: error instanceof Error ? error.message : String(error) }, 'installed, but the chat it was asked for was not given it');
  }
}

/** Which App an install from this computer's own sheet records: the market's is gugu's, a folder's the account installing it. */
export async function ownInstallIdentity(manifestId: string, origin: 'market' | 'folder'): Promise<AppIdentity | null> {
  const publisher = origin === 'folder' ? await (await import('./app-files')).folderPublisher() : null;
  return appIdentityOf({ manifest: { id: manifestId }, origin, publisher });
}

/**
 * The person changes who gets an App on its row in 「App」: each change on its own — this computer's every agent on or off,
 * one chat's row added or removed. Never the whole set written back, so what another computer (or another sheet still open)
 * changed meanwhile stays (architecture I9).
 */
export async function changeAppPlaces(extensionId: string, changes: readonly { id: string; on: boolean }[]): Promise<void> {
  const identity = extensionsService().identityOf(extensionId);
  if (!identity) throw new Error(`App ${extensionId} has no publisher on record here: install it again to choose which agents get it`);
  const here = changes.filter((change) => isHerePlace(change.id));
  if (here.length) extensionsService().setGivenHere(identity, here.at(-1)!.on ? [HERE_ALL] : []);
  const chats = changes.filter((change) => !isHerePlace(change.id));
  if (!chats.length) return;
  const { token, userId } = await me();
  for (const change of chats) await setEnablement(token, userId, change.id, identity, change.on);
}
