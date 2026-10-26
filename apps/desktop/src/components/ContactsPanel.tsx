import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { AgentSettingsModal } from './agentsettings/AgentSettingsModal'
import { chatPublicId, displayName, sortContactsPinnedFirst, sortGroupChatsPinnedFirst, userPublicId } from '../lib/contactsListSort'
import {
  agentContactAvatarBadgeClass, agentContactPresentation,
  useShownAgentContactStatus,
  agentContactRowDotClass,
  agentContactRowStatusClass,
  type AgentContactTone
} from './contactAgentTone'
import { Collapse } from './ui/Collapse'
import { PaneEmptyState } from './ui/PaneEmptyState'
// @@@ui-ruler 通讯录只消费原语:列/列头 → Pane/PaneHeader、行 → ListRow、图标钮 → IconButton、
// 分区标签 → SectionLabel、小标签/计数 → Chip。几何一律来自 tokens.css 的那把尺子。
// ⚠️ 本文件已有一个来自 contactsDetailControls 的 IconButton(详情面板 28px 钮),故原语按 UiIconButton 引入。
import { Sheet } from './ui/Sheet'
import { Pane, PaneHeader } from './ui/Pane'
import { navigateMobile } from '@/mobile/navigateMobile'
import { ListRow } from './ui/ListRow'
import { IconButton as UiIconButton } from './ui/IconButton'
import { useBackLayer } from './ui/sheetStack'
import { SectionLabel } from './ui/SectionLabel'
import { Chip } from './ui/Chip'
import {
  Bot, ChevronDown, ChevronRight,
  BellOff,
  Check,
  ChevronLeft,
  Eye,
  EyeOff,
  Mail,
  MessageCircle,
  Pencil,
  Plus,
  Power,
  SquareTerminal,
  Tag,
  Trash2,
  UserPlus,
  Users,
  X, Zap
} from '@/lib/icons'
import type { SidebarTab } from '@gugu/core/shared/enums/sidebarTabModels'
import { useContactsStore } from '../store/contactsContext'
import { useChatStore } from '../store/chatContext'
import { useAuth } from '../store/auth'
import { NewFriendsPanel } from './NewFriendsPanel'
import { AddFriendSearch } from './AddFriendSearch'
import { ContactsHeaderActions } from './contacts/AddContactMenu'
import { ActionButton, AgentContactStatusChip, FieldList, FieldRow, IconButton } from './contactsDetailControls'
import { Avatar } from './Avatar'; import { AgentContactStatusMark } from './AgentContactStatusMark'
import { CopyValue } from './CopyValue'
import { CreateGroupChatForm, MEMBER_PICKER_SHEET } from './CreateGroupChatModal'
import { ContactsPersonSectionState, ContactsGroupSectionState } from './contacts/ContactsSectionState'
import { ContactsDeviceSections } from './contacts/ContactsDeviceSections'
import { contactsAreEmpty } from './contacts/contactsByDevice'
import { sidebarCountClass } from '../session/renderer/features/sidebar/sidebar-primitives'
import { ContactGroupAvatar, ContactSearch, SelectionCheckbox } from './contacts/ContactSearch'
import { ContactsListDock } from './contacts/ContactsListDock'
import { OwnedAgentNameEditor } from './contacts/OwnedAgentNameEditor'
import { Button } from './ui/Button'
import { useToast } from './toastContext'
import type { ContactGroup, ContactGroupChat, ContactUser } from '@gugu/core/shared/types/contacts'
import { isCloudAgentMarked } from '@gugu/core/shared/enums/agentTypeModels'
import { chatService } from '../lib/chat'
import { persistableGroupRoster, replaceGroupRoster } from '../lib/imRepository'
import { rendererLogger } from '../lib/log'
import { closeIfMyAssistant } from '../lib/assistantClose'
import { getGroupRoleLabel } from '@gugu/core/shared/enums/groupRoleModels'
import { useAgentDisplayStatus } from '../hooks/useAgentDisplayStatus'
import { AUTOMATION_TEST_IDS } from '../lib/automationDom'
import { platform } from '../platform'
import type { GroupMemberItem } from '@gugu/core/shared/types/chat'
import type { QrScanRoute } from '../lib/qrScanRoute'
// @@@1397 群邀请 QR 与可复制链接同口径：都走 buildGroupInviteShareUrl(VITE_GUGU_WEB_URL/invite 落地页)，
// 不再让 QR 单独编码 Android 下载页基址 → 扫码/点链都落同一 env 域名(app.gugu.nextmind.space)。
import { AgentContactProfileCard, PersonAliasField, PersonContactProfileCard } from './contacts/ContactProfileCard'
import { commonGroupForAgent, requestStateForAgent, type AgentRequestState } from './contacts/agentContactRequest'
import {
  ContactRowContextMenu,
  ContactRowDeleteButton,
  type ContactRowMenuActions
} from './contacts/ContactRowActions'
import { useRowContextMenu } from '../hooks/useRowContextMenu'
import { ShareAgentModal } from './contacts/ShareAgentModal'
import { TagEmptyDetail, TagMemberEditorDetail } from './contacts/TagDetail'
import { GroupInviteJoinModal, GroupInviteQrShare } from './contacts/GroupInvite'
import { ContactsIndex } from './contacts/ContactsIndex'
import { useTranslation } from 'react-i18next'
import { formatDate, i18n } from '../i18n'
import { cn } from '@/lib/cn'
import { messageForUser } from '../lib/userFacingError'
// #855 契约：GroupJoinConfirmDialog 曾从本模块导出，实现搬走后仍从这里透出，外部 import 不受影响。
export { GroupJoinConfirmDialog } from './contacts/GroupInvite'
interface ContactsPanelProps {
  activeTab: SidebarTab
  externalContactId?: string
  mobile?: boolean
  scanSeed?: { route: QrScanRoute; token: number } | null
  onSwitchToChat?: (target: ContactUser) => void
  onOpenGroupChat?: (group: ContactGroupChat) => void
  /** 开共享 Session Composer 创建草稿(#2549/#2558);缺省 = 拿不到 composer → 入口不渲染。 */
  onOpenAgentCreateDraft?: () => void
}
type LeftSel = 'contacts' | 'new_friends' | 'add_friend' | 'group_chats' | 'agent_library' | `group:${string}`
type MobileContactsPane = 'nav' | 'index' | 'detail'

const ct = i18n.getFixedT(null, 'contacts')

// @@@ui-ruler 本地样式副本(rowBase / meta / name / sharedTag / reqBadge / section* / cpane*)已按角色
// 收口进原语,这里只剩原语不管的那点:头像壳(agent 状态角标挂在它的 ::after 上)、⚡ 标记、
// 分区标签的 chevron 与加号、资料卡排版。几何一律取 tokens,❌ 字面量像素。
const rowAvatarClass =
  'gg-c-av flex h-[var(--avatar-sm)] w-[var(--avatar-sm)] shrink-0 items-center justify-center overflow-hidden rounded-full'
const boltClass = 'gg-c-bolt flex shrink-0 text-[var(--agent-bolt)]'
const sectionLabelClass = 'gg-c-sec-h !mt-3'
// 资料卡(cpane):头像 --avatar-xl(96)、名字 --font-size-xl、状态 --font-body。
const cpaneCardClass = 'gg-c-cpane-card flex flex-col items-center animate-[ggCNaPop_var(--dur-med)_var(--ease)_both]'
const cpaneAvatarClass =
  'gg-c-cpane-av flex h-[var(--avatar-xl)] w-[var(--avatar-xl)] shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-xl)]'
const cpaneNameClass = 'gg-c-cpane-name !mt-5 flex items-center gap-2 text-xl font-semibold text-[var(--fg)]'
const cpaneStatusClass = 'gg-c-cpane-status !mt-2 flex items-center gap-2 text-sm text-[var(--muted-fg)]'
const cpaneActionsClass = 'gg-c-cpane-acts !mt-6 flex gap-3'
// 行内改名/备注输入:控件高与 Button/Field 同一把尺子(--control-h-md)。
const inlineInputClass =
  'h-[var(--control-h-md)] min-w-0 flex-1 rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--input-bg)] !px-2 text-sm text-[var(--fg)] outline-none'
// 详情面里的说明/分节标题(内容读文,--font-body)。
const detailCaptionClass = 'text-[length:var(--font-body)] text-[var(--muted-fg)]'
const detailBlockClass = '!mt-6 max-w-[620px]'
// 详情面里的一行提示条(加载中/为空/出错):控件高一档,圆角与卡片同 --r。
const detailNoticeClass =
  'flex min-h-[var(--control-h-lg)] items-center rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--input-bg)] !px-3 text-[length:var(--font-body)] text-[var(--muted-fg)]'
// 详情面里的卡片行(公开 Agent / 群成员):同一内距、同一圆角、同一边框。
const detailCardRowClass =
  'flex min-h-[var(--control-h-touch)] min-w-0 items-center gap-3 rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--input-bg)] !p-2'
// 详情面里的强调小标(Agent / 群密度):药丸小标,与 Chip 同一档。
const detailTitleClass = 'text-lg font-semibold text-[var(--fg)] [overflow-wrap:anywhere]'
const detailPlaceholderClass = 'flex flex-1 items-center justify-center text-sm text-[var(--muted-fg)]'
const detailSectionClass = (mobile?: boolean) => (mobile ? '!px-4 !py-5' : '!px-6 !py-6')
const detailBodyClass = (mobile?: boolean) =>
  cn(
    'flex-1 overflow-y-auto overflow-x-hidden',
    mobile ? '!px-4 !pt-4 !pb-[max(24px,env(safe-area-inset-bottom))]' : '!px-6 !py-6',
  )

/** 移动壳详情页的返回键:列头 leading 槽,44 触控命中框(#4292);安卓返回键走同一个 onBack。 */
function PaneBackButton({ label, onBack }: { label: string; onBack: () => void }) {
  useBackLayer(onBack)
  return <UiIconButton aria-label={label} onClick={onBack}><ChevronLeft /></UiIconButton>
}

const sectionChevronClass = (collapsed: boolean) =>
  cn(
    'gg-c-sec-chev flex shrink-0 transition-transform duration-[var(--dur-med)] [transition-timing-function:var(--ease)]',
    collapsed && '-rotate-90',
  )

const agentAvatarClass = (tone: AgentContactTone | null) => cn(rowAvatarClass, agentContactAvatarBadgeClass(tone))

/** ListRow 的根是 div(行里要嵌删除钮,按钮不能嵌按钮),键盘可达性靠 role/tabIndex + Enter/Space 补齐。 */
const rowKeyActivate = (activate: () => void) => (event: React.KeyboardEvent<HTMLDivElement>) => {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  activate()
}

function formatDateTime(value?: string | null): string {
  if (!value) return ct('common.unknown')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ct('common.unknown')
  return formatDate(date, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function getAgentProjectPath(contact: ContactUser): string | null {
  if (contact.project_path) return contact.project_path
  const match = contact.bio?.match(/项目目录：\s*([^·]+)/)
  return match?.[1]?.trim() || null
}

// @@@1514 channel 概念已抹除(并入 group)：agent 分享会话即普通 group。
// @@@1787 分组措辞统一用「群组」(桌面三段 sidebar: Agent/个人/群组)。
function groupChatListTitle(): string {
  return ct('panel.groupSectionTitle')
}

function groupChatListCountLabel(count: number): string {
  return ct('panel.groupCount', { count })
}

function groupChatSummaryLabel(count: number): string {
  return ct('panel.groupCountSummary', { count })
}

// @@@qr-share-as-image - save a data-URL image (e.g. the exported group-invite QR) as a downloaded
// file, used as the fallback when clipboard image write is unavailable.
function NavButton({
  icon,
  label,
  active,
  count,
  badge,
  testId,
  mobile = false,
  onClick
}: {
  icon: React.ReactNode
  label: string
  active: boolean
  count?: number
  badge?: number
  testId?: string
  mobile?: boolean
  onClick: () => void
}) { // 手机入口页整屏换页,回来时不该有哪行亮着 ⇒ 手机不画选中(同 SettingsNav 的 isActive)
  return (
    <button
      type="button"
      data-testid={testId}
      data-selected={(active && !mobile) || undefined}
      className={cn(
        'gg-row flex w-full cursor-pointer select-none items-center rounded-[var(--radius-control)] border-0 text-left text-[var(--fg)]',
        mobile ? 'min-h-[var(--control-h-touch)] gap-3 !px-3' : 'min-h-[var(--control-h-lg)] gap-2 !px-2',
      )}
      onClick={onClick}
    >
      <span className={cn('flex shrink-0', active && !mobile ? 'text-[var(--primary)]' : 'text-[var(--muted-fg)]')}>{icon}</span>
      {/* @@@ui-ruler 字阶取 token(mobile 15 / desktop 13);inline 只为在同一行里二选一,❌ 裸像素。 */}
      <span
        className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
        style={{ fontSize: mobile ? 'var(--font-title)' : 'var(--font-body)' }}
      >
        {label}
      </span>
      {badge !== undefined && badge > 0 ? (
        <Chip tone="danger" shape="count">{badge > 99 ? '99+' : badge}</Chip>
      ) : count !== undefined ? (
        <span className="text-xs text-[var(--muted-fg)]">{count}</span>
      ) : null}{mobile && <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-[var(--faint-fg)]" />}
    </button>
  )
}

function GroupNameEditor({
  value,
  placeholder,
  onSave,
  onCancel
}: {
  value: string
  placeholder: string
  onSave: (name: string) => Promise<void> | void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState(value)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    const name = draft.trim()
    if (!name || saving) return
    setSaving(true)
    try {
      await onSave(name)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex items-center gap-1">
      <input
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') save()
          if (event.key === 'Escape') onCancel()
        }}
        placeholder={placeholder}
        className={inlineInputClass}
      />
      <IconButton title={ct('profile.saveAlias')} onClick={save}>
        <Check size={14} />
      </IconButton>
      <IconButton title={ct('common.cancel')} onClick={onCancel}>
        <X size={14} />
      </IconButton>
    </div>
  )
}

// ── AgentContactRow ────────────────────────────────────────────────────────────
function AgentContactRow({
  contact,
  selected,
  multiSelected = false,
  selectionMode = false,
  pinned = false,
  onSelect,
  onToggleSelection,
  menu
}: {
  contact: ContactUser
  selected: boolean
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
        data-contact-option={selectionMode ? contact.id : undefined}
        aria-pressed={selectionMode ? multiSelected : undefined}
        selected={selected}
        pinned={pinned}
        leading={
          <>
            {selectionMode ? <SelectionCheckbox checked={multiSelected} /> : null}
            <div className={agentAvatarClass(tone)}>
              <Avatar name={contact.display_name} avatarUrl={contact.avatar} seed={contact.id} size="sm" isAgent agentStatus={status === 'needs_user' ? status : undefined} />
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

// ── PersonContactRow ──────────────────────────────────────────────────────────
function PersonContactRow({
  contact,
  selected,
  multiSelected = false,
  selectionMode = false,
  pinned = false,
  onSelect,
  onToggleSelection,
  menu
}: {
  contact: ContactUser
  selected: boolean
  multiSelected?: boolean
  selectionMode?: boolean
  pinned?: boolean
  onSelect: () => void
  onToggleSelection?: () => void
  menu?: ContactRowMenuActions
}) {
  const { menuPos, onContextMenu, closeMenu } = useRowContextMenu()
  return (
    <>
      <ListRow
        role="button"
        tabIndex={0}
        data-contact-id={contact.id}
        data-contact-option={selectionMode ? contact.id : undefined}
        aria-pressed={selectionMode ? multiSelected : undefined}
        selected={selected}
        pinned={pinned}
        leading={
          <>
            {selectionMode ? <SelectionCheckbox checked={multiSelected} /> : null}
            <div className={rowAvatarClass}>
              <Avatar name={contact.display_name} avatarUrl={contact.avatar} seed={contact.id} size="sm" />
            </div>
          </>
        }
        title={displayName(contact)}
        onClick={() => (selectionMode ? onToggleSelection?.() : onSelect())}
        onKeyDown={rowKeyActivate(() => (selectionMode ? onToggleSelection?.() : onSelect()))}
        onContextMenu={menu ? onContextMenu : undefined}
      />
      {menu && menuPos ? (
        <ContactRowContextMenu x={menuPos.x} y={menuPos.y} onClose={closeMenu} {...menu} />
      ) : null}
    </>
  )
}

// ── GroupChatRow (in 3-section sidebar) ──────────────────────────────────────
function GroupSectionRow({
  group,
  selected,
  pinned = false,
  onSelect,
  menu
}: {
  group: ContactGroupChat
  selected: boolean
  pinned?: boolean
  onSelect: () => void
  menu?: ContactRowMenuActions
}) {
  const { menuPos, onContextMenu, closeMenu } = useRowContextMenu()
  return (
    <>
      <ListRow
        role="button"
        tabIndex={0}
        data-group-id={group.id}
        selected={selected}
        pinned={pinned}
        leading={<ContactGroupAvatar group={group} size="sm" />}
        title={group.name}
        /* show member count like design's group row .st-dot.off — 静态灰点(非 agent 态),用 offline 档 */
        subtitle={
          <span className={agentContactRowStatusClass('offline')}>
            <span className={agentContactRowDotClass('offline')} aria-hidden="true" />
            {ct('panel.memberCount', { count: group.member_count })}
          </span>
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

// Replaces ContactsNav + ContactsIndex for desktop. Single scrollable sidebar with
// 3 collapsible sections: Agent / 个人 / 群组.
function ContactsThreeSectionSidebar({
  mobile,
  currentUserId,
  agentContacts,
  humanContacts,
  groupChats,
  pendingCount,
  query,
  onQuery,
  selectedContactId,
  selectedGroupId,
  selectionMode,
  selectedContactIds,
  newFriendsActive,
  onSelectContact,
  onToggleContact,
  onEnterSelectionMode,
  onFinishSelectionMode,
  onCreateGroupFromSelection,
  onSelectGroup,
  onSelectNewFriends,
  onSelectAddFriend,
  onCreateAgent,
  onCreateGroup,
  onStartChat,
  onPin,
  onMarkUnread,
  onToggleNotif,
  onRemove,
  contactPinned,
  contactNotifMuted,
  getContactRemoveLabel,
  onGroupPin,
  onGroupToggleNotif,
  onGroupLeaveOrDissolve,
  groupPinned,
  groupNotifMuted
}: {
  mobile?: boolean
  currentUserId?: string | null
  agentContacts: ContactUser[]
  humanContacts: ContactUser[]
  groupChats: ContactGroupChat[]
  pendingCount: number
  query: string
  onQuery: (v: string) => void
  selectedContactId: string | null
  selectedGroupId: string | null
  selectionMode: boolean
  selectedContactIds: Set<string>
  newFriendsActive?: boolean
  onSelectContact: (c: ContactUser) => void
  onToggleContact: (c: ContactUser) => void
  onEnterSelectionMode: () => void
  onFinishSelectionMode: () => void
  onCreateGroupFromSelection: () => void
  onSelectGroup: (g: ContactGroupChat) => void
  onSelectNewFriends: () => void
  onSelectAddFriend: (mode: 'contact' | 'group', seed?: string) => void
  onCreateAgent?: () => void
  onCreateGroup: () => void
  // #886 — 右键菜单同款 chat-scoped 动作（与移动端 ContactRow / 聊天列表行为同步统一）
  onStartChat?: (contact: ContactUser) => void
  onPin?: (contact: ContactUser) => void
  onMarkUnread?: (contact: ContactUser) => void
  onToggleNotif?: (contact: ContactUser) => void
  onRemove?: (contact: ContactUser) => void
  contactPinned?: Map<string, boolean>
  contactNotifMuted?: Map<string, boolean>
  getContactRemoveLabel: (contact: ContactUser) => string
  // #1694 — 群行右键菜单动作（chat-scoped；群本身即 chat，无需 resolveDmId）
  onGroupPin?: (g: ContactGroupChat) => void
  onGroupToggleNotif?: (g: ContactGroupChat) => void
  onGroupLeaveOrDissolve?: (g: ContactGroupChat) => void
  groupPinned?: Map<string, boolean>
  groupNotifMuted?: Map<string, boolean>
}) {
  // #886 — resolve the per-contact right-click menu action set (undefined ⇒ no menu, e.g. new-friends).
  const buildRowMenu = useCallback(
    (c: ContactUser): ContactRowMenuActions | undefined => {
      if (!onPin || !onMarkUnread || !onToggleNotif || !onRemove) return undefined
      return {
        removeLabel: getContactRemoveLabel(c), contact: c, // #5645 → 「设置备注」
        onStartChat: onStartChat ? () => onStartChat(c) : undefined,
        isPinned: contactPinned?.get(c.id) ?? false,
        notifMuted: contactNotifMuted?.get(c.id) ?? false,
        onPin: () => onPin(c),
        onMarkUnread: () => onMarkUnread(c),
        onToggleNotif: () => onToggleNotif(c),
        onRemove: () => onRemove(c)
      }
    },
    [onPin, onMarkUnread, onToggleNotif, onRemove, onStartChat, contactPinned, contactNotifMuted, getContactRemoveLabel]
  )
  // #1694 — 群行右键菜单：复用 ContactRowContextMenu，仅给 置顶 / 通知 / 退出·解散（不传 onStartChat/onMarkUnread）。
  // 角色化：owner → 「解散群聊」，member → 「退出群聊」；确认弹窗 + 真正动作在父层 onGroupLeaveOrDissolve。
  const buildGroupRowMenu = useCallback(
    (g: ContactGroupChat): ContactRowMenuActions | undefined => {
      if (!onGroupPin || !onGroupToggleNotif || !onGroupLeaveOrDissolve) return undefined
      return {
        removeLabel: g.my_role === 'owner' ? ct('contextMenu.dissolveGroup') : ct('contextMenu.leaveGroup'),
        isPinned: groupPinned?.get(g.id) ?? false,
        notifMuted: groupNotifMuted?.get(g.id) ?? g.is_muted,
        onPin: () => onGroupPin(g),
        onToggleNotif: () => onGroupToggleNotif(g),
        onRemove: () => onGroupLeaveOrDissolve(g)
      }
    },
    [onGroupPin, onGroupToggleNotif, onGroupLeaveOrDissolve, groupPinned, groupNotifMuted]
  )
  const [personCollapsed, setPersonCollapsed] = useState(false)

  // #2598 三分区此前完全无排序(置顶点了位置不动 = 假开关)。置顶前置走 contactsListSort,与移动端同一条链路。
  const isContactPinned = useCallback((c: ContactUser) => contactPinned?.get(c.id) ?? false, [contactPinned])
  const isGroupPinned = useCallback((g: ContactGroupChat) => groupPinned?.get(g.id) ?? false, [groupPinned])
  const sortedAgents = sortContactsPinnedFirst(agentContacts, isContactPinned)
  const sortedHumans = sortContactsPinnedFirst(humanContacts, isContactPinned)

  return (
    // @@@ui-ruler 导航列 = Pane nav:列宽 --nav-col-w、底色 --sidebar、右分隔线全由原语给,
    // 与会话列表同宽同色 —— 切 tab 时分隔线不再左右跳。
    <Pane paneRole="nav" mobile={mobile}>
      {/* @@@4322-selection-dock 标题不再在多选态换成计数 —— 计数与批量动作一起收在底部坞里
          （见 contacts/ContactsListDock.tsx）；头部只留稳定标题与模式进出，切模式时不再抖一下。
          添加联系人走独立的 add_friend 路由（@@@add-friend-unify），不是「新的请求」。 */}
      <PaneHeader
        mobile={mobile}
        title={ct('panel.title')}
        actions={
          <ContactsHeaderActions
            mobile={mobile}
            selectionMode={selectionMode}
            labels={{ selectModeDone: ct('panel.selectModeDone'), selectMode: ct('panel.selectMode') }}
            onFinishSelectionMode={onFinishSelectionMode}
            onEnterSelectionMode={onEnterSelectionMode}
            onSelectAddFriend={onSelectAddFriend}
          />
        }
      />
      <ContactSearch query={query} onQuery={onQuery} people={humanContacts} agents={agentContacts} groups={groupChats} onOpenContact={onSelectContact} onOpenGroup={onSelectGroup}
        pick={selectionMode ? { ids: selectedContactIds, canPick: (c) => c.type !== 'agent' || c.owner_user_id === currentUserId, onToggle: onToggleContact } : undefined}
        onLookupNumber={(number) => onSelectAddFriend('contact', number)}>
      <div className="flex-1 overflow-y-auto !px-2 !pb-3">
        {/* 新的请求 row — @@@1944 目的地统一走 onSelectNewFriends（selectedNav 单一真相源），
            与「添加联系人」+ 同一入口，请求视图只在详情列渲一次（不再有 sidebar 私有 overlay）。 */}
        <ListRow
          role="button"
          tabIndex={0}
          selected={newFriendsActive}
          data-testid={AUTOMATION_TEST_IDS.contactsNewFriendsNav}
          leading={
            <div className="grid h-[var(--avatar-sm)] w-[var(--avatar-sm)] shrink-0 place-items-center rounded-full bg-[var(--warn)] text-[var(--color-white)]">
              <UserPlus size={16} />
            </div>
          }
          title={ct('panel.newRequests')}
          accessory={pendingCount > 0 ? <Chip tone="accent" shape="count">{pendingCount}</Chip> : null}
          onClick={onSelectNewFriends}
          onKeyDown={rowKeyActivate(onSelectNewFriends)}
        />

        <ContactsDeviceSections
          agents={sortedAgents} people={sortedHumans}
          groups={sortGroupChatsPinnedFirst(groupChats, isGroupPinned)}
          currentUserId={currentUserId}
          onCreateAgent={onCreateAgent}
          onCreateGroup={onCreateGroup}
          renderAgent={(c) => (
            <AgentContactRow
              key={c.id}
              contact={c}
              selected={c.id === selectedContactId}
              multiSelected={selectedContactIds.has(c.id)}
              selectionMode={selectionMode && c.owner_user_id === currentUserId}
              pinned={isContactPinned(c)}
              onSelect={() => onSelectContact(c)}
              onToggleSelection={() => onToggleContact(c)}
              menu={c.owner_user_id === currentUserId ? buildRowMenu(c) : undefined}
            />
          )}
          renderGroup={(g) => (
            <GroupSectionRow
              key={g.id}
              group={g}
              selected={g.id === selectedGroupId}
              pinned={isGroupPinned(g)}
              onSelect={() => onSelectGroup(g)}
              menu={buildGroupRowMenu(g)}
            />
          )}
          personSection={
            <>
              <SectionLabel
                interactive
                className={sectionLabelClass}
                leading={<span className={sectionChevronClass(personCollapsed)}><ChevronDown size={16} /></span>}
                trailing={personCollapsed ? <span className={sidebarCountClass}>{sortedHumans.length}</span> : undefined}
                onClick={() => setPersonCollapsed((v) => !v)}
              >
                {ct('panel.contactSectionTitle')}
              </SectionLabel>
              <Collapse open={!personCollapsed} className="gg-c-sec-body">
                {sortedHumans.map((c) => (
                  <PersonContactRow
                    key={c.id}
                    contact={c}
                    selected={c.id === selectedContactId}
                    multiSelected={selectedContactIds.has(c.id)}
                    selectionMode={selectionMode}
                    pinned={isContactPinned(c)}
                    onSelect={() => onSelectContact(c)}
                    onToggleSelection={() => onToggleContact(c)}
                    menu={buildRowMenu(c)}
                  />
                ))}
                <ContactsPersonSectionState isEmpty={contactsAreEmpty(sortedHumans, sortedAgents, groupChats)} onAddContact={() => onSelectAddFriend('contact')} />
              </Collapse>
            </>
          }
        />
      </div>
      </ContactSearch>
      <ContactsListDock
        mobile={mobile}
        selectionMode={selectionMode}
        selectedCount={selectedContactIds.size}
        onCreateGroupFromSelection={onCreateGroupFromSelection}
      />
    </Pane>
  )
}

/**
 * 桌面详情列的外壳。原来四个分支各写一遍 `<main style>` + 一条 50px 空 header 条
 * （截图里 y≈77 那条只有线、上面什么都没有的横杠）。现在统一成 Pane detail + PaneHeader：
 * 列头有内容（当前联系人/群名），与会话头同高同线，切 tab 时标题基线不跳。
 */
function CpaneShell({ title, overlay, children }: { title?: string; overlay?: ReactNode; children: ReactNode }) {
  return (
    <Pane paneRole="detail">
      <PaneHeader divider title={title} />
      <div className="flex flex-1 items-start justify-center overflow-y-auto !px-6 !pb-6 !pt-[calc(var(--spacing-2xl)*2)]">
        <div className="w-full max-w-[480px]">{children}</div>
      </div>
      {overlay}
    </Pane>
  )
}

function CpaneGroupHeader({
  group,
  onOpenGroupChat
}: {
  group: ContactGroupChat
  onOpenGroupChat?: (g: ContactGroupChat) => void
}) {
  return (
    <div className={cpaneCardClass}>
      <div className={cpaneAvatarClass}>
        <ContactGroupAvatar group={group} size={96} />
      </div>
      <div className={cpaneNameClass}>{group.name}</div>
      {/* group status: member count, no dot per design noStatus class */}
      <div className={cpaneStatusClass}>{ct('panel.memberCount', { count: group.member_count })}</div>
      <div className={cpaneActionsClass}>
        <Button variant="primary" size="lg" onClick={() => onOpenGroupChat?.(group)}>
          {ct('panel.enterGroup')}
        </Button>
      </div>
    </div>
  )
}

function ContactsNav({
  selected,
  mobile = false,
  active,
  people,
  agents,
  groupChats,
  pendingCount,
  groups,
  query,
  onQuery,
  onSelect,
  onOpenContact,
  onOpenGroupChat,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup
}: {
  selected: LeftSel
  mobile?: boolean
  /** 联系人 tab 此刻在屏上(别的 tab 时它仍挂着)。 */
  active: boolean
  people: ContactUser[]
  agents: ContactUser[]
  groupChats: ContactGroupChat[]
  pendingCount: number
  groups: ContactGroup[]
  query: string
  onQuery: (value: string) => void
  onSelect: (value: LeftSel, seed?: string) => void
  onOpenContact: (contact: ContactUser) => void
  onOpenGroupChat?: (group: ContactGroupChat) => void
  onCreateGroup: (name: string) => Promise<string | null>
  onRenameGroup: (groupId: string, name: string) => Promise<void>
  onDeleteGroup: (groupId: string) => Promise<void>
}) {
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null)

  return (
    <Pane paneRole="nav" mobile={mobile}>
      <ContactSearch mobile={mobile} onScreen={active} query={query} onQuery={onQuery} people={people} agents={agents} groups={groupChats} onOpenContact={onOpenContact}
        head={(searchButton) => <PaneHeader mobile={mobile} title={ct('common.contacts')} actions={searchButton} />}
        onOpenGroup={(group) => onOpenGroupChat?.(group)} onLookupNumber={(number) => onSelect('add_friend', number)}>
      <div className="flex-1 overflow-y-auto !px-2 !pb-3">
        <NavButton
          mobile={mobile}
          icon={<Users size={mobile ? 20 : 15} />}
          label={ct('common.person')}
          count={people.length}
          active={selected === 'contacts'}
          onClick={() => onSelect('contacts')}
        />
        {/* @@@add-friend-unify 移动端 Contacts tab 的搜索加人入口——桌面在头部有「添加联系人」按钮，
            移动端必须在此 nav 里同样可达，否则拆掉 NewFriendsPanel 搜索后移动端只能靠聊天页「+」加人。 */}
        <NavButton
          mobile={mobile}
          icon={
            <svg width={mobile ? 20 : 15} height={mobile ? 20 : 15} viewBox="0 0 24 24">
              <g fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="12" cy="6" r="4" />
                <circle cx="17" cy="18" r="4" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 16.667v2.666M15.667 18h2.666" />
                <path d="M14 20.834c-.634.108-1.305.166-2 .166c-3.866 0-7-1.79-7-4s3.134-4 7-4c1.713 0 3.283.352 4.5.936" />
              </g>
            </svg>
          }
          label={ct('panel.addContact')}
          active={selected === 'add_friend'}
          onClick={() => onSelect('add_friend')}
        />
        <NavButton
          mobile={mobile}
          icon={<UserPlus size={mobile ? 20 : 15} />}
          label={ct('panel.newRequests')}
          badge={pendingCount}
          active={selected === 'new_friends'}
          testId={AUTOMATION_TEST_IDS.contactsNewFriendsNav}
          onClick={() => onSelect('new_friends')}
        />
        <NavButton
          mobile={mobile}
          icon={<MessageCircle size={mobile ? 20 : 15} />}
          label={ct('common.groups')}
          count={groupChats.length}
          active={selected === 'group_chats'}
          onClick={() => onSelect('group_chats')}
        />
        <NavButton
          mobile={mobile}
          icon={<Bot size={mobile ? 20 : 15} />}
          label={ct('common.agent')}
          count={agents.length}
          active={selected === 'agent_library'}
          testId={AUTOMATION_TEST_IDS.contactsAgentNav}
          onClick={() => onSelect('agent_library')}
        />

        {/* 标签分区标签 —— 与三分区同一档(11/16 semibold muted)。新建入口在移动壳要 44 命中框(#4292)。 */}
        <SectionLabel
          className="!mt-3"
          trailing={
            <IconButton title={ct('tags.create')} touchTarget={mobile} onClick={() => setCreatingGroup(true)}>
              <Plus size={mobile ? 16 : 14} />
            </IconButton>
          }
        >
          {ct('tags.title')}
        </SectionLabel>

        {creatingGroup ? (
          <GroupNameEditor
            value=""
            placeholder={ct('tags.namePlaceholder')}
            onCancel={() => setCreatingGroup(false)}
            onSave={async (name) => {
              const id = await onCreateGroup(name)
              setCreatingGroup(false)
              if (id) onSelect(`group:${id}`)
            }}
          />
        ) : null}

        {groups.map((group) =>
          editingGroupId === group.id ? (
            <GroupNameEditor
              key={group.id}
              value={group.name}
              placeholder={ct('tags.namePlaceholder')}
              onCancel={() => setEditingGroupId(null)}
              onSave={async (name) => {
                await onRenameGroup(group.id, name)
                setEditingGroupId(null)
              }}
            />
          ) : (
            <div key={group.id} className="flex items-center gap-1">
              <div className="min-w-0 flex-1">
                <NavButton
                  mobile={mobile}
                  icon={<Tag size={mobile ? 18 : 14} />}
                  label={group.name}
                  count={group.contactIds.length}
                  active={selected === `group:${group.id}`}
                  onClick={() => onSelect(`group:${group.id}`)}
                />
              </div>
              <IconButton title={ct('tags.rename', { name: group.name })} onClick={() => setEditingGroupId(group.id)}>
                <Pencil size={13} />
              </IconButton>
              <IconButton
                title={ct('tags.delete', { name: group.name })}
                onClick={() => {
                  if (window.confirm(ct('tags.deleteConfirm', { name: group.name }))) onDeleteGroup(group.id)
                }}
              >
                <Trash2 size={13} />
              </IconButton>
            </div>
          )
        )}
      </div>
      </ContactSearch>
    </Pane>
  )
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

function ContactDetail({
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

function GroupChatRow({
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

function GroupChatDetailPane({
  group,
  mobile = false,
  onBack,
  onOpenGroupChat
}: {
  group: ContactGroupChat | null
  mobile?: boolean
  onBack?: () => void
  onOpenGroupChat?: (group: ContactGroupChat) => void
}) {
  const { identitiesById, getImRepository } = useChatStore('identitiesById', 'getImRepository')
  const [members, setMembers] = useState<GroupMemberItem[]>([])
  const [loadingMembers, setLoadingMembers] = useState(false)
  const groupId = group?.id ?? null
  useEffect(() => {
    if (!groupId) { setMembers([]); return }
    let cancelled = false
    setLoadingMembers(true)
    chatService
      .getGroupCollab(groupId)
      .then(async ({ snapshot, identities }) => {
        // 与聊天面板同一条写路径(名册 + 身份同事务),先落库再渲染成员;本地写失败只记日志,不否决远端读到的名册 (#5610)
        await getImRepository().then((repository) => replaceGroupRoster(repository, groupId, persistableGroupRoster(groupId, snapshot, identities), identities)).catch((err: unknown) => rendererLogger('contacts/group-detail').error({ err }, 'write group roster failed'))
        if (!cancelled) setMembers([...snapshot.humans, ...snapshot.agents])
      })
      .catch((err) => {
        console.error('[ContactsPanel] load group members error', err)
        if (!cancelled) setMembers([])
      })
      .finally(() => {
        if (!cancelled) setLoadingMembers(false)
      })
    return () => {
      cancelled = true
    }
  }, [groupId, getImRepository])

  if (!group) {
    return (
      <Pane paneRole="detail" mobile={mobile}>
        <PaneHeader divider mobile={mobile} title={ct('groupDetail.title')} />
        <div className={detailPlaceholderClass}>{ct('panel.selectGroupDetail')}</div>
      </Pane>
    )
  }

  const densityText = group.member_count >= 10
    ? ct('groupDetail.multi')
    : group.member_count >= 3
      ? ct('groupDetail.small')
      : ct('common.groupChat')
  const visibleMembers = members.slice(0, 12)

  return (
    <Pane paneRole="detail" mobile={mobile}>
      {/* @@@1238-top 群详情列头与会话头同高同线,标题字阶来自 PaneHeader。 */}
      <PaneHeader
        divider
        mobile={mobile}
        title={ct('groupDetail.title')}
        leading={mobile && onBack ? <PaneBackButton label={ct('panel.backToGroupList')} onBack={onBack} /> : undefined}
      />

      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        <section className={cn(detailSectionClass(mobile), 'flex items-start gap-4 border-b border-[var(--border)]')}>
          <div className="flex h-[var(--avatar-lg)] w-[var(--avatar-lg)] shrink-0 items-center justify-center rounded-[var(--radius-xl)] bg-[var(--primary)] text-[var(--primary-fg)]">
            <Users size={28} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className={detailTitleClass}>{group.name}</h2>
            <div className="!mt-2 flex flex-wrap items-center gap-2">
              <Chip>{densityText}</Chip>
              <span className="text-sm text-[var(--muted-fg)]">
                {ct('groupDetail.memberCount', { count: group.member_count })}
              </span>
            </div>
            <div className="!mt-4 flex flex-wrap gap-2">
              <ActionButton
                primary
                icon={<MessageCircle size={15} />}
                label={ct('panel.enterGroup')}
                onClick={() => onOpenGroupChat?.(group)}
              />
            </div>
          </div>
        </section>

        <section className={cn(detailSectionClass(mobile), 'border-b border-[var(--border)]')}>
          <FieldList className="max-w-[620px]">
            <FieldRow
              label={ct('groupDetail.number')}
              value={
                chatPublicId(group) ? (
                  <CopyValue
                    value={chatPublicId(group)!}
                    message={ct('groupDetail.copiedNumber')}
                  />
                ) : (
                  ct('common.unassigned')
                )
              }
            />
            <FieldRow label={ct('groupDetail.membersLabel')} value={ct('groupDetail.memberCountValue', { count: group.member_count })} />
            <FieldRow label={ct('groupDetail.typeLabel')} value={densityText} />
            <GroupInviteQrShare group={group} />
          </FieldList>
        </section>

        <section className={cn(detailSectionClass(mobile), mobile && '!pb-[max(24px,env(safe-area-inset-bottom))]')}>
          <div className={cn(detailCaptionClass, '!mb-3')}>
            {ct('groupDetail.overview')}
          </div>
          {loadingMembers || visibleMembers.length === 0 ? (
            <div className="text-sm text-[var(--muted-fg)]">
              {loadingMembers ? ct('groupDetail.loadingMembers') : ct('groupDetail.emptyMembers')}
            </div>
          ) : (
            <div className="grid max-w-[720px] grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-3">
              {visibleMembers.map((member) => (
                <div key={member.id} className={detailCardRowClass}>
                  <Avatar
                    name={identitiesById[member.id]?.display_name ?? ''}
                    avatarUrl={identitiesById[member.id]?.avatar}
                    seed={member.id}
                    size="sm"
                    isAgent={member.type === 'agent'}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[length:var(--font-body)] text-[var(--fg)]">
                      {identitiesById[member.id]?.display_name ?? ''}
                    </div>
                    <div className="text-xs text-[var(--muted-fg)]">
                      {member.type === 'agent' ? 'Agent · ' : ''}
                      {getGroupRoleLabel(member.role)}
                    </div>
                  </div>
                </div>
              ))}
              {members.length > visibleMembers.length ? (
                <div className={cn(detailCardRowClass, 'justify-center text-[length:var(--font-body)] text-[var(--muted-fg)]')}>
                  {ct('groupDetail.remainingMembers', { count: members.length - visibleMembers.length })}
                </div>
              ) : null}
              {group.member_count > members.length ? (
                <div className={cn(detailCardRowClass, 'justify-center text-[length:var(--font-body)] text-[var(--muted-fg)]')}>
                  {ct('groupDetail.pendingSync', { count: group.member_count - members.length })}
                </div>
              ) : null}
            </div>
          )}
        </section>
      </div>
    </Pane>
  )
}

function GroupChatsDetail({
  groups,
  mobile = false,
  onBack,
  onOpenGroupChat,
  onCreateGroup, onGroupPin, onGroupToggleNotif, onGroupLeaveOrDissolve,
  groupPinned,
  groupNotifMuted,
}: {
  groups: ContactGroupChat[]
  mobile?: boolean
  onBack?: () => void
  onOpenGroupChat?: (group: ContactGroupChat) => void
  onCreateGroup?: () => void // #2118 — 空群组分区「创建群聊」CTA
  onGroupPin?: (group: ContactGroupChat) => void
  onGroupToggleNotif?: (group: ContactGroupChat) => void
  onGroupLeaveOrDissolve?: (group: ContactGroupChat) => void
  groupPinned?: Map<string, boolean>
  groupNotifMuted?: Map<string, boolean>
}) {
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)
  // #1169 (b): the bare-数字群号 SEARCH/lookup (gugu-specific #653 enumeration surface) is removed —
  // typing a number no longer previews a foreign group. Token-gated JOINING moved to GroupInviteJoinModal,
  // driven by a scanned/pasted invite QR (which carries the unguessable token), bypassing this box
  // (a /join/:inviteCode route). This pane only lists the groups you're already in; search lives on the contacts home.
  const visibleGroups = useMemo(
    () => sortGroupChatsPinnedFirst(groups, (g) => groupPinned?.get(g.id) ?? false),
    [groups, groupPinned],
  )

  const menuForGroup = (group: ContactGroupChat): ContactRowMenuActions | undefined => {
    if (!onGroupPin || !onGroupToggleNotif || !onGroupLeaveOrDissolve) return undefined
    return {
      removeLabel: group.my_role === 'owner' ? ct('contextMenu.dissolveGroup') : ct('contextMenu.leaveGroup'),
      isPinned: groupPinned?.get(group.id) ?? false,
      notifMuted: groupNotifMuted?.get(group.id) ?? group.is_muted,
      onPin: () => onGroupPin(group),
      onToggleNotif: () => onGroupToggleNotif(group),
      onRemove: () => onGroupLeaveOrDissolve(group),
    }
  }

  useEffect(() => {
    if (visibleGroups.length === 0) {
      setSelectedGroupId(null)
      return
    }
    if (mobile && !selectedGroupId) return
    if (!selectedGroupId || !visibleGroups.some((group) => group.id === selectedGroupId)) {
      setSelectedGroupId(visibleGroups[0].id)
    }
  }, [mobile, selectedGroupId, visibleGroups])

  const selectedGroup =
    visibleGroups.find((group) => group.id === selectedGroupId) ??
    (mobile ? null : (visibleGroups[0] ?? null))
  const title = groupChatListTitle()

  if (mobile && selectedGroupId) {
    return (
      <GroupChatDetailPane
        group={selectedGroup}
        mobile
        onBack={() => setSelectedGroupId(null)}
        onOpenGroupChat={onOpenGroupChat}
      />
    )
  }

  return (
    <div className="flex h-full min-w-0 flex-1 overflow-hidden">
      <Pane
        paneRole="nav"
        mobile={mobile}
        data-three-col-list
        className={mobile ? undefined : '!w-[360px] !min-w-[300px] max-w-[420px]'}
      >
        {/* @@@1238-top 群列表列头与其余列头同高同线;副行(计数)跟在标题下,仍在同一条基线上。 */}
        <PaneHeader
          divider
          mobile={mobile}
          leading={mobile && onBack ? <PaneBackButton label={ct('panel.backToContacts')} onBack={onBack} /> : undefined}
          title={
            <div className="min-w-0 flex-1">
              <div className={cn('overflow-hidden text-ellipsis whitespace-nowrap font-semibold text-[var(--fg)]', mobile ? 'text-xl' : 'text-base')}>
                {title}
              </div>
              <div className="text-xs text-[var(--muted-fg)]">{groupChatListCountLabel(visibleGroups.length)}</div>
            </div>
          }
        />
        <div className="flex-1 overflow-y-auto">
          {visibleGroups.length === 0 ? (
            <div className="flex min-h-full items-center justify-center">
              <ContactsGroupSectionState isEmpty onCreateGroup={onCreateGroup} align="center" />
            </div>
          ) : (
            visibleGroups.map((group) => (
              <GroupChatRow
                key={group.id}
                group={group}
                selected={group.id === selectedGroup?.id}
                pinned={groupPinned?.get(group.id) ?? false}
                onSelect={() => {
                  setSelectedGroupId(group.id)
                }}
                cardId={group.id}
                menu={menuForGroup(group)}
              />
            ))
          )}
        </div>
        <div className="flex h-8 shrink-0 items-center justify-center border-t border-[var(--border)] text-[length:var(--font-body)] text-[var(--muted-fg)]">
          {groupChatSummaryLabel(groups.length)}
        </div>
      </Pane>

      {/* @@@three-col-shrink (#390) - The detail pane shrinks first (high flex-shrink +
          real basis) down to minWidth; only then does the list-section shrink to its
          own minWidth; the nav is pinned by its minWidth. Plain flex:1 gave the detail
          basis 0 (shrink-weight 0), so the list shrank instead of the detail. */}
      {!mobile && (
        <div data-three-col-detail className="flex min-h-0 min-w-[380px] flex-[1_1000_480px] overflow-hidden">
          <GroupChatDetailPane group={selectedGroup} onOpenGroupChat={onOpenGroupChat} />
        </div>
      )}
    </div>
  )
}

export function ContactsPanel({
  activeTab,
  externalContactId,
  mobile = false,
  scanSeed,
  onSwitchToChat,
  onOpenGroupChat,
  onOpenAgentCreateDraft
}: ContactsPanelProps) {
  useTranslation('contacts')
  const {
    contacts,
    sharedGroupAgents,
    groups,
    groupChats,
    pendingRequestCount,
    sentRequests,
    loadingContacts,
    loadingGroups,
    sendRequest,
    createGroup,
    renameGroup,
    deleteGroup,
    updateGroupMembers,
    setAgentPublic,
    setAgentDesiredStatus,
    removeOwnedAgent,
    removeContact,
    getCommonGroupChats,
  } = useContactsStore()
  const { user } = useAuth()
  const { toast } = useToast()
  const { chats: liveChats, pinChat, markUnread, setChatNotificationLevel, leaveGroup, deleteChat, refreshChats } = useChatStore('chats', 'pinChat', 'markUnread', 'setChatNotificationLevel', 'leaveGroup', 'deleteChat', 'refreshChats')
  const chats = useMemo(() => liveChats, [JSON.stringify(liveChats.map((c) => [c.id, c.kind, c.peer_user_id, c.is_pinned, c.notification_level]))]) // eslint-disable-line react-hooks/exhaustive-deps -- 只读私聊对象、置顶、通知档:这几项没变就沿用上一份,不跟着每条消息把几百行联系人重渲染
  const [selectedNav, setSelectedNav] = useState<LeftSel>('contacts')
  const [mobilePane, setMobilePane] = useState<MobileContactsPane>('nav')
  const [query, setQuery] = useState('')
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null)
  const [contactSelectionMode, setContactSelectionMode] = useState(false)
  const [selectedContactIds, setSelectedContactIds] = useState<Set<string>>(new Set())
  const [requestingAgentId, setRequestingAgentId] = useState<string | null>(null)
  const [showGroupModal, setShowGroupModal] = useState(false) // #2118 — 空群组分区「创建群聊」CTA 开建群弹窗
  const [editingTagId, setEditingTagId] = useState<string | null>(null)
  // @@@scan-seed (#537-A) - a contact scan routes the 咕咕号 into NewFriendsPanel's search; the token
  // forces a re-search even when the same code is scanned twice. Group scans use `query` directly.
  const [addFriendSeed, setAddFriendSeed] = useState<{ query: string; token: number } | null>(null)
  // #1169 (b): a scanned/pasted group invite QR opens this token-gated join-confirm modal.
  const [groupInviteJoin, setGroupInviteJoin] = useState<{ publicId: number; joinToken?: string; token: number } | null>(null)
  // @@@contacts-sidebar - selected group in the 3-section sidebar (cpane design)
  const [selectedSidebarGroupId, setSelectedSidebarGroupId] = useState<string | null>(null)

  const humanContacts = useMemo(
    () => contacts.filter((contact) => contact.type !== 'agent'),
    [contacts]
  )
  const agentContacts = useMemo(() => {
    const byId = new Map<string, ContactUser>()
    for (const contact of contacts) if (contact.type === 'agent') byId.set(contact.id, contact)
    for (const agent of sharedGroupAgents) byId.set(agent.id, agent)
    return [...byId.values()]
  }, [contacts, sharedGroupAgents])
  const sentRequestIds = useMemo(
    () => new Set(sentRequests.map((request) => request.receiver_id)),
    [sentRequests]
  )
  const requestAgent = useCallback(async (agent: ContactUser) => {
    if (requestingAgentId) return
    setRequestingAgentId(agent.id)
    try {
      await sendRequest(agent.id)
    } finally {
      setRequestingAgentId(null)
    }
  }, [requestingAgentId, sendRequest])
  const getContactRemoveLabel = (contact: ContactUser) =>
    contact.type === 'agent' && contact.owner_user_id === user?.id
      ? ct('contextMenu.deleteAgent')
      : ct('contextMenu.deleteContact')

  // #886 — per-contact DM lookup helpers for pin/notif toggle labels.
  // Returns the existing DM chat for a contact from the loaded chats list, if any.
  const findDm = useCallback(
    (contactId: string) =>
      chats.find(
        (c) => (c.kind === 'dm' || c.kind === 'ai') && c.peer_user_id === contactId
      ),
    [chats]
  )

  // Resolves (or lazily creates) the DM chat ID for a contact.
  const resolveDmId = useCallback(
    async (contact: ContactUser): Promise<string> => {
      const existing = findDm(contact.id)
      if (existing) return existing.id
      return chatService.getOrCreateDM(user!.id, contact.id)
    },
    [findDm, user]
  )

  // Maps each contact id → isPinned / notifMuted derived from the loaded chats list.
  const contactPinned = useMemo(
    () => new Map(contacts.map((c) => [c.id, findDm(c.id)?.is_pinned ?? false])),
    [contacts, findDm]
  )
  const contactNotifMuted = useMemo(
    () => new Map(contacts.map((c) => [c.id, (findDm(c.id)?.notification_level ?? 'all') === 'none'])),
    [contacts, findDm]
  )

  const handleContactPin = useCallback(
    async (contact: ContactUser) => {
      const chatId = await resolveDmId(contact)
      const currentlyPinned = findDm(contact.id)?.is_pinned ?? false
      await pinChat(chatId, !currentlyPinned)
    },
    [resolveDmId, findDm, pinChat]
  )

  const handleContactMarkUnread = useCallback(
    async (contact: ContactUser) => {
      const chatId = await resolveDmId(contact)
      await markUnread(chatId)
    },
    [resolveDmId, markUnread]
  )

  const handleContactToggleNotif = useCallback(
    async (contact: ContactUser) => {
      const chatId = await resolveDmId(contact)
      const currentlyMuted = (findDm(contact.id)?.notification_level ?? 'all') === 'none'
      await setChatNotificationLevel(chatId, currentlyMuted ? 'all' : 'none')
    },
    [resolveDmId, findDm, setChatNotificationLevel]
  )

  // #1694 — 群行右键菜单状态/动作（群本身即 chat，g.id 即 chatId，无需 resolveDmId）。
  const groupPinned = useMemo(
    () => new Map(groupChats.map((g) => [g.id, chats.find((c) => c.id === g.id)?.is_pinned ?? false])),
    [groupChats, chats]
  )
  // #1694-followup — notif 状态与 pin 同源:从 chats(chat store，setChatNotificationLevel 即时更新)读，
  // 不用 g.is_muted(groupChats contacts-store 快照，mute 后不刷新 → label stale + toggle 方向反)。
  const groupNotifMuted = useMemo(
    () => new Map(groupChats.map((g) => [g.id, (chats.find((c) => c.id === g.id)?.notification_level ?? 'all') === 'none'])),
    [groupChats, chats]
  )
  const handleGroupPin = useCallback(
    async (g: ContactGroupChat) => {
      const currentlyPinned = chats.find((c) => c.id === g.id)?.is_pinned ?? false
      await pinChat(g.id, !currentlyPinned)
    },
    [chats, pinChat]
  )
  const handleGroupToggleNotif = useCallback(
    async (g: ContactGroupChat) => {
      // 从 chats live 读当前静音态(对齐 handleContactToggleNotif)，g.is_muted 是快照会 stale。
      const currentlyMuted = (chats.find((c) => c.id === g.id)?.notification_level ?? 'all') === 'none'
      await setChatNotificationLevel(g.id, currentlyMuted ? 'all' : 'none')
    },
    [chats, setChatNotificationLevel]
  )
  // 角色化：owner → 解散群聊（deleteChat persist → chats.status='archived'，全员退出）；
  // member → 退出群聊（leaveGroup 删自己 chat_members 行）。确认弹窗复用 ChatManagementActions 文案。
  const handleGroupLeaveOrDissolve = useCallback(
    async (g: ContactGroupChat) => {
      const isOwner = g.my_role === 'owner'
      const ok = window.confirm(isOwner ? ct('confirmations.dissolveGroup') : ct('confirmations.leaveGroup'))
      if (!ok) return
      // #1694-followup — 对齐 handleRemoveContact:成功/失败都 toast，别静默吞(fail-loud)。
      try {
        if (isOwner) await deleteChat(g.id, true)
        else await leaveGroup(g.id)
        toast(isOwner ? ct('toast.dissolvedGroup') : ct('toast.leftGroup'), 'success')
      } catch (error) {
        toast(isOwner ? ct('toast.dissolveFailed') : ct('toast.leaveFailed'), 'error', messageForUser(error))
      }
    },
    [deleteChat, leaveGroup, toast]
  )

  const selectedGroup = selectedNav.startsWith('group:')
    ? groups.find((group) => selectedNav === `group:${group.id}`)
    : undefined
  const editingTag = editingTagId ? groups.find((group) => group.id === editingTagId) : undefined

  const scopedContacts = useMemo(() => {
    if (selectedNav === 'agent_library') return agentContacts
    // @@@tag-metadata-filter - UI tags are a metadata view over all communication objects, not a human-only folder.
    if (selectedGroup)
      return contacts.filter((contact) => selectedGroup.contactIds.includes(contact.id))
    // @@@1944 new_friends 不再是联系人列表的一种 scope——它的请求列表（含已发出）由 NewFriendsPanel
    // 自渲染，桌面/移动都只在一个渲染点出现，无中间联系人行列表。
    if (selectedNav === 'group_chats' || selectedNav === 'new_friends') return []
    return humanContacts
  }, [agentContacts, contacts, humanContacts, selectedGroup, selectedNav])

  const selectedContact = useMemo(
    () =>
      scopedContacts.find((contact) => contact.id === selectedContactId) ??
      scopedContacts[0] ??
      null,
    [selectedContactId, scopedContacts]
  )

  useEffect(() => {
    if (!externalContactId) return
    const contact = contacts.find((item) => item.id === externalContactId)
      ?? sharedGroupAgents.find((item) => item.id === externalContactId)
    if (!contact) return
    setSelectedNav(contact.type === 'agent' ? 'agent_library' : 'contacts')
    setSelectedContactId(contact.id)
    if (mobile) setMobilePane('detail')
  }, [contacts, externalContactId, mobile, sharedGroupAgents])

  useEffect(() => {
    if (selectedNav === 'group_chats') return
    if (selectedContactId && scopedContacts.some((contact) => contact.id === selectedContactId))
      return
    setSelectedContactId(scopedContacts[0]?.id ?? null)
  }, [selectedContactId, selectedNav, scopedContacts])

  useEffect(() => {
    if (!editingTagId) return
    if (groups.some((group) => group.id === editingTagId)) return
    setEditingTagId(null)
  }, [editingTagId, groups])

  useEffect(() => {
    if (selectedContactIds.size === 0) return
    const liveIds = new Set(contacts.map((contact) => contact.id))
    setSelectedContactIds((current) => {
      const next = new Set([...current].filter((id) => liveIds.has(id)))
      return next.size === current.size ? current : next
    })
  }, [contacts, selectedContactIds.size])

  // @@@scan-seed (#537) - a QR decoded by the chat-list "+" scan (MainLayout owns the camera + tab
  useEffect(() => {
    if (!scanSeed) return
    const { route } = scanSeed
    setSelectedContactId(null)
    // @@@1944 nav 高亮同源清理：new_friends 行按 selectedNav 高亮，群行按 selectedSidebarGroupId
    // 高亮——扫码路由切到 new_friends 时必须一并清群选中，否则双高亮。
    setSelectedSidebarGroupId(null)
    setEditingTagId(null)
    if (route.nav === 'group_join') {
      // #1169 (b): a scanned/pasted group invite QR → token-gated join-confirm modal (bypasses the
      // removed 群号 search box). The route carries the unguessable join_token from the QR payload.
      setGroupInviteJoin({ publicId: route.publicId, joinToken: route.joinToken, token: Date.now() })
    } else {
      // @@@add-friend-unify 扫码得到一个人的咕咕号 = 加人意图 → 直达 add_friend 搜索面板并 seed 查询，
      // 而非「新的请求」收件箱（后者是收发申请，与扫码加人不同意图）。
      setSelectedNav('add_friend')
      setAddFriendSeed({ query: route.query, token: Date.now() })
      // @@@1944 移动端 add_friend 直达 AddFriendSearch（住在 index pane，无中间列表）
      if (mobile) setMobilePane('index')
    }
  }, [scanSeed, mobile])

  // ── three-section sidebar derived state ────────────────────────────────────
  const selectedSidebarContact = useMemo(
    () => contacts.find((c) => c.id === selectedContactId)
      ?? sharedGroupAgents.find((c) => c.id === selectedContactId)
      ?? null,
    [contacts, selectedContactId, sharedGroupAgents]
  )
  const selectedSidebarGroup = useMemo(
    () => groupChats.find((g) => g.id === selectedSidebarGroupId) ?? null,
    [groupChats, selectedSidebarGroupId]
  )

  // @@@cpane-modals — modal state for the desktop cpane action buttons
  const [cpaneSettingsContact, setCpaneSettingsContact] = useState<ContactUser | null>(null)
  const [cpaneShareContact, setCpaneShareContact] = useState<ContactUser | null>(null)
  const [addFriendMode, setAddFriendMode] = useState<'contact' | 'group'>('contact')

  // 手机壳里这张页常驻在横滑分页器里,切走 tab 时也挂着 ⇒ 切走即回到根(#6730)。
  useEffect(() => { if (activeTab !== 'contacts') setMobilePane('nav') }, [activeTab])

  const listTitle =
    selectedNav === 'agent_library'
      ? ct('common.agent')
      : selectedNav === 'group_chats'
        ? ct('common.groups')
        : (selectedGroup?.name ?? ct('panel.allContacts'))

  const selectNav = (next: LeftSel, seed?: string) => navigateMobile(() => {
    setSelectedNav(next)
    setSelectedContactId(null)
    setContactSelectionMode(false)
    setSelectedContactIds(new Set())
    setEditingTagId(null)
    // @@@add-friend-unify 从 nav 点进 add_friend = 空态搜索；清掉扫码残留 seed（同 onSelectAddFriend）。
    if (next === 'add_friend') setAddFriendSeed(seed ? { query: seed, token: Date.now() } : null)
    if (mobile) setMobilePane('index')
  }, 'push')

  const selectContact = (contact: ContactUser) => navigateMobile(() => {
    setSelectedContactId(contact.id)
    setEditingTagId(null)
    if (mobile) setMobilePane('detail')
  }, 'push')

  const toggleContactSelection = (contact: ContactUser) => {
    if (contact.type === 'agent' && isCloudAgentMarked(contact)) return
    setSelectedContactIds((current) => {
      const next = new Set(current)
      if (next.has(contact.id)) next.delete(contact.id)
      else next.add(contact.id)
      return next
    })
  }

  const enterContactSelectionMode = () => {
    setSelectedNav('contacts')
    setSelectedContactId(null)
    setSelectedSidebarGroupId(null)
    setEditingTagId(null)
    setContactSelectionMode(true)
    setSelectedContactIds(new Set())
  }

  const finishContactSelectionMode = () => {
    setContactSelectionMode(false)
    setSelectedContactIds(new Set())
  }

  const handleRemoveContact = async (contact: ContactUser) => {
    const name = displayName(contact)
    const isOwnedAgent = contact.type === 'agent' && contact.owner_user_id === user?.id
    if (isOwnedAgent && closeIfMyAssistant(user?.id, contact.id)) return // #7350 删的是咕咕:换成关闭咕咕那份确认
    const message = isOwnedAgent ? ct('confirmations.deleteAgent', { name }) : ct('confirmations.deleteContact', { name })
    if (!window.confirm(message)) return
    try {
      if (isOwnedAgent) await removeOwnedAgent(contact.id)
      else await removeContact(contact.id)
      toast(isOwnedAgent ? ct('toast.deletedAgent') : ct('toast.deletedContact'), 'success')
    } catch (error) {
      toast(
        isOwnedAgent ? ct('toast.deleteAgentFailed') : ct('toast.deleteContactFailed'),
        'error', messageForUser(error)
      )
    }
  }

  const editTagMembers = (group: ContactGroup) => navigateMobile(() => {
    setEditingTagId(group.id)
    if (mobile) setMobilePane('detail')
  }, 'push')

  const groupModal = <Sheet open={showGroupModal} onClose={() => setShowGroupModal(false)} {...MEMBER_PICKER_SHEET} testId="create-group-modal" ariaLabel={ct('createGroup.title')}>
    {showGroupModal ? <CreateGroupChatForm initialSelectedIds={[...selectedContactIds]} onClose={() => setShowGroupModal(false)} onCreated={() => { setShowGroupModal(false); finishContactSelectionMode(); void refreshChats() }} /> : null}
  </Sheet>
  const groupInviteJoinModal = groupInviteJoin ? (
    <GroupInviteJoinModal key={groupInviteJoin.token} publicId={groupInviteJoin.publicId}
      joinToken={groupInviteJoin.joinToken} onClose={() => setGroupInviteJoin(null)} />
  ) : null

  // Desktop layout: three-section sidebar + centered cpane
  if (!mobile) {
    // @@@1944 桌面详情列唯一路由：selectedNav（+ 选中实体）→ 详情视图的单一真相源。
    // 每个 nav 目的地在双栏里只渲染一次——列表列恒为联系人导航，详情列由这里决定。
    const cpaneRight = (() => {
      if (selectedNav === 'add_friend') {
        return <AddFriendSearch seed={addFriendSeed} autoFocus showHeader mode={addFriendMode} />
      }
      if (selectedNav === 'new_friends') {
        return <NewFriendsPanel onOpenGroupChat={onOpenGroupChat} />
      }
      if (selectedSidebarGroup) {
        return (
          <CpaneShell title={selectedSidebarGroup.name}>
            <CpaneGroupHeader
              group={selectedSidebarGroup}
              onOpenGroupChat={onOpenGroupChat}
            />
          </CpaneShell>
        )
      }
      if (selectedSidebarContact) {
        const isOwnedAgent =
          selectedSidebarContact.type === 'agent' &&
          selectedSidebarContact.owner_user_id === user?.id
        if (selectedSidebarContact.type === 'agent') {
          const commonGroup = commonGroupForAgent(selectedSidebarContact.id, groupChats)
          const requestState = requestStateForAgent({
            agent: selectedSidebarContact,
            currentUserId: user?.id,
            commonGroup,
            sentRequestIds,
            requestingAgentId,
          })
          return (
            <CpaneShell
              title={displayName(selectedSidebarContact)}
              overlay={
                <>
                  {/* 设置 modal — opens AgentSettingsModal (rename lives in AgentProfilePane) */}
                  {cpaneSettingsContact?.id === selectedSidebarContact.id ? (
                    <AgentSettingsModal
                      agent={cpaneSettingsContact}
                      onClose={() => setCpaneSettingsContact(null)}
                    />
                  ) : null}
                  {/* 分享 modal — opens ShareAgentModal (invites friends via shareAgentWithFriends) */}
                  {cpaneShareContact?.id === selectedSidebarContact.id ? (
                    <ShareAgentModal
                      agent={cpaneShareContact}
                      contacts={humanContacts}
                      onClose={() => setCpaneShareContact(null)}
                      onOpenGroupChat={onOpenGroupChat}
                    />
                  ) : null}
                </>
              }
            >
              {/* 设计稿 cpane = 仅头像/名称/状态 + 动作卡片；旧 AgentDetail 的可见性/运行/共同群等
                  不在设计稿 cpane 中（移到 Agent 设置 modal）→ 不再 stack。 */}
              <AgentContactProfileCard
                contact={selectedSidebarContact}
                onSwitchToChat={isOwnedAgent && onSwitchToChat ? () => onSwitchToChat(selectedSidebarContact) : undefined}
                onShare={isOwnedAgent ? () => setCpaneShareContact(selectedSidebarContact) : undefined}
                onSettings={isOwnedAgent ? () => setCpaneSettingsContact(selectedSidebarContact) : undefined}
                onDelete={isOwnedAgent ? () => handleRemoveContact(selectedSidebarContact) : undefined}
                requestState={requestState}
                onRequest={() => requestAgent(selectedSidebarContact)}
                onOpenGroup={commonGroup && onOpenGroupChat ? () => onOpenGroupChat(commonGroup) : undefined}
              />
            </CpaneShell>
          )
        }
        // human contact — 设计稿人物 cpane = 仅头像/名称 + 发消息卡片；旧 HumanDetail 不在设计稿 → 不 stack。
        return (
          <CpaneShell title={displayName(selectedSidebarContact)}>
            <PersonContactProfileCard
              contact={selectedSidebarContact}
              onSwitchToChat={onSwitchToChat ? () => onSwitchToChat(selectedSidebarContact) : undefined}
            />
          </CpaneShell>
        )
      }
      // empty state
      return (
        <Pane paneRole="detail">
          <PaneHeader divider />
          <div className="gg-c-cpane-empty flex flex-1 items-center justify-center">
            <PaneEmptyState icon={<Users size={26} color="var(--text-tertiary)" />} caption={ct('panel.selectContact')} />
          </div>
        </Pane>
      )
    })()

    return (
      <div className="flex h-full min-w-0 flex-1 overflow-hidden">
        <ContactsThreeSectionSidebar
          mobile={false}
          currentUserId={user?.id}
          agentContacts={agentContacts}
          humanContacts={humanContacts}
          groupChats={groupChats}
          pendingCount={pendingRequestCount}
          query={query}
          onQuery={setQuery}
          selectedContactId={selectedContactId}
          selectedGroupId={selectedSidebarGroupId}
          selectionMode={contactSelectionMode}
          selectedContactIds={selectedContactIds}
          newFriendsActive={selectedNav === 'new_friends'}
          onSelectContact={(c) => {
            if (contactSelectionMode && c.owner_user_id === user?.id) {
              toggleContactSelection(c)
              return
            }
            setSelectedContactId(c.id)
            setSelectedSidebarGroupId(null)
            setSelectedNav(c.type === 'agent' ? 'agent_library' : 'contacts')
            setEditingTagId(null)
          }}
          onToggleContact={toggleContactSelection}
          onEnterSelectionMode={enterContactSelectionMode}
          onFinishSelectionMode={finishContactSelectionMode}
          onCreateGroupFromSelection={() => setShowGroupModal(true)}
          onSelectGroup={(g) => {
            setContactSelectionMode(false)
            setSelectedContactIds(new Set())
            setSelectedSidebarGroupId(g.id)
            setSelectedContactId(null)
            setSelectedNav('group_chats')
            setEditingTagId(null)
          }}
          onSelectNewFriends={() => {
            setContactSelectionMode(false)
            setSelectedContactIds(new Set())
            setSelectedNav('new_friends')
            setSelectedContactId(null)
            setSelectedSidebarGroupId(null)
          }}
          onSelectAddFriend={(mode, seed) => {
            setAddFriendMode(mode)
            setContactSelectionMode(false)
            setSelectedContactIds(new Set())
            setSelectedNav('add_friend')
            setSelectedContactId(null)
            setSelectedSidebarGroupId(null)
            // @@@add-friend-unify 点按钮进加人搜索必须开在空态：清掉上一次扫码残留的 seed，
            // 否则会用旧扫码号预填搜索（seed effect 按 token 只触发一次，但新挂载会重读旧 token）。
            setAddFriendSeed(seed ? { query: seed, token: Date.now() } : null)
          }}
          onCreateAgent={onOpenAgentCreateDraft}
          onCreateGroup={() => setShowGroupModal(true)}
          onStartChat={onSwitchToChat}
          onPin={handleContactPin}
          onMarkUnread={handleContactMarkUnread}
          onToggleNotif={handleContactToggleNotif}
          onRemove={handleRemoveContact}
          contactPinned={contactPinned}
          contactNotifMuted={contactNotifMuted}
          getContactRemoveLabel={getContactRemoveLabel}
          onGroupPin={handleGroupPin}
          onGroupToggleNotif={handleGroupToggleNotif}
          onGroupLeaveOrDissolve={handleGroupLeaveOrDissolve}
          groupPinned={groupPinned}
          groupNotifMuted={groupNotifMuted}
        />
        {cpaneRight}
        {groupModal}
        {groupInviteJoinModal}
      </div>
    )
  }

  // ── Mobile layout: nav / index / detail pane flow ────────────────────────────
  // @@@1944 只有移动端走到这里（桌面已在上方 return）——mobilePane 是这套 pane 流的单一真相源。
  const showNav = mobilePane === 'nav'
  const showIndex = mobilePane === 'index'
  const showDetail = mobilePane === 'detail'

  return (
    <div className="flex h-full min-w-0 flex-1 overflow-hidden">
      {showNav && (
        <ContactsNav
          selected={selectedNav}
          mobile={mobile}
          active={activeTab === 'contacts'}
          people={humanContacts}
          agents={agentContacts}
          groupChats={groupChats}
          pendingCount={pendingRequestCount}
          groups={groups}
          query={query}
          onQuery={setQuery}
          onSelect={selectNav}
          onOpenContact={(c) => { setSelectedNav(c.type === 'agent' ? 'agent_library' : 'contacts'); selectContact(c) }}
          onOpenGroupChat={onOpenGroupChat}
          onCreateGroup={createGroup}
          onRenameGroup={renameGroup}
          onDeleteGroup={async (groupId) => {
            await deleteGroup(groupId)
            if (selectedNav === `group:${groupId}`) setSelectedNav('contacts')
          }}
        />
      )}

      {selectedNav === 'group_chats' ? (
        showIndex ? (
          <GroupChatsDetail
            groups={groupChats}
            mobile={mobile}
            onBack={() => navigateMobile(() => setMobilePane('nav'), 'pop')}
            onOpenGroupChat={onOpenGroupChat}
            onCreateGroup={() => setShowGroupModal(true)}
            onGroupPin={handleGroupPin}
            onGroupToggleNotif={handleGroupToggleNotif}
            onGroupLeaveOrDissolve={handleGroupLeaveOrDissolve}
            groupPinned={groupPinned} groupNotifMuted={groupNotifMuted}
          />
        ) : null
      ) : selectedNav === 'add_friend' ? (
        // @@@add-friend-unify add_friend 直达搜索加人面板（AddFriendSearch）——与「新的请求」分成
        // 两条链路：扫码/点加人图标进这里搜索加人，此面板不含请求收件箱。
        showIndex ? (
          <AddFriendSearch
            seed={addFriendSeed}
            autoFocus
            showHeader
            mode={addFriendMode}
            onBack={() => navigateMobile(() => setMobilePane('nav'), 'pop')}
          />
        ) : null
      ) : selectedNav === 'new_friends' ? (
        // @@@1944 new_friends 直达请求面板（对齐 group_chats 分支形状）——不再经过一层把请求
        // 发起/接收人伪装成联系人行的 ContactsIndex；「返回」由 NewFriendsPanel 按 onBack 真渲染。
        showIndex ? (
          <NewFriendsPanel
            onOpenGroupChat={onOpenGroupChat}
            onBack={() => navigateMobile(() => setMobilePane('nav'), 'pop')}
          />
        ) : null
      ) : (
        <>
          {showIndex && (
            <ContactsIndex
              title={listTitle}
              mobile={mobile}
              contacts={scopedContacts}
              currentUserId={user?.id}
              sectionBy={selectedNav === 'agent_library' ? 'device' : undefined}
              loading={loadingContacts || loadingGroups}
              selectedContactId={selectedContact?.id}
              selectionMode={contactSelectionMode}
              selectedContactIds={selectedContactIds}
              onEnterSelectionMode={enterContactSelectionMode}
              onFinishSelectionMode={finishContactSelectionMode}
              onToggleContact={toggleContactSelection}
              onCreateGroupFromSelection={() => setShowGroupModal(true)}
              onBack={() => navigateMobile(() => setMobilePane('nav'), 'pop')}
              onAddContact={selectedGroup ? undefined : () => selectNav('add_friend')}
              onCreateAgent={onOpenAgentCreateDraft}
              onSelect={selectContact}
              onRemoveContact={handleRemoveContact}
              onStartChat={onSwitchToChat}
              onPin={handleContactPin}
              onMarkUnread={handleContactMarkUnread}
              onToggleNotif={handleContactToggleNotif}
              contactPinned={contactPinned}
              contactNotifMuted={contactNotifMuted}
              getContactRemoveLabel={getContactRemoveLabel}
              subtitle={selectedGroup ? ct('tags.titleWithCount', { count: scopedContacts.length }) : undefined}
              summaryLabel={selectedGroup ? ct('tags.countSummary', { count: scopedContacts.length }) : undefined}
              headerActions={
                selectedGroup ? (
                  <IconButton title={ct('tags.editTitle')} onClick={() => editTagMembers(selectedGroup)}>
                    <UserPlus size={14} />
                  </IconButton>
                ) : undefined
              }
            />
          )}

          {showDetail && editingTag ? (
            <TagMemberEditorDetail
              tag={editingTag}
              mobile={mobile}
              onBack={() => {
                setEditingTagId(null)
                setMobilePane('index')
              }}
              contacts={contacts}
              onUpdateMembers={updateGroupMembers}
            />
          ) : showDetail && selectedGroup ? (
            selectedContact ? (
              <ContactDetail
                contact={selectedContact}
                humanContacts={humanContacts}
                sentRequestIds={sentRequestIds}
                requestingAgentId={requestingAgentId}
                groupChats={groupChats}
                mobile={mobile}
                onBack={() => navigateMobile(() => setMobilePane('index'), 'pop')}
                onSwitchToChat={onSwitchToChat}
                onOpenGroupChat={onOpenGroupChat}
                onRequestAgent={requestAgent}
                onSetAgentPublic={setAgentPublic}
                onSetAgentDesiredStatus={setAgentDesiredStatus}
                getCommonGroupChats={getCommonGroupChats}
              />
            ) : (
              <TagEmptyDetail
                tag={selectedGroup}
                mobile={mobile}
                onBack={() => navigateMobile(() => setMobilePane('index'), 'pop')}
                onEditMembers={() => editTagMembers(selectedGroup)}
              />
            )
          ) : showDetail ? (
            <ContactDetail
              contact={selectedContact}
              humanContacts={humanContacts}
              sentRequestIds={sentRequestIds}
              requestingAgentId={requestingAgentId}
              groupChats={groupChats}
              mobile={mobile}
              onBack={() => navigateMobile(() => setMobilePane(query.trim() ? 'nav' : 'index'), 'pop')}
              onSwitchToChat={onSwitchToChat}
              onOpenGroupChat={onOpenGroupChat}
              onRequestAgent={requestAgent}
              onSetAgentPublic={setAgentPublic}
              onSetAgentDesiredStatus={setAgentDesiredStatus}
              getCommonGroupChats={getCommonGroupChats}
            />
          ) : null}
        </>
      )}
      {groupModal}
      {groupInviteJoinModal}
    </div>
  )
}
