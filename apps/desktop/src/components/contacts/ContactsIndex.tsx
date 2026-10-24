import { useMemo, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronLeft } from '@/lib/icons'
import { cn } from '@/lib/cn'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { displayName, groupContacts, PINNED_CONTACTS_SECTION } from '../../lib/contactsListSort'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import { useAgentDisplayStatus } from '../../hooks/useAgentDisplayStatus'
import { useShownAgentStatus } from '../chat/useAgentsOnCloudComputer'
import { useRowContextMenu } from '../../hooks/useRowContextMenu'
import { Avatar } from '../Avatar'
import { agentContactPresentation } from '../contactAgentTone'
import { ContactRowContextMenu } from './ContactRowActions'
import { RemovedAgentContactBadge } from './ContactProfileCard'
import { ContactsAgentSectionState, ContactsPersonSectionState } from './ContactsSectionState'
import { useTranslation } from 'react-i18next'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { ListRow } from '../ui/ListRow'
import { Pane, PaneHeader } from '../ui/Pane'
import { SectionLabel } from '../ui/SectionLabel'
import { ContactsListDock } from './ContactsListDock'
import { useDevicesStore } from '../../store/devicesContext'
import { useDisplayDevices } from '@/hooks/useAssistantHomeLabel'
import { partitionContactsByDevice } from './contactsByDevice'
import { useBackLayer } from '../ui/sheetStack'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { ContactsAzIndex } from './ContactsLetterPicker'
import { SelectionCheckbox } from './ContactSearch'

// @@@ui-ruler 移动壳的联系人索引也只吃原语:列 → Pane nav、列头 → PaneHeader、行 → ListRow、
// 字母分区头 → SectionLabel(加 sticky)。原来这里另写了一套 56/42 行高、11/9 间距、15/13 字号。
const rowKeyActivate = (activate: () => void) => (event: KeyboardEvent<HTMLDivElement>) => {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  activate()
}

function ContactRow({ contact, currentUserId, selected, multiSelected, selectionMode, onSelect, onToggleSelection, onRemove, onStartChat, onPin, onMarkUnread, onToggleNotif, isPinned, notifMuted, removeLabel, mobile }: {
  contact: ContactUser
  currentUserId?: string | null
  selected: boolean
  multiSelected: boolean
  selectionMode: boolean
  onSelect: () => void
  onToggleSelection: () => void
  onRemove?: (contact: ContactUser) => void
  onStartChat?: (contact: ContactUser) => void
  onPin?: (contact: ContactUser) => void
  onMarkUnread?: (contact: ContactUser) => void
  onToggleNotif?: (contact: ContactUser) => void
  isPinned: boolean
  notifMuted: boolean
  removeLabel: string
  mobile: boolean
}) {
  const { menuPos, onContextMenu, closeMenu } = useRowContextMenu()
  const { status } = useAgentDisplayStatus(contact.type === 'agent' ? contact.id : null)
  const { allowsLiveActions } = agentContactPresentation(status)
  const shownStatus = useShownAgentStatus().status(contact.id, status) // #7199 宿主闲时收回着:不画睡团
  const isAnotherUsersAgent = contact.type === 'agent' && Boolean(contact.owner_user_id) && contact.owner_user_id !== currentUserId
  const canSelect = selectionMode && !isAnotherUsersAgent
  const hasRowMenu = !selectionMode && !isAnotherUsersAgent && allowsLiveActions && Boolean(onStartChat || onPin || onMarkUnread || onToggleNotif || onRemove)
  return (
    <>
      <ListRow
        role="button"
        tabIndex={0}
        data-contact-id={contact.id}
        data-contact-option={canSelect ? contact.id : undefined}
        aria-pressed={canSelect ? multiSelected : undefined}
        selected={selected}
        pinned={isPinned}
        mobile={mobile}
        className="!rounded-none"
        leading={
          <>
            {canSelect ? <SelectionCheckbox checked={multiSelected} /> : null}
            <Avatar name={contact.display_name} avatarUrl={contact.avatar} seed={contact.id} size={mobile ? 'md' : 'sm'} isAgent={contact.type === 'agent'} agentStatus={contact.type === 'agent' ? shownStatus : undefined} />
          </>
        }
        title={displayName(contact)}
        accessory={!allowsLiveActions ? <RemovedAgentContactBadge /> : null}
        onClick={canSelect ? onToggleSelection : onSelect}
        onKeyDown={rowKeyActivate(canSelect ? onToggleSelection : onSelect)}
        onContextMenu={hasRowMenu ? onContextMenu : undefined}
      />
      {hasRowMenu && menuPos ? <ContactRowContextMenu x={menuPos.x} y={menuPos.y} removeLabel={removeLabel} onClose={closeMenu} onRemove={() => onRemove?.(contact)} onStartChat={onStartChat ? () => onStartChat(contact) : undefined} isPinned={isPinned} notifMuted={notifMuted} onPin={() => onPin?.(contact)} onMarkUnread={() => onMarkUnread?.(contact)} onToggleNotif={() => onToggleNotif?.(contact)} /> : null}
    </>
  )
}

export function ContactsIndex({ title, subtitle, summaryLabel, headerActions, mobile = false, contacts, currentUserId, loading, selectedContactId, selectionMode, selectedContactIds, onEnterSelectionMode, onFinishSelectionMode, onToggleContact, onCreateGroupFromSelection, onBack, onAddContact, onCreateAgent, onSelect, onRemoveContact, onStartChat, onPin, onMarkUnread, onToggleNotif, contactPinned, contactNotifMuted, getContactRemoveLabel, sectionBy }: {
  title: string
  /** #5019 'device' = 按设备分段(本机 → 其他设备 → 咕咕云)而不是首字母;agent 列表用。 */
  sectionBy?: 'device'
  subtitle?: string
  summaryLabel?: string
  headerActions?: ReactNode
  mobile?: boolean
  contacts: ContactUser[]
  currentUserId?: string | null
  loading: boolean
  selectedContactId?: string
  selectionMode: boolean
  selectedContactIds: Set<string>
  onEnterSelectionMode: () => void
  onFinishSelectionMode: () => void
  onToggleContact: (contact: ContactUser) => void
  onCreateGroupFromSelection: () => void
  onBack?: () => void
  onAddContact?: () => void
  onCreateAgent?: () => void
  onSelect: (contact: ContactUser) => void
  onRemoveContact?: (contact: ContactUser) => void
  onStartChat?: (contact: ContactUser) => void
  onPin?: (contact: ContactUser) => void
  onMarkUnread?: (contact: ContactUser) => void
  onToggleNotif?: (contact: ContactUser) => void
  contactPinned?: Map<string, boolean>
  contactNotifMuted?: Map<string, boolean>
  getContactRemoveLabel: (contact: ContactUser) => string
}) {
  const { t } = useTranslation('contacts')
  const listRef = useRef<HTMLDivElement>(null)
  useBackLayer(onBack, mobile) // 手机整页:安卓返回键 = 左上返回
  // #7199 个人助理住的那台那一段,段名是它的名字(用户看不到它住在哪)。
  const devices = useDisplayDevices(useDevicesStore().devices)
  const groups = useMemo(() => {
    if (sectionBy !== 'device') return groupContacts(contacts, (contact) => contactPinned?.get(contact.id) ?? false)
    // #5019 按设备分段:标题与桌面三段侧栏同一套文案;主段空着也保留(空态由下面的空列表分支给)。
    return partitionContactsByDevice(contacts, [], devices, currentUserId)
      .sections.filter((section) => section.agents.length > 0)
      .map((section) => ({
        letter: section.scope === 'local' ? t('panel.localDeviceSectionTitle')
          : section.scope === 'cloud' ? t('panel.cloudDeviceSectionTitle')
          : section.scope === 'device' ? (section.displayLabel ?? section.key)
          : t('panel.agentSectionTitle'),
        items: section.agents,
      }))
  }, [contacts, contactPinned, sectionBy, devices, currentUserId, t])
  const presentLetters = useMemo(() => new Set(groups.map((group) => group.letter)), [groups])
  const showAzRail = sectionBy !== 'device' && contacts.length >= 12
  const jump = (letter: string) => listRef.current?.querySelector(`[data-letter-section="${letter}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  return (
    <Pane paneRole="nav" mobile={mobile}>
      <PaneHeader
        mobile={mobile}
        leading={mobile && onBack ? <IconButton aria-label={t('panel.backToContacts')} onClick={onBack}><ChevronLeft /></IconButton> : undefined}
        title={title}
        subtitle={subtitle}
        titleLevel={mobile && !onBack ? 'page' : 'panel'}
        actions={selectionMode ? <Button variant="ghost" size="sm" data-testid={AUTOMATION_TEST_IDS.contactsSelectModeDoneButton} onClick={onFinishSelectionMode} className="text-[var(--primary)]">{t('panel.selectModeDone')}</Button> : headerActions}
      />
      {loading ? <div className="grid flex-1 place-items-center"><LoadingIndicator ariaLabel={t('common.loading')} /></div> : contacts.length === 0 ? <div className="grid flex-1 place-items-center">{sectionBy === 'device' ? <ContactsAgentSectionState isEmpty onCreateAgent={onCreateAgent} align="center" /> : <ContactsPersonSectionState isEmpty onAddContact={onAddContact} align="center" />}</div> : (
        <div className="relative min-h-0 flex-1">
          <div ref={listRef} className={cn('h-full overflow-y-auto', showAzRail && !mobile && '!pr-6')}>
            {groups.map(({ letter, items }) => <div key={letter} data-letter-section={letter}>
              {letter !== PINNED_CONTACTS_SECTION ? <SectionLabel className="sticky top-0 z-[var(--z-raised)] bg-[var(--sidebar)]">{letter}</SectionLabel> : null}
              {items.map((contact) => <ContactRow key={contact.id} contact={contact} currentUserId={currentUserId} selected={!mobile && !selectionMode && contact.id === selectedContactId} multiSelected={selectedContactIds.has(contact.id)} selectionMode={selectionMode} onSelect={() => onSelect(contact)} onToggleSelection={() => onToggleContact(contact)} onRemove={onRemoveContact} onStartChat={onStartChat} onPin={onPin} onMarkUnread={onMarkUnread} onToggleNotif={onToggleNotif} isPinned={contactPinned?.get(contact.id) ?? false} notifMuted={contactNotifMuted?.get(contact.id) ?? false} removeLabel={getContactRemoveLabel(contact)} mobile={mobile} />)}
            </div>)}
          </div>
          {showAzRail ? <ContactsAzIndex mobile={mobile} present={presentLetters} onPick={jump} /> : null}
        </div>
      )}
      <ContactsListDock
        mobile={mobile}
        selectionMode={selectionMode}
        selectedCount={selectedContactIds.size}
        summaryLabel={summaryLabel ?? t('panel.contactCountSummary', { count: contacts.length })}
        canEnterSelectionMode={contacts.length > 0}
        onEnterSelectionMode={onEnterSelectionMode}
        onCreateGroupFromSelection={onCreateGroupFromSelection}
      />
    </Pane>
  )
}
