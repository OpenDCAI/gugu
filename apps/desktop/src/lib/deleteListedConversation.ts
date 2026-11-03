import { chatDb } from './supabase';
import { currentGroupAdmin } from './groupAdmin';

/** A DM deletion removes only the current owner's durable list entry, never group or identity state. */
export type PersonalConversationDeletion = { chat_id: string; deleted_at: string };
export async function deleteListedConversation(chatId: string): Promise<PersonalConversationDeletion | null> {
  const chat = await chatDb.from('chats').select('kind').eq('id', chatId).single();
  if (chat.error) throw new Error(chat.error.message);
  if (chat.data.kind === 'dm') {
    const { data, error } = await chatDb.rpc('delete_my_dm_conversation', { p_chat_id: chatId });
    if (error) throw new Error(error.message);
    if (!data || data.chat_id !== chatId || typeof data.deleted_at !== 'string') throw new Error('Conversation deletion was not confirmed');
    return { chat_id: data.chat_id, deleted_at: data.deleted_at };
  }
  if (chat.data.kind !== 'group') throw new Error('conversation_dm_identity_unverified');
  await (await currentGroupAdmin()).archive(chatId);
  return null;
}
