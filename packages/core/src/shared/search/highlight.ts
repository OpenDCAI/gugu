import { parseSearchTerms } from './query'
import { queryTokenGroups, searchTokens } from './segment'
import type { SearchHighlight } from './types'

/** Match on normalized tokens but return ranges into the untouched original string. */
export function highlight(text: string, query: string): SearchHighlight[] {
  const document = searchTokens(text)
  const ranges: SearchHighlight[] = []
  for (const term of parseSearchTerms(query)) {
    if (term.exclude) continue
    for (const group of queryTokenGroups(term.text, term.phrase)) {
      for (let at = 0; at <= document.length - group.tokens.length; at += 1) {
        if (!group.tokens.every((needle, offset) => {
          const token = document[at + offset]
          return token.text === needle.text || (group.prefix && token.text.startsWith(needle.text))
        })) continue
        ranges.push({ start: document[at].start, end: document[at + group.tokens.length - 1].end })
      }
    }
  }
  ranges.sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: SearchHighlight[] = []
  for (const range of ranges) {
    const previous = merged[merged.length - 1]
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end)
    else merged.push({ ...range })
  }
  return merged
}

/** A view excerpt around the first match; the indexed body and its identity stay complete. */
export function searchExcerpt(text: string, highlights: readonly SearchHighlight[], radius = 120): { text: string; highlights: SearchHighlight[] } {
  let start = Math.max(0, (highlights[0]?.start ?? 0) - radius)
  let end = Math.min(text.length, Math.max(start + radius * 2, highlights[0]?.end ?? 0))
  // A UTF-16 excerpt must not split a surrogate pair at either edge.
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start])) start--
  if (end < text.length && /[\uDC00-\uDFFF]/u.test(text[end])) end++
  const prefix = start ? '…' : ''
  return { text: prefix + text.slice(start, end) + (end < text.length ? '…' : ''),
    highlights: highlights.filter(range => range.start < end && range.end > start).map(range => ({
      start: Math.max(start, range.start) - start + prefix.length, end: Math.min(end, range.end) - start + prefix.length,
    })) }
}
