import type { StoredUnreadBinding } from './unread-binding';

/** A projection of the original read source. Unknown is not a verified zero. */
export function conversationUnreadProjection(input: {
  ownerId: string | null;
  binding: StoredUnreadBinding | null | undefined;
  name: string;
  chats: readonly { id: string; unread_count: number }[];
}): boolean | null {
  const { ownerId, binding, name, chats } = input;
  if (!ownerId || !binding || binding.ownerId !== ownerId || binding.name !== name) return null;
  const source = chats.find(chat => chat.id === binding.chatId);
  if (!source || !Number.isFinite(source.unread_count) || source.unread_count < 0) return null;
  return source.unread_count > 0;
}
