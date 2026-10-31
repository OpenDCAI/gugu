// @@@1315 — pure scroll-control classifier for the chat message window.
//
// The chat list needs one authoritative decision, per message-window change, about how the
// viewport should react — mirroring WeChat/Feishu IM semantics:
//   - at the bottom  → any new message (mine OR received) snaps to the TRUE bottom (no "差一截").
//   - scrolled up    → arriving rows leave the viewport in place, regardless of sender.
// Local sends use the history window's explicit latest navigation.
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
  /** True when a new tail row arrives while this viewport is at the bottom. */
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

  const pin = lastId !== prev.lastId && lastId != null && isAtBottom
  return { pin }
}
