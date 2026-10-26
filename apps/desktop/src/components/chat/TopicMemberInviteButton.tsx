import { messageForUser } from '@/lib/userFacingError';
import { useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, UserPlus, X } from '@/lib/icons'
import type { GroupRosterCandidate } from '@/lib/mention'
import { rendererLogger } from '@/lib/log'
import { Avatar } from '../Avatar'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { ListRow } from '../ui/ListRow'
import { SearchField } from '../ui/SearchField'
import { Sheet } from '../ui/Sheet'

const inviteLog = rendererLogger('chat/topic-member-invite')
const HEADER_STYLE: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '14px 16px', borderBottom: '1px solid var(--border-subtle)' }
const TITLE_STYLE: CSSProperties = { margin: 0, fontSize: 'var(--font-body)', fontWeight: 600 }
const SEARCH_STYLE: CSSProperties = { padding: '12px 16px' }
const LIST_STYLE: CSSProperties = { minHeight: 0, overflowY: 'auto', flex: 1, padding: '0 8px' }
const HINT_STYLE: CSSProperties = { margin: 0, padding: '8px 16px', fontSize: 'var(--font-body)', color: 'var(--text-secondary)', lineHeight: 1.5 }
const ERROR_STYLE: CSSProperties = { ...HINT_STYLE, color: 'var(--danger)' }
const FOOTER_STYLE: CSSProperties = { ...HEADER_STYLE, borderBottom: undefined, borderTop: '1px solid var(--border-subtle)' }

export type TopicMemberInvitation = {
  candidates: readonly GroupRosterCandidate[]
  send: (text: string, toUserIds: readonly string[] | null, replyToMessageId: string | null) => Promise<void>
}

export function TopicMemberInviteButton({ invitation, participantIds, currentUserId, onInvited }: {
  invitation: TopicMemberInvitation
  participantIds: readonly string[]
  currentUserId: string
  onInvited: () => Promise<void>
}) {
  const { t } = useTranslation('messaging')
  const [open, setOpen] = useState(false)
  return (
    <>
      <IconButton size="sm" aria-label={t('group.topicInvite.title')} data-testid="topic-member-invite" onClick={() => setOpen(true)}>
        <UserPlus />
      </IconButton>
      {open ? (
        <TopicMemberPicker
          invitation={invitation}
          participantIds={participantIds}
          currentUserId={currentUserId}
          onInvited={onInvited}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  )
}

function TopicMemberPicker({ invitation, participantIds, currentUserId, onInvited, onClose }: {
  invitation: TopicMemberInvitation
  participantIds: readonly string[]
  currentUserId: string
  onInvited: () => Promise<void>
  onClose: () => void
}) {
  const { t } = useTranslation('messaging')
  const [query, setQuery] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState('')
  const candidates = invitation.candidates.filter((member) => member.id !== currentUserId && !participantIds.includes(member.id))
  const selected = candidates.filter((member) => selectedIds.has(member.id))
  const visible = candidates.filter((member) => member.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const close = () => { if (!busy) onClose() }
  const toggle = (id: string) => {
    if (busy) return
    setSelectedIds((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const invite = async () => {
    if (busy || !selected.length) return
    setBusy(true)
    setFailed('')
    try {
      // 与话题 composer 共用发送路径。@ 消息本身就是邀请，成员维护归服务端。
      const names = selected.map((member) => `@${member.name}`).join(' ')
      await invitation.send(t('group.topicInvite.message', { names }), selected.map((member) => member.id), null)
      await onInvited()
      onClose()
    } catch (error) {
      inviteLog.error({ error }, 'topic member invitation failed')
      setFailed(messageForUser(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Sheet onClose={close} closeOnBackdrop={!busy} desktopWidth="420px" ariaLabel={t('group.topicInvite.title')} testId="topic-member-picker">
      <div style={HEADER_STYLE}>
        <h2 style={TITLE_STYLE}>{t('group.topicInvite.title')}</h2>
        <IconButton size="sm" aria-label={t('common.close')} onClick={close} disabled={busy}><X /></IconButton>
      </div>
      <div style={SEARCH_STYLE}>
        <SearchField value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('group.topicInvite.search')} disabled={busy} autoFocus />
      </div>
      <div style={LIST_STYLE}>
        {visible.map((member) => (
          <ListRow
            key={member.id}
            role="checkbox"
            aria-checked={selectedIds.has(member.id)}
            aria-disabled={busy}
            aria-label={member.name}
            tabIndex={busy ? -1 : 0}
            onClick={() => toggle(member.id)}
            onKeyDown={(event) => {
              if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); toggle(member.id) }
            }}
            selected={selectedIds.has(member.id)}
            leading={<Avatar name={member.name} seed={member.id} size="sm" isAgent={member.type === 'agent'} />}
            title={member.name}
            subtitle={member.type === 'agent' ? t('group.memberList.sectionAgents') : t('group.memberList.sectionPeople')}
            meta={selectedIds.has(member.id) ? <Check size={16} /> : undefined}
          />
        ))}
        {visible.length === 0 ? <p style={HINT_STYLE}>{t(query.trim() ? 'group.topicInvite.noResults' : 'group.topicInvite.empty')}</p> : null}
      </div>
      {failed ? <p role="alert" style={ERROR_STYLE}>{failed}</p> : null}
      <div style={FOOTER_STYLE}>
        <Button variant="ghost" onClick={close} disabled={busy}>{t('common.cancel')}</Button>
        <Button variant="primary" onClick={() => { void invite() }} disabled={busy || !selected.length} data-testid="topic-member-invite-confirm">
          {busy ? t('group.picker.adding') : t('group.topicInvite.confirm', { count: selected.length })}
        </Button>
      </div>
    </Sheet>
  )
}
