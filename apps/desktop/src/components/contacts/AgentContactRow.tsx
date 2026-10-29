import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { useAgentDisplayStatus } from '@/hooks/useAgentDisplayStatus'
import { useRowContextMenu } from '@/hooks/useRowContextMenu'
import { displayName } from '@/lib/contactsListSort'
import { Zap } from '@/lib/icons'
import { Avatar } from '../Avatar'
import { AgentContactStatusMark } from '../AgentContactStatusMark'
import { agentContactPresentation, useShownAgentContactStatus, agentContactRowStatusClass } from '../contactAgentTone'
import { Chip } from '../ui/Chip'
import { ListRow } from '../ui/ListRow'
import { SelectionCheckbox } from './ContactSearch'
import { ContactRowContextMenu, ContactRowDeleteButton, type ContactRowMenuActions } from './ContactRowActions'
import { agentAvatarClass, boltClass, ct, rowKeyActivate } from './contactsPanelStyles'

export function AgentContactRow({
  contact,
  selected,
  multiSelected = false,
  selectionMode = false,
  pinned = false,
  mobile = false,
  testId,
  onSelect,
  onToggleSelection,
  menu
}: {
  contact: ContactUser
  selected: boolean
  mobile?: boolean
  testId?: string
  multiSelected?: boolean
  selectionMode?: boolean
  pinned?: boolean
  onSelect: () => void
  onToggleSelection?: () => void
  menu?: ContactRowMenuActions
}) {
  const { status, presence } = useAgentDisplayStatus(contact.id)
  const { tone, label: statusLabel } = useShownAgentContactStatus(contact.id, status, presence.presentation) // #7199 收回着 ≠ 不在线
  const { allowsLiveActions } = agentContactPresentation(status)
  const { menuPos, onContextMenu, closeMenu } = useRowContextMenu()
  const rowActions = allowsLiveActions ? menu : undefined
  return (
    <>
      {/* #3253 host 包一层：删除钮浮在行上而不是嵌进行里，行底色由 .gg-row-host:hover 接管
          （tokens.css），否则指针移到钮上行就不高亮了。机制不变，只是行本身换成了 ListRow。 */}
      <div className="gg-row-host group/contact-row relative">
      <ListRow
        role="button"
        tabIndex={0}
        data-contact-id={contact.id}
        data-testid={testId}
        data-contact-option={selectionMode ? contact.id : undefined}
        aria-pressed={selectionMode ? multiSelected : undefined}
        selected={selected}
        pinned={pinned}
        mobile={mobile}
        leading={
          <>
            {selectionMode ? <SelectionCheckbox checked={multiSelected} /> : null}
            <div className={agentAvatarClass(tone)} style={mobile ? { width: 'var(--avatar-md)', height: 'var(--avatar-md)' } : undefined}>
              <Avatar name={contact.display_name} avatarUrl={contact.avatar} seed={contact.id} size={mobile ? 'md' : 'sm'} isAgent agentStatus={status === 'needs_user' ? status : undefined} />
            </div>
          </>
        }
        title={displayName(contact)}
        accessory={
          <>
            <span className={boltClass}><Zap size={11} /></span>
            {allowsLiveActions && contact.agent_public ? <Chip>{ct('panel.shared')}</Chip> : null}
          </>
        }
        subtitle={
          <span className={agentContactRowStatusClass(tone)}>
            <AgentContactStatusMark tone={tone} />
            {statusLabel}
          </span>
        }
        onClick={() => (selectionMode ? onToggleSelection?.() : onSelect())}
        onKeyDown={rowKeyActivate(() => (selectionMode ? onToggleSelection?.() : onSelect()))}
        onContextMenu={rowActions ? onContextMenu : undefined}
      />
      {rowActions ? (
        <ContactRowDeleteButton label={rowActions.removeLabel} onRemove={rowActions.onRemove} />
      ) : null}
      </div>
      {allowsLiveActions && menu && menuPos ? (
        <ContactRowContextMenu x={menuPos.x} y={menuPos.y} onClose={closeMenu} {...menu} />
      ) : null}
    </>
  )
}
