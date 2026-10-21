/**
 * 标签详情两态 —— 从 ContactsPanel 抽出（该文件行数被 CI 冻结，只能减）。
 *   TagEmptyDetail        标签下没人时的空态 + 加人入口
 *   TagMemberEditorDetail 标签成员编辑（按人/Agent 过滤、勾选、保存）
 * 两者共用 TagMemberFilter / contactKindLabel，一起搬才内聚。
 * ❌ 不改行为：纯搬运 + 补 import。
 */
import { useMemo, useState } from 'react'
import { Check, ChevronLeft, Tag, UserPlus } from '@/lib/icons'
import type { ContactGroup, ContactUser } from '@gugu/core/shared/types/contacts'
import { displayName } from '../../lib/contactsListSort'
import { Avatar } from '../Avatar'
import { IconButton } from '../contactsDetailControls'
import { useTranslation } from 'react-i18next'
import { SearchField } from '../ui/SearchField'
// @@@ui-ruler 标签详情的列与列头也只吃原语:Pane detail + PaneHeader(同高同线同字阶),
// ❌ 再各自拍 50/38/16/650。
import { Pane, PaneHeader } from '../ui/Pane'
import { IconButton as UiIconButton } from '../ui/IconButton'
import { useBackLayer } from '../ui/sheetStack'
import { Button } from '../ui/Button'

/** 两个标签面共用的列头 leading:移动壳返回键 + 标签图标。 */
function TagHeaderLeading({ backLabel, onBack, mobile }: { backLabel: string; onBack?: () => void; mobile?: boolean }) {
  useBackLayer(onBack, mobile) // 手机整页:安卓返回键 = 左上返回
  return (
    <>
      {mobile && onBack ? (
        <UiIconButton aria-label={backLabel} onClick={onBack}><ChevronLeft /></UiIconButton>
      ) : null}
      <Tag size={16} className="shrink-0 text-[var(--muted-fg)]" />
    </>
  )
}

export function TagEmptyDetail({
  tag,
  mobile = false,
  onBack,
  onEditMembers
}: {
  tag: ContactGroup
  mobile?: boolean
  onBack?: () => void
  onEditMembers: () => void
}) {
  const { t } = useTranslation('contacts')
  return (
    <Pane paneRole="detail" mobile={mobile}>
      <PaneHeader
        divider
        mobile={mobile}
        title={tag.name}
        leading={<TagHeaderLeading backLabel={t('tags.backToList')} onBack={onBack} mobile={mobile} />}
      />
      <div className="flex flex-1 items-center justify-center !p-6">
        <div className="max-w-[320px] text-center">
          <div className="text-base font-semibold text-[var(--fg)]">{t('tags.emptyTitle')}</div>
          <div className="!mt-2 text-[length:var(--font-body)] text-[var(--muted-fg)]">
            {t('tags.emptyDescription')}
          </div>
          <Button variant="primary" size="md" className="!mt-4" onClick={onEditMembers}>
            <UserPlus size={15} />
            {t('tags.editMembers')}
          </Button>
        </div>
      </div>
    </Pane>
  )
}

type TagMemberFilter = 'all' | 'human' | 'agent'

export function TagMemberEditorDetail({
  tag,
  mobile = false,
  onBack,
  contacts,
  onUpdateMembers
}: {
  tag: ContactGroup
  mobile?: boolean
  onBack?: () => void
  contacts: ContactUser[]
  onUpdateMembers: (groupId: string, contactIds: string[]) => Promise<void>
}) {
  const { t } = useTranslation('contacts')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<TagMemberFilter>('all')
  const [savingId, setSavingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const memberIds = useMemo(() => new Set(tag.contactIds), [tag.contactIds])
  const normalizedQuery = query.trim().toLowerCase()
  const filterOptions = [
    { value: 'all' as const, label: t('tags.filters.all'), count: contacts.length },
    {
      value: 'human' as const,
      label: t('tags.filters.contacts'),
      count: contacts.filter((contact) => contact.type !== 'agent').length
    },
    {
      value: 'agent' as const,
      label: t('tags.filters.agent'),
      count: contacts.filter((contact) => contact.type === 'agent').length
    }
  ]
  const visibleContacts = useMemo(
    () =>
      contacts.filter((contact) => {
        if (filter === 'human' && contact.type === 'agent') return false
        if (filter === 'agent' && contact.type !== 'agent') return false
        if (!normalizedQuery) return true
        const searchable = [
          displayName(contact),
          contact.display_name,
          contact.alias ?? '',
          contact.email ?? '',
          contact.type === 'agent' ? t('tags.filters.agent') : t('tags.contactKind'),
          contact.agent_type ?? '',
          contact.bio ?? ''
        ]
          .join(' ')
          .toLowerCase()
        return searchable.includes(normalizedQuery)
      }),
    [contacts, filter, normalizedQuery, t]
  )

  const toggleMember = async (contactId: string) => {
    if (savingId) return
    const next = memberIds.has(contactId)
      ? tag.contactIds.filter((id) => id !== contactId)
      : [...tag.contactIds, contactId]
    setSavingId(contactId)
    setError(null)
    try {
      await onUpdateMembers(tag.id, next)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('tags.updateFailed'))
    } finally {
      setSavingId(null)
    }
  }

  return (
    <Pane paneRole="detail" mobile={mobile}>
      <PaneHeader
        divider
        mobile={mobile}
        title={t('tags.editTitle')}
        leading={<TagHeaderLeading backLabel={t('tags.back')} onBack={onBack} mobile={mobile} />}
        actions={
          !mobile && onBack ? (
            <IconButton title={t('common.done')} onClick={onBack}>
              <Check size={14} />
            </IconButton>
          ) : undefined
        }
      />
      <div
        className={mobile
          ? 'flex-1 overflow-y-auto !px-4 !pt-4 !pb-[max(24px,env(safe-area-inset-bottom))]'
          : 'flex-1 overflow-y-auto !px-6 !py-5'}
      >
        <div className="max-w-[560px]">
          <div className="overflow-hidden text-ellipsis whitespace-nowrap text-base font-semibold text-[var(--fg)]">
            {tag.name}
          </div>
          <div className="!mt-1 text-[length:var(--font-body)] text-[var(--muted-fg)]">
            {t('tags.objectCount', { count: tag.contactIds.length })}
          </div>
        </div>

        <div style={{ maxWidth: 560, marginTop: 16, display: 'grid', gap: 10 }}>
          <SearchField
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('tags.searchPlaceholder')}
          />

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {filterOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setFilter(option.value)}
                style={{
                  height: 28,
                  border: `1px solid ${filter === option.value ? 'var(--accent)' : 'var(--border-color)'}`,
                  borderRadius: 'var(--radius-xl)',
                  background:
                    filter === option.value ? 'var(--accent-tint-row)' : 'var(--input-bg)',
                  color: filter === option.value ? 'var(--accent)' : 'var(--text-secondary)',
                  padding: '0 10px',
                  fontSize: 'var(--font-caption)',
                  cursor: 'pointer'
                }}
              >
                {option.label} {option.count}
              </button>
            ))}
          </div>

          {error ? (
            <div
              role="alert"
              style={{
                minHeight: 34,
                border: '1px solid var(--border-color)',
                borderRadius: 'var(--radius-control)',
                background: 'var(--input-bg)',
                color: 'var(--danger)',
                display: 'flex',
                alignItems: 'center',
                padding: '8px 10px',
                fontSize: 'var(--font-body)'
              }}
            >
              {error}
            </div>
          ) : null}

          <div
            style={{
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-control)',
              overflow: 'hidden',
              background: 'var(--input-bg)'
            }}
          >
            {contacts.length === 0 ? (
              <div
                style={{
                  height: 92,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--text-secondary)',
                  fontSize: 'var(--font-body)'
                }}
              >
                {t('tags.emptyContacts')}
              </div>
            ) : visibleContacts.length === 0 ? (
              <div
                style={{
                  height: 92,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--text-secondary)',
                  fontSize: 'var(--font-body)'
                }}
              >
                {t('tags.noResults')}
              </div>
            ) : (
              visibleContacts.map((contact) => {
                const checked = memberIds.has(contact.id)
                const saving = savingId === contact.id
                return (
                  <button
                    key={contact.id}
                    type="button"
                    className="gg-row"
                    data-selected={checked ? '' : undefined}
                    aria-pressed={checked}
                    disabled={Boolean(savingId)}
                    onClick={() => toggleMember(contact.id)}
                    style={{
                      width: '100%',
                      minHeight: 50,
                      // 2026-09-22 按 design.md 删逐行 hairline(「A ledger of forty rows with forty hairlines
                      // is a cage」):行靠 minHeight 节奏 + .gg-row 的 hover/selected 底色分组。
                      // ❌ 选中态别写 inline background:inline 赢过 .gg-row:hover/:active —— 线删了、
                      //    hover 也被盖掉,这一列就既无分隔也无响应。走 data-selected 交给 .gg-row。
                      border: 0,
                      color: 'var(--text-primary)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '8px 12px',
                      textAlign: 'left',
                      cursor: savingId ? 'default' : 'pointer',
                      opacity: saving ? 0.68 : 1
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: 'var(--radius-surface)',
                        border: `1px solid ${checked ? 'var(--accent)' : 'var(--border-color)'}`,
                        background: checked ? 'var(--accent)' : 'transparent',
                        color: 'var(--text-on-accent)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0
                      }}
                    >
                      {checked ? <Check size={12} /> : null}
                    </span>
                    <Avatar
                      name={contact.display_name}
                      avatarUrl={contact.avatar}
                      seed={contact.id}
                      size="sm"
                      isAgent={contact.type === 'agent'}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          color: 'var(--text-primary)',
                          fontSize: 'var(--font-body)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap'
                        }}
                      >
                        {displayName(contact)}
                      </div>
                      <div
                        style={{
                          color: 'var(--text-secondary)',
                          fontSize: 'var(--font-caption)',
                          marginTop: 2,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap'
                        }}
                      >
                        {contact.type === 'agent' ? t('tags.filters.agent') : t('tags.contactKind')}
                      </div>
                    </div>
                  </button>
                )
              })
            )}
          </div>
        </div>
      </div>
    </Pane>
  )
}
