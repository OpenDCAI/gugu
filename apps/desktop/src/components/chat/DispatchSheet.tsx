import { observer } from 'mobx-react-lite'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { chatDisplayName } from '@gugu/core/shared/ui/chatModels'
import { INSTALL_CONSENT_HUMAN_WINDOW_MS } from '@/session/shared/extensions/host-actions'
import type { DispatchPicked } from '@/session/shared/extensions/app-dispatch-core'
import { RESOURCE_TEMPLATES, type ResourceTemplate } from '@/session/shared/resource-actions'
import { Button } from '../ui/Button'
import { appendToDraft } from '@/store/chatDraftWrites'
import { useChatStore } from '../../store/chatContext'
import { useOwnedAgents } from '../settings/channels/channelAgents'
import { chatPickRow, forwardableChats } from './forwardMessageUtils'
import { ChatPickSheet, type ChatPickRow, type ChatPickSection } from './ChatPickSheet'
import { DispatchMachine } from './DispatchMachine'
import { takeDispatchAsks, type DispatchAsked } from './dispatchAsk'

const NEW_AGENT = 'new:agent'

/**
 * Whom an App hands something to (`gugu.dispatch` naming no target), drawn by the shell over whatever is on screen
 * (ExtensionConsentSheet), so the view does not change for it. Above the rows: what will go — the text, which the person may
 * change (it goes as theirs), and each pill — and, for a member of a chat, whether the chat sees it. The rows are the
 * host's own: the page's chat's agents and people, the person's own agents (the page's own first; for a draft only those
 * with a session here), a new agent, chats (a draft). A forum assignment (`ask.assign`) is the same sheet: the post's title
 * read only, the person's own agents. Nothing goes before the press; the App hears only what was picked.
 */
export const DispatchSheet = observer(function DispatchSheet() {
  const { t } = useTranslation('messaging')
  const { chats, identitiesById } = useChatStore('chats', 'identitiesById')
  const owned = useOwnedAgents()
  const [asked, setAsked] = useState<DispatchAsked | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [query, setQuery] = useState('')
  const [text, setText] = useState('')
  const [visible, setVisible] = useState(false)
  const [spawnDevice, setSpawnDevice] = useState<string | null>(null)
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
    setSelected(new Set(next.offers.includes('my-agent') && next.preselect ? [`agent:${next.preselect}`] : []))
    setQuery('')
    setText(next.text)
    setVisible(next.visible)
    setSpawnDevice(next.spawnOn ?? null)
  }), [])
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
  // The person's own agents: the one preselected first; a draft only into one whose session is here (its composer).
  const local = asked.local ? new Set(asked.local) : null
  const agentRows = !offers.has('my-agent') ? [] : owned
    .map((agent) => ({ ...agent, id: `user:${agent.id.replace(/^user:/, '')}` }))
    .filter((agent) => found(agent.display_name) && (!asked.draft || !local || local.has(agent.id)))
    .sort((a, b) => Number(b.id === asked.preselect) - Number(a.id === asked.preselect))
    .map((agent): ChatPickRow => ({
      id: `agent:${agent.id}`,
      name: agent.display_name,
      avatar: { name: agent.display_name, avatarUrl: agent.avatar, seed: agent.id, isAgent: true },
    }))
  const nameOf = (chat: (typeof chats)[number]) => chatDisplayName(chat, identitiesById[chat.peer_user_id ?? '']?.display_name)
  const chatRows = !offers.has('chat') ? [] : forwardableChats(chats, '', query, nameOf).map((chat) => ({ ...chatPickRow(chat, nameOf(chat), identitiesById), id: `chat:${chat.id}` }))
  const newRows: ChatPickRow[] = offers.has('new-agent') && found(t('dispatchPick.newAgent'))
    ? [{ id: NEW_AGENT, name: t('dispatchPick.newAgent'), avatar: { name: '+', seed: NEW_AGENT, isAgent: true } }]
    : []
  const sections: ChatPickSection[] = [
    { id: 'chat-agents', title: t('dispatchPick.chatAgents', { chat: asked.chat?.name ?? '' }), rows: offers.has('agent-in-chat') ? memberRows('agent') : [] },
    { id: 'chat-people', title: t('dispatchPick.chatPeople', { chat: asked.chat?.name ?? '' }), rows: offers.has('person-in-chat') ? memberRows('human') : [] },
    { id: 'agents', title: t('dispatchPick.myAgents'), rows: agentRows },
    { id: 'new', title: t('dispatchPick.new'), rows: newRows },
    { id: 'chats', title: t('composePick.chats'), rows: chatRows },
  ]
  const [picked] = selected
  const toMember = picked?.startsWith('member:') === true
  const said = text.trim()
  const pickedTarget = (): NonNullable<DispatchPicked>['to'] | null => {
    if (!picked) return null
    if (picked === NEW_AGENT) return { new: true, ...(spawnDevice ? { device: spawnDevice } : {}) }
    const [kind, id = ''] = picked.split(/:(.*)/)
    if (kind === 'agent') return { agent: id }
    if (kind === 'member' && asked.chat) return { chat: asked.chat.id, member: id }
    return { chat: id }
  }
  // A forum assignment: what is assigned (the post), read only — nothing is written to anyone.
  const assign = asked.assign
  // What will go, as it will read: the text (theirs to change) and each pill under it.
  const preview = assign ? (
    <div className="text-[length:var(--font-body)] text-[var(--text-primary)]" data-testid="dispatch-assign">
      {assign.title}
      <p className="m-0 mt-1 text-[var(--text-secondary)]">{t('forum.consent.assignBody')}</p>
    </div>
  ) : (
    <div className="flex flex-col gap-[var(--spacing-xs)]" data-testid="dispatch-preview">
      <textarea
        className="min-h-[64px] w-full resize-y rounded-[var(--radius-control)] border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1 text-[length:var(--font-body)] text-[var(--text-primary)]"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={t('dispatchPick.textPlaceholder')}
        aria-label={t('dispatchPick.text')}
        data-testid="dispatch-text"
      />
      {asked.resource && <div className="flex flex-wrap gap-1" data-testid="dispatch-templates">
        {(RESOURCE_TEMPLATES[asked.resource.kind] as readonly ResourceTemplate[]).filter(template => template.requires?.every(fact => asked.resource?.facts?.includes(fact)) ?? true).map(template => (
          <Button key={template.id} size="sm" variant="ghost" onClick={() => setText(current => appendToDraft(current, t(template.textKey)))}>{t(template.labelKey)}</Button>
        ))}
      </div>}
      {asked.pills.map((pill, index) => (
        <span key={index} className="truncate text-[length:var(--font-caption)] text-[var(--text-secondary)]" data-testid="dispatch-pill">@{pill}</span>
      ))}
      {picked === NEW_AGENT && asked.spawnOn !== undefined && <DispatchMachine deviceId={spawnDevice} onPick={setSpawnDevice} />}
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
      title={assign ? t('forum.consent.assignTitle') : asked.draft ? t('composePick.title') : t('dispatchPick.title')}
      onClose={() => finish(null)}
      testId="dispatch-sheet"
      rows={[]}
      sections={sections}
      above={preview}
      selected={selected}
      onToggle={(id) => setSelected(new Set([id]))}
      query={query}
      onQuery={setQuery}
      placeholder={assign ? t('forum.consent.searchAgents') : t('dispatchPick.search')}
      empty={assign ? t('forum.consent.noAgents') : t('dispatchPick.empty')}
      actionLabel={assign ? t('forum.consent.assignConfirm') : asked.draft ? t('composePick.action') : t('dispatchPick.send')}
      actionDisabled={!picked || (picked === NEW_AGENT && asked.spawnOn !== undefined && !spawnDevice) || (!assign && !said && asked.pills.length === 0)}
      onAction={() => {
        const to = pickedTarget()
        if (to) finish({ to, visible: toMember && visible, text: said })
      }}
      fullScreenMobile
    />
  )
})
