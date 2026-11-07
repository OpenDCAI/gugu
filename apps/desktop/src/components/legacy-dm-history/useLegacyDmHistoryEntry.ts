import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLegacyDmOwner } from './useLegacyDmOwner';

/**
 * Whether a session's menu offers its old chats. Reading takes a walk over the account's chats, so only a menu
 * that was opened asks. A failed read keeps the entry: the dialog says what went wrong and retries.
 */
export function useLegacyDmHistoryEntry(sessionId: string | undefined) {
  const ownerUserId = useLegacyDmOwner();
  const [asked, setAsked] = useState(false);
  const reading = useQuery({
    queryKey: ['legacy-dm-history', ownerUserId, sessionId],
    queryFn: () => import('./data').then(({ hasLegacyDmHistory }) => hasLegacyDmHistory(ownerUserId!, sessionId!)),
    enabled: asked && Boolean(ownerUserId && sessionId),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  return { isAvailable: () => reading.data === true || reading.isError, onMenuOpen: () => setAsked(true) };
}
