import { action, makeObservable, observable } from 'mobx';
import type { CSSProperties } from 'react';
import type { SessionParams } from './recent-session-pages';

/**
 * A session shown beside an App (`gugu.showSession(id, { peek: true })`): its own retained session page — the same page,
 * conversation and composer as on its row's click — drawn over the box the peek holds for it, instead of a block of the
 * screen, wherever that box is (an App's full page, a chat's side panel, a session's tab). Fixed, so it is drawn where the
 * box is even while the session frame around it is hidden (the chat tabs), as the App pages' layer is.
 */
class SessionPeek {
  current: (SessionParams & { box: HTMLElement }) | null = null;

  constructor() {
    makeObservable(this, { current: observable.ref, open: action, close: action });
  }

  open(session: SessionParams & { box: HTMLElement }): void {
    this.current = session;
  }

  close(sessionId?: string): void {
    if (!sessionId || this.current?.sessionId === sessionId) this.current = null;
  }
}

export const sessionPeek = new SessionPeek();

export const PEEKED_PAGE_STYLE: CSSProperties = {
  position: 'fixed',
  // The session frame is hidden on the chat tabs; this page is shown, so it says so for itself.
  visibility: 'visible',
  pointerEvents: 'auto',
  zIndex: 40,
};

/**
 * @@@follow-the-box - the page is laid over the peek's box by measuring it, as the App pages' layer lays a page over its
 * slot, and again whenever the box or anything above it changes size. Not CSS anchoring: a fixed element only takes an
 * anchor whose containing blocks come before it in the DOM, and the peek's box (in the App's slot, rendered after the
 * retained session pages) does not — the page fell to 0,0 (mac1 10-19; a probe box fixed at the top of <body> did anchor).
 * Placed by the box's viewport rect, then corrected by where it actually landed, so a transformed ancestor cannot skew it.
 */
export function followBox(page: HTMLElement, box: HTMLElement): () => void {
  const place = () => {
    const want = box.getBoundingClientRect();
    const set = (left: number, top: number) => Object.assign(page.style, { left: `${left}px`, top: `${top}px`, width: `${want.width}px`, height: `${want.height}px` });
    set(want.left, want.top);
    const got = page.getBoundingClientRect();
    if (got.left !== want.left || got.top !== want.top) set(2 * want.left - got.left, 2 * want.top - got.top);
  };
  place();
  const observer = new ResizeObserver(place);
  for (let node: HTMLElement | null = box; node; node = node.parentElement) observer.observe(node);
  window.addEventListener('resize', place);
  return () => {
    observer.disconnect();
    window.removeEventListener('resize', place);
    // Its place back to the style it goes to (a block's anchors, or hidden in its own box): that style sets the edges.
    Object.assign(page.style, { width: '', height: '' });
  };
}
