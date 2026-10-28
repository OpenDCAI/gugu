import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { cn } from '@/lib/cn'
import { X } from '@/lib/icons'
import { useDisplayDevices } from '@/hooks/useAssistantHomeLabel'
import { useLiveDeviceSessions,usePhoneTaskDirectory } from '@/session/shared/remote-sessions/session-directory'
import { useAgentDisplayStatus } from '../../hooks/useAgentDisplayStatus'
import { useMobileShell } from '../../hooks/useMobileShell'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import { formatCalendarDay } from '../../lib/calendarTime'
import { recentChatActivity, searchContacts, type ContactSearchHit } from '../../lib/contactSearch'
import { displayName, getPinyinInitial } from '../../lib/contactsListSort'
import { rendererLogger } from '../../lib/log'
import { useAuth } from '../../store/auth'
import { useChatStore } from '../../store/chatContext'
import { useContactsStore } from '../../store/contactsContext'
import { useDevicesStore } from '../../store/devicesContext'
import { AgentContactStatusMark } from '../AgentContactStatusMark'
import { AgentHarnessIcon } from '../AgentHarnessIdentity'
import { Avatar } from '../Avatar'
import { useShownAgentContactStatus } from '../contactAgentTone'
import { Marked, SelectionCheckbox } from '../contacts/ContactSearch'
import { ContactsAzIndex } from '../contacts/ContactsLetterPicker'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { ListRow } from '../ui/ListRow'
import { SearchField } from '../ui/SearchField'
import { SectionLabel } from '../ui/SectionLabel'
import { pickerModel, projectsOf, type PickerEntry, type PickerSource } from './memberPickerModel'

const log = rendererLogger('chat/member-picker')

/** 新建群聊与添加成员共用这一个外壳尺寸:桌面左栏来源 + 右栏列表,手机整屏。 */
export const MEMBER_PICKER_SHEET = { desktopWidth: 'min(740px, 100%)', desktopHeight: 'min(640px, calc(100dvh - 32px))', fullScreenMobile: true } as const

type Row = { entry: PickerEntry; hit?: ContactSearchHit<ContactUser> }

export interface MemberPickerProps {
  title: string
  confirmLabel: (count: number) => string
  /** 返回一组 id = 换成这组继续选(添加成员时没加进去的那几个);不返回 = 照旧。 */
  onConfirm: (ids: string[]) => Promise<readonly string[] | void> | void
  onClose: () => void
  initialSelectedIds?: readonly string[]
  /** 已经在群里的:勾着、不能取消,不进已选。 */
  lockedIds?: ReadonlySet<string>
  /** 不能拉人进来时「人」那一页说的话(项目群 / 没有邀请权限);给了就只能选 Agent。 */
  peopleDenied?: string
  /** Agent 行上替换任务那一句的话(添加成员时的审批状态)。 */
  agentNote?: (id: string) => string | undefined
  busy?: boolean
  busyLabel?: string
  /** 提交后的说明 / 错误,画在确认按钮上方。 */
  footer?: ReactNode
}

export function MemberPicker({ title, confirmLabel, onConfirm, onClose, initialSelectedIds = [], lockedIds, peopleDenied, agentNote, busy = false, busyLabel, footer }: MemberPickerProps) {
  usePhoneTaskDirectory()
  const { t } = useTranslation('contacts')
  const mobile = useMobileShell()
  const { contacts, contactsStatus, loadingContacts, refreshContacts } = useContactsStore()
  const currentUserId = useAuth().user?.id ?? null
  const { chats } = useChatStore('chats')
  const devices = useDisplayDevices(useDevicesStore().devices)
  const live = useLiveDeviceSessions()
  const [openedAt] = useState(() => Date.now())

  // 选成员要新鲜的候选:通讯录 revision 与弹窗开关可能同一帧到,打开时再取一次权威快照。
  const [refreshing, setRefreshing] = useState(true)
  const reload = useCallback(() => {
    setRefreshing(true)
    return refreshContacts().catch((error: unknown) => log.error({ error: String(error) }, 'refresh contacts failed')).finally(() => setRefreshing(false))
  }, [refreshContacts])
  useEffect(() => { void reload() }, [reload])

  const model = useMemo(
    () => pickerModel({ contacts, currentUserId, devices, live, recentChats: recentChatActivity(chats), now: openedAt, withPeople: !peopleDenied }),
    [contacts, currentUserId, devices, live, chats, openedAt, peopleDenied],
  )
  const { sources } = model
  const labelOf = (source: PickerSource): string => {
    if (source.kind === 'recent') return t('memberPicker.recent')
    if (source.kind === 'people') return t('panel.contactSectionTitle')
    const { scope, displayLabel, key } = source.section
    if (scope === 'local') return displayLabel ? t('memberPicker.localDevice', { name: displayLabel }) : t('panel.localDeviceSectionTitle')
    if (scope === 'cloud') return t('panel.cloudDeviceSectionTitle')
    return scope === 'device' ? (displayLabel ?? key) : t('panel.agentSectionTitle')
  }
  const deviceLabelOf = (id: string): string | null => {
    const key = model.sourcesOf(id).find((k) => k !== 'recent' && k !== 'people')
    const source = key ? sources.find((s) => s.key === key) : undefined
    return source ? labelOf(source) : null
  }

  const [selected, setSelected] = useState<string[]>(() => initialSelectedIds.filter((id) => !lockedIds?.has(id)))
  const [query, setQuery] = useState('')
  const [chosenSource, setChosenSource] = useState<string | null>(null)
  const [searchScope, setSearchScope] = useState('all')
  const [project, setProject] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const deferredQuery = useDeferredValue(query)

  const defaultSource = sources.find((source) => source.entries.length > 0 && !(source.kind === 'people' && peopleDenied))?.key ?? 'recent'
  const sourceKey = sources.some((source) => source.key === chosenSource) ? chosenSource! : defaultSource
  const source = sources.find((s) => s.key === sourceKey)!
  const result = useMemo(() => searchContacts(deferredQuery, {
    people: model.people.map((entry) => entry.contact),
    agents: model.agents.map((entry) => entry.contact),
    groups: [],
    recentAt: model.lastAt,
    extraFields: model.searchFields,
  }), [deferredQuery, model])

  const entryOf = useMemo(() => new Map([...model.people, ...model.agents].map((entry) => [entry.contact.id, entry])), [model])
  const unavailableSelection = selected.some((id) => !entryOf.has(id))
  const canConfirm = !busy && !refreshing && !loadingContacts && contactsStatus === 'ready' && selected.length > 0 && !unavailableSelection
  const searchRows: Row[] = result ? [...result.people, ...result.agents].map((hit) => ({ entry: entryOf.get(hit.item.id)!, hit })) : []
  const scopeCounts = new Map<string, number>()
  for (const row of searchRows) for (const key of model.sourcesOf(row.entry.contact.id)) scopeCounts.set(key, (scopeCounts.get(key) ?? 0) + 1)
  const projects = !result && source.kind === 'device' ? projectsOf(source.entries) : []
  const rows: Row[] = result
    ? searchRows.filter((row) => searchScope === 'all' || model.sourcesOf(row.entry.contact.id).includes(searchScope))
    : source.entries.filter((entry) => !project || entry.project === project).map((entry) => ({ entry }))
  const showPeopleDenied = !result && source.kind === 'people' && Boolean(peopleDenied)
  const visibleRows = showPeopleDenied ? [] : rows
  const letters = !result && source.kind === 'people' && visibleRows.length >= 12
  const activeIndex = Math.min(active, Math.max(0, visibleRows.length - 1))
  const showWhere = Boolean(result) || source.kind === 'recent'

  const isLocked = (id: string) => lockedIds?.has(id) ?? false
  const toggle = (id: string) => {
    if (isLocked(id)) return
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }
  const confirm = async () => {
    if (!canConfirm) return
    const keep = await onConfirm(selected.filter((id) => !isLocked(id)))
    if (keep) setSelected([...keep])
  }
  const pickSource = (key: string) => {
    if (result) setSearchScope(key)
    else { setChosenSource(key); setProject(null) }
    setActive(0)
    if (listRef.current) listRef.current.scrollTop = 0
  }
  const changeQuery = (value: string) => {
    if (!value.trim()) setSearchScope('all')
    setQuery(value)
    setActive(0)
  }
  const activate = (index: number) => {
    const row = visibleRows[index]
    if (!row) return
    toggle(row.entry.contact.id)
    if (query.trim()) changeQuery('')
  }
  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void confirm() }
    else if (event.key === 'Enter') { event.preventDefault(); activate(activeIndex) }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const next = Math.max(0, Math.min(visibleRows.length - 1, activeIndex + (event.key === 'ArrowDown' ? 1 : -1)))
      setActive(next)
      listRef.current?.querySelector(`[data-option-index="${next}"]`)?.scrollIntoView({ block: 'nearest' })
    } else if (event.key === 'Backspace' && !query && selected.length > 0) { event.preventDefault(); setSelected((prev) => prev.slice(0, -1)) }
  }
  const onRowKeyDown = (index: number) => (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); activate(index) }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const next = Math.max(0, Math.min(visibleRows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
      setActive(next)
      listRef.current?.querySelector<HTMLElement>(`[data-option-index="${next}"]`)?.focus()
    }
  }
  const jump = (letter: string) => listRef.current?.querySelector(`[data-letter-section="${letter}"]`)?.scrollIntoView({ block: 'start' })

  // 左栏(手机:横滑分段)的一项;搜索时数的是命中数,另多一项「全部结果」。
  const sourceButton = (key: string, label: string, count: number) => {
    const picked = key === 'all' ? 0 : selected.filter((id) => model.sourcesOf(id).includes(key)).length
    return (
      <Button key={key} variant="option" size="sm" role="radio" aria-checked={result ? searchScope === key : sourceKey === key} data-picker-source={key} onClick={() => pickSource(key)}
        className={cn('shrink-0 gap-2', mobile ? '!rounded-[var(--radius-capsule)]' : 'w-full justify-start !border-transparent', result && count === 0 && 'text-[var(--faint-fg)]')}>
        <span className={cn(!mobile && 'min-w-0 flex-1 truncate text-left')}>{label}</span>
        {picked > 0 ? <span className="text-[length:var(--font-caption)] text-[var(--primary)]">✓{picked}</span> : null}
        <span className="text-[length:var(--font-caption)] tabular-nums text-[var(--faint-fg)]">{count}</span>
      </Button>
    )
  }
  const sourceButtons = [
    ...(result ? [sourceButton('all', t('memberPicker.allResults'), searchRows.length)] : []),
    ...sources.map((s) => sourceButton(s.key, labelOf(s), result ? scopeCounts.get(s.key) ?? 0 : s.entries.length)),
  ]
  const confirmButton = (
    <Button variant="primary" size={mobile ? 'sm' : 'md'} disabled={!canConfirm} onClick={() => void confirm()}>
      {busy && busyLabel ? busyLabel : confirmLabel(selected.length)}
    </Button>
  )

  let lastLetter: string | null = null
  const list = visibleRows.map((row, index) => {
    const id = row.entry.contact.id
    const letter = letters ? getPinyinInitial(displayName(row.entry.contact)) : null
    const header = letter && letter !== lastLetter ? <SectionLabel key={`letter-${letter}`} data-letter-section={letter} className="sticky top-0 z-[var(--z-raised)] bg-[var(--modal-bg)]">{letter}</SectionLabel> : null
    lastLetter = letter ?? lastLetter
    const option = (
      <PickerOption key={id} row={row} index={index} mobile={mobile} active={index === activeIndex} checked={isLocked(id) || selected.includes(id)} locked={isLocked(id)}
        where={showWhere ? deviceLabelOf(id) : null} note={agentNote?.(id)} onToggle={() => { setActive(index); activate(index) }} onKeyDown={onRowKeyDown(index)} />
    )
    return header ? [header, option] : option
  })
  const loading = contacts.length === 0 && (refreshing || loadingContacts || contactsStatus === 'loading')
  const failed = contacts.length === 0 && !refreshing && !loadingContacts && contactsStatus === 'error'
  const emptyText = contacts.length === 0 ? t('createGroup.emptyContacts') : t('createGroup.noResults')

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="member-picker">
      <div className={cn('flex items-center gap-2', mobile ? '!px-3 !pt-3 !pb-2' : '!px-5 !pt-4 !pb-3')}>
        {mobile ? <IconButton aria-label={t('common.close')} onClick={onClose}><X size={18} /></IconButton> : null}
        <h3 className={cn('m-0 min-w-0 flex-1 truncate text-[length:var(--font-heading)] font-semibold text-[var(--text-primary)]', mobile && 'text-center')}>{title}</h3>
        {mobile ? confirmButton : <IconButton aria-label={t('common.close')} onClick={onClose}><X size={18} /></IconButton>}
      </div>
      <div className={mobile ? '!px-3 !pb-2' : '!px-5 !pb-2'}>
        <SearchField value={query} onChange={(event) => changeQuery(event.target.value)} onKeyDown={onSearchKeyDown} placeholder={t('createGroup.searchPlaceholder')}
          clearLabel={t('friendSearch.clearSearch')} onClear={() => changeQuery('')} autoFocus={!mobile}
          role="combobox" aria-expanded aria-controls="member-picker-list" aria-activedescendant={visibleRows[activeIndex] ? `member-option-${visibleRows[activeIndex].entry.contact.id}` : undefined} />
      </div>
      {selected.length > 0 ? (
        <div className={cn('flex shrink-0 gap-2 overflow-x-auto !pb-2', mobile ? '!px-3' : '!px-5')}>
          {selected.map((id) => { const contact = entryOf.get(id)?.contact; if (!contact) return null; return (
            <Button key={id} variant="secondary" size="sm" onClick={() => toggle(id)} aria-label={t('createGroup.removeMember', { name: displayName(contact) })} className="shrink-0 gap-2 !rounded-[var(--radius-capsule)] !pl-1">
              <Avatar name={contact.display_name} avatarUrl={contact.avatar} seed={contact.id} size="xs" isAgent={contact.type === 'agent'} />
              <span className="max-w-[160px] truncate">{displayName(contact)}</span><X size={12} />
            </Button>
          ) })}
        </div>
      ) : null}
      {mobile ? <div role="radiogroup" className="flex shrink-0 gap-2 overflow-x-auto !px-3 !pb-2">{sourceButtons}</div> : null}
      <div className="flex min-h-0 flex-1 border-t border-[var(--border-subtle)]">
        {!mobile ? <nav role="radiogroup" className="flex w-[178px] shrink-0 flex-col gap-1 overflow-y-auto border-r border-[var(--border-subtle)] !p-2">{sourceButtons}</nav> : null}
        <div className="relative flex min-w-0 flex-1 flex-col">
          {projects.length > 0 ? (
            <div role="radiogroup" className="flex shrink-0 flex-wrap gap-2 !px-3 !pt-2">
              {[{ name: null, count: source.entries.length }, ...projects].map((p) => (
                <Button key={p.name ?? ''} variant="option" size="sm" role="radio" aria-checked={project === p.name} onClick={() => { setProject(p.name); setActive(0) }} className="!rounded-[var(--radius-capsule)]">
                  {p.name ?? t('memberPicker.allProjects')} <span className="tabular-nums text-[var(--faint-fg)]">{p.count}</span>
                </Button>
              ))}
            </div>
          ) : null}
          <div ref={listRef} id="member-picker-list" role="listbox" aria-multiselectable="true" className={cn('min-h-0 flex-1 overflow-y-auto !px-2 !pb-3', letters && !mobile && '!pr-6')}>
            {loading ? <p className="!m-0 !p-8 text-center text-[length:var(--font-body)] text-[var(--faint-fg)]">{t('common.loading')}</p>
              : failed ? <div className="!p-8 text-center text-[length:var(--font-body)] text-[var(--faint-fg)]">{t('common.loadFailed')} <Button variant="ghost" size="sm" onClick={() => void reload()}>{t('common.retry')}</Button></div>
              : showPeopleDenied ? <p data-testid={AUTOMATION_TEST_IDS.groupMembersPickerHumanDenied} className="!m-0 !p-6 text-center text-[length:var(--font-body)] leading-relaxed text-[var(--text-tertiary)]">{peopleDenied}</p>
              : visibleRows.length === 0 ? <p className="!m-0 !p-8 text-center text-[length:var(--font-body)] text-[var(--faint-fg)]">{emptyText}</p>
              : list}
          </div>
          {letters ? <ContactsAzIndex mobile={mobile} present={new Set(visibleRows.map((row) => getPinyinInitial(displayName(row.entry.contact))))} onPick={jump} /> : null}
        </div>
      </div>
      {!refreshing && contactsStatus === 'ready' && unavailableSelection ? <p role="alert" className="!m-0 !px-5 !py-2 text-[length:var(--font-caption)] text-[var(--danger)]">{t('memberPicker.selectionUnavailable')}</p> : null}
      {footer}
      {!mobile ? <div className="flex shrink-0 justify-end border-t border-[var(--border-subtle)] !px-5 !py-3">{confirmButton}</div> : null}
    </div>
  )
}

/** 一行:主文字是这个成员在群里显示的名字;Agent 后面是 harness 图标与状态点,任务(或项目)降为淡色。 */
function PickerOption({ row, index, mobile, active, checked, locked, where, note, onToggle, onKeyDown }: {
  row: Row
  index: number
  mobile: boolean
  active: boolean
  checked: boolean
  locked: boolean
  where: string | null
  note?: string
  onToggle: () => void
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
}) {
  const { t } = useTranslation('contacts')
  const { entry, hit } = row
  const { contact } = entry
  const isAgent = contact.type === 'agent'
  const { status, presence } = useAgentDisplayStatus(isAgent ? contact.id : null)
  const { tone, label } = useShownAgentContactStatus(contact.id, status, presence.presentation)
  const name = displayName(contact)
  const nameText = hit?.field === 'title' ? <Marked text={name} hits={hit.hits} /> : name
  const faint = note
    ?? (hit && hit.field !== 'title' && hit.field !== 'device' && hit.field !== 'type' ? <Marked text={hit.text} hits={hit.hits} /> : null) // 设备在行尾、类型就是图标,❌ 再说一遍
    ?? (isAgent ? entry.task ?? entry.project : contact.gugu_number == null ? null : `${t('common.guguNumber')} ${contact.gugu_number}`)
  const time = entry.lastAt ? formatCalendarDay(new Date(entry.lastAt).toISOString()) : ''
  const marks = isAgent ? (
    <span className="inline-flex shrink-0 items-center gap-1" title={label} aria-label={label}>
      <AgentHarnessIcon agentId={contact.id} size={14} />
      <AgentContactStatusMark tone={tone} />
    </span>
  ) : null
  return (
    <ListRow
      role="option"
      id={`member-option-${contact.id}`}
      data-contact-option={contact.id}
      data-option-index={index}
      aria-selected={checked}
      aria-disabled={locked || undefined}
      tabIndex={active ? 0 : -1}
      selected={active && !mobile}
      mobile={mobile}
      className={cn(locked && 'opacity-60')}
      leading={<>
        <SelectionCheckbox checked={checked} />
        <Avatar name={contact.display_name} avatarUrl={contact.avatar} seed={contact.id} size={mobile ? 'md' : 'sm'} isAgent={isAgent} harnessBadge={false} />
      </>}
      title={nameText}
      accessory={mobile ? marks : <>{marks}{faint ? <span className="min-w-0 flex-1 truncate !pl-1 text-[length:var(--font-caption)] text-[var(--faint-fg)]">{faint}</span> : null}</>}
      meta={mobile || !where ? time : `${where} · ${time}`}
      subtitle={mobile ? <>{where ? `${where} · ` : ''}{faint}</> : undefined}
      onClick={onToggle}
      onKeyDown={onKeyDown}
    />
  )
}
