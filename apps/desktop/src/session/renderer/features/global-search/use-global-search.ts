import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useChatSummaries } from '@/lib/chatSummariesBridge'
import { readIdentityDirectoryBridge } from '@/lib/identityDirectoryBridge'
import { chatDb } from '@/lib/supabase'
import { useDebounce } from '@renderer/lib/hooks/useDebounce'
import { rpc } from '@renderer/lib/ipc'
import { excerpt } from '@shared/core/search'
import { rankPaletteMatches } from '../command-palette/palette-rank'
import type { SearchChip, SearchFacet } from './search-session'

/** One page per source: the counts beside the filters are these rows, shown as "100+" when a source returns a full page. */
export const SEARCH_LIMIT = 100

type MessageRow = { id: string; chat_id: string; sender_user_id: string | null; sender_name: string; content: string | null; created_at: string; file_item_id: string | null }

export type SearchHit =
  | { kind: 'message'; id: string; group: string; chatId: string; messageId: string; senderId: string | null; sender: string; text: string; at: string; file: boolean }
  | { kind: 'task'; id: string; group: string; taskId: string; projectId: string; title: string; itemId: string; role: 'user' | 'assistant'; text: string; at: string }

export interface SearchView {
  /** What is searched for once in: / from: are taken out of the typed text. */
  query: string
  /** The chips plus whatever the typed in: / from: resolved to. */
  scopes: SearchChip[]
  /** A typed in: / from: that matches nothing. */
  unresolved: string | null
  hits: SearchHit[]
  counts: Record<SearchFacet, number>
  capped: boolean
  loading: boolean
  error: Error | null
}

/** Milliseconds of a hit's time: cloud messages are ISO; local task turns are SQLite CURRENT_TIMESTAMP (UTC, no zone). */
export const instant = (at: string) => Date.parse(/[TZ+]/.test(at.slice(10)) ? at : `${at.replace(' ', 'T')}Z`)

function useIdentities() {
  const bridge = readIdentityDirectoryBridge()
  const [snapshot, setSnapshot] = useState(() => bridge?.getSnapshot() ?? null)
  useEffect(() => bridge?.subscribe(() => setSnapshot(bridge.getSnapshot())), [bridge])
  return snapshot ?? {}
}

/**
 * The global search panel's data: chat messages from the cloud (chat.message_search_as, every conversation or one) and
 * what was said in local tasks (search.taskTurns, only where this device has tasks). Both come newest first, so the
 * merged list is newest first too; there is no other order.
 */
export function useGlobalSearch(text: string, chips: readonly SearchChip[], facet: SearchFacet, tasks: boolean): SearchView {
  const summaries = useChatSummaries()
  const identities = useIdentities()
  const typed = useDebounce(text, 150)

  const scopes: SearchChip[] = [...chips]
  let unresolved: string | null = null
  const words: string[] = []
  for (const word of typed.trim().split(/\s+/).filter(Boolean)) {
    const [, key, value] = /^(in|from):(.+)$/i.exec(word) ?? []
    if (key?.toLowerCase() === 'in') {
      const chat = rankPaletteMatches([...summaries], value!, ([, summary]) => [summary.name, summary.alias])[0]
      if (chat) scopes.push({ kind: 'in', chatId: chat[0] })
      else unresolved = word
    } else if (key?.toLowerCase() === 'from') {
      const person = rankPaletteMatches(Object.entries(identities), value!, ([, identity]) => [identity.display_name])[0]
      if (person) scopes.push({ kind: 'from', userId: person[0], name: person[1].display_name })
      else unresolved = word
    } else words.push(word)
  }
  const query = words.join(' ')
  const inChat = scopes.find((chip) => chip.kind === 'in')
  const inTask = scopes.find((chip) => chip.kind === 'in-task')
  const from = scopes.find((chip) => chip.kind === 'from')
  const runnable = !!query && !unresolved

  const messages = useQuery({
    queryKey: ['global-search-messages', query, inChat?.chatId ?? null],
    queryFn: async () => {
      const { data, error } = await chatDb.rpc('message_search_as', { p_chat_id: inChat?.chatId ?? null, p_query: query, p_limit: SEARCH_LIMIT })
      if (error) throw new Error(error.message)
      return data as MessageRow[]
    },
    enabled: runnable && !inTask,
    staleTime: 5_000,
  })
  const turns = useQuery({
    queryKey: ['global-search-task-turns', query],
    queryFn: () => rpc.search.taskTurns({ query, limit: SEARCH_LIMIT }),
    enabled: runnable && tasks && !inChat && !from,
    staleTime: 5_000,
  })

  const messageHits: SearchHit[] = inTask ? [] : (messages.data ?? [])
    .filter((row) => !from || row.sender_user_id === from.userId)
    .map((row) => ({ kind: 'message', id: `m:${row.id}`, group: row.chat_id, chatId: row.chat_id, messageId: row.id, senderId: row.sender_user_id,
      sender: row.sender_name, text: excerpt(row.content ?? '', query), at: row.created_at, file: row.file_item_id !== null }))
  const taskHits: SearchHit[] = !tasks || inChat || from ? [] : (turns.data ?? [])
    .filter((hit) => !inTask || hit.sessionId === inTask.taskId)
    .map((hit) => ({ kind: 'task', id: `t:${hit.sessionId}:${hit.itemId}`, group: `task:${hit.sessionId}`, taskId: hit.sessionId, projectId: hit.projectId,
      title: hit.title, itemId: hit.itemId, role: hit.role, text: hit.excerpt, at: hit.at }))
  const all = [...messageHits, ...taskHits].sort((a, b) => instant(b.at) - instant(a.at))
  const counts: Record<SearchFacet, number> = {
    all: all.length,
    message: messageHits.length,
    task: taskHits.length,
    file: messageHits.filter((hit) => hit.kind === 'message' && hit.file).length,
  }
  const shown = facet === 'all' ? all : all.filter((hit) => facet === 'task' ? hit.kind === 'task' : hit.kind === 'message' && (facet === 'message' || hit.file))
  return {
    query, scopes, unresolved, hits: runnable ? shown : [], counts: runnable ? counts : { all: 0, message: 0, task: 0, file: 0 },
    capped: (messages.data?.length ?? 0) >= SEARCH_LIMIT || (turns.data?.length ?? 0) >= SEARCH_LIMIT,
    loading: runnable && (messages.isFetching || turns.isFetching || text !== typed),
    error: (messages.error as Error | null) ?? (turns.error as Error | null),
  }
}
