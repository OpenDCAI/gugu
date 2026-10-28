import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase';
import { appKey, type AppIdentity } from './app-identity';

/**
 * D-30 (主人 10-01 ①, 10-02, 10-06): which agents get which App's tools — `chat.app_enablements` (gugu-supabase #86, a DM
 * allowed since #97), kept by the server per account, so every computer of a person and every agent of theirs reads the same.
 * A row is (chat, person, App): the person gives the App to the agents in that chat — a group's, or one agent's private chat
 * with them. Read with the person's own token: a chat's members read its rows; a person writes only their own. A row goes
 * away by itself when its person leaves the chat (the foreign key cascades). Never read by any App verb (125 10-05).
 */
export interface AppEnablement {
  chatId: string;
  userId: string;
  app: AppIdentity;
}

interface Row {
  chat_id: string;
  user_id: string;
  app_publisher: string;
  app_id: string;
}

function chat(token: string) {
  return createGuguSupabaseClient({ schema: 'chat', headers: { Authorization: `Bearer ${token}` } });
}

/** One person's rows, all of them or in these chats. */
export async function readEnablements(token: string, userId: string, chatIds?: readonly string[]): Promise<AppEnablement[]> {
  if (chatIds && chatIds.length === 0) return [];
  let query = chat(token).from('app_enablements').select('chat_id, user_id, app_publisher, app_id').eq('user_id', userId);
  if (chatIds) query = query.in('chat_id', [...chatIds]);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return ((data as Row[] | null) ?? []).map((row) => ({
    chatId: row.chat_id,
    userId: row.user_id,
    app: { publisher: row.app_publisher, id: row.app_id },
  }));
}

/**
 * The Apps (`<publisher>/<id>`) a person gave to the agents of a chat this agent is in: their rows, narrowed to the chats
 * the agent is a member of — a group it is in, or its own private chat with them.
 */
export async function appsGivenTo(token: string, ownerId: string, agentUserId: string): Promise<Set<string>> {
  const rows = await readEnablements(token, ownerId);
  if (rows.length === 0) return new Set();
  const { data, error } = await chat(token)
    .from('chat_members')
    .select('chat_id')
    .eq('user_id', agentUserId)
    .in('chat_id', [...new Set(rows.map((row) => row.chatId))]);
  if (error) throw new Error(error.message);
  const its = new Set(((data as { chat_id: string }[] | null) ?? []).map((row) => row.chat_id));
  return new Set(rows.filter((row) => its.has(row.chatId)).map((row) => appKey(row.app)));
}

/**
 * The chat an App is given at for a chat a card or an install is in. A topic goes by the chat it grew out of: its people are
 * that chat's, and that is where tools reach — with its name, as a sheet says it. `null`: none (a chat it cannot read).
 */
export async function enablementChatOf(token: string, chatId: string): Promise<{ id: string; name: string } | null> {
  const read = async (id: string) => {
    const { data, error } = await chat(token).from('chats').select('id, kind, name, source_chat_id').eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    return data as { id: string; kind: string; name: string | null; source_chat_id: string | null } | null;
  };
  const row = await read(chatId);
  const place = row?.kind === 'topic' && row.source_chat_id ? await read(row.source_chat_id) : row;
  return place && (place.kind === 'group' || place.kind === 'dm') ? { id: place.id, name: place.name ?? '' } : null;
}

/** The person gives (`on`) or stops giving an App at a chat — their own row; giving twice changes nothing. */
export async function setEnablement(token: string, userId: string, chatId: string, app: AppIdentity, on: boolean): Promise<void> {
  const row = { chat_id: chatId, user_id: userId, app_publisher: app.publisher, app_id: app.id };
  const { error } = on
    ? await chat(token).from('app_enablements').upsert(row, { onConflict: 'chat_id,user_id,app_publisher,app_id', ignoreDuplicates: true })
    : await chat(token).from('app_enablements').delete().match(row);
  if (error) throw new Error(error.message);
}
