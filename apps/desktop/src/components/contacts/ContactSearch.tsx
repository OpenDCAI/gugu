import { Fragment, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ContactGroupChat, ContactUser } from '@gugu/core/shared/types/contacts'
import { Check, Search } from '@/lib/icons'
import { cn } from '@/lib/cn'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import { recentChatActivity, searchContacts, type ContactSearchHit } from '../../lib/contactSearch'
import { displayName } from '../../lib/contactsListSort'
import { graphemes, normalizeMentionKey } from '../../lib/mentionMatch'
import { useChatStore } from '../../store/chatContext'
import { Avatar } from '../Avatar'
import { ListRow } from '../ui/ListRow'
import { SearchField } from '../ui/SearchField'
import { HeaderSearch } from '../ui/HeaderSearch'
import { SectionLabel } from '../ui/SectionLabel'

// 通讯录搜索(桌面侧栏与手机联系人首页共用):有关键词时,浏览视图(children)让位给一张结果表 ——
// 人 / Agent / 群三组,组标题在组外、组内只有行,没命中的组不出现。浏览视图只隐藏不卸载,清空后折叠状态原样。
// 键盘留在输入框:↑↓ 移动当前行,回车打开;打字本身不打开任何东西。

export function ContactGroupAvatar({ group, size }: { group: ContactGroupChat; size: 'sm' | 'md' | 'lg' | number }) {
  const { identitiesById } = useChatStore('identitiesById')
  return <Avatar name={group.name} avatarUrl={group.avatar_url} variant="group" size={size} memberAvatars={group.member_user_ids?.flatMap((id) => identitiesById[id] ? [{ id, name: identitiesById[id].display_name, avatar: identitiesById[id].avatar }] : [])} />
}

export function SelectionCheckbox({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid h-[var(--avatar-xs)] w-[var(--avatar-xs)] shrink-0 place-items-center rounded-full border !mr-2 text-[var(--primary-fg)]',
        checked ? 'border-[var(--primary)] bg-[var(--primary)]' : 'border-[var(--border-strong)] bg-transparent',
      )}
    >
      {checked ? <Check size={12} /> : null}
    </span>
  )
}

/** 多选态(桌面建群)下,可选的人点一下是勾选而不是打开。 */
export interface ContactSearchPick {
  ids: ReadonlySet<string>
  canPick: (contact: ContactUser) => boolean
  onToggle: (contact: ContactUser) => void
}

type Row =
  | { kind: 'contact'; hit: ContactSearchHit<ContactUser> }
  | { kind: 'group'; hit: ContactSearchHit<ContactGroupChat> }
  | { kind: 'lookup'; number: string }

/** 命中的字满墨、其余降到 muted:靠前景填充度区分,不加粗、不换色相。 */
function Marked({ text, hits }: { text: string; hits: number[] }) {
  if (hits.length === 0) return <>{text}</>
  const on = new Set(hits)
  const runs: { at: number; hit: boolean; text: string }[] = []
  for (const { segment, index } of graphemes.segment(text)) {
    const last = runs.at(-1)
    if (last && last.hit === on.has(index)) last.text += segment
    else runs.push({ at: index, hit: on.has(index), text: segment })
  }
  return <>{runs.map((run) => <span key={run.at} className={run.hit ? 'text-[var(--fg)]' : 'text-[var(--muted-fg)]'}>{run.text}</span>)}</>
}

export function ContactSearch({ query, onQuery, mobile = false, onScreen, head, people, agents, groups, pick, onOpenContact, onOpenGroup, onLookupNumber, children }: {
  query: string
  onQuery: (query: string) => void
  mobile?: boolean
  /** 手机:这一页此刻在屏上(见 HeaderSearch)。 */
  onScreen?: boolean
  /** 手机:页头。框收在页头的放大镜里(ui/HeaderSearch),与桌面那颗常驻框共用同一份输入与键盘处理。 */
  head?: (searchButton: ReactNode) => ReactNode
  people: ContactUser[]
  agents: ContactUser[]
  groups: ContactGroupChat[]
  pick?: ContactSearchPick
  onOpenContact: (contact: ContactUser) => void
  onOpenGroup: (group: ContactGroupChat) => void
  onLookupNumber: (number: string) => void
  /** 没有关键词时的浏览视图(滚动区本身)。 */
  children: ReactNode
}) {
  const { t } = useTranslation('contacts')
  const { chats } = useChatStore('chats')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const recentAt = useMemo(() => recentChatActivity(chats), [chats])
  const result = useMemo(() => searchContacts(query, { people, agents, groups, recentAt }), [query, people, agents, groups, recentAt])

  const sections = result ? [
    { key: 'people', label: t('panel.contactSectionTitle'), rows: result.people.map((hit): Row => ({ kind: 'contact', hit })) },
    { key: 'agents', label: t('panel.agentSectionTitle'), rows: result.agents.map((hit): Row => ({ kind: 'contact', hit })) },
    { key: 'groups', label: t('panel.groupSectionTitle'), rows: result.groups.map((hit): Row => ({ kind: 'group', hit })) },
  ].filter((section) => section.rows.length > 0) : []
  const digits = normalizeMentionKey(query)
  const lookup: Row[] = result && sections.length === 0 && /^\d+$/.test(digits) ? [{ kind: 'lookup', number: digits }] : []
  const rows = [...sections.flatMap((section) => section.rows), ...lookup]
  const current = Math.min(active, rows.length - 1)

  const open = (row: Row) => {
    if (row.kind === 'lookup') onLookupNumber(row.number)
    else if (row.kind === 'group') onOpenGroup(row.hit.item)
    else if (pick?.canPick(row.hit.item)) pick.onToggle(row.hit.item)
    else onOpenContact(row.hit.item)
  }
  const changeQuery = (value: string) => { onQuery(value); setActive(0) }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (rows.length === 0 || event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const next = Math.max(0, Math.min(rows.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))
      setActive(next)
      listRef.current?.querySelector(`[data-search-row="${next}"]`)?.scrollIntoView({ block: 'nearest' })
    } else if (event.key === 'Enter') {
      event.preventDefault()
      open(rows[current])
    }
  }

  const renderRow = (row: Row, index: number) => {
    const common = {
      role: 'button', tabIndex: 0, mobile, 'data-search-row': index,
      selected: !mobile && index === current,
      onClick: () => { setActive(index); open(row) },
      onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => { if (event.key === 'Enter') { event.preventDefault(); open(row) } },
    } as const
    const avatarSize = mobile ? 'md' : 'sm'
    if (row.kind === 'lookup') {
      return (
        <ListRow key="lookup" {...common}
          leading={<div className={cn('grid shrink-0 place-items-center text-[var(--muted-fg)]', mobile ? 'size-[var(--avatar-md)]' : 'size-[var(--avatar-sm)]')}><Search size={16} /></div>}
          title={t('panel.lookupGuguNumber', { number: row.number })} />
      )
    }
    const { hit } = row
    const why = hit.field === 'title' ? undefined : (
      <span>{hit.field === 'original' ? t('profile.originalName') : row.kind === 'group' ? t('groupDetail.number') : t('common.guguNumber')} <Marked text={hit.text} hits={hit.hits} /></span>
    )
    if (row.kind === 'group') {
      const group = row.hit.item
      return <ListRow key={group.id} {...common} data-group-id={group.id} leading={<ContactGroupAvatar group={group} size={avatarSize} />} title={<Marked text={group.name} hits={hit.field === 'title' ? hit.hits : []} />} subtitle={why} />
    }
    const contact = row.hit.item
    const picking = pick?.canPick(contact) ?? false
    return (
      <ListRow key={contact.id} {...common}
        data-contact-id={contact.id}
        data-contact-option={picking ? contact.id : undefined}
        aria-pressed={picking ? pick?.ids.has(contact.id) : undefined}
        leading={<>
          {picking ? <SelectionCheckbox checked={pick?.ids.has(contact.id) ?? false} /> : null}
          <Avatar name={contact.display_name} avatarUrl={contact.avatar} seed={contact.id} size={avatarSize} isAgent={contact.type === 'agent'} />
        </>}
        title={<Marked text={displayName(contact)} hits={hit.field === 'title' ? hit.hits : []} />}
        subtitle={why} />
    )
  }

  let index = 0
  return (
    <>
      {mobile ? (
        <HeaderSearch mobile active={onScreen} value={query} onChange={changeQuery} onKeyDown={onKeyDown} placeholder={t('panel.searchContacts')} testId={AUTOMATION_TEST_IDS.contactsSearchInput}>
          {(searchButton) => head?.(searchButton)}
        </HeaderSearch>
      ) : (
        <div className="shrink-0 !px-3 !pb-2">
          <SearchField
            data-testid={AUTOMATION_TEST_IDS.contactsSearchInput}
            value={query}
            onChange={(event) => changeQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('panel.searchContacts')}
            clearLabel={t('friendSearch.clearSearch')}
            onClear={() => onQuery('')}
          />
        </div>
      )}
      {result ? (
        <div ref={listRef} data-testid="contacts-search-results" className="flex-1 overflow-y-auto !px-2 !pb-3">
          {sections.map((section) => (
            <Fragment key={section.key}>
              <SectionLabel className="gg-c-sec-h !mt-3">{section.label}</SectionLabel>
              {section.rows.map((row) => renderRow(row, index++))}
            </Fragment>
          ))}
          {sections.length === 0 ? <p className="!m-0 !px-2 !py-3 text-[length:var(--font-body)] text-[var(--text-secondary)]">{t('common.noMatches')}</p> : null}
          {lookup.map((row) => renderRow(row, index++))}
        </div>
      ) : null}
      <div data-testid="contacts-browse" className={result ? 'hidden' : 'contents'}>{children}</div>
    </>
  )
}
