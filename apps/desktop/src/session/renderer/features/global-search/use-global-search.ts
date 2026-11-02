import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useChatSummaries } from '@/lib/chatSummariesBridge'
import { readIdentityDirectoryBridge } from '@/lib/identityDirectoryBridge'
import { chatDb } from '@/lib/supabase'
import { useDebounce } from '@renderer/lib/hooks/useDebounce'
import { rpc } from '@renderer/lib/ipc'
import { excerpt } from '@shared/core/search'
import { rankPaletteMatches } from '../command-palette/palette-rank'
import type { SearchChip } from './search-session'

/** One page per source, shown as "100+" when a source returns a full page. */
export const SEARCH_LIMIT = 100

type MessageRow = { id: string; chat_id: string; sender_user_id: string | null; sender_name: string; content: string | null; created_at: string; file_item_id: string | null }

export type SearchHit =
  | { kind: 'message'; id: string; group: string; chatId: string; messageId: string; senderId: string | null; sender: string; text: string; at: string; file: boolean }
  | { kind: 'task'; id: string; group: string; taskId: string; projectId: string; title: string; itemId: string; role: 'user' | 'assistant'; text: string; at: string }

export interface SearchView {
  query: string
  scopes: SearchChip[]
  completing: boolean
  completionKey: string
  completions: SearchCompletion[]
  hits: SearchHit[]
  capped: boolean
  loading: boolean
  error: Error | null
}

export type SearchCompletion = {
  id: string
  label: string
  description?: string
  icon?: 'chat' | 'task' | 'person'
  chip?: SearchChip
  text: string
}

const PREFIXES = ['in:', 'from:', 'is:task', 'is:chat', 'has:file'] as const

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
export function useGlobalSearch(text: string, chips: readonly SearchChip[], tasks: boolean): SearchView {
  const summaries = useChatSummaries()
  const identities = useIdentities()
  const scopes: SearchChip[] = [...chips]
  let prefix: { key: string; value: string; start: number; end: number } | null = null
  const words: string[] = []
  // The same parser feeds completion and the query. Names become scopes only after explicit selection.
  for (const match of text.matchAll(/\S+/g)) {
    const word = match[0]
    const [, key, value] = /^(in|from|is|has)[:：](.*)$/i.exec(word) ?? []
    if (!prefix && key) prefix = { key: key.toLowerCase(), value: value!, start: match.index, end: match.index + word.length }
    else if (!prefix && PREFIXES.some((item) => item.startsWith(word.toLowerCase()))) {
      prefix = { key: '', value: word.toLowerCase(), start: match.index, end: match.index + word.length }
    } else words.push(word)
  }
  if (!text.trim()) prefix = { key: '', value: '', start: 0, end: 0 }
  const query = useDebounce(words.join(' '), 100)
  const replacePrefix = (replacement: string) => prefix
    ? `${text.slice(0, prefix.start)}${replacement}${text.slice(prefix.end)}`.trim().replace(/\s+/g, ' ') : text
  const titleQuery = useQuery({
    queryKey: ['cmdk-search', prefix?.value ?? ''],
    queryFn: () => rpc.search.commandPalette({ query: prefix?.value ?? '' }),
    enabled: tasks && prefix?.key === 'in',
    staleTime: 5_000,
  })
  const titles = titleQuery.data ?? []
  let completions: SearchCompletion[] = []
  if (prefix?.key === 'in') {
    completions = rankPaletteMatches([
      ...[...summaries].map(([chatId, chat]) => ({ id: `in:${chatId}`, label: chat.alias || chat.name || '', alias: chat.name,
        icon: 'chat' as const, chip: { kind: 'in' as const, chatId }, text: replacePrefix('') })),
      ...titles.filter((item) => item.kind === 'session').map((item) => ({ id: `in-task:${item.id}`, label: item.title, alias: null,
        icon: 'task' as const, chip: { kind: 'in-task' as const, taskId: item.id, title: item.title }, text: replacePrefix('') })),
    ].filter((item) => item.label), prefix.value, (item) => [item.label, item.alias])
  } else if (prefix?.key === 'from') {
    completions = rankPaletteMatches(Object.entries(identities), prefix.value, ([, person]) => [person.display_name])
      .map(([userId, person]) => ({ id: `from:${userId}`, label: person.display_name, icon: 'person',
        chip: { kind: 'from', userId, name: person.display_name }, text: replacePrefix('') }))
  } else if (prefix) {
    const typedPrefix = prefix.key ? `${prefix.key}:${prefix.value.toLowerCase()}` : prefix.value
    completions = PREFIXES.filter((value) => value.startsWith(typedPrefix) && (tasks || value !== 'is:task')).map((value) => ({
      id: value, label: value, description: `globalSearch.prefix.${value.replace(/:$/, '').replace(':', '.')}`,
      chip: value === 'is:task' ? { kind: 'is', value: 'task' } : value === 'is:chat' ? { kind: 'is', value: 'chat' }
        : value === 'has:file' ? { kind: 'has', value: 'file' } : undefined,
      text: replacePrefix(value === 'in:' || value === 'from:' ? value : ''),
    }))
  }
  const inChat = scopes.find((chip) => chip.kind === 'in')
  const inTask = scopes.find((chip) => chip.kind === 'in-task')
  const from = scopes.find((chip) => chip.kind === 'from')
  const kind = scopes.find((chip) => chip.kind === 'is')?.value
  const files = scopes.some((chip) => chip.kind === 'has')
  const searchMessages = !inTask && kind !== 'task'
  const searchTasks = tasks && !inChat && !from && kind !== 'chat' && !files
  const runnable = !!query && !prefix && query === words.join(' ')

  const messages = useQuery({
    queryKey: ['global-search-messages', query, inChat?.chatId ?? null],
    queryFn: async () => {
      const { data, error } = await chatDb.rpc('message_search_as', { p_chat_id: inChat?.chatId ?? null, p_query: query, p_limit: SEARCH_LIMIT })
      if (error) throw new Error(error.message)
      return data as MessageRow[]
    },
    enabled: runnable && searchMessages,
    staleTime: 5_000,
  })
  const turns = useQuery({
    queryKey: ['global-search-task-turns', query],
    queryFn: () => rpc.search.taskTurns({ query, limit: SEARCH_LIMIT }),
    enabled: runnable && searchTasks,
    staleTime: 5_000,
  })

  const messageHits: SearchHit[] = !searchMessages ? [] : (messages.data ?? [])
    .filter((row) => (!from || row.sender_user_id === from.userId) && (!files || row.file_item_id !== null))
    .map((row) => ({ kind: 'message', id: `m:${row.id}`, group: row.chat_id, chatId: row.chat_id, messageId: row.id, senderId: row.sender_user_id,
      sender: row.sender_name, text: excerpt(row.content ?? '', query), at: row.created_at, file: row.file_item_id !== null }))
  const taskHits: SearchHit[] = !searchTasks ? [] : (turns.data ?? [])
    .filter((hit) => !inTask || hit.sessionId === inTask.taskId)
    .map((hit) => ({ kind: 'task', id: `t:${hit.sessionId}:${hit.itemId}`, group: `task:${hit.sessionId}`, taskId: hit.sessionId, projectId: hit.projectId,
      title: hit.title, itemId: hit.itemId, role: hit.role, text: hit.excerpt, at: hit.at }))
  const all = [...messageHits, ...taskHits].sort((a, b) => instant(b.at) - instant(a.at))
  return {
    query, scopes, completing: !!prefix, completionKey: prefix?.key ?? '', completions, hits: runnable ? all : [],
    capped: (searchMessages && (messages.data?.length ?? 0) >= SEARCH_LIMIT) || (searchTasks && (turns.data?.length ?? 0) >= SEARCH_LIMIT),
    loading: prefix?.key === 'in' ? titleQuery.isFetching : !prefix && !!words.length
      && (query !== words.join(' ') || (searchMessages && messages.isFetching) || (searchTasks && turns.isFetching)),
    error: prefix ? (prefix.key === 'in' ? titleQuery.error as Error | null : null)
      : (searchMessages ? messages.error as Error | null : null) ?? (searchTasks ? turns.error as Error | null : null),
  }
}
