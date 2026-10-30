import { matchText, normalizeMentionKey } from './textMatch'
import type { SearchRank, SearchReason } from './types'

const matchReasons: SearchReason['code'][] = ['pinyin', 'contains', 'prefix', 'exact']

/** Exact legacy name tiers. Equal tiers retain the caller's existing recent/familiarity order. */
export function rankEntity(texts: readonly (string | null | undefined)[], query: string): SearchRank {
  const score = Math.max(0, ...texts.map((text) => matchText(text, query)?.score ?? 0))
  return { score, reasons: score ? [{ code: matchReasons[score - 1], points: score }] : [] }
}

export function rankEntityMatches<T>(
  items: readonly T[], query: string,
  texts: (item: T) => readonly (string | null | undefined)[],
  { recallOnly = false } = {},
): T[] {
  if (!normalizeMentionKey(query)) return [...items]
  return items
    .map((item, index) => ({ item, index, score: rankEntity(texts(item), query).score }))
    .filter((row) => recallOnly || row.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((row) => row.item)
}

export interface SearchMessageRankFeatures {
  phraseHit: boolean
  allTermsHit: boolean
  /** Caller-normalized text relevance and affinities, each in [0, 1]. */
  textRelevance: number
  chatAffinity: number
  senderAffinity: number
  createdAt: string | null
  mentionsActor: boolean
  fromActor: boolean
  isAgent: boolean
  isThreadReply: boolean
}

export function rankMessage(
  features: SearchMessageRankFeatures,
  context: { now: number; sort: 'recent' | 'relevant' },
): SearchRank {
  const at = features.createdAt === null ? null : Date.parse(features.createdAt)
  if ((at !== null && !Number.isFinite(at)) || !Number.isFinite(context.now)) throw new Error('Search rank timestamp is invalid')
  for (const value of [features.textRelevance, features.chatAffinity, features.senderAffinity]) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('Search rank feature must be between zero and one')
  }
  const reasons: SearchReason[] = []
  const add = (code: SearchReason['code'], points: number) => { if (points) reasons.push({ code, points }) }
  add('phrase', features.phraseHit ? 40 : 0)
  add('terms', features.allTermsHit ? 20 : 0)
  add('text-relevance', 10 * features.textRelevance)
  add('recent', at === null ? 0 : 30 * 2 ** (-Math.max(0, context.now - at) / (14 * 86_400_000)))
  add('mention', features.mentionsActor ? 25 : 0)
  add('from-self', features.fromActor ? 10 : 0)
  add('chat-affinity', 12 * features.chatAffinity)
  add('sender-affinity', 6 * features.senderAffinity)
  add('agent', context.sort === 'relevant' && features.isAgent ? -15 : 0)
  add('thread', features.isThreadReply ? -10 : 0)
  return { score: reasons.reduce((sum, reason) => sum + reason.points, 0), reasons }
}
