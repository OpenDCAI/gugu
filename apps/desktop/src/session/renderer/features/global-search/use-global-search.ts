import { useQuery } from '@tanstack/react-query'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { useChatSummaries } from '@/lib/chatSummariesBridge'
import { readIdentityDirectoryBridge } from '@/lib/identityDirectoryBridge'
import { chatDb } from '@/lib/supabase'
import { useDebounce } from '@renderer/lib/hooks/useDebounce'
import { rpc } from '@renderer/lib/ipc'
import { excerpt, type TaskTurnHit, type TaskTurnIndexStatus } from '@shared/core/search'
import { parseAttachmentContent } from '@gugu/core/shared/ui/attachmentModels'
import { readSelfIdentityBridge } from '@/lib/selfIdentityBridge'
import { rankPaletteMatches } from '../command-palette/palette-rank'
import type { SearchChip, SearchFacet, SearchKind } from './search-session'

/** One page per source: the counts beside the filters are these rows, shown as "100+" when a source returns a full page. */
export const SEARCH_LIMIT = 100

type MessageRow = { id: string; chat_id: string; sender_user_id: string | null; sender_name: string; content_type: string; content: string | null; created_at: string; file_item_id: string | null }

export type SearchHit =
  | { kind: 'message'; id: string; group: string; chatId: string; messageId: string; senderId: string | null; sender: string | null; text: string; at: string; file: boolean }
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
  /** With an in: chip: how many hits the same words have in every other conversation (null: not counted yet). */
  elsewhere: { count: number; capped: boolean } | null
  loading: boolean
  error: Error | null
  taskIndex?: TaskTurnIndexStatus
}

/** Which quick-filter kinds a message is: a picture or video, any other file, a link, or one that @-mentions `me`. */
export function messageKinds(row: Pick<MessageRow, 'content_type' | 'content' | 'file_item_id'>, me: string | null): Set<SearchKind> {
  const kinds = new Set<SearchKind>()
  const content = row.content ?? ''
  if (row.content_type === 'attachment' || row.file_item_id !== null) {
    const attachment = parseAttachmentContent(content)
    kinds.add(attachment?.kind === 'image' || /\.(mp4|mov|m4v|webm|mkv)$/i.test(attachment?.fileName ?? '') ? 'media' : 'file')
  } else if (/https?:\/\/\S/i.test(content)) kinds.add('link')
  if (me && content.includes(`user:${me}`)) kinds.add('mention')
  return kinds
}

/** The first main-timeline message (not a system notice, as search leaves them out) of `chatId` sent on or after the local day `day` (YYYY-MM-DD); null when none. */
export async function firstMessageOn(chatId: string, day: string): Promise<string | null> {
  const from = new Date(`${day}T00:00:00`)
  if (Number.isNaN(from.getTime())) throw new Error(`Not a date: ${day}`)
  const { data, error } = await chatDb.from('messages_view').select('id').eq('chat_id', chatId).is('deleted_at', null).is('thread_root_id', null)
    .neq('content_type', 'system').gte('created_at', from.toISOString()).order('seq', { ascending: true }).limit(1)
  if (error) throw new Error(error.message)
  return (data as { id: string }[] | null)?.[0]?.id ?? null
}

/** Milliseconds of a hit's time: cloud messages are ISO; local task turns are SQLite CURRENT_TIMESTAMP (UTC, no zone). */
export const instant = (at: string) => Date.parse(/[TZ+]/.test(at.slice(10)) ? at : `${at.replace(' ', 'T')}Z`)

/** Who is signed in, as the task workspace learns it (the same bridge its chats read): for the @me filter. */
function useSelfId(): string | null {
  const bridge = readSelfIdentityBridge()
  return useSyncExternalStore((listener) => bridge?.subscribe(listener) ?? (() => {}), () => bridge?.getSnapshot()?.userId ?? null)
}

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
  const me = useSelfId()
  const typed = useDebounce(text, 100)

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
  const kinds = scopes.flatMap((chip) => chip.kind === 'type' ? [chip.type] : [])
  // A quick filter (a sender or a kind of message) is a search on its own: no words means every message, newest first.
  const runnable = (!!query || !!from || kinds.length > 0) && !unresolved

  const searchChats = (chatId: string | null) => ({
    queryKey: ['global-search-messages', query, chatId],
    queryFn: async () => {
      const { data, error } = await chatDb.rpc('message_search_as', { p_chat_id: chatId, p_query: query, p_limit: SEARCH_LIMIT })
      if (error) throw new Error(error.message)
      return data as MessageRow[]
    },
    staleTime: 5_000,
  })
  const messages = useQuery({ ...searchChats(inChat?.chatId ?? null), enabled: runnable && !inTask })
  // The same words everywhere, for the line that says how many more the in: chip is hiding (the unscoped search).
  const everywhere = useQuery({ ...searchChats(null), enabled: runnable && !!query && !!inChat })
  const shownRow = (row: MessageRow) => row.content_type !== 'system' && (!from || row.sender_user_id === from.userId)
    && (kinds.length === 0 || kinds.every((kind) => messageKinds(row, me).has(kind)))
  const turns = useQuery({
    queryKey: ['global-search-task-turns', query],
    queryFn: async (): Promise<{ hits: TaskTurnHit[]; index: TaskTurnIndexStatus }> => {
      const [index, hits] = await Promise.all([
        rpc.search.taskTurnIndexStatus(),
        rpc.search.taskTurns({ query, limit: SEARCH_LIMIT }),
      ])
      return { index, hits }
    },
    enabled: runnable && !!query && tasks && !inChat && !from && kinds.length === 0,
    staleTime: 5_000,
    refetchInterval: (q) => q.state.data?.index.state === 'preparing' ? 2_000 : false,
  })

  const messageHits: SearchHit[] = inTask ? [] : (messages.data ?? [])
    .filter(shownRow)
    .map((row) => ({ kind: 'message', id: `m:${row.id}`, group: row.chat_id, chatId: row.chat_id, messageId: row.id, senderId: row.sender_user_id,
      sender: row.sender_user_id === null ? null : row.sender_name, text: excerpt(parseAttachmentContent(row.content)?.fileName ?? row.content ?? '', query), at: row.created_at, file: row.file_item_id !== null }))
  const taskHits: SearchHit[] = !tasks || inChat || from || kinds.length > 0 || !query ? [] : (turns.data?.hits ?? [])
    .filter((hit) => !inTask || hit.sessionId === inTask.taskId)
    .map((hit) => ({ kind: 'task', id: `t:${hit.sessionId}:${hit.itemId}`, group: `task:${hit.sessionId}`, taskId: hit.sessionId, projectId: hit.projectId,
      title: hit.title, itemId: hit.itemId, role: hit.role, text: hit.excerpt, at: hit.at }))
  // `instant` 是正则 + Date.parse:放进比较器里等于每次排序都付 O(n log n) 遍解析的费用。
  const all = [...messageHits, ...taskHits]
    .map((hit) => ({ hit, at: instant(hit.at) }))
    .sort((a, b) => b.at - a.at)
    .map((entry) => entry.hit)
  const counts: Record<SearchFacet, number> = {
    all: all.length,
    message: messageHits.length,
    task: taskHits.length,
    file: messageHits.filter((hit) => hit.kind === 'message' && hit.file).length,
  }
  const shown = facet === 'all' ? all : all.filter((hit) => facet === 'task' ? hit.kind === 'task' : hit.kind === 'message' && (facet === 'message' || hit.file))
  return {
    query, scopes, unresolved, hits: runnable ? shown : [], counts: runnable ? counts : { all: 0, message: 0, task: 0, file: 0 },
    capped: (messages.data?.length ?? 0) >= SEARCH_LIMIT || (turns.data?.hits.length ?? 0) >= SEARCH_LIMIT,
    elsewhere: runnable && query && inChat && everywhere.data ? {
      count: everywhere.data.filter((row) => row.chat_id !== inChat.chatId && shownRow(row)).length,
      capped: everywhere.data.length >= SEARCH_LIMIT,
    } : null,
    loading: runnable && (messages.isFetching || turns.isFetching || text !== typed),
    error: (messages.error as Error | null) ?? (everywhere.error as Error | null) ?? (turns.error as Error | null),
    taskIndex: runnable && query && tasks && !inChat && !from && kinds.length === 0 ? turns.data?.index : undefined,
  }
}
