import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from '@/lib/icons'
import { Avatar, type AvatarProps } from '../Avatar'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { Sheet } from '../ui/Sheet'
import { SearchField } from '../ui/SearchField'

/** One chat to pick, drawn as the chat list draws it: `avatar` goes to `Avatar` as it is. */
export interface ChatPickRow {
  id: string
  name: ReactNode
  avatar: AvatarProps
  /** After the name: a mark such as 「项目」. */
  badge?: ReactNode
  /** On the right: such as 「6 人」. */
  trailing?: ReactNode
  /** A second line under the name: why a search found it. */
  hint?: ReactNode
}

/** A run of rows under a heading (「我的任务」 below the chats): searched and picked as the rows above it are. */
export interface ChatPickSection {
  id: string
  title: ReactNode
  rows: readonly ChatPickRow[]
}

interface ChatPickSheetProps {
  title: string
  onClose: () => void
  testId: string
  rows: readonly ChatPickRow[]
  sections?: readonly ChatPickSection[]
  selected: ReadonlySet<string>
  onToggle: (id: string) => void
  query: string
  onQuery: (query: string) => void
  placeholder: string
  /** Said where no row is left. */
  empty: string
  /** Above the search field (forwarding: what is forwarded). */
  above?: ReactNode
  /** Above the rows while nothing is searched. */
  top?: ReactNode
  /** The foot: how many are picked, and what the pick is for. */
  picked: string
  actionLabel: string
  onAction: () => void
  actionDisabled?: boolean
  error?: string | null
  /** On the phone the sheet fills the screen. */
  fullScreenMobile?: boolean
}

/**
 * Pick chats, several at once: a search field, then each chat with a round tick, and a foot saying how many. The forward
 * sheet (ForwardMessageDialog) and 「添加群或项目」 (AppPlaces) are this one sheet; which rows a search leaves, what a row
 * says and what the pick is for are the caller's. Each row carries its chat id in `data-pick-row`.
 */
export function ChatPickSheet(props: ChatPickSheetProps) {
  const { t } = useTranslation('messaging')
  const { rows, sections = [], selected, query, actionDisabled = false } = props
  const renderRows = (list: readonly ChatPickRow[]) => list.map((row) => {
    const isSelected = selected.has(row.id)
    return (
      <div
        key={row.id}
        data-pick-row={row.id}
        className="gg-row"
        data-selected={isSelected || undefined}
        onClick={() => props.onToggle(row.id)}
        style={{ display: 'flex', alignItems: 'center', padding: '8px 16px', cursor: 'pointer', gap: '10px' }}
      >
        <div
          style={{
            width: '18px',
            height: '18px',
            borderRadius: 'var(--radius-circle)',
            border: isSelected ? '2px solid var(--accent)' : '2px solid var(--border-subtle)',
            background: isSelected ? 'var(--accent)' : 'var(--bg-transparent)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            transition: 'border-color var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease)',
          }}
        >
          {isSelected && (
            <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
              <path d="M1 4l3 3 5-6" stroke="var(--surface-white)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </div>
        <Avatar size="sm" {...row.avatar} />
        <div className="gg-list-row-body">
          <div className="gg-list-row-line">
            <span style={{ fontSize: 'var(--font-body)', color: 'var(--text-primary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {row.name}
            </span>
            {row.badge}
          </div>
          {row.hint}
        </div>
        {row.trailing}
      </div>
    )
  })
  return (
    <Sheet
      onClose={props.onClose}
      desktopWidth="min(340px, 100%)"
      desktopMaxHeight="min(520px, calc(100dvh - 32px))"
      fullScreenMobile={props.fullScreenMobile}
      testId={props.testId}
      ariaLabel={props.title}
    >
      <div
        style={{
          padding: '14px 16px',
          borderBottom: '1px solid var(--border-color)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span style={{ fontSize: 'var(--font-title)', fontWeight: 600, color: 'var(--text-primary)' }}>{props.title}</span>
        <IconButton size="sm" onClick={props.onClose} aria-label={t('common.close')}>
          <X />
        </IconButton>
      </div>

      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {props.above}
        <SearchField value={query} onChange={(event) => props.onQuery(event.target.value)} placeholder={props.placeholder} />
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {!query.trim() && props.top}
        {rows.length === 0 && sections.every((section) => section.rows.length === 0) && (
          <div style={{ padding: '32px 16px', textAlign: 'center', fontSize: 'var(--font-body)', color: 'var(--text-secondary)' }}>{props.empty}</div>
        )}
        {renderRows(rows)}
        {sections.map((section) => section.rows.length > 0 && (
          <div key={section.id} data-pick-section={section.id}>
            <div className="px-4 pt-3 pb-1 text-[length:var(--font-caption)] font-semibold text-[var(--text-secondary)]">{section.title}</div>
            {renderRows(section.rows)}
          </div>
        ))}
      </div>

      <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {props.error && <span style={{ fontSize: 'var(--font-body)', color: 'var(--danger)' }}>{props.error}</span>}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: 'var(--font-body)', color: 'var(--text-secondary)', flex: 1 }}>{props.picked}</span>
          <Button size="sm" onClick={props.onClose}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" onClick={props.onAction} disabled={actionDisabled} data-testid={`${props.testId}-action`}>
            {props.actionLabel}
          </Button>
        </div>
      </div>
    </Sheet>
  )
}
