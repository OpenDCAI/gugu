// @@@msg-cache (#621/P2/#947/#1926) - the single shared decision for how to reconcile a chat's message
// window against the server on (re)open, given a cursor (highest cached mainline seq) and the expected
// tail. Used by BOTH the L2 cold-start path and the in-memory reopen path in chat.tsx.
//
// @@@1926 result-side degrade (was: gap prediction). expectedTailSeq = chat.next_message_seq - 1 counts
// EVERY message including thread replies (assign_message_seq is monotonic across the whole chat), while
// maxSeq comes from the mainline-only cache (getMessages filters thread_root_id IS NULL). Subtracting the
// two mixes units: a burst of thread replies inflates a FALSE gap. The old code predicted "gap > one page
// → degrade (drop cache + full initialLoad)" from that mismatched difference, so a thread-heavy chat lost
// its cache and full-reloaded on every reopen despite a complete mainline window (#1926 — the open-chat
// dual of #1888 heal, fixed there by the same "don't predict, re-verify" principle).
//
// So we no longer predict degrade from the seq difference. When there's a cache and anything might be
// ahead, we issue a bounded loadNewer(since cursor) and let the RESULT decide (deltaResultRequiresDegrade):
// a FULL page is server evidence the real mainline gap may exceed one page → the delta can't guarantee
// cursor→tail coverage → degrade; a short/empty page reached the tail → merge the delta, keep the cache.
// The no-silent-loss guarantee (#621 ⑥/⑦) is preserved — it just moves from a predicted gap size to the
// observed page fill.

export type ColdStartPlan =
  // No usable cache → establish a fresh tail window.
  | { kind: 'initialLoad' }
  // Cache already holds the tail → paint it + revalidate overlays/mutations; ZERO message-body fetch.
  | { kind: 'paintRevalidateOnly' }
  // Something may be ahead → paint cache + a single bounded loadNewer(seq > sinceSeq); the caller degrades
  // result-side (deltaResultRequiresDegrade) if that page comes back full.
  | { kind: 'paintLoadNewerDelta'; sinceSeq: number }

export interface ColdStartInput {
  // a non-empty L1 or L2 window is available to paint from.
  hasCache: boolean
  // cursor: highest real (seq >= 0) MAINLINE seq already cached (0 when none).
  maxSeq: number
  // latest seq that should exist anywhere in the chat = chat.next_message_seq - 1 (counts thread replies).
  expectedTailSeq: number
  // @@@2160 — an INDEPENDENT "something is unread" signal: chat-row unread_count > 0. It is derived from the
  // read watermark (last_read_seq vs server messages via count_unread_per_chat), NOT from next_message_seq,
  // so it stays true even when next_message_seq is momentarily stale. It's the second channel that catches a
  // just-inserted message the seq math missed (see decideColdStartFetch).
  hasPositiveUnread: boolean
}

export function decideColdStartFetch({ hasCache, maxSeq, expectedTailSeq, hasPositiveUnread }: ColdStartInput): ColdStartPlan {
  // Nothing to paint from → must establish a fresh tail window via initialLoad.
  if (!hasCache) return { kind: 'initialLoad' }
  // expectedTailSeq is the GLOBAL max seq, so expectedTailSeq <= maxSeq ⟺ the newest message anywhere in
  // the chat IS the cached mainline tail ⟺ nothing new (no thread reply is newer either).
  if (expectedTailSeq - maxSeq <= 0) {
    // @@@2160 — but expectedTailSeq is chat.next_message_seq - 1, and that chat-row counter can LAG a
    // just-inserted message (the message row and the chat-row bump arrive on different channels). When it
    // lags, expectedTailSeq looks gap-free while a real newer message exists. unread_count is the independent
    // read-watermark signal that contradicts "nothing new" → we must NOT trust the gap-free read: issue a
    // bounded loadNewer(seq > cursor) to authoritatively re-check the mainline tail. Bounded + result-side
    // degrade keeps cached paint immediate and never full-reloads; a thread-only / already-caught-up false
    // positive just returns an empty delta (harmless). Only a genuinely-read chat (unread 0) trusts gap-free
    // → ZERO body fetch.
    return hasPositiveUnread ? { kind: 'paintLoadNewerDelta', sinceSeq: maxSeq } : { kind: 'paintRevalidateOnly' }
  }
  // Something is ahead (real new mainline messages, OR only thread replies that inflated the difference —
  // we can't tell cheaply). Attempt a bounded delta from the cursor; the caller degrades result-side.
  return { kind: 'paintLoadNewerDelta', sinceSeq: maxSeq }
}

// @@@1926 result-side degrade rule. After a bounded loadNewer(since cursor, ≤ newerPage rows): a FULL page
// (rowCount >= newerPage) means the server had at least a page of new MAINLINE rows beyond the cursor and
// possibly more — the delta can't guarantee it reached the tail, so degrade to a fresh contiguous window.
// A short/empty page means loadNewer exhausted the mainline tail (fewer than a full page remained), so the
// painted cache + this delta already cover cursor→tail with no hole → keep the cache. This is the observed
// signal that replaces the old predicted (expectedTailSeq - maxSeq > newerPage), immune to the thread-reply
// unit mismatch because it counts only real mainline rows the server actually returned.
export function deltaResultRequiresDegrade(deltaRowCount: number, newerPage: number): boolean {
  return deltaRowCount >= newerPage
}
