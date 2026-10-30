// Global search (globalSearch.v3): the one search state shared by the modal and the in-chat results bar.
// "Results" in the bar reopens the modal on exactly this state; nothing else keeps a copy of a query.
import { useSyncExternalStore } from 'react'
import type { SearchMessageHit, SearchQuery, SearchResults } from '@gugu/core/shared/search/types'
import { followLink } from '@/lib/guguLinks'
import { chatComposerTarget, scheduleComposerFocus } from '@/lib/focusComposer'
import { conversationLink } from '@gugu/core/shared/ui/guguLink'
import { commandRegistry } from '@renderer/lib/commands/registry'
import { rpcOn } from '@renderer/lib/ipc'

export type SearchChip =
  | { kind: 'in'; chatId: string }
  | { kind: 'from'; userId: string }
  | { kind: 'on'; date: string }

export type SearchFacet = 'all' | 'file' | 'image' | 'link'

export interface SearchSession {
  text: string
  chips: SearchChip[]
  facet: SearchFacet
  sort: SearchQuery['sort']
  /** The query the results below answer; the bar and the modal both page through this one result set. */
  query: SearchQuery | null
  /** Loaded pages of results, in order. */
  results: SearchMessageHit[]
  /** How many messages match in all (the facet total), whatever has been loaded so far. */
  total: number
  nextCursor: string | null
  selectedId: string | null
  /** The chat the bar is showing in, after a jump; null = the bar is closed. */
  barChatId: string | null
}

const EMPTY: SearchSession = {
  text: '', chips: [], facet: 'all', sort: 'relevant', query: null, results: [], total: 0, nextCursor: null, selectedId: null, barChatId: null,
}
export const SEARCH_PAGE = 50
/** Set by an entry point that prepared the session; ⌘⇧F on its own opens a fresh one. */
let prepared = false
let focusCleanup: (() => void) | null = null
let session: SearchSession = EMPTY
const listeners = new Set<() => void>()

function set(next: Partial<SearchSession>): void {
  session = { ...session, ...next }
  for (const listener of listeners) listener()
}

export const readSearchSession = () => session
export const updateSearchSession = set
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

/** Whether this message is the result the chat's results bar is on (a boolean, so only its own row re-renders). */
export function useIsSearchCurrent(chatId: string, messageId: string): boolean {
  return useSyncExternalStore(subscribe, () => session.barChatId === chatId && session.selectedId === messageId)
}

export function useSearchSession(): SearchSession {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => session)
}

/** A single chat scope reads newest first; everything else by relevance. */
export const defaultSort = (chips: readonly SearchChip[]): SearchQuery['sort'] =>
  chips.filter((chip) => chip.kind === 'in').length === 1 ? 'recent' : 'relevant'

/** Every entry point: a fresh query, optionally scoped. Reopening the bar's results uses reopenGlobalSearch. */
export function openGlobalSearch(options: { text?: string; chips?: SearchChip[] } = {}): void {
  const chips = options.chips ?? []
  set({ ...EMPTY, text: options.text ?? '', chips, sort: defaultSort(chips) })
  prepared = true
  commandRegistry.dispatch('app.globalSearch')
}

/** A member's messages in one conversation (member profile cards). */
export const findMemberMessages = (chatId: string, userId: string) =>
  openGlobalSearch({ chips: [{ kind: 'in', chatId }, { kind: 'from', userId }] })

export function reopenGlobalSearch(): void {
  set({ barChatId: null })
  prepared = true
  commandRegistry.dispatch('app.globalSearch')
}

/** The app.globalSearch command: keep what an entry point prepared, otherwise start from nothing. */
export function takeGlobalSearchOpen(): void {
  if (!prepared) set(EMPTY)
  prepared = false
}

/** The first page of a new query replaces the result set. */
export function setSearchResults(query: SearchQuery | null, page: SearchResults | null): void {
  set({ query, results: page?.results ?? [], total: page?.facets.total ?? 0, nextCursor: page?.nextCursor ?? null })
}

/** The next page of the same query, for the modal's list and the bar alike. */
export async function loadMoreHits(): Promise<void> {
  const { query, nextCursor } = session
  if (!query || !nextCursor) return
  const page = await rpcOn(null).search.global({ query, cursor: nextCursor, limit: SEARCH_PAGE })
  if (session.query !== query) return
  set({ results: [...session.results, ...page.results], nextCursor: page.nextCursor })
}

/** The existing conversation link opens the chat (or topic) at the message and flashes it. */
export function showHit(hit: SearchMessageHit): void {
  set({ selectedId: hit.id, barChatId: hit.chatId })
  followLink(conversationLink(hit.chatId, hit.id))
  // Entering the chat from search lands in that chat's composer once it has rendered (the shared focus contract),
  // not in the chat that was showing and not on whatever had focus.
  focusCleanup?.()
  focusCleanup = scheduleComposerFocus('chat-entry', { target: chatComposerTarget(hit.chatId) })
}

/** ⌘G / ⇧⌘G: the next or previous result over the whole result set, loading pages as needed, wrapping. */
export async function stepHit(direction: 1 | -1): Promise<void> {
  const at = session.results.findIndex((hit) => hit.id === session.selectedId)
  if (direction === 1 && at === session.results.length - 1 && session.nextCursor) await loadMoreHits()
  const { results, nextCursor } = session
  if (results.length === 0) return
  // Wrapping backwards from the first needs the true last result: only once every page is loaded.
  if (direction === -1 && at <= 0 && nextCursor) return
  showHit(results[(at + direction + results.length) % results.length]!)
}

export const closeSearchBar = () => set({ barChatId: null })
