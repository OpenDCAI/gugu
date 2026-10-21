import { createContext, useRef } from 'react';

/** Session pages kept mounted (hidden) after you leave them; the 7th most recent is unmounted. */
export const RETAINED_SESSION_PAGES = 6;
export type SessionParams = { projectId: string; sessionId: string };

/** False inside a retained session page that is not on screen; true everywhere else. */
export const PageShownContext = createContext(true);

/**
 * @@@retained-session-pages — every session page you visited stays mounted, hidden, until it falls out of
 * the six most recent (owner 10-08, same as SpexCode's page pool): switching back only flips which one is
 * visible, so nothing is rebuilt (panes, Monaco, web pages, Review) and each page keeps its own geometry —
 * a terminal's size comes from its own session's layout, never from the session shown before.
 * Hidden the way the chat surface is (lib/retainedSurface.ts): same box, so no hidden page measures a new
 * size; inert, so it takes no focus or keys.
 */
export function useRecentSessions(current: SessionParams | null, onScreen: readonly SessionParams[] = []): SessionParams[] {
  // Kept in the order pages were first opened, never reordered: moving a mounted page in the DOM would
  // reload every web page in it. Recency only decides which page leaves.
  const pages = useRef<Array<SessionParams & { usedAt: number }>>([]);
  const clock = useRef(0);
  if (current) {
    const page = pages.current.find((p) => p.sessionId === current.sessionId);
    if (!page || page.usedAt !== clock.current) {
      clock.current += 1;
      if (page) page.usedAt = clock.current;
      else pages.current = [...pages.current, { ...current, usedAt: clock.current }];
    }
  }
  // A page in a block of the screen (spec session-page「一屏几块」) is mounted, and is never the one to leave.
  const kept = new Set(onScreen.map((p) => p.sessionId));
  for (const page of onScreen) {
    if (!pages.current.some((p) => p.sessionId === page.sessionId)) pages.current = [...pages.current, { ...page, usedAt: clock.current }];
  }
  while (pages.current.length > RETAINED_SESSION_PAGES) {
    const leaving = pages.current
      .filter((p) => !kept.has(p.sessionId) && p.sessionId !== current?.sessionId)
      .reduce<(typeof pages.current)[number] | null>((a, b) => (!a || b.usedAt < a.usedAt ? b : a), null);
    if (!leaving) break;
    pages.current = pages.current.filter((p) => p !== leaving);
  }
  return pages.current;
}
