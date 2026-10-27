import { useInfiniteQuery } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import type { TopicSummary } from '@gugu/core/shared/types/chat'
import { createAppMessages } from '@/session/shared/extensions/app-messages-core'
import { queryClient } from '@/session/renderer/lib/query-client'
import { getRendererAccessToken } from '@/lib/sessionPublication'
import { messageForUser } from '@/lib/userFacingError'
import { useAuth } from '@/store/auth'
import { Button } from '../ui/Button'

const messages = createAppMessages({ account: async () => {
  const token = getRendererAccessToken()
  if (!token) throw new Error('Not signed in')
  return { token }
} })
const RESULTS_STYLE: CSSProperties = { flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }
const SPLIT_RESULTS_STYLE: CSSProperties = { ...RESULTS_STYLE, flex: '0 1 40%' }
const HIT_STYLE: CSSProperties = { height: 'auto', whiteSpace: 'normal', textAlign: 'left' }

/** The group's existing topic list and message_search_as reader; opening a hit uses the topic's own timeline. */
export function ChatTopicSearchResults({ topics, query, hasMainResults, onOpen }: {
  topics: readonly Pick<TopicSummary, 'chat_id' | 'name'>[]
  query: string
  hasMainResults: boolean
  onOpen: (chatId: string, messageId: string) => void
}) {
  const { t } = useTranslation('messaging')
  const { user } = useAuth()
  const chatIds = topics.map(topic => topic.chat_id).sort()
  const result = useInfiniteQuery({
    queryKey: ['chat-topic-search', user?.id, chatIds, query],
    enabled: !!user && !!query.trim(),
    retry: false,
    initialPageParam: chatIds.map(chat => ({ chat, before: undefined as number | undefined })),
    queryFn: ({ pageParam }) => Promise.all(pageParam.map(scope => messages.search({ ...scope, query }))),
    getNextPageParam: pages => {
      const next = pages.flatMap(page => page.next === null ? [] : [{ chat: page.messages[0]!.chat, before: page.next }])
      return next.length ? next : undefined
    },
  }, queryClient)
  const hits = (result.data?.pages.flatMap(pages => pages.flatMap(page => page.messages)) ?? [])
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
  return <div data-testid="chat-topic-search-results" style={hasMainResults ? SPLIT_RESULTS_STYLE : RESULTS_STYLE}>
    {hits.map(message => <Button key={message.id} variant="ghost" className="w-full flex-col items-start gap-1" style={HIT_STYLE}
      data-search-message={message.id} onClick={() => onOpen(message.chat, message.id)}>
      <span className="text-[length:var(--font-caption)] text-[var(--text-tertiary)]">{topics.find(topic => topic.chat_id === message.chat)?.name}</span>
      <span className="line-clamp-2">{message.text}</span>
    </Button>)}
    {result.isFetching ? <p role="status">{t('common.loading')}</p> : null}
    {result.error ? <p role="alert">{messageForUser(result.error)} <Button variant="ghost" onClick={() => void result.refetch()}>{t('common.retry')}</Button></p>
      : !result.isPending && !hasMainResults && hits.length === 0 ? <p>{t('chatArea.searchNoResults', { query })}</p> : null}
    {result.hasNextPage ? <Button variant="ghost" disabled={result.isFetching} onClick={() => void result.fetchNextPage()}>{t('chatArea.searchMore')}</Button> : null}
  </div>
}
