import { GUGU_QR_PAYLOAD_QUERY_PARAM } from '@gugu/core/shared/qrPayload'
import type { QrScanRoute } from './qrScanRoute'
import { resolveQrScanRoute } from './qrScanRoute'

export interface GuguLinkMatch { raw: string; start: number; end: number; route: QrScanRoute }
export type GuguLinkSegment = ({ kind: 'link' } & GuguLinkMatch) | { kind: 'text'; text: string; start: number; end: number }
function candidateEnd(text: string, start: number): number {
  let end = start
  while (end < text.length && !/\s|[<>"']/.test(text[end] ?? '')) end += 1
  return end
}
function hasHttpPayloadCarrier(candidate: string): boolean {
  try {
    const url = new URL(candidate)
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.searchParams.has(GUGU_QR_PAYLOAD_QUERY_PARAM)
  } catch {
    return false
  }
}
function longestValidLink(text: string, start: number, end: number): GuguLinkMatch | null {
  for (let candidateEndIndex = end; candidateEndIndex > start + 'http://'.length; candidateEndIndex -= 1) {
    const raw = text.slice(start, candidateEndIndex)
    if (!hasHttpPayloadCarrier(raw)) continue
    const route = resolveQrScanRoute(raw)
    if (route) return { raw, start, end: candidateEndIndex, route }
  }
  return null
}
export function scanGuguLinks(text: string): GuguLinkMatch[] {
  if (!text) return []
  const matches: GuguLinkMatch[] = []
  let cursor = 0
  for (const candidate of text.matchAll(/https?:\/\//giu)) {
    const start = candidate.index
    if (start === undefined) continue
    if (start < cursor) continue
    const end = candidateEnd(text, start)
    if (!hasHttpPayloadCarrier(text.slice(start, end))) continue
    const match = longestValidLink(text, start, end)
    if (match) {
      matches.push(match)
      cursor = match.end
    }
  }
  return matches
}
export function splitGuguLinkSegments(text: string): GuguLinkSegment[] {
  const matches = scanGuguLinks(text)
  if (matches.length === 0) return text ? [{ kind: 'text', text, start: 0, end: text.length }] : []
  const segments: GuguLinkSegment[] = []
  let cursor = 0
  for (const match of matches) {
    if (match.start > cursor) {
      segments.push({ kind: 'text', text: text.slice(cursor, match.start), start: cursor, end: match.start })
    }
    segments.push({ kind: 'link', ...match })
    cursor = match.end
  }
  if (cursor < text.length) {
    segments.push({ kind: 'text', text: text.slice(cursor), start: cursor, end: text.length })
  }
  return segments
}
