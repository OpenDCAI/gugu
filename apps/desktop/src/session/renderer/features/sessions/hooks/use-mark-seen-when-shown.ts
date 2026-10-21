import { useEffect } from 'react';

/**
 * 「看见即已读」: a session's unread / needs-you state is cleared only while it is actually on screen.
 * Retained session pages stay mounted while hidden (@@@retained-session-pages), so being mounted is not
 * being seen — callers pass whether this session is on screen.
 */
export function useMarkSeenWhenShown(
  session: { seen: boolean; markSeen: () => void } | null | undefined,
  shown: boolean
): void {
  const seen = session?.seen;
  useEffect(() => {
    if (shown && session && !session.seen) session.markSeen();
  }, [shown, session, seen]);
}
