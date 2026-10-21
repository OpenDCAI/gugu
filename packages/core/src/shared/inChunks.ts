// @@@1666 — PostgREST `.in()` serializes every id into the request URL (`?id=in.(uuid,uuid,…)`), so an
// unbounded id list must be fetched in bounded chunks and merged client-side. Past the budget below the
// gateway answers **502 Bad Gateway**, and because that error page carries no CORS headers the browser
// withholds it — application code only ever sees `TypeError: Failed to fetch`.

// @@@in-filter-budget (#5458; provenance pinned #5394) — the limit is NOT on the request. It is
// nginx's buffer for reading the **upstream response header block** (`proxy_buffer_size`, default
// **4096 B**), and the request URL lands in that block because PostgREST echoes it back in
// **`Content-Location`**. That one mechanism explains every reading:
//
//   · bodies are empty (`[]`, 2 B) at the boundary ⇒ it was never about payload size;
//   · +1024 B of *request* header does not move the boundary, +185 B of URL does ⇒ the URL is the
//     variable because it is echoed into the *response*;
//   · a browser fails ~3 keys earlier than curl ⇒ its `Origin` makes kong add CORS response headers,
//     which eat the same 4096 B.
//   · an anon request survives a 7.6 KB URL (it gets `401`) ⇒ that error response echoes no URL.
//
// MEASURED (2026-09-11, mac1 → shared test DB, real user session, curl, `Content-Length: 2`;
// each boundary reproduced 4–8/8; response header block = status line + all header lines + final CRLF):
//
//   with `Origin`:  k=88 → block **4093 B** → 200   ·  k=89 → 502   (next key would be 4132 > 4096)
//   no `Origin`:    k=91 → block **4059 B** → 200   ·  k=92 → 502   (next key would be 4098 > 4096)
//
// Both flip exactly at **4096 B**. Components, measured and additive (they reconstruct the two blocks
// above to the byte): fixed headers + status line **281 B** · CORS headers **183 B** when `Origin` is
// present (**32 B** without) · `Content-Location` = **197 B** of path+select for `chat_members` plus
// **39 B per key** (a 36-char UUID whose separating comma is percent-encoded to `%2C`).
//
// ⚠️ Two earlier statements in this comment were WRONG and are corrected here: the failure is not "the
// request never left" (there is a 502 status line on the wire — Playwright's `requestfailed` reports
// `net::ERR_FAILED` for both "no response" and "response withheld for missing CORS"; only CDP's
// `corsErrorStatus` separates them), and the budget is not a URL-length budget.
//
// ⚠️ NOT COVERED: `proxy_buffer_size` is nginx's default here, but the gateway config lives on the
// database machine — not in this repo, not in gugu-base (`deploy/db-host/README.md` says so) — so the
// **production** link's value is UNVERIFIED and was not probed. The margin below absorbs that.
// Readings and probes: gugu-base `evidence/2026-09-11-5394-cause-transport-budget/`.

/** nginx `proxy_buffer_size` — the upstream **response header** block must fit in it. Default 4 KiB. */
export const PROXY_RESPONSE_HEADER_BUDGET_BYTES = 4096
/** Status line + the fixed response headers (Server/Date/Content-Type/Length/Range/Profile/Kong/Via). */
const RESPONSE_FIXED_HEADER_BYTES = 281
/** CORS response headers kong adds when the request carries `Origin` — a browser always does. */
const RESPONSE_CORS_HEADER_BYTES = 183
/** `Content-Location`'s non-key part (path + echoed `select`); 197 B for `chat_members`, 320 covers the longest select we send. */
const ECHOED_PATH_AND_SELECT_BYTES = 320
/** Absorbs an unverified production `proxy_buffer_size` and future `select` growth. ≈16 keys. */
const RESPONSE_BUDGET_MARGIN_BYTES = 640
/** One UUID key as echoed back: 36 chars + `%2C`. */
export const ECHOED_KEY_BYTES = 39

/**
 * Max ids per `.in()` filter — **derived** from the response-header budget above, defined ONCE here.
 * Every caller inherits it as `fetchInChunks`' default chunk size; do not re-declare a local number
 * anywhere (two numbers drift, and the one that drifts is only wrong on big accounts).
 */
export const IN_FILTER_CHUNK = Math.floor(
  (PROXY_RESPONSE_HEADER_BUDGET_BYTES
    - RESPONSE_FIXED_HEADER_BYTES
    - RESPONSE_CORS_HEADER_BYTES
    - ECHOED_PATH_AND_SELECT_BYTES
    - RESPONSE_BUDGET_MARGIN_BYTES) / ECHOED_KEY_BYTES,
)

/**
 * Fetch rows for `ids` in chunks of `chunkSize`, concatenated in chunk order.
 * Chunks run in parallel (independent reads on a hot path); a rejected chunk
 * rejects the whole fetch — error semantics stay whatever `fetchChunk` throws.
 */
export async function fetchInChunks<Id, Row>(
  ids: readonly Id[],
  fetchChunk: (chunk: Id[]) => Promise<Row[]>,
  chunkSize: number = IN_FILTER_CHUNK,
): Promise<Row[]> {
  if (ids.length === 0) return []
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error(`fetchInChunks: chunkSize must be a positive integer, got ${chunkSize}`)
  }
  const chunks: Id[][] = []
  for (let i = 0; i < ids.length; i += chunkSize) {
    chunks.push(ids.slice(i, i + chunkSize))
  }
  const results = await Promise.all(chunks.map((chunk) => fetchChunk(chunk)))
  return results.flat()
}

/**
 * Comparator equivalent to PostgREST `.order('<col>', { ascending: false, nullsFirst: false })`
 * for ISO-8601 timestamp columns: newest first, nulls last. Needed because per-chunk DB ordering
 * is meaningless once chunks are merged — callers re-sort the merged rows with this.
 * Same-column timestamps share one serialization format, so lexicographic compare is exact
 * (no ms-precision loss from Date.parse).
 */
export function compareIsoDescNullsLast(a: string | null, b: string | null): number {
  if (a === b) return 0
  if (a == null) return 1
  if (b == null) return -1
  return a < b ? 1 : -1
}
