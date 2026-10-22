import { observer } from 'mobx-react-lite'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { chatDisplayName } from '@gugu/core/shared/ui/chatModels'
import { INSTALL_CONSENT_HUMAN_WINDOW_MS } from '@/session/shared/extensions/host-actions'
import type { ComposePlace } from '@/session/shared/extensions/app-send-core'
import { localHomeSessions } from '@/session/renderer/features/assistant/assistant-home-sessions'
import { getProjectStore } from '@/session/renderer/features/projects/stores/project-selectors'
import { useChatStore } from '../../store/chatContext'
import { chatPickRow, forwardableChats } from './forwardMessageUtils'
import { ChatPickSheet, type ChatPickRow, type ChatPickSection } from './ChatPickSheet'
import { takeComposeAsks, type ComposeAsked } from './composeTargetAsk'

/** The sheet itself, drawn by the shell over whatever is on screen (ExtensionConsentSheet), so the view does not change for it. */
export const ComposeTargetPicker = observer(function ComposeTargetPicker() {
  const { t } = useTranslation('messaging')
  const { chats, identitiesById } = useChatStore('chats', 'identitiesById')
  const [asked, setAsked] = useState<ComposeAsked | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [query, setQuery] = useState('')
  const open = useRef<ComposeAsked | null>(null)

  // Answered once: by the person, by running out, or by the next ask taking the sheet.
  const finish = useCallback((place: ComposePlace | null) => {
    open.current?.answer(place)
    open.current = null
    setAsked(null)
  }, [])
  useEffect(() => takeComposeAsks((next) => {
    open.current?.answer(null)
    open.current = next
    setAsked(next)
    setSelected(new Set(next.tasks && next.current ? [`session:${next.current}`] : []))
    setQuery('')
  }), [])
  const tasks = asked?.tasks === true
  useEffect(() => (tasks ? localHomeSessions.use() : undefined), [tasks])
  // It waits on a person, as an install's consent does; main's clock (ipc-bridge) is the longer one.
  useEffect(() => {
    if (!asked) return
    const timer = setTimeout(() => finish(null), INSTALL_CONSENT_HUMAN_WINDOW_MS)
    return () => clearTimeout(timer)
  }, [asked, finish])

  if (!asked) return null
  const needle = query.trim().toLocaleLowerCase()
  const nameOf = (chat: (typeof chats)[number]) => chatDisplayName(chat, identitiesById[chat.peer_user_id ?? '']?.display_name)
  const chatRows = forwardableChats(chats, '', query, nameOf).map((chat) => ({ ...chatPickRow(chat, nameOf(chat), identitiesById), id: `chat:${chat.id}` }))
  // This computer's tasks only: a compose names a session here (`composeTarget`). The page's own first, then its project's.
  const currentProject = localHomeSessions.sessions.find((session) => session.conversationId === asked.current)?.projectId
  const rank = (session: (typeof localHomeSessions.sessions)[number]) =>
    session.conversationId === asked.current ? 0 : session.projectId === currentProject ? 1 : 2
  const taskRows = !tasks ? [] : localHomeSessions.sessions
    .filter((session) => session.supported && (!needle || session.title.toLocaleLowerCase().includes(needle)))
    .sort((a, b) => rank(a) - rank(b) || (b.lastInteractedAt ?? '').localeCompare(a.lastInteractedAt ?? ''))
    .map((session): ChatPickRow => ({
      id: `session:${session.conversationId}`,
      name: session.title || session.conversationId,
      avatar: { name: session.title || session.conversationId, seed: session.conversationId, isAgent: true },
      hint: <span className="gg-list-row-meta">{getProjectStore(session.projectId)?.name ?? session.projectId}</span>,
    }))
  const taskSection: ChatPickSection = { id: 'tasks', title: t('composePick.tasks'), rows: taskRows }
  const chatSection: ChatPickSection = { id: 'chats', title: t('composePick.chats'), rows: chatRows }
  const [picked] = selected
  return (
    <ChatPickSheet
      title={t('composePick.title')}
      onClose={() => finish(null)}
      testId="compose-target-picker"
      rows={[]}
      sections={asked.current ? [taskSection, chatSection] : [chatSection, taskSection]}
      selected={selected}
      onToggle={(id) => setSelected(new Set([id]))}
      query={query}
      onQuery={setQuery}
      placeholder={t('composePick.search')}
      empty={t('composePick.empty')}
      picked={t('forward.selected', { count: selected.size })}
      actionLabel={t('composePick.action')}
      actionDisabled={!picked}
      onAction={() => {
        if (!picked) return
        const [kind, id = ''] = picked.split(/:(.*)/)
        finish(kind === 'session' ? { session: id } : { chat: id })
      }}
      fullScreenMobile
    />
  )
})
