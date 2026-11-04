import { useSyncExternalStore } from 'react';
import { getRendererSession, observeRendererSession } from '@/lib/sessionPublication';

const subscribe = (changed: () => void) => observeRendererSession(changed);
const ownerId = () => getRendererSession()?.user.id ?? null;

/** The embedded session page is a separate React root; consume the existing auth publication. */
export function useLegacyDmOwner(): string | null {
  return useSyncExternalStore(subscribe, ownerId, () => null);
}
