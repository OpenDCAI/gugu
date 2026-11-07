import { z } from 'zod';
import { userIdFromSupabaseAccessToken } from '@gugu/core';
import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase';
import type { AppUnreadBinding, StoredUnreadBinding } from '@shared/extensions/unread-binding';
import { currentAccountAccessToken } from './account-token';
import { extensionsService } from './extensions-root';
import { unreadBindingChatChoices } from './app-files';

const denied = (message: string) => Object.assign(new Error(message), { code: 'denied' });
async function account() {
  const token = await currentAccountAccessToken();
  const ownerId = token ? userIdFromSupabaseAccessToken(token) : null;
  if (!token || !ownerId) throw denied('Not signed in');
  return { token, ownerId };
}
async function current(ownerId: string) {
  if ((await account()).ownerId !== ownerId) throw denied('Account changed');
}
async function member(token: string, ownerId: string, chatId: string) {
  const client = createGuguSupabaseClient({ schema: 'chat', headers: { Authorization: `Bearer ${token}` } });
  const { data, error } = await client.from('active_members').select('chat_id').eq('user_id', ownerId).eq('chat_id', chatId).maybeSingle();
  if (error) throw Object.assign(new Error('Could not verify conversation membership'), { code: 'failed' });
  if (!data) throw denied('This account is not an active member of the conversation');
}

/** The installed page cannot nominate an owner, target chat or permission. */
export async function appUnreadBinding(extensionId: string, input: unknown): Promise<AppUnreadBinding> {
  const { name } = z.strictObject({ name: z.string() }).parse(input);
  const { token, ownerId } = await account();
  const before = extensionsService().conversationUnreadBinding(ownerId, extensionId, name);
  if (!before) return { name, state: 'unbound', actions: ['unread'] };
  await member(token, ownerId, before.chatId);
  await current(ownerId);
  const after = extensionsService().conversationUnreadBinding(ownerId, extensionId, name);
  if (after?.handle !== before.handle) throw denied('Conversation binding changed');
  return { name, state: 'bound', handle: after.handle, actions: ['unread'] };
}

/** Trusted App permissions UI only. This is not an App bridge verb. */
export async function unreadBindingChoices(extensionId: string, name: string) {
  const { ownerId } = await account();
  const authority = extensionsService().conversationUnreadAuthority(ownerId, extensionId, name);
  const selected = extensionsService().conversationUnreadBinding(ownerId, extensionId, name);
  const chats = await unreadBindingChatChoices();
  await current(ownerId);
  if (extensionsService().conversationUnreadAuthority(ownerId, extensionId, name) !== authority) throw denied('App unread authority changed');
  return { ownerId, authority, selected: selected?.chatId ?? null, chats: chats.map(({ id, name: title, kind }) => ({ id, name: title, kind })) };
}

/** Host-only write; expectedOwner binds the person's selection to the account that drew it. */
export async function setUnreadBinding(input: unknown): Promise<void> {
  const args = z.strictObject({ extensionId: z.string(), name: z.string(), ownerId: z.string().uuid(), authority: z.string().uuid(), chatId: z.string().uuid().nullable() }).parse(input);
  const { token, ownerId } = await account();
  if (ownerId !== args.ownerId) throw denied('Account changed');
  const assertAuthority = () => {
    if (extensionsService().conversationUnreadAuthority(ownerId, args.extensionId, args.name) !== args.authority) throw denied('App unread authority changed');
  };
  assertAuthority();
  if (args.chatId !== null) await member(token, ownerId, args.chatId);
  await current(ownerId);
  assertAuthority();
  extensionsService().setConversationUnreadBinding(ownerId, args.extensionId, args.name, args.chatId);
}

/** Host projection reads a validated, current account association, never a page-supplied chat. */
export async function grantedUnreadBindings(expectedOwner: string): Promise<Record<string, StoredUnreadBinding>> {
  const { token, ownerId } = await account();
  if (ownerId !== expectedOwner) throw denied('Account changed');
  const service = extensionsService();
  const result: Record<string, StoredUnreadBinding> = {};
  for (const { manifest } of service.list().extensions) {
    const name = manifest.permissions?.bindings?.[0]?.name;
    if (!name || !service.isEnabled(manifest.id) || !service.hasCapability(manifest.id, 'chat:unread')) continue;
    const binding = service.conversationUnreadBinding(ownerId, manifest.id, name);
    if (!binding) continue;
    await member(token, ownerId, binding.chatId);
    await current(ownerId);
    if (service.conversationUnreadBinding(ownerId, manifest.id, name)?.handle === binding.handle) result[manifest.id] = binding;
  }
  await current(ownerId);
  return result;
}
