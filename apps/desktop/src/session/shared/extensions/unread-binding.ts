import { z } from 'zod';

/** Only unread is supported. A stored target is host data and never part of the App's answer. */
export const storedUnreadBindingSchema = z.strictObject({
  ownerId: z.string().uuid(),
  name: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
  chatId: z.string().uuid(),
  handle: z.string().uuid(),
});
export type StoredUnreadBinding = z.infer<typeof storedUnreadBindingSchema>;
export type AppUnreadBinding = { name: string; state: 'unbound'; actions: readonly ['unread'] }
  | { name: string; state: 'bound'; handle: string; actions: readonly ['unread'] };

export function unreadBindingKey(ownerId: string, appIdentity: string): string {
  return `${z.string().uuid().parse(ownerId)}/${appIdentity}`;
}

export function readUnreadBindings(value: unknown): Record<string, StoredUnreadBinding> {
  const parsed = z.record(z.string(), storedUnreadBindingSchema).parse(value);
  for (const [key, binding] of Object.entries(parsed)) {
    if (!key.startsWith(`${binding.ownerId}/`) || key.split('/').length !== 3) throw new Error('Invalid unread binding identity');
  }
  return Object.assign(Object.create(null) as Record<string, StoredUnreadBinding>, parsed);
}
