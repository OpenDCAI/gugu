// @@@1315 — pure scroll-control classifier for the chat message window.
//
// The chat list needs one authoritative decision, per message-window change, about how the
// viewport should react — mirroring WeChat/Feishu IM semantics:
//   - at the bottom  → any new message (mine OR received) snaps to the TRUE bottom (no "差一截").
//   - scrolled up    → a received message does NOT yank the viewport; it raises the unread bubble.
// (A load-older prepend needs no decision here: lib/flowList.ts keeps the row being read in place.)
//
// Keeping this as a pure function (no React, no refs) makes the IM semantics unit-testable in isolation,
// independent of the list's imperative scroll calls (which can only be judged on a real device).

export interface FeedTrack {
  /** id of the window's first (oldest) message at the previous render, or null. */
  firstId: string | null
  /** id of the window's last (newest) message at the previous render, or null. */
  lastId: string | null
}

export interface FeedItem {
  id: string
  is_mine?: boolean
}

export interface FeedChange {
  /** True when the viewport should snap to the true bottom (at-bottom new message, or own message). */
  pin: boolean
}

/**
 * Classify how the message window changed between two renders, for scroll control. Pure — same inputs
 * always yield the same decision; no side effects.
 */
export function classifyFeedChange(
  prev: FeedTrack,
  feed: ReadonlyArray<FeedItem>,
  isAtBottom: boolean,
): FeedChange {
  if (feed.length === 0) return { pin: false }

  const lastId = feed[feed.length - 1].id

  // — back-grow (a new newest message): pin, or leave the viewport alone (scrolled up + received: the
  // unread bubble is counted by the history window, which also sees rows cropped out of the window).
  // #1315 fix: previously only `is_mine` pinned — a RECEIVED message while at the bottom fell through
  // to the list's follow-output + 80px threshold and stopped ~80px short ("差一截"). At the bottom,
  // both sent and received now snap to the true bottom.
  const pin = lastId !== prev.lastId && lastId != null && (feed[feed.length - 1]?.is_mine === true || isAtBottom)
  return { pin }
}
