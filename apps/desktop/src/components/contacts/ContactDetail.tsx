// 联系人详情(人 / Agent)和它用到的几块:原样从 ContactsPanel.tsx 搬出(那个文件行数冻结、只减不增),
// 手机「伙伴」点一个朋友也开这一页(#446)。
import { useEffect, useState } from 'react'
import { agentContactPresentation, useShownAgentContactStatus } from '../contactAgentTone'
import { Pane, PaneHeader } from '../ui/Pane'
import { ListRow } from '../ui/ListRow'
import { IconButton as UiIconButton } from '../ui/IconButton'
import { useBackLayer } from '../ui/sheetStack'
import { Chip } from '../ui/Chip'
import { BellOff, ChevronLeft, Eye, EyeOff, Mail, MessageCircle, Power, SquareTerminal, UserPlus } from '@/lib/icons'
import { useAuth } from '../../store/auth'
import { ActionButton, AgentContactStatusChip, FieldList, FieldRow } from '../contactsDetailControls'
import { Avatar } from '../Avatar'
import { CopyValue } from '../CopyValue'
import { ContactGroupAvatar } from './ContactSearch'
import { OwnedAgentNameEditor } from './OwnedAgentNameEditor'
import type { ContactGroupChat, ContactUser } from '@gugu/core/shared/types/contacts'
import { useAgentDisplayStatus } from '../../hooks/useAgentDisplayStatus'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import { platform } from '../../platform'
import { PersonAliasField } from './ContactProfileCard'
import { commonGroupForAgent, requestStateForAgent, type AgentRequestState } from './agentContactRequest'
import { ContactRowContextMenu, type ContactRowMenuActions } from './ContactRowActions'
import { useRowContextMenu } from '../../hooks/useRowContextMenu'
import { ShareAgentModal } from './ShareAgentModal'
import { cn } from '@/lib/cn'
import { chatPublicId, displayName, userPublicId } from '../../lib/contactsListSort'
import {
  ct, detailBlockClass, detailBodyClass, detailCaptionClass, detailNoticeClass, detailPlaceholderClass, detailTitleClass,
  formatDateTime, getAgentProjectPath, rowKeyActivate
} from './contactsPanelStyles'

/** 移动壳详情页的返回键:列头 leading 槽,44 触控命中框(#4292);安卓返回键走同一个 onBack。 */
export function PaneBackButton({ label, onBack }: { label: string; onBack: () => void }) {
  useBackLayer(onBack)
  return <UiIconButton aria-label={label} onClick={onBack}><ChevronLeft /></UiIconButton>
}


function CommonGroups({
  contactId,
  getCommonGroupChats,
  onOpenGroupChat
}: {
  contactId: string
  getCommonGroupChats: (contactId: string) => Promise<ContactGroupChat[]>
  onOpenGroupChat?: (group: ContactGroupChat) => void
}) {
  const [groups, setGroups] = useState<ContactGroupChat[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    getCommonGroupChats(contactId)
      .then((data) => {
        if (!cancelled) setGroups(data)
      })
      .catch((err) => {
        console.error('[ContactsPanel] load common group chats error', err)
        if (!cancelled) {
          setGroups([])
          setError(err instanceof Error ? err.message : ct('commonGroups.loadFailed'))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [contactId, getCommonGroupChats])

  return (
    <div className={detailBlockClass}>
      <div className={cn(detailCaptionClass, '!mb-2')}>{ct('commonGroups.title')}</div>
      {loading ? (
        <div className={detailNoticeClass}>{ct('commonGroups.loading')}</div>
      ) : error ? (
        <div role="alert" className={cn(detailNoticeClass, 'text-[var(--danger)]')}>{error}</div>
      ) : groups.length === 0 ? (
        <div className={detailNoticeClass}>{ct('commonGroups.empty')}</div>
      ) : (
        <div className="overflow-hidden rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--input-bg)]">
          {groups.map((group) => (
            <GroupChatRow
              key={group.id}
              group={group}
              selected={false}
              onSelect={() => onOpenGroupChat?.(group)}
              cardId={group.id}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function HumanDetail({
  contact,
  onSwitchToChat,
  onOpenGroupChat,
  getCommonGroupChats
}: {
  contact: ContactUser
  onSwitchToChat?: (target: ContactUser) => void
  onOpenGroupChat?: (group: ContactGroupChat) => void
  getCommonGroupChats: (contactId: string) => Promise<ContactGroupChat[]>
}) {
  const name = displayName(contact)
  const hasFields = Boolean(contact.email || contact.bio)

  return (
    <>
      <div className="flex items-start gap-4">
        <Avatar name={contact.display_name} avatarUrl={contact.avatar} seed={contact.id} size="lg" />
        <div className="min-w-0 flex-1">
          <h2 className={detailTitleClass}>{name}</h2>
          {contact.alias ? (
            <div className={cn(detailCaptionClass, '!mt-1')}>
              {ct('profile.originalName')}：{contact.display_name}
            </div>
          ) : null}
          {contact.email ? (
            <div className="!mt-2 flex items-center gap-2 text-sm text-[var(--muted-fg)]">
              <Mail size={14} />
              <span>{contact.email}</span>
            </div>
          ) : null}
          <PersonAliasField contact={contact} />
        </div>
      </div>

      <div className="!mt-4 flex flex-wrap gap-2">
        <ActionButton
          primary
          icon={<MessageCircle size={15} />}
          label={ct('common.sendMessage')} testId={AUTOMATION_TEST_IDS.contactsDetailSendMessageButton}
          onClick={() => onSwitchToChat?.(contact)}
        />
      </div>

      <FieldList className={detailBlockClass}>
        <FieldRow
          label={ct('common.guguNumber')}
          value={
            userPublicId(contact) ? (
              <CopyValue value={userPublicId(contact)!} message={ct('common.copiedGuguNumber')} />
            ) : (
              ct('common.unassigned')
            )
          }
        />
        {hasFields && contact.email ? <FieldRow label={ct('profile.email')} value={contact.email} /> : null}
        {hasFields && contact.bio ? <FieldRow label={ct('profile.bio')} value={contact.bio} /> : null}
      </FieldList>

      <CommonGroups
        contactId={contact.id}
        getCommonGroupChats={getCommonGroupChats}
        onOpenGroupChat={onOpenGroupChat}
      />
    </>
  )
}

function AgentDetail({
  contact,
  humanContacts,
  onSwitchToChat,
  onOpenGroupChat,
  onSetAgentPublic,
  onSetAgentDesiredStatus,
  requestState,
  onRequest,
  commonGroup,
  getCommonGroupChats
}: {
  contact: ContactUser
  humanContacts: ContactUser[]
  onSwitchToChat?: (target: ContactUser) => void
  onOpenGroupChat?: (group: ContactGroupChat) => void
  onSetAgentPublic: (agentId: string, agentPublic: boolean) => Promise<void>
  onSetAgentDesiredStatus: (agentId: string, desiredStatus: 'online' | 'offline') => Promise<void>
  requestState: AgentRequestState | null
  onRequest?: () => void
  commonGroup: ContactGroupChat | null
  getCommonGroupChats: (contactId: string) => Promise<ContactGroupChat[]>
}) {
  const { user } = useAuth()
  const [showShareModal, setShowShareModal] = useState(false)
  const [visibilitySaving, setVisibilitySaving] = useState(false)
  const { status, presence, opening, openRuntime: handleOpenRuntime } = useAgentDisplayStatus(contact.id)
  const { tone: statusTone, label: statusLabel } = useShownAgentContactStatus(contact.id, status, presence.presentation) // #7199
  const desiredStatus = contact.desired_status === 'offline' ? 'offline' : 'online'
  const isOwned = Boolean(user?.id && contact.owner_user_id === user.id)
  const sourceText = isOwned ? ct('profile.ownedSource') : contact.owner_user_id ? ct('profile.otherOwnerSource') : ct('common.unknown')
  const [desiredStatusSaving, setDesiredStatusSaving] = useState(false)
  const { allowsLiveActions } = agentContactPresentation(status)
  const requestLabel = requestState === 'requested'
    ? ct('commonGroups.requested')
    : requestState === 'requesting'
      ? ct('commonGroups.requesting')
      : ct('commonGroups.requestJoin')
  const canOpenCommonGroup = Boolean(!isOwned && commonGroup && onOpenGroupChat)
  useEffect(() => {
    if (allowsLiveActions) return
    setShowShareModal(false)
  }, [allowsLiveActions])
  const togglePublic = async () => {
    if (!isOwned || !allowsLiveActions || visibilitySaving) return
    setVisibilitySaving(true)
    try {
      await onSetAgentPublic(contact.id, !contact.agent_public)
    } finally {
      setVisibilitySaving(false)
    }
  }
  const toggleDesiredStatus = async () => {
    if (!isOwned || !allowsLiveActions || desiredStatusSaving) return
    setDesiredStatusSaving(true)
    try {
      await onSetAgentDesiredStatus(contact.id, desiredStatus === 'offline' ? 'online' : 'offline')
    } finally {
      setDesiredStatusSaving(false)
    }
  }

  return (
    <>
      <div className="flex items-start gap-4">
        <Avatar name={contact.display_name} avatarUrl={contact.avatar} seed={contact.id} size="lg" isAgent />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <OwnedAgentNameEditor key={contact.id} agentId={contact.id} name={contact.display_name} ownerUserId={contact.owner_user_id} status={status} className={detailTitleClass}>
              <h2>{contact.display_name}</h2>
            </OwnedAgentNameEditor>
            <Chip>{ct('common.agent')}</Chip>
            <AgentContactStatusChip agentId={contact.id} tone={statusTone} label={statusLabel} />
          </div>
          {contact.bio ? (
            <p className="!mt-2 max-w-[620px] text-sm text-[var(--muted-fg)]">
              {contact.bio}
            </p>
          ) : null}
        </div>
      </div>

      {(allowsLiveActions && isOwned) || canOpenCommonGroup || (!commonGroup && requestState) ? <div className="!mt-4 flex flex-wrap gap-2">
        {allowsLiveActions && isOwned ? <ActionButton
          primary
          icon={<MessageCircle size={15} />}
          label={ct('common.sendMessage')} testId={AUTOMATION_TEST_IDS.contactsDetailSendMessageButton}
          onClick={() => onSwitchToChat?.(contact)}
        /> : null}
        {!isOwned && commonGroup && onOpenGroupChat ? (
          <ActionButton
            primary
            icon={<MessageCircle size={15} />}
            label={ct('commonGroups.open')}
            onClick={() => onOpenGroupChat?.(commonGroup)}
          />
        ) : null}
        {!isOwned && !commonGroup && requestState ? (
          <ActionButton
            primary={requestState === 'available'}
            icon={<UserPlus size={15} />}
            label={requestLabel}
            disabled={requestState !== 'available'}
            onClick={requestState === 'available' ? onRequest : undefined}
          />
        ) : null}
        {isOwned ? (
          <ActionButton
            icon={<UserPlus size={15} />}
            label={ct('profile.inviteToAgent')}
            onClick={() => setShowShareModal(true)}
          />
        ) : null}
        {isOwned ? (
          <ActionButton
            icon={contact.agent_public ? <EyeOff size={15} /> : <Eye size={15} />}
            label={visibilitySaving ? ct('profile.saving') : contact.agent_public ? ct('profile.setPrivate') : ct('profile.setPublic')}
            disabled={visibilitySaving}
            onClick={togglePublic}
          />
        ) : null}
        {isOwned ? (
          <ActionButton
            icon={<Power size={15} />}
            label={
              desiredStatusSaving ? ct('profile.saving') : desiredStatus === 'offline' ? ct('profile.setOnline') : ct('profile.setOffline')
            }
            disabled={desiredStatusSaving}
            onClick={toggleDesiredStatus}
          />
        ) : null}
        {platform.capabilities.agentRuntime && isOwned ? (
          <ActionButton
            icon={<SquareTerminal size={15} />}
            label={opening ? ct('profile.opening') : ct('profile.openRuntime')}
            disabled={opening}
            onClick={handleOpenRuntime}
            testId={AUTOMATION_TEST_IDS.contactAgentRuntimeOpenButton}
          />
        ) : null}
      </div> : null}

      <FieldList className={detailBlockClass}>
        <FieldRow
          label={ct('common.guguNumber')}
          value={
            userPublicId(contact) ? (
              <CopyValue value={userPublicId(contact)!} message={ct('common.copiedGuguNumber')} />
            ) : (
              ct('common.unassigned')
            )
          }
        />
        {statusLabel ? <FieldRow label={ct('profile.currentStatus')} value={statusLabel} /> : null}
        {allowsLiveActions ? <FieldRow label={ct('profile.desiredStatus')} value={desiredStatus === 'offline' ? ct('profile.manualOffline') : ct('profile.online')} /> : null}
        <FieldRow label={ct('profile.source')} value={sourceText} />
        <FieldRow label={ct('profile.createdAt')} value={formatDateTime(contact.created_at)} />
        {allowsLiveActions ? (
          <FieldRow
            label={ct('profile.publicStatus')}
            value={contact.agent_public ? ct('profile.publicValue') : ct('profile.privateValue')}
          />
        ) : null}
        <FieldRow label={ct('profile.projectPath')} value={getAgentProjectPath(contact) ?? ct('profile.unconfigured')} />
        {contact.email ? <FieldRow label={ct('profile.email')} value={contact.email} /> : null}
        {contact.bio ? <FieldRow label={ct('profile.bio')} value={contact.bio} /> : null}
      </FieldList>
      <CommonGroups
        contactId={contact.id}
        getCommonGroupChats={getCommonGroupChats}
        onOpenGroupChat={onOpenGroupChat}
      />
      {showShareModal ? (
        <ShareAgentModal
          agent={contact}
          contacts={humanContacts}
          onClose={() => setShowShareModal(false)}
          onOpenGroupChat={onOpenGroupChat}
        />
      ) : null}
    </>
  )
}

export function ContactDetail({
  contact,
  humanContacts,
  sentRequestIds,
  requestingAgentId,
  groupChats,
  mobile = false,
  onBack,
  onSwitchToChat,
  onOpenGroupChat,
  onRequestAgent,
  onSetAgentPublic,
  onSetAgentDesiredStatus,
  getCommonGroupChats
}: {
  contact: ContactUser | null
  humanContacts: ContactUser[]
  sentRequestIds: Set<string>
  requestingAgentId: string | null
  groupChats: ContactGroupChat[]
  mobile?: boolean
  onBack?: () => void
  onSwitchToChat?: (target: ContactUser) => void
  onOpenGroupChat?: (group: ContactGroupChat) => void
  onRequestAgent: (agent: ContactUser) => Promise<void>
  onSetAgentPublic: (agentId: string, agentPublic: boolean) => Promise<void>
  onSetAgentDesiredStatus: (agentId: string, desiredStatus: 'online' | 'offline') => Promise<void>
  getCommonGroupChats: (contactId: string) => Promise<ContactGroupChat[]>
}) {
  const { user } = useAuth()
  const commonAgentGroup = contact?.type === 'agent' ? commonGroupForAgent(contact.id, groupChats) : null
  const agentRequestState = contact?.type === 'agent'
    ? requestStateForAgent({
        agent: contact,
        currentUserId: user?.id,
        commonGroup: commonAgentGroup,
        sentRequestIds,
        requestingAgentId,
      })
    : null
  return (
    <Pane paneRole="detail" mobile={mobile}>
      {/* @@@1238-top 详情列头与会话头同高同线(--pane-header-h + divider),标题走 PaneHeader 的字阶。 */}
      <PaneHeader
        divider
        mobile={mobile}
        title={contact ? displayName(contact) : ct('panel.contactDetail')}
        leading={mobile && onBack ? <PaneBackButton label={ct('panel.backToContactList')} onBack={onBack} /> : undefined}
      />

      {contact ? (
        <div className={detailBodyClass(mobile)}>
          {contact.type === 'agent' ? (
            <AgentDetail
              contact={contact}
              humanContacts={humanContacts}
              onSwitchToChat={onSwitchToChat}
              onOpenGroupChat={onOpenGroupChat}
              onSetAgentPublic={onSetAgentPublic}
              onSetAgentDesiredStatus={onSetAgentDesiredStatus}
              requestState={agentRequestState}
              onRequest={() => onRequestAgent(contact)}
              commonGroup={commonAgentGroup}
              getCommonGroupChats={getCommonGroupChats}
            />
          ) : (
            <HumanDetail
              contact={contact}
              onSwitchToChat={onSwitchToChat}
              onOpenGroupChat={onOpenGroupChat}
              getCommonGroupChats={getCommonGroupChats}
            />
          )}
        </div>
      ) : (
        <div className={detailPlaceholderClass}>{ct('panel.selectContactDetail')}</div>
      )}
    </Pane>
  )
}

export function GroupChatRow({
  group,
  selected,
  pinned = false,
  onSelect,
  cardId,
  menu,
}: {
  group: ContactGroupChat
  selected: boolean
  pinned?: boolean
  onSelect: () => void
  cardId?: string
  menu?: ContactRowMenuActions
}) {
  const { menuPos, onContextMenu, closeMenu } = useRowContextMenu()
  const kindLabel = ct('common.groupChat')
  const publicId = chatPublicId(group)
  return (
    <>
      <ListRow
        role="button"
        tabIndex={0}
        data-common-group-card={cardId}
        className="!rounded-none border-b border-[var(--border)]"
        selected={selected}
        pinned={pinned}
        emphasis={selected}
        leading={<ContactGroupAvatar group={group} size="sm" />}
        title={group.name}
        subtitle={
          <>
            {kindLabel} · {publicId ? `${ct('groupInvite.groupNumber', { number: publicId })} · ` : ''}
            {ct('groupDetail.memberCount', { count: group.member_count })}
          </>
        }
        trailing={
          group.is_muted ? (
            <span aria-label={ct('groupDetail.muted')} title={ct('groupDetail.muted')} className="flex text-[var(--muted-fg)]">
              <BellOff size={14} strokeWidth={1.8} aria-hidden="true" />
            </span>
          ) : undefined
        }
        onClick={onSelect}
        onKeyDown={rowKeyActivate(onSelect)}
        onContextMenu={menu ? onContextMenu : undefined}
      />
      {menu && menuPos ? (
        <ContactRowContextMenu x={menuPos.x} y={menuPos.y} onClose={closeMenu} {...menu} />
      ) : null}
    </>
  )
}
