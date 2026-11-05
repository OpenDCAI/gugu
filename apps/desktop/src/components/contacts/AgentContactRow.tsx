import { memo } from 'react'
import { useShownAgentName } from '@/hooks/useShownAgentName'
import type { AgentRowActions } from '@/hooks/useAgentRowActions'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { useAgentDisplayStatus } from '@/hooks/useAgentDisplayStatus'
import { useRowContextMenu } from '@/hooks/useRowContextMenu'
import { displayName } from '@/lib/contactsListSort'
import { Avatar } from '../Avatar'
import { AgentContactStatusMark } from '../AgentContactStatusMark'
import { agentContactPresentation, useShownAgentContactStatus, agentContactRowStatusClass } from '../contactAgentTone'
import { Chip } from '../ui/Chip'
import { ListRow } from '../ui/ListRow'
import { SelectionCheckbox } from './ContactSearch'
import { ContactRowContextMenu, ContactRowDeleteButton, type ContactRowMenuActions } from './ContactRowActions'
import { agentAvatarClass, ct, rowKeyActivate } from './contactsPanelStyles'

// @@@agent-row-memo - 一个 agent 变了只重画那一行:props 只有这一行自己的数据 + 一份稳定的动作,
// 行里读的也都是按 id 选择的外部 store(在线态、身份目录、设备目录),❌ 整份通讯录 / 设备 context。
export const AgentContactRow = memo(function AgentContactRow({
  contact,
  selected,
  multiSelected = false,
  selectionMode = false,
  pinned = false,
  notifMuted = false,
  mobile = false,
  testId,
  actions,
  removeLabel
}: {
  contact: ContactUser
  selected: boolean
  mobile?: boolean
  testId?: string
  multiSelected?: boolean
  selectionMode?: boolean
  pinned?: boolean
  notifMuted?: boolean
  actions: AgentRowActions
  /** 有右键菜单与删除钮时它们的那句「删除 / 移除」;没有菜单 = undefined。 */
  removeLabel?: string
}) {
  const { status, presence } = useAgentDisplayStatus(contact.id)
  const { tone, label: statusLabel } = useShownAgentContactStatus(contact.id, status, presence.presentation) // #7199 收回着 ≠ 不在线
  const { allowsLiveActions } = agentContactPresentation(status)
  const { menuPos, onContextMenu, closeMenu } = useRowContextMenu()
  const shownName = useShownAgentName({ name: displayName(contact), agentType: contact.agent_type, createdAt: selectionMode ? undefined : contact.created_at ?? undefined })
  const menu: ContactRowMenuActions | undefined = removeLabel === undefined ? undefined : {
    removeLabel, contact, isPinned: pinned, notifMuted,
    onStartChat: actions.onStartChat ? () => actions.onStartChat?.(contact) : undefined,
    onPin: () => actions.onPin(contact),
    onMarkUnread: () => actions.onMarkUnread(contact),
    onToggleNotif: () => actions.onToggleNotif(contact),
    onRemove: () => actions.onRemove(contact)
  }
  const rowActions = allowsLiveActions ? menu : undefined
  const activate = () => (selectionMode ? actions.onToggleSelection(contact) : actions.onSelect(contact))
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
              <Avatar name={shownName} avatarUrl={contact.avatar} seed={contact.id} size={mobile ? 'md' : 'sm'} isAgent agentStatus={status === 'needs_user' ? status : undefined} />
            </div>
          </>
        }
        title={shownName}
        accessory={
          <>
            {allowsLiveActions && contact.agent_public ? <Chip>{ct('panel.shared')}</Chip> : null}
          </>
        }
        subtitle={
          <span className={agentContactRowStatusClass(tone)}>
            <AgentContactStatusMark tone={tone} />
            {statusLabel}
          </span>
        }
        onClick={activate}
        onKeyDown={rowKeyActivate(activate)}
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
})
