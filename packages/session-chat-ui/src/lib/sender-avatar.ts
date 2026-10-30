/**
 * A delivery sender's avatar (#6306). The host resolves it from the same identity cache and the same
 * projection as its own chat (uploaded image, else the generated face for that identity), so a
 * person looks the same on both pages. This package only draws the URL it is given; `null` means
 * draw no avatar — the sender has no identity, or the host doesn't know them yet (the host re-reads
 * and fills the slot once, through its change source).
 */
import { createContext, useContext } from 'solid-js';

const SenderAvatarContext = createContext<(fromId: string | null) => string | null>(() => null);
const SenderNameContext = createContext<(fromId: string | null) => string | null>(() => null);

export const SenderAvatarProvider = SenderAvatarContext.Provider;
export const SenderNameProvider = SenderNameContext.Provider;
export const useSenderName = () => useContext(SenderNameContext);

/** Reactive accessor; returns `null` when the host declared no resolver. */
export function useSenderAvatar(): (fromId: string | null) => string | null {
  return useContext(SenderAvatarContext);
}
