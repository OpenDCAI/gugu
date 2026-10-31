import { messageForUser } from '@/lib/userFacingError';
import { useCallback, useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useTopicsOfChat } from '../../hooks/useTopics'
import { useChatStore } from '../../store/chatContext'
import { Button } from '../ui/Button'
import { AgentFloodThresholdSetting } from './AgentFloodThresholdSetting'

function useChatChangedSubscription() {
  const { subscribeAccountRevision } = useChatStore('subscribeAccountRevision')
  return useCallback((listener: (ids: readonly string[]) => void) => (
    subscribeAccountRevision('chat_changed', (operations) => {
      listener(operations.flatMap(({ payload }) => {
        const id = (payload as { chat_id?: unknown } | null)?.chat_id
        return typeof id === 'string' ? [id] : []
      }))
    })
  ), [subscribeAccountRevision])
}

function GroupThreshold({ chatId }: { chatId: string }) {
  const subscribeChatChanged = useChatChangedSubscription()
  const [revision, setRevision] = useState(0)
  useEffect(() => subscribeChatChanged((ids) => {
    if (ids.includes(chatId)) setRevision((value) => value + 1)
  }), [chatId, subscribeChatChanged])
  return <AgentFloodThresholdSetting chatId={chatId} inherits={false} revision={revision} />
}

function TopicThresholds({ chatId }: { chatId: string }) {
  const { t } = useTranslation('messaging')
  const subscribeChatChanged = useChatChangedSubscription()
  const selectId = useId()
  const [selectedId, setSelectedId] = useState('')
  const [revision, setRevision] = useState(0)
  const { topics, loading, error, reload } = useTopicsOfChat(chatId, subscribeChatChanged)
  const selected = topics.find((topic) => topic.chat_id === selectedId) ?? topics[0]
  useEffect(() => subscribeChatChanged((ids) => {
    if (ids.includes(chatId) || (selected && ids.includes(selected.chat_id))) setRevision((value) => value + 1)
  }), [chatId, selected, subscribeChatChanged])
  return <>
    {loading ? <p className="text-sm text-[var(--text-tertiary)]">{t('common.loading')}</p> : null}
    {error ? <div role="alert">
      {messageForUser(error)}
      <Button variant="ghost" size="sm" onClick={reload}>{t('common.retry')}</Button>
    </div> : null}
    {selected ? <>
      <label htmlFor={selectId} className="block pt-3 pb-1 text-sm font-medium text-[var(--text-primary)]">{t('group.settings.agentFloodTopics')}</label>
      <select id={selectId} value={selected.chat_id} onChange={(event) => setSelectedId(event.target.value)}
        className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2 py-1 text-sm text-[var(--text-primary)]">
        {topics.map((topic) => <option key={topic.chat_id} value={topic.chat_id}>{topic.name}</option>)}
      </select>
      <AgentFloodThresholdSetting key={selected.chat_id} chatId={selected.chat_id} inherits revision={revision} />
    </> : null}
  </>
}

/** A group's settings carry only the group's own value; its topics follow it. DMs have topics only. */
export function GroupAgentFloodSettings({ chatId, scope = 'topics' }: { chatId: string; scope?: 'group' | 'topics' }) {
  return <section data-testid="group-agent-flood-settings">
    {scope === 'topics' ? <TopicThresholds chatId={chatId} /> : <GroupThreshold chatId={chatId} />}
  </section>
}
