/**
 * Who is looking at this transcript (#5048).
 *
 * A delivery card names its sender from the envelope's `from`. For a message the
 * current user sent themselves that fact is frozen at send time — and older
 * envelopes carried no `from` at all, so the owner's own first message read as
 * `user:<uuid>`. The host knows who is signed in, so the card asks it: when
 * `from_id` is the current user's typed id, the local profile names the sender.
 * Anyone else is still named only by what the envelope says — no guessing.
 */
import { createContext, useContext } from 'solid-js';

export type SelfIdentity = {
  /** Canonical `identity.users.id`; compared against the envelope's `from_id` (`user:<id>`). */
  userId: string;
  displayName: string | null;
  guguNumber: number | null;
};

/**
 * The same rendering rule as core's `identityShown` minus the typed-id anchor
 * (the card already shows `from_id` in its details tier):
 * "Name (咕咕号 N)" → "Name" → "咕咕号 N" → null when the profile names nothing.
 */
export function selfIdentityLabel(self: SelfIdentity): string | null {
  const name = self.displayName?.trim() || null;
  const number = self.guguNumber != null ? `咕咕号 ${self.guguNumber}` : null;
  if (name && number) return `${name} (${number})`;
  return name ?? number;
}

export function isSelfAddress(fromId: string | null, self: SelfIdentity | null): boolean {
  return !!self && !!fromId && fromId === `user:${self.userId}`;
}

/**
 * The sender line uses the local profile for the current user's own messages.
 * For other messages, a typed address repeated after a readable name stays in
 * details; an address with no readable name remains visible here.
 */
export function shownSender(from: string | null, fromId: string | null, self: SelfIdentity | null): string | null {
  if (self && isSelfAddress(fromId, self)) {
    const label = selfIdentityLabel(self);
    if (label) return label;
  }
  const repeatedAddress = fromId?.startsWith('user:') ? ` (${fromId})` : null;
  if (from && repeatedAddress && from.endsWith(repeatedAddress)) {
    const label = from.slice(0, -repeatedAddress.length).trim();
    if (label) return label;
  }
  return from ?? fromId;
}

const SelfIdentityContext = createContext<() => SelfIdentity | null>(() => null);

export const SelfIdentityProvider = SelfIdentityContext.Provider;

/** Reactive accessor; `null` when the host declared nobody (standalone page, signed out). */
export function useSelfIdentity(): () => SelfIdentity | null {
  return useContext(SelfIdentityContext);
}
