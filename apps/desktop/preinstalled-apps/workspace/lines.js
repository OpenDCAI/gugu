// A cited place in a text file (群文件夹 引用 #7238): which lines, as a pill names them (`at`: `{ lines: '12-14', h, n? }`),
// and finding them again once the file has changed. Pure: no page, no gugu.

/** Some lines' fingerprint: FNV-1a (32 bits) of their text as UTF-8, 8 hex digits — a pill's `h`. */
export function fingerprint(text) {
  let h = 0x811c9dc5
  for (const byte of new TextEncoder().encode(text)) h = Math.imul(h ^ byte, 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0')
}

/** Lines `first`–`last` (from 1) of `text`, as one string. */
export const linesText = (text, first, last) => text.split('\n').slice(first - 1, last).join('\n')

/** Where a run of `count` lines with fingerprint `h` starts in `text`, each (from 1). */
function runsOf(text, count, h) {
  const lines = text.split('\n')
  const starts = []
  for (let start = 1; start + count - 1 <= lines.length; start += 1) {
    if (fingerprint(lines.slice(start - 1, start - 1 + count).join('\n')) === h) starts.push(start)
  }
  return starts
}

/** The place a pill names for lines `first`–`last` of `text`; `n`: how many runs read the same, when more than one does. */
export function placeOf(text, first, last) {
  const h = fingerprint(linesText(text, first, last))
  const n = runsOf(text, last - first + 1, h).length
  return { lines: first === last ? `${first}` : `${first}-${last}`, h, ...(n > 1 ? { n } : {}) }
}

/**
 * Picked words as a reader sees them, for a pill's label: one line; a list's, a heading's or a quote's marker, bold and
 * code marks and a link's target dropped — the source's `- **截止日期**：见[排期表](https://…)` reads as the preview's
 * `截止日期：见排期表`. (A lone `*` or `_` stays: `file_name` is a name.)
 */
export function plainWords(text) {
  return text
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, '')
    .replace(/^[ \t]*(?:#{1,6}|>)[ \t]*/gm, '')
    .replace(/\*\*|__|~~|`/g, '')
    .split(/\s+/)
    .join(' ')
    .trim()
}

/** `'12-14'` / `'15'` → [12, 14] / [15, 15]; anything else null. */
export function spanOf(lines) {
  const m = /^(\d+)(?:-(\d+))?$/.exec(String(lines ?? ''))
  const span = m && [Number(m[1]), Number(m[2] ?? m[1])]
  return span && span[0] >= 1 && span[1] >= span[0] ? span : null
}

/**
 * Where a pill's lines are in `text` now: where it said while those lines still read the same; else the run that does,
 * nearest to where it said (`moved`). Null when none does — or when fewer do than the `n` that did (a twin of the lines
 * was cited, and one of the twins changed: which, there is no telling).
 */
export function relocate(text, [first, last], h, n = 1) {
  const runs = runsOf(text, last - first + 1, h)
  if (runs.includes(first)) return { first, last, moved: false }
  if (runs.length === 0 || runs.length < n) return null
  const best = runs.reduce((a, b) => (Math.abs(b - first) < Math.abs(a - first) ? b : a))
  return { first: best, last: best + (last - first), moved: true }
}
