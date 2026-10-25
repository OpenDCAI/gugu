import { observer } from 'mobx-react-lite'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { chatDisplayName } from '@gugu/core/shared/ui/chatModels'
import { INSTALL_CONSENT_HUMAN_WINDOW_MS } from '@/session/shared/extensions/host-actions'
import type { DispatchPicked } from '@/session/shared/extensions/app-dispatch-core'
import { localHomeSessions } from '@/session/renderer/features/assistant/assistant-home-sessions'
import { getProjectStore } from '@/session/renderer/features/projects/stores/project-selectors'
import { useChatStore } from '../../store/chatContext'
import { chatPickRow, forwardableChats } from './forwardMessageUtils'
import { ChatPickSheet, type ChatPickRow, type ChatPickSection } from './ChatPickSheet'
import { takeDispatchAsks, type DispatchAsked } from './dispatchAsk'

const NEW_AGENT = 'new:agent'

/**
 * Whom an App hands something to (`gugu.dispatch` naming no target), drawn by the shell over whatever is on screen
 * (ExtensionConsentSheet), so the view does not change for it. Above the rows: what will go — the text, which the person may
 * change (it goes as theirs), and each pill — and, for a member of a chat, whether the chat sees it. The rows are the
 * host's own: the page's chat's agents and people, this computer's tasks (the page's own first), a new agent, chats (a draft).
 * Nothing goes before the press; the App hears only what was picked.
 */
export const DispatchSheet = observer(function DispatchSheet() {
  const { t } = useTranslation('messaging')
  const { chats, identitiesById } = useChatStore('chats', 'identitiesById')
  const [asked, setAsked] = useState<DispatchAsked | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [query, setQuery] = useState('')
  const [text, setText] = useState('')
  const [visible, setVisible] = useState(false)
  const open = useRef<DispatchAsked | null>(null)

  // Answered once: by the person, by running out, or by the next ask taking the sheet.
  const finish = useCallback((picked: DispatchPicked) => {
    open.current?.answer(picked)
    open.current = null
    setAsked(null)
  }, [])
  useEffect(() => takeDispatchAsks((next) => {
    open.current?.answer(null)
    open.current = next
    setAsked(next)
    setSelected(new Set(next.offers.includes('my-agent') && next.current ? [`session:${next.current}`] : []))
    setQuery('')
    setText(next.text)
    setVisible(next.visible)
  }), [])
  const tasks = asked?.offers.includes('my-agent') === true
  useEffect(() => (tasks ? localHomeSessions.use() : undefined), [tasks])
  // It waits on a person, as an install's consent does; main's clock (ipc-bridge) is the longer one.
  useEffect(() => {
    if (!asked) return
    const timer = setTimeout(() => finish(null), INSTALL_CONSENT_HUMAN_WINDOW_MS)
    return () => clearTimeout(timer)
  }, [asked, finish])

  if (!asked) return null
  const needle = query.trim().toLocaleLowerCase()
  const found = (name: string) => !needle || name.toLocaleLowerCase().includes(needle)
  const offers = new Set(asked.offers)
  const members = (asked.chat?.members ?? []).filter((member) => found(member.name))
  const memberRows = (kind: 'agent' | 'human'): ChatPickRow[] => members
    .filter((member) => member.kind === kind)
    .map((member) => ({
      id: `member:${member.id}`,
      name: member.name,
      avatar: { name: member.name, avatarUrl: member.avatar, seed: member.id, isAgent: member.kind === 'agent' },
    }))
  // This computer's tasks: the page's own first, then its project's, then the latest.
  const currentProject = localHomeSessions.sessions.find((session) => session.conversationId === asked.current)?.projectId
  const rank = (session: (typeof localHomeSessions.sessions)[number]) =>
    session.conversationId === asked.current ? 0 : session.projectId === currentProject ? 1 : 2
  const taskRows = !tasks ? [] : localHomeSessions.sessions
    .filter((session) => session.supported && found(session.title))
    .sort((a, b) => rank(a) - rank(b) || (b.lastInteractedAt ?? '').localeCompare(a.lastInteractedAt ?? ''))
    .map((session): ChatPickRow => ({
      id: `session:${session.conversationId}`,
      name: session.title || session.conversationId,
      avatar: { name: session.title || session.conversationId, seed: session.conversationId, isAgent: true },
      hint: <span className="text-[length:var(--font-caption)] text-[var(--text-tertiary)]">{getProjectStore(session.projectId)?.name ?? session.projectId}</span>,
    }))
  const nameOf = (chat: (typeof chats)[number]) => chatDisplayName(chat, identitiesById[chat.peer_user_id ?? '']?.display_name)
  const chatRows = !offers.has('chat') ? [] : forwardableChats(chats, '', query, nameOf).map((chat) => ({ ...chatPickRow(chat, nameOf(chat), identitiesById), id: `chat:${chat.id}` }))
  const newRows: ChatPickRow[] = offers.has('new-agent') && found(t('dispatchPick.newAgent'))
    ? [{ id: NEW_AGENT, name: t('dispatchPick.newAgent'), avatar: { name: '+', seed: NEW_AGENT, isAgent: true } }]
    : []
  const sections: ChatPickSection[] = [
    { id: 'chat-agents', title: t('dispatchPick.chatAgents', { chat: asked.chat?.name ?? '' }), rows: offers.has('agent-in-chat') ? memberRows('agent') : [] },
    { id: 'chat-people', title: t('dispatchPick.chatPeople', { chat: asked.chat?.name ?? '' }), rows: offers.has('person-in-chat') ? memberRows('human') : [] },
    { id: 'tasks', title: t('composePick.tasks'), rows: taskRows },
    { id: 'new', title: t('dispatchPick.new'), rows: newRows },
    { id: 'chats', title: t('composePick.chats'), rows: chatRows },
  ]
  const [picked] = selected
  const toMember = picked?.startsWith('member:') === true
  const said = text.trim()
  const pickedTarget = (): NonNullable<DispatchPicked>['to'] | null => {
    if (!picked) return null
    if (picked === NEW_AGENT) return { new: true }
    const [kind, id = ''] = picked.split(/:(.*)/)
    if (kind === 'session') return { session: id }
    if (kind === 'member' && asked.chat) return { chat: asked.chat.id, member: id }
    return { chat: id }
  }
  // What will go, as it will read: the text (theirs to change) and each pill under it.
  const preview = (
    <div className="flex flex-col gap-[var(--spacing-xs)]" data-testid="dispatch-preview">
      <textarea
        className="min-h-[64px] w-full resize-y rounded-[var(--radius-control)] border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1 text-[length:var(--font-body)] text-[var(--text-primary)]"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={t('dispatchPick.textPlaceholder')}
        aria-label={t('dispatchPick.text')}
        data-testid="dispatch-text"
      />
      {asked.pills.map((pill, index) => (
        <span key={index} className="truncate text-[length:var(--font-caption)] text-[var(--text-secondary)]" data-testid="dispatch-pill">@{pill}</span>
      ))}
      {!asked.draft && toMember && (
        <label className="flex items-center gap-[var(--spacing-xs)] text-[length:var(--font-caption)] text-[var(--text-secondary)]">
          <input type="checkbox" checked={visible} onChange={(event) => setVisible(event.target.checked)} data-testid="dispatch-visible" />
          {t('dispatchPick.visible')}
        </label>
      )}
    </div>
  )
  return (
    <ChatPickSheet
      title={asked.draft ? t('composePick.title') : t('dispatchPick.title')}
      onClose={() => finish(null)}
      testId="dispatch-sheet"
      rows={[]}
      sections={sections}
      above={preview}
      selected={selected}
      onToggle={(id) => setSelected(new Set([id]))}
      query={query}
      onQuery={setQuery}
      placeholder={t('dispatchPick.search')}
      empty={t('dispatchPick.empty')}
      actionLabel={asked.draft ? t('composePick.action') : t('dispatchPick.send')}
      actionDisabled={!picked || (!said && asked.pills.length === 0)}
      onAction={() => {
        const to = pickedTarget()
        if (to) finish({ to, visible: toMember && visible, text: said })
      }}
      fullScreenMobile
    />
  )
})
