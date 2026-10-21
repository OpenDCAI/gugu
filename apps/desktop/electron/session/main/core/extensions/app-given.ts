import { userIdFromSupabaseAccessToken } from '@gugu/core';
import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase';
import { fetchInChunks } from '@gugu/core/shared/inChunks';
import { extensionsService } from '@main/core/extensions/extensions-root';
import { currentAccountAccessToken } from '@main/core/extensions/account-token';
import { appIdentityOf, appKey, type AppIdentity } from '@shared/extensions/app-identity';
import { enablementChatOf, readEnablements, setEnablement } from '@shared/extensions/app-enablements-core';
import { GROUP_FACES, givesAgentTools, isHerePlace, placesOfChats, type PlaceChat, type PlaceIdentity } from '@shared/extensions/app-places';
import { HERE_ALL, type EnablePlace } from '@shared/extensions/host-actions';
import type { ExtensionManifest } from '@shared/extensions/manifest';
import { listProjectGroupIds } from '../../../../sessionpage/sessionpage-project-groups';

/**
 * D-30 「给哪些 agent」 (主人 10-06「肯定是能选的啊」, on 主人 10-02 方案 A): main reads and writes it for the desktop — the
 * App's row in 「App」 and every install's sheet. This computer's half is kept with the install (`givenHere`); a chat's is
 * the person's own row (`chat.app_enablements`). Nothing here is read by an App's verbs (125 10-05).
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

/**
 * The places an App can be given at, ticked where it is given now (its row in 「App」) — or, for an install, as `ticked`
 * says (`installTicks`). An App installed here before anyone chose reaches every agent here, and its row says so.
 */
export async function appPlaces(extensionId: string | null, ticked?: readonly string[]): Promise<EnablePlace[]> {
  const { token, userId } = await me();
  const on = new Set<string>(ticked ?? []);
  if (!ticked && extensionId) {
    const identity = extensionsService().identityOf(extensionId);
    for (const place of (identity ? extensionsService().givenHere(identity) : null) ?? [HERE_ALL]) on.add(place);
    if (identity) {
      for (const row of await readEnablements(token, userId)) if (appKey(row.app) === appKey(identity)) on.add(row.chatId);
    }
  }
  const projects = new Set((await listProjectGroupIds(userId)).map((entry) => entry.chatId));
  const { chats, identities } = await placeChats(token, userId);
  return placesOfChats(chats, identities, { me: userId, enabled: on, projects, here: true });
}

/**
 * What an install ticks at first: an install again for a chat (a card's, the chat an agent installs for; a topic goes by the
 * chat it grew out of) ticks that chat when it is a place — a group, or the person's private chat with one of their agents;
 * anything else ticks every agent on this computer. A first install names no chat here, wherever it comes from (编号 2,
 * 10-12: D-30「没选过的 App 给本机所有 agent」— a first install from a card ticked only the card's chat, and the agents of
 * every other group had nothing).
 */
export async function installTicks(chatId: string | undefined, places?: readonly EnablePlace[]): Promise<string[]> {
  if (!chatId) return [HERE_ALL];
  const place = await enablementChatOf((await me()).token, chatId).catch(() => null);
  const listed = places ?? (await appPlaces(null, []));
  return place && listed.some((one) => one.id === place && one.kind !== 'here') ? [place] : [HERE_ALL];
}

/**
 * What an install asks about 「给哪些 agent」, only for an App giving agents tools (125 10-05: the question is about tools
 * alone): its first install here, every agent here ticked wherever it is installed from — and an install of it again for a
 * chat it is not given at yet (125 10-07: an agent's app_install with chat_id, a card's install in another chat widen who
 * gets its tools once the person narrowed them, so the person confirms it, the chat ticked and what they chose kept). An
 * upgrade where it is given already, or naming no chat, leaves their choice. Null when it does not ask. Places that cannot be
 * read now throw: the install fails, saying why (owner 10-17, 体检 #21) — never «not asked», which reached every agent here.
 * From a card, the chat it is in is marked so.
 */
export async function installAsk(
  manifest: Pick<ExtensionManifest, 'permissions' | 'contributes'>,
  firstInstall: boolean,
  chatId: string | undefined,
  identity: AppIdentity | null,
  fromCard = false,
): Promise<{ places: EnablePlace[]; ticks: string[] } | null> {
  if (!givesAgentTools(manifest)) return null;
  // What this computer keeps for it, as places (a removed one is none); none recorded is every agent here (installed before
  // anyone chose), which no chat widens.
  const here = (firstInstall ? [] : (identity ? extensionsService().givenHere(identity) : null) ?? [HERE_ALL]).filter(isHerePlace);
  if (!firstInstall && (!chatId || here.includes(HERE_ALL))) return null;
  // Places unread fails the install, said: never «not asked», which reaches every agent here (owner 10-17, 体检 #21).
  const asked = await installPlaces(identity, firstInstall ? undefined : chatId, fromCard, here);
  if (firstInstall) return asked;
  const before = new Set([...here, ...(identity ? await givenAt(identity) : [])]);
  // A chat that is no place ticks every agent here (installTicks): installing for one chat never asks for that.
  const added = asked.ticks.filter((place) => !before.has(place));
  return added.length > 0 && !added.includes(HERE_ALL) ? asked : null;
}

/** The chats the person gave this App at: rows of their account, written from any computer of theirs. */
async function givenAt(identity: AppIdentity): Promise<string[]> {
  const { token, userId } = await me();
  return (await readEnablements(token, userId)).filter((row) => appKey(row.app) === appKey(identity)).map((row) => row.chatId);
}

/**
 * The places an install's sheet shows, ticked as it starts: what the install ticks at first (`installTicks`), every chat
 * the person already gave this App at — rows of their account, written from another computer of theirs — and, for an App
 * installed here already, the places this computer keeps for it (`kept`). A first install here is not the account's
 * first: the sheet shows those as they are, and leaving one off is the person's own choice (复核 72: the answer is written
 * back whole, so a second computer's first install used to drop them unseen).
 */
export async function installPlaces(
  identity: AppIdentity | null,
  chatId: string | undefined,
  fromCard = false,
  kept: readonly string[] = [],
): Promise<{ places: EnablePlace[]; ticks: string[] }> {
  const listed = await appPlaces(null, []);
  const first = await installTicks(chatId, listed);
  const card = fromCard && !first.includes(HERE_ALL) ? first[0] : undefined;
  const ticks = [...new Set([...kept, ...first, ...(identity ? await givenAt(identity) : [])])];
  return { places: listed.map((place) => ({ ...place, enabled: ticks.includes(place.id), ...(place.id === card ? { card: true } : {}) })), ticks };
}

/** Which App an install from this computer's own sheet records: the market's is gugu's, a folder's the account installing it. */
export async function ownInstallIdentity(manifestId: string, origin: 'market' | 'folder'): Promise<AppIdentity | null> {
  const publisher = origin === 'folder' ? await (await import('./app-files')).folderPublisher() : null;
  return appIdentityOf({ manifest: { id: manifestId }, origin, publisher });
}

/** After an install that asked: the person's answer — or, when no sheet came up, what it ticked at first (没弹框 = 照原样). */
export async function recordGiven(extensionId: string, asked: { ticks: string[] } | null, enableIn: readonly string[] | undefined): Promise<void> {
  if (!asked) return;
  await setAppPlaces(extensionId, enableIn ?? asked.ticks);
}

/** The person's choice for an App, the whole set: this computer's places, and their own rows at chats. */
export async function setAppPlaces(extensionId: string, enableIn: readonly string[]): Promise<void> {
  const identity = extensionsService().identityOf(extensionId);
  if (!identity) throw new Error(`App ${extensionId} has no publisher on record here: install it again to choose which agents get it`);
  extensionsService().setGivenHere(identity, enableIn.filter(isHerePlace));
  const { token, userId } = await me();
  const wanted = new Set(enableIn.filter((place) => !isHerePlace(place)));
  const now = new Set((await readEnablements(token, userId)).filter((row) => appKey(row.app) === appKey(identity)).map((row) => row.chatId));
  for (const chatId of wanted) if (!now.has(chatId)) await setEnablement(token, userId, chatId, identity, true);
  for (const chatId of now) if (!wanted.has(chatId)) await setEnablement(token, userId, chatId, identity, false);
}
