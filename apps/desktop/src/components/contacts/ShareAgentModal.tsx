/**
 * 分享 Agent 弹层 —— 从 ContactsPanel 抽出（该文件行数被 CI 冻结，只能减）。
 * 一个自成一体的模态：选人 → 确认 → 给每位好友发入群邀请（#6524，与 MCP contact_friend 同一条链），
 * 除了 Sheet/Avatar 不依赖通讯录其余部分。
 */
import { useCallback, useMemo, useState } from 'react'
import { Check, X } from '@/lib/icons'
import { resolveOrLoud } from '@gugu/core/shared/resolveOrLoud'
import type { ContactGroupChat, ContactUser } from '@gugu/core/shared/types/contacts'
import { describeAgentShare, shareAgentWithFriends } from '../../lib/agentShare'
import { displayName } from '../../lib/contactsListSort'
import { useAuth } from '../../store/auth'
import { Avatar } from '../Avatar'
import { useToast } from '../toastContext'
import { Sheet } from '../ui/Sheet'
import { useTranslation } from 'react-i18next'
import { SearchField } from '../ui/SearchField'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'

export function ShareAgentModal({
  agent,
  contacts,
  onClose,
  onOpenGroupChat
}: {
  agent: ContactUser
  contacts: ContactUser[]
  onClose: () => void
  onOpenGroupChat?: (group: ContactGroupChat) => void
}) {
  const { t, i18n } = useTranslation('contacts')
  const { user } = useAuth()
  const { toast } = useToast()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const normalizedQuery = query.trim().toLowerCase()
  const visibleContacts = useMemo(() => {
    if (!normalizedQuery) return contacts
    return contacts.filter((contact) => {
      const searchable = [
        displayName(contact),
        contact.display_name,
        contact.alias ?? '',
        contact.email ?? ''
      ]
        .join(' ')
        .toLowerCase()
      return searchable.includes(normalizedQuery)
    })
  }, [contacts, normalizedQuery])

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const confirm = useCallback(async () => {
    if (!user) return
    if (selected.size === 0) {
      setError(t('inviteAgent.selectAtLeastOne'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const outcomes = await shareAgentWithFriends(
        agent.id,
        Array.from(selected),
        t('inviteAgent.invitationNote', { owner: user.nickname, agent: agent.display_name })
      )
      const nameOf = (id: string) => {
        const contact = contacts.find((item) => item.id === id)
        return resolveOrLoud(contact ? displayName(contact) : null, `share-agent friend name ${id}`)
      }
      const report = describeAgentShare(outcomes, nameOf, t, i18n.language)
      for (const line of report.done) toast(line, 'success')
      if (report.problem) {
        // 成了的、拒绝过的移出选中，只留失败的等重试。
        setSelected(new Set(report.retryIds))
        setError(report.problem)
        return
      }
      if (report.openGroup) {
        onOpenGroupChat?.({
          id: report.openGroup.id,
          kind: 'group',
          name: report.openGroup.name,
          avatar_url: null,
          // already_member 就是按「恰好 3 人：主人 + Agent + 好友」找到的群。
          member_count: 3,
          is_muted: false
        })
      }
      onClose()
    } finally {
      setBusy(false)
    }
  }, [agent.display_name, agent.id, contacts, i18n.language, onClose, onOpenGroupChat, selected, t, toast, user])

  return (
    <Sheet
      onClose={onClose}
      desktopWidth="min(380px, 100%)"
      desktopMaxHeight="min(560px, calc(100dvh - 32px))"
      ariaLabel={t('inviteAgent.dialogLabel')}
    >
      <div
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          flex: 1,
          overflow: 'hidden'
        }}
      >
        <div
          style={{
            padding: 16,
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            gap: 12
          }}
        >
          <Avatar name={agent.display_name} avatarUrl={agent.avatar} seed={agent.id} size="sm" isAgent />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 'var(--font-title)', lineHeight: 'var(--lh-title)', fontWeight: 600 }}>{t('inviteAgent.title', { name: agent.display_name })}</div>
          </div>
          <IconButton
            aria-label={t('common.close')}
            onClick={onClose}
            disabled={busy}
          >
            <X size={16} />
          </IconButton>
        </div>

        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
          <SearchField
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('inviteAgent.searchPlaceholder')}
            clearLabel={t('inviteAgent.clearSearch')}
            onClear={() => setQuery('')}
          />
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px 0' }}>
          {contacts.length === 0 ? (
            <div
              style={{
                padding: 16,
                color: 'var(--text-secondary)',
                fontSize: 'var(--font-body)',
                lineHeight: 'var(--lh-body)',
                textAlign: 'center'
              }}
            >
              {t('inviteAgent.empty')}
            </div>
          ) : visibleContacts.length === 0 ? (
            <div
              style={{
                padding: 16,
                color: 'var(--text-secondary)',
                fontSize: 'var(--font-body)',
                lineHeight: 'var(--lh-body)',
                textAlign: 'center'
              }}
            >
              {t('inviteAgent.noResults')}
            </div>
          ) : (
            visibleContacts.map((contact) => {
              const checked = selected.has(contact.id)
              return (
                <button
                  key={contact.id}
                  data-share-contact={contact.id}
                  aria-pressed={checked}
                  data-selected={checked || undefined}
                  className="gg-row"
                  type="button"
                  onClick={() => toggle(contact.id)}
                  style={{
                    width: '100%',
                    minHeight: 52,
                    border: 0,
                    color: 'var(--text-primary)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '8px 16px',
                    textAlign: 'left',
                    cursor: 'pointer'
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: 'var(--radius-xs)',
                      border: `1px solid ${checked ? 'var(--primary)' : 'var(--border-color)'}`,
                      background: checked ? 'var(--primary)' : 'transparent',
                      color: 'var(--primary-fg)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0
                    }}
                  >
                    {checked ? <Check size={12} /> : null}
                  </span>
                  <Avatar name={contact.display_name} avatarUrl={contact.avatar} seed={contact.id} size="sm" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 'var(--font-body)',
                        lineHeight: 'var(--lh-body)',
                        fontWeight: 550,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      {displayName(contact)}
                    </div>
                    {contact.email ? (
                      <div
                        style={{
                          marginTop: 2,
                          fontSize: 'var(--font-caption)',
                          lineHeight: 'var(--lh-caption)',
                          color: 'var(--text-secondary)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap'
                        }}
                      >
                        {contact.email}
                      </div>
                    ) : null}
                  </div>
                </button>
              )
            })
          )}
        </div>

        <div
          style={{
            padding: '12px 16px max(12px, env(safe-area-inset-bottom))',
            borderTop: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            gap: 8
          }}
        >
          <div
            role={error ? 'alert' : 'status'}
            style={{
              flex: 1,
              minWidth: 0,
              color: error ? 'var(--danger)' : 'var(--text-secondary)',
              fontSize: error ? 'var(--font-body)' : 'var(--font-caption)',
              lineHeight: error ? 'var(--lh-body)' : 'var(--lh-caption)',
              // 报错要整句读得到(谁拒绝过、谁没成),换行;计数那一行照旧单行省略。
              overflow: 'hidden',
              textOverflow: error ? undefined : 'ellipsis',
              whiteSpace: error ? 'normal' : 'nowrap'
            }}
          >
            {error ?? t('inviteAgent.selectedCount', { count: selected.size })}
          </div>
          <Button
            onClick={onClose}
            disabled={busy}
          >
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={confirm}
            disabled={busy || selected.size === 0}
          >
            {busy ? t('inviteAgent.processing') : t('inviteAgent.invite')}
          </Button>
        </div>
      </div>
    </Sheet>
  )
}
