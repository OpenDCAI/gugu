import { useState, useEffect, useMemo, useRef, useCallback, type KeyboardEventHandler } from 'react'
import { useTranslation } from 'react-i18next'
import { BellOff, CheckCircle, Checklist, ChevronDown, ChevronRight, MessageCircle, MessageSquare, Pin, Plus, Trash, X, Zap, type IconComponent } from '@/lib/icons'
import { Sheet } from './ui/Sheet'
import { DropdownMenu, Menu, MenuItem } from './ui/Menu'
import { PaneEmptyState } from './ui/PaneEmptyState'
import { SearchField } from './ui/SearchField'
import { HeaderSearch } from './ui/HeaderSearch'
import { Pane, PaneHeader } from './ui/Pane'
import { ListRow } from './ui/ListRow'
import { Chip } from './ui/Chip'
import { Button } from './ui/Button'
import { IconButton } from './ui/IconButton'
import type { SidebarTab } from '@gugu/core/shared/enums/sidebarTabModels'
import { useAssistantShell } from '../session/renderer/features/assistant/assistant-shell'
import { isDuplicateAssistantChat } from '../lib/assistantChatList'
import { useAssistantWorkrooms } from './assistant/useAssistantWorkrooms'
import { useChatStore } from '../store/chatContext'
import { markAllChatsReadAndRefresh } from '../lib/chatUnreadLocator'
import { chatPreviewText } from '../lib/agentTurnFailure'
import { useToast } from './toastContext'
import { formatCalendarDay } from '../lib/calendarTime'
import { CreateGroupChatForm } from './CreateGroupChatModal'
import { AddFriendSearch } from './AddFriendSearch'
import { Avatar } from './Avatar'
import { AUTOMATION_TEST_IDS } from '../lib/automationDom'
import { UI_EVENTS } from '../lib/uiEvents'
import { requestTopicSplit } from '../lib/topicSplitRequest'
import { groupTopicsBySource, isTopLevelChatRow, splitSunkTopics } from './chatListTopicNesting'
import { requestTopicsPanel } from '../lib/topicsPanelRequest'
import { useAgentDisplayStatuses } from '../hooks/useAgentDisplayStatus'
import { useShownAgentStatus, type ShownAgentStatus } from './chat/useAgentsOnCloudComputer'
import { AgentHostStaleBadge } from './AgentHostStaleBadge'
import { aggregateGroupAgentStatus } from '../lib/groupAgentStatus'
import { chatActivityAt, chatDisplayName, compareChatsByActivityDesc, isChatListed, isRoomChat, isSunkTopic } from '@gugu/core/shared/ui/chatModels'
import { platform } from '../platform'
import type { AgentDisplayStatus, ChatItem, NotificationLevel } from '@gugu/core/shared/types/chat'
import { useDevicesStore } from '../store/devicesContext'
import { chatRowTag } from '../lib/chatRowTag'
import { resolveOrLoud } from '@gugu/core/shared/resolveOrLoud'
import { rendererLogger } from '../lib/log'
import { chatListShortcutFor, nextChatId } from './chat-list-keyboard-nav'

const chatListLog = rendererLogger('chat/list')

// @@@chat-list-agent-status (#437) - an agent chat is glanceable in the list when its presence shows
function chatIsAgent(chat: ChatItem, identity?: { type: 'human' | 'agent' }): boolean {
  return chat.kind === 'ai' || identity?.type === 'agent'
}

// @@@group-agent-status (#33) - aggregate helper lives in its own module (pure, unit-tested) so this
// component file only exports components (keeps fast-refresh happy). This wrapper stays local.
// 一行的状态点就是那张 agent 表里那个 agent 的态 —— agent 行取它自己的,群行取成员的聚合(任一成员在跑
// 即群在跑)。❌ 没有「按本行会话再收口一次」:同一个 agent 的两行不许给出两个答案。
function rowAgentStatus(
  chat: ChatItem,
  identities: Readonly<Record<string, { type: 'human' | 'agent' }>>,
  statuses: Record<string, AgentDisplayStatus>,
  shown: ShownAgentStatus,
): AgentDisplayStatus | undefined {
  if (chatIsAgent(chat, identities[chat.peer_user_id ?? ''])) {
    return shown.status(chat.peer_user_id, statuses[chat.peer_user_id ?? ''] ?? 'pending')
  }
  // 场所(群 + 话题)都有成员名单,聚合判据同形 —— ❌ 不是只有群才聚合。
  if (isRoomChat(chat.kind)) {
    const agentIds = (chat.member_user_ids ?? []).filter((id) => identities[id]?.type === 'agent')
    return aggregateGroupAgentStatus(shown.members(agentIds, statuses), statuses)
  }
  return undefined
}

interface ChatListPanelProps {
  activeTab: SidebarTab
  mobile?: boolean
  /** 手机上列表被打开的会话 / 创建页整页盖住(隐藏不卸载)。 */
  hidden?: boolean
  onChatSelected?: (focusTarget?: 'composer' | 'sidebar') => void
  onScan?: () => void
  // #2549/#3195 对话页创建 Agent — all shells hand off to the shared Session Composer assembly.
  // @@@4287 必填,不是可选:「哪套装配」是宿主的事,「有没有这个入口」不是。写成可选时,一个
  // `sessionHostAvailable ? open : undefined` 就能在类型层面无声地把安卓出货面的创建入口整个摘掉
  // (#3809 实际发生过)。必填让那种写法当场是编译错误 —— 比任何测试都早、也更便宜。
  onOpenAgentCreateDraft?: () => void
  onOpenSessionCreate?: () => void
}

const CHAT_LIST_PLUS_BUTTON_SELECTOR = AUTOMATION_TEST_IDS.chatListPlusButton
const COLOR_PLACEHOLDER = 'var(--text-tertiary)'

// @@@ui-ruler — 迁移到 Pane/PaneHeader/ListRow 原语后仍需要的少量结构性 style,提到模块作用域
// 命名常量:既避免每次渲染重建对象,也让 JSX 里的 `style={{` 计数落回原语迁移前的水平。
const NAV_PANE_STYLE: React.CSSProperties = { width: '100%', minWidth: 0, flex: '1 1 auto' }
// 保留 macOS 交通灯让位逻辑(#1238):列头左内距在「基础内距」与「交通灯安全区」间取大值。
const NAV_HEADER_STYLE: React.CSSProperties = { paddingLeft: 'max(var(--pane-pad-x), var(--titlebar-list-header-inset))' }
// #6753 桌面上还要让开浮在左上角的列表栏开关(--list-toggle-lane;Windows 的开关在标题栏行,那里是 0)。
const NAV_HEADER_STYLE_DESKTOP: React.CSSProperties = { paddingLeft: 'max(var(--pane-pad-x), var(--titlebar-list-header-inset), var(--list-toggle-lane))' }
const LIST_SCROLL_STYLE: React.CSSProperties = { flex: 1, overflowY: 'auto', padding: '4px 8px 16px' }
const LOADING_STATE_STYLE: React.CSSProperties = { padding: '24px', textAlign: 'center', color: COLOR_PLACEHOLDER, fontSize: 'var(--font-body)' }
const EMPTY_STATE_WRAP_STYLE: React.CSSProperties = { padding: '40px 16px', display: 'flex', justifyContent: 'center' }
const NO_RESULTS_STYLE: React.CSSProperties = { padding: '40px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-body)' }
const PLUS_MENU_CONTENT_STYLE: React.CSSProperties = { minWidth: 160 }
const PLUS_MENU_ITEM_STYLE_DESKTOP: React.CSSProperties = { minHeight: 'var(--control-h-lg)', fontSize: 'var(--font-body)' }
const PLUS_MENU_ITEM_STYLE_TOUCH: React.CSSProperties = { minHeight: 'var(--control-h-touch)', fontSize: 'var(--font-title)' }
const ADD_FRIEND_BODY_STYLE: React.CSSProperties = { position: 'relative', display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1, overflow: 'hidden' }
const ADD_FRIEND_HEADER_STYLE: React.CSSProperties = { display: 'flex', alignItems: 'center', padding: '14px 16px 10px', borderBottom: '1px solid var(--border-color)' }
const ADD_FRIEND_TITLE_STYLE: React.CSSProperties = { flex: 1, fontSize: 'var(--font-title)', lineHeight: 'var(--lh-title)', fontWeight: 600, color: 'var(--text-primary)' } // #7333 弹层标题 16/24

// ── Chat row context menu ──────────────────────────────────────────────────────

interface ChatRowMenuProps {
  x: number
  y: number
  chat: ChatItem
  onClose: () => void
  onPin: () => void
  onSetNotificationLevel: (level: NotificationLevel) => void
  onDelete: () => void
}

// @@@5856 「更早」分段头:一行低调的可点条,不做成折叠箭头家具。
const SUNK_SECTION_STYLE: React.CSSProperties = {
  width: '100%',
  justifyContent: 'flex-start',
  padding: '8px 16px 8px calc(40px + 13px + var(--row-gap))',
  border: 0,
  minHeight: 0,
  color: 'var(--text-tertiary)',
  // #7333 标注档 12/18:Button 自带 leading-none,不写行高这一行就是 12/12。
  fontSize: 'var(--font-caption)',
  lineHeight: 'var(--lh-caption)',
}

// 会话右键菜单 —— 按设计稿 #ctxmenu：置顶 / 关闭通知 / 全部标为已读 / 删除（带原图标）。
function ChatRowContextMenu({ x, y, chat, onClose, onPin, onSetNotificationLevel, onDelete }: ChatRowMenuProps) {
  const { t } = useTranslation('messaging')
  const { chats, refreshChats } = useChatStore('chats', 'refreshChats')
  const { toast } = useToast()
  const currentLevel = chat.notification_level ?? 'all'

  const items: { label: string; icon: IconComponent; danger?: boolean; disabled?: boolean; testId?: string; onClick: () => void }[] = [
    {
      label: chat.is_pinned ? t('chatList.unpin') : t('chatList.pin'),
      icon: Pin,
      onClick: () => { onPin(); onClose() },
    },
    {
      label: currentLevel === 'none' ? t('chatList.enableNotifications') : t('chatList.disableNotifications'),
      icon: BellOff,
      onClick: () => {
        onSetNotificationLevel(currentLevel === 'none' ? 'all' : 'none')
        onClose()
      },
    },
    {
      label: t('chatList.markAllRead'),
      icon: CheckCircle,
      testId: 'chat-row-mark-all-read',
      disabled: !chats.some((row) => row.unread_count > 0),
      onClick: () => {
        onClose()
        void markAllChatsReadAndRefresh({ chats, refresh: refreshChats })
          .then(({ failedChats }) => { if (failedChats > 0) toast(t('chatList.markAllReadPartial', { count: failedChats }), 'error') })
          .catch((error: unknown) => {
            chatListLog.error({ error: String(error) }, 'mark all read failed')
            toast(t('chatList.markAllReadFailed'), 'error')
          })
      },
    },
    {
      label: t('chatList.delete'),
      icon: Trash,
      danger: true,
      onClick: () => { onDelete(); onClose() },
    },
  ]

  return (
    <Menu x={x} y={y} minWidth={160} onClose={onClose}>
      {items.map((item) => (
        <MenuItem key={item.label} danger={item.danger} disabled={item.disabled} data-testid={item.testId} icon={<item.icon size={15} />} onClick={item.onClick}>
          {item.label}
        </MenuItem>
      ))}
    </Menu>
  )
}

// ── Chat row ───────────────────────────────────────────────────────────────────

interface ChatRowProps {
  chat: ChatItem
  agentStatus?: AgentDisplayStatus
  isActive: boolean
  topicsExpanded?: boolean
  draft?: string
  // @@@1787 移动触控放大(对齐 ContactsPanel.ContactRow 的 mobile 规格)
  mobile?: boolean
  onClick: () => void
  onPin: () => void
  onSetNotificationLevel: (level: NotificationLevel) => void
  onDelete: () => void
  tabIndex: number
  onFocus: () => void
  onKeyDown: KeyboardEventHandler<HTMLDivElement>
}

// @@@5856 会话列表里的话题子行。
//
// 它要读起来是「来源那条线底下的一条支线」,❌ 不是一条平级会话 —— 所以与 ChatRow 的差别是刻意的:
//   · 没有头像。头像是**身份**的东西(人、agent、群的成员组合),话题不是一个身份;
//     给它一个头像,它在列表里立刻长得和群一模一样,这正是 owner 指出的那个问题。
//   · 只有一行:名字 + 有未读时贴右的那个数字。时间和预览都留给来源那条线的行去说 ——
//     一条支线不该和它的来源在同一屏上比谁的信息多。
//   · 左边一条竖轨(.gg-topic-subrows)把同一条线下的话题圈成一组。
const TOPIC_SUBROW_STYLE: React.CSSProperties = { paddingLeft: 40, paddingTop: 4, paddingBottom: 4 }
const TOPIC_SUBROW_ICON_STYLE: React.CSSProperties = { color: 'var(--text-tertiary)' }
const TOPIC_SUBROW_NAME_STYLE: React.CSSProperties = { fontSize: 'var(--font-body)', color: 'var(--text-secondary)' }

function TopicSubRow({ topic, isActive, tabIndex, onClick, onFocus, onKeyDown, onPin, onSetNotificationLevel, onDelete }: {
  topic: ChatItem
  isActive: boolean
  tabIndex: number
  onClick: () => void
  onFocus: () => void
  onKeyDown: KeyboardEventHandler<HTMLDivElement>
  onPin: () => void
  onSetNotificationLevel: (level: NotificationLevel) => void
  onDelete: () => void
}) {
  // @@@5856 子行与普通会话行共用同一份右键菜单(置顶 / 免打扰 / 删除)。
  // 缺了它话题就成了「删不掉、置顶不了、免打扰不了」的一等会话 —— 而 isSunkTopic 读的
  // is_pinned / is_marked_unread 也会变成没人写得进的死字段(找茬第十轮实测)。
  const [showMenu, setShowMenu] = useState(false)
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 })
  useEffect(() => {
    if (!showMenu) return
    const close = () => setShowMenu(false)
    document.addEventListener(UI_EVENTS.closeContextMenus, close as EventListener)
    return () => { document.removeEventListener(UI_EVENTS.closeContextMenus, close as EventListener) }
  }, [showMenu])
  return (
    <>
    <ListRow
      data-chat-id={topic.id}
      data-chat-row={topic.id}
      data-topic-subrow={topic.id}
      selected={isActive}
      emphasis={topic.unread_count > 0}
      role="option"
      aria-selected={isActive}
      tabIndex={tabIndex}
      onClick={onClick}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        document.dispatchEvent(new CustomEvent(UI_EVENTS.closeContextMenus))
        setMenuPos({ x: e.clientX, y: e.clientY })
        setShowMenu(true)
      }}
      style={TOPIC_SUBROW_STYLE}
      leading={<MessageSquare size={13} style={TOPIC_SUBROW_ICON_STYLE} />}
      title={<span style={TOPIC_SUBROW_NAME_STYLE}>{topic.name}</span>}
      meta={topic.unread_count > 0 ? topic.unread_count : undefined}
    />
    {showMenu && (
      <ChatRowContextMenu
        x={menuPos.x}
        y={menuPos.y}
        chat={topic}
        onClose={() => setShowMenu(false)}
        onPin={onPin}
        onSetNotificationLevel={onSetNotificationLevel}
        onDelete={onDelete}
      />
    )}
    </>
  )
}

function ChatRow({ chat, agentStatus, isActive, topicsExpanded, draft, mobile = false, onClick, onPin, onSetNotificationLevel, onDelete, tabIndex, onFocus, onKeyDown }: ChatRowProps) {
  const { t } = useTranslation('messaging')
  const { identitiesById } = useChatStore('identitiesById')
  const [showMenu, setShowMenu] = useState(false)
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 })
  const peerIdentity = identitiesById[chat.peer_user_id ?? '']
  const isAgentChat = chatIsAgent(chat, peerIdentity)
  // @@@5856 这四处判的都是「这是不是一个**场所**」(有自己的名字/头像/成员),不是「是不是群」。
  // 写 kind === 'group' 的后果:话题落进私聊分支 → peer_user_id 为 null → resolveOrLoud 在正式包
  // 返回空串 ⇒ 会话列表里话题是**一行没有名字的空行**,还每渲染一次刷一条 console.error。
  const isRoom = isRoomChat(chat.kind)
  const peerName = isRoom ? '' : resolveOrLoud(peerIdentity?.display_name, `chat-list peer ${chat.peer_user_id ?? 'missing'} for chat ${chat.id}`)
  const displayName = chatDisplayName(chat, peerName)
  const preview = chatPreviewText(chat)
  const { devices } = useDevicesStore() // @@@1759 解析 agent 会话行的真实设备归属标签
  const tag = chatRowTag(chat, peerIdentity, devices)
  const hasBolt = isRoom || isAgentChat

  useEffect(() => {
    if (!showMenu) return
    const close = () => setShowMenu(false)
    document.addEventListener(UI_EVENTS.closeContextMenus, close as EventListener)
    return () => {
      document.removeEventListener(UI_EVENTS.closeContextMenus, close as EventListener)
    }
  }, [showMenu])

  return (
    <>
      <ListRow
        data-chat-id={chat.id}
        data-chat-row={chat.id}
        data-unread-stream-id={chat.unread_locator?.stream_id ?? undefined}
        data-unread-message-id={chat.unread_locator?.message_id ?? undefined}
        selected={isActive}
        pinned={chat.is_pinned}
        emphasis={chat.unread_count > 0}
        mobile={mobile}
        role="option"
        aria-selected={isActive}
        aria-expanded={topicsExpanded}
        tabIndex={tabIndex}
        onClick={onClick}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          document.dispatchEvent(new CustomEvent(UI_EVENTS.closeContextMenus))
          setMenuPos({ x: e.clientX, y: e.clientY })
          setShowMenu(true)
        }}
        leading={
          // Avatar — agent status lives in the corner badge (AvatarStatusBadge); the old
          // top-right dot was consolidated into it (#793 follow-up).
          <Avatar
            name={displayName}
            avatarUrl={isRoom ? chat.avatar : peerIdentity?.avatar}
            seed={chat.peer_user_id ?? undefined}
            size={mobile ? 'md' : 'sm'}
            isAgent={isAgentChat}
            agentStatus={agentStatus}
            variant={isRoom ? 'group' : 'default'}
            memberAvatars={chat.member_user_ids?.flatMap((id) => identitiesById[id] ? [{ id, name: identitiesById[id].display_name, avatar: identitiesById[id].avatar }] : [])}
          />
        }
        title={
          <>
            {isAgentChat && chat.peer_user_id && <AgentHostStaleBadge agentUserId={chat.peer_user_id} size={13} />}
            {displayName}
          </>
        }
        accessory={
          <>
            {/* Bolt/sparkle — the design accent, kept off the icon-size ladder
                (11px decorative, not an icon-button glyph). Shown on agent and group rows. */}
            {hasBolt && <Zap size={11} style={{ color: 'var(--agent-bolt)', flexShrink: 0 }} />}
            {topicsExpanded !== undefined && (topicsExpanded
              ? <ChevronDown className="size-3.5 shrink-0" style={TOPIC_SUBROW_ICON_STYLE} aria-hidden="true" />
              : <ChevronRight className="size-3.5 shrink-0" style={TOPIC_SUBROW_ICON_STYLE} aria-hidden="true" />)}
          </>
        }
        meta={formatCalendarDay(chatActivityAt(chat))}
        subtitle={
          draft ? (
            <>
              <span style={{ color: 'var(--color-draft)' }}>{t('chatList.draft')}</span>
              {' '}{draft}
            </>
          ) : preview
        }
        trailing={
          <>
            {/* @@@ui-ruler 设备名 / 群聊 chip 放第二行右侧,不和名字抢标题行——名字优先保完整
                (原来「论文助手」被 MacBook Pro chip 挤成一个字)。 */}
            {tag && <Chip>{tag}</Chip>}
            {chat.is_muted && (
              <span aria-label={t('chatList.muted')} title={t('chatList.muted')} style={{ color: 'var(--text-tertiary)' }}>
                <BellOff size={13} strokeWidth={1.8} aria-hidden="true" />
              </span>
            )}
            {chat.unread_count > 0 && (
              <Chip tone="accent" shape="count">
                {chat.unread_count > 99 ? '99+' : chat.unread_count}
              </Chip>
            )}
          </>
        }
      />

      {/* Context menu — portalled to body */}
      {showMenu && (
        <ChatRowContextMenu
          x={menuPos.x}
          y={menuPos.y}
          chat={chat}
          onClose={() => setShowMenu(false)}
          onPin={onPin}
          onSetNotificationLevel={onSetNotificationLevel}
          onDelete={onDelete}
        />
      )}
    </>
  )
}

// ── AddFriendModal ─────────────────────────────────────────────────────────────

// @@@add-friend-unify 弹窗只是一层壳：搜索加人的实现复用 AddFriendSearch，与通讯录「添加联系人」
// 路由同一条链路（同一搜索框 / 结果行 / 附言发送流）。此前这里自写了一套搜索 UI + 结果行，与
// NewFriendsPanel 的搜索态重复；unify 后统一走 AddFriendSearch，并因此获得附言 dialog（原弹窗是即发）。
function AddFriendContent({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('messaging')
  return (
      <div style={ADD_FRIEND_BODY_STYLE}>
        {/* Header */}
        <div style={ADD_FRIEND_HEADER_STYLE}>
          <span style={ADD_FRIEND_TITLE_STYLE}>{t('chatList.addContact')}</span>
          <IconButton aria-label={t('common.close')} size="sm" onClick={onClose}>
            <X />
          </IconButton>
        </div>

        <AddFriendSearch autoFocus onBack={onClose} />
      </div>
  )
}

// ── PlusMenu ───────────────────────────────────────────────────────────────────
// The shared social actions are always present. A task-host capability may contribute New task;
// targets without the task renderer omit the action instead of advertising a dead destination.

interface PlusMenuItemsProps {
  onSessionCreate?: () => void
  onGroupChat: () => void
  onAddFriend: () => void
  onScan?: () => void
  mobile?: boolean
}

function PlusMenuItems({ onSessionCreate, onGroupChat, onAddFriend, onScan, mobile = false }: PlusMenuItemsProps) {
  const { t } = useTranslation('messaging')
  // design line 592: 新建群聊 (contacts icon) + 添加联系人 (add-person icon)
  const items = [
    ...(onSessionCreate
      ? [{
          testid: AUTOMATION_TEST_IDS.mobileSessionCreateAction,
          icon: <Checklist size={15} />,
          label: t('chatList.createTask'),
          onClick: onSessionCreate,
        }]
      : []),
    {
      testid: 'plus-menu-create-group',
      // design: contacts SVG from line 592 (#pm-newgroup)
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24">
          <g fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="9" cy="6" r="4"/>
            <path strokeLinecap="round" d="M15 9a3 3 0 1 0 0-6"/>
            <ellipse cx="9" cy="17" rx="7" ry="4"/>
            <path strokeLinecap="round" d="M18 14c1.754.385 3 1.359 3 2.5c0 1.03-1.014 1.923-2.5 2.37"/>
          </g>
        </svg>
      ),
      label: t('chatList.createGroup'),
      onClick: onGroupChat,
    },
    {
      testid: 'plus-menu-add-friend',
      // design: add-person SVG from line 592 (#pm-addcontact)
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24">
          <g fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="12" cy="6" r="4"/>
            <circle cx="17" cy="18" r="4"/>
            <path strokeLinecap="round" strokeLinejoin="round" d="M17 16.667v2.666M15.667 18h2.666"/>
            <path d="M14 20.834c-.634.108-1.305.166-2 .166c-3.866 0-7-1.79-7-4s3.134-4 7-4c1.713 0 3.283.352 4.5.936"/>
          </g>
        </svg>
      ),
      label: t('chatList.addContact'),
      onClick: onAddFriend,
    },
    // @@@scan-frame-icon (#537) — gated on barcodeScan capability; not in design dropdown but kept for native-scan devices
    ...(onScan && platform.capabilities.barcodeScan
      ? [{
          testid: 'plus-menu-scan',
          icon: (
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
              <path d="M2.5 6V4A1.5 1.5 0 0 1 4 2.5H6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M13.5 10v2A1.5 1.5 0 0 1 12 13.5H10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ),
          label: t('chatList.scan'),
          onClick: onScan,
        }]
      : []),
  ]

  return (
    <>
      {items.map((item) => (
        <MenuItem
          key={item.label}
          data-testid={item.testid}
          onClick={item.onClick}
          icon={item.icon}
          style={mobile ? PLUS_MENU_ITEM_STYLE_TOUCH : PLUS_MENU_ITEM_STYLE_DESKTOP}
        >
          {item.label}
        </MenuItem>
      ))}
    </>
  )
}

// ── Panel ──────────────────────────────────────────────────────────────────────

export function ChatListPanel({
  activeTab,
  mobile = false,
  hidden = false,
  onChatSelected,
  onScan,
  onOpenAgentCreateDraft,
  onOpenSessionCreate,
}: ChatListPanelProps) {
  const { t } = useTranslation('messaging')
  const { t: tMain } = useTranslation('main')
  const assistantShell = useAssistantShell()
  const { chats, identitiesById, activeChatId, setActiveChatId, openUnreadChat, loadingChats, pinChat, deleteChat, setChatNotificationLevel, drafts } = useChatStore('chats', 'identitiesById', 'activeChatId', 'setActiveChatId', 'openUnreadChat', 'loadingChats', 'pinChat', 'deleteChat', 'setChatNotificationLevel', 'drafts')
  const workrooms = useAssistantWorkrooms(assistantShell, chats.filter((chat) => chat.kind === 'group')
    .map((chat) => `${chat.id}:${[...(chat.member_user_ids ?? [])].sort().join(',')}`).sort().join('|'))
  // @@@chat-list-agent-status (#437/#33) - one batched presence subscription for every agent shown in
  // the list: DM-with-agent peers + all group agent members (so the group dot can aggregate).
  const agentIdsForStatus = [
    ...chats.filter((chat) => chatIsAgent(chat, identitiesById[chat.peer_user_id ?? ''])).map((c) => c.peer_user_id ?? '').filter(Boolean),
    ...chats.flatMap((c) => (c.member_user_ids ?? []).filter((id) => identitiesById[id]?.type === 'agent')),
  ]
  const agentStatuses = useAgentDisplayStatuses(agentIdsForStatus)
  const shownAgent = useShownAgentStatus() // #7199 宿主闲时收回着的自己的 agent:不画睡团 / 「不在线」
  const [showGroupModal, setShowGroupModal] = useState<boolean | string>(false)
  const [showAddFriendModal, setShowAddFriendModal] = useState(false)
  const [showPlusMenu, setShowPlusMenu] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [focusedChatId, setFocusedChatId] = useState<string | null>(activeChatId)
  const [collapsedTopicSources, setCollapsedTopicSources] = useState<ReadonlySet<string>>(() => new Set())
  // @@@5856 分栏此刻显示的是哪条话题 —— 子行的高亮要跟着它,而分栏也可以从消息上的锚点打开,
  // 所以这个真值只能由聊天区广播过来(UI_EVENTS.topicSplitChanged),❌ 不许在这边猜。
  const [activeTopicChatId, setActiveTopicChatId] = useState<string | null>(null)
  useEffect(() => {
    const onChanged = (event: Event) => {
      setActiveTopicChatId((event as CustomEvent<{ chatId: string | null }>).detail?.chatId ?? null)
    }
    window.addEventListener(UI_EVENTS.topicSplitChanged, onChanged)
    return () => window.removeEventListener(UI_EVENTS.topicSplitChanged, onChanged)
  }, [])
  // @@@ui-ruler — ListRow(见 ui/ListRow.tsx)是纯函数组件,没有声明 `ref` prop,React 19 的
  // ref-as-prop 也够不到它(类型层会拒绝、运行时也不会转发到根 div)。键盘导航要拿真实 DOM 节点调
  // `.focus()`,原来靠一张 chatId→node 的 Map;既然要不到逐行 ref,改为在滚动容器内按
  // `data-chat-row` 现查——容器本就有这个 ref,行元素也已经带着这个 data 属性,不必新增状态。
  const listboxRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  // @@@2264 排序键 = canonical activity 投影(chatActivityAt:last_message_at ?? created_at)。
  // 无消息的新会话按创建时刻置顶后正常老化——替换掉 #1953 的 null→Infinity 哨兵(#2208 移除建号
  // 问候语后它把空会话永久钉顶,发送后的会话永远排不到它前面,即 #2264)。
  // 现在能走到这个排序键的「无消息会话」只剩群、以及被置顶/标未读/有草稿的单聊(见下面 isListed)。
  const byTime = compareChatsByActivityDesc
  const matchesSearch = (chat: ChatItem) => {
    const query = searchQuery.trim().toLocaleLowerCase()
    if (!query) return true
    // @@@5856 话题和群一样有自己的名字(搜索按名字走);私聊才回落到对端名。
    const name = isRoomChat(chat.kind) ? chat.name : (chat.peer_alias?.trim() || identitiesById[chat.peer_user_id ?? '']?.display_name || '')
    return `${name} ${chatPreviewText(chat)}`.toLocaleLowerCase().includes(query)
  }
  const hasSearchQuery = searchQuery.trim().length > 0
  // @@@empty-dm-not-listed — 没有过消息的单聊不占列表行(判据在 core,见 isChatListed)。搜索是一次明确的
  // 指名道姓,不受此约束:搜得到就打得开,不然会话页开出来的空私聊只剩通讯录一条路。
  const isListed = (chat: ChatItem) =>
    !isDuplicateAssistantChat(chat, assistantShell, workrooms)
      && (hasSearchQuery || isChatListed(chat, { activeChatId, hasDraft: Boolean(drafts[chat.id]?.trim()) }))
  // @@@5856 沉降:长期无活动的话题落到底部的「更早」。它**只是列表位置**,不是话题的一种状态 ——
  // 话题没有开关(product spec)。任何人发一句,last_message_at 前移,这一条自己就浮回来了。
  // 搜索时不分段:搜索是一次指名道姓,沉下去的照样要搜得到。
  // 沉降判据要一个「当下」。它随每次渲染重取即可 —— ❌ 不 memo 到 chats 上(那是假依赖:
  // chats 没变而时间过去了,沉降照样该发生)。逐渲染取一次 Date.now 的成本可忽略。
  const nowMs = Date.now()
  const isSunk = (chat: ChatItem) => !hasSearchQuery && isSunkTopic(chat, nowMs) && chat.id !== activeChatId
  // @@@5856 话题**不占一行平级的会话**(owner 2026-09-19:「怎么还有把一个 topic 当做群的形式表达」)。
  // 它挂在来源那条线底下,缩进 + 一条竖轨(见 tokens.css 的 .gg-topic-subrows)。
  // 搜索时例外:搜索是一次指名道姓,搜得到就得点得开 —— 那时它照常出现在结果里(按来源线归组)。
  const topicNesting = useMemo(() => {
    // 来源线此刻在不在列表里。不在(归档 / 已退出)⇒ 挂不上去,那条话题退回顶层,❌ 不许消失。
    const listedIds = new Set(chats.filter((chat) => isListed(chat)).map((chat) => chat.id))
    return groupTopicsBySource(
      chats,
      (chat) => isListed(chat) && matchesSearch(chat),
      byTime,
      (sourceChatId) => listedIds.has(sourceChatId),
    )
    // isListed / matchesSearch 都是每次渲染新建的闭包,进依赖数组等于不缓存;
    // 它们的输入(chats / 搜索词 / 草稿 / 当前会话)已经在下面列全了。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chats, searchQuery, activeChatId, drafts, assistantShell, workrooms])
  const isTopLevel = (c: ChatItem) => isTopLevelChatRow(c, topicNesting, isListed, matchesSearch)
  const pinnedChats = chats.filter((c) => c.is_pinned && isTopLevel(c)).sort(byTime)
  const normalChats = chats.filter((c) => !c.is_pinned && isTopLevel(c)).sort(byTime)
  // @@@5856 顶层不再有「沉降」这一段:isSunkTopic 只对话题为真,而话题现在永不占顶层 ⇒ 那一段恒空。
  // 沉降下沉到**子行**这一层(每条来源线自己一行「更多」),见 renderChatRow。
  // 键盘上下走的是「看得见的那些行」,所以子行也要在里面 —— ❌ 不能让话题只能用鼠标点。
  // 没摊开的那些❌ 不在里面:它们不在这条侧边栏上,键盘也不该能走到看不见的行。
  const visibleChats = useMemo(
    () => [...pinnedChats, ...normalChats].flatMap((chat) => {
      if (collapsedTopicSources.has(chat.id)) return [chat]
      const { live } = splitSunkTopics(topicNesting.bySource.get(chat.id) ?? [], isSunk)
      return [chat, ...live]
    }),
    // isSunk 每次渲染新建(它读 Date.now),输入已在下面列全。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pinnedChats, normalChats, topicNesting, activeTopicChatId, collapsedTopicSources],
  )
  const visibleChatIds = useMemo(() => visibleChats.map((chat) => chat.id), [visibleChats])

  useEffect(() => {
    if (focusedChatId && visibleChatIds.includes(focusedChatId)) return
    setFocusedChatId(activeChatId && visibleChatIds.includes(activeChatId) ? activeChatId : (visibleChatIds[0] ?? null))
  }, [activeChatId, focusedChatId, visibleChatIds])

  // @@@5856 一条线 + 挂在它底下的话题子行。置顶段与常规段共用这一份 ——
  // ❌ 不在两处各抄一遍「记得也画子行」,那种东西漏一处就只在某一段里话题消失。
  const renderChatRow = (chat: ChatItem) => {
    const { live, sunk } = splitSunkTopics(topicNesting.bySource.get(chat.id) ?? [], isSunk)
    const hasTopics = live.length > 0 || sunk.length > 0
    const topicsExpanded = !collapsedTopicSources.has(chat.id)
    const row = (
      <ChatRow
        key={chat.id}
        chat={chat}
        agentStatus={rowAgentStatus(chat, identitiesById, agentStatuses, shownAgent)}
        isActive={chat.id === activeChatId}
        topicsExpanded={hasTopics ? topicsExpanded : undefined}
        mobile={mobile}
        draft={drafts[chat.id]}
        onClick={() => activateChatRow(chat)}
        onPin={() => pinChat(chat.id, !chat.is_pinned)}
        onSetNotificationLevel={(level) => setChatNotificationLevel(chat.id, level)}
        onDelete={() => deleteChat(chat.id, true)}
        tabIndex={focusedChatId === chat.id ? 0 : -1}
        onFocus={() => setFocusedChatId(chat.id)}
        onKeyDown={(event) => handleChatKeyDown(event, chat)}
      />
    )
    if (!hasTopics) return row
    const subRow = (topic: ChatItem) => (
      <TopicSubRow
        key={topic.id}
        topic={topic}
        isActive={topic.id === activeTopicChatId}
        tabIndex={focusedChatId === topic.id ? 0 : -1}
        onClick={() => selectChat(topic)}
        onFocus={() => setFocusedChatId(topic.id)}
        onKeyDown={(event) => handleChatKeyDown(event, topic)}
        onPin={() => pinChat(topic.id, !topic.is_pinned)}
        onSetNotificationLevel={(level: NotificationLevel) => setChatNotificationLevel(topic.id, level)}
        onDelete={() => deleteChat(topic.id, true)}
      />
    )
    return (
      <div key={chat.id}>
        {row}
        {topicsExpanded && <div className="gg-topic-subrows">
          {live.map(subRow)}
          {/* @@@5856 「更多 · N」—— 沉下去的 + 摊不下的那些话题。只留一行告诉你它们还在,
              发一句就浮回上面(spec:「没有开关,只有沉降」)。
              ❌ 它不就地展开:一个老群能攒出两百条,展开等于把整条侧边栏灌满
              (owner 2026-09-20)。点它跳到这条线顶栏的「历史 → 话题」——那才是全部话题的主场,
              带搜索、能翻。 */}
          {sunk.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              data-testid="topic-sunk-section"
              data-source-chat-id={chat.id}
              onClick={() => { selectChat(chat, 'sidebar'); requestTopicsPanel(chat.id) }}
              style={SUNK_SECTION_STYLE}
            >
              {t('chatList.moreTopics', { count: sunk.length })}
            </Button>
          )}
        </div>}
      </div>
    )
  }

  const focusChatRow = (chatId: string | null) => {
    if (!chatId) return
    setFocusedChatId(chatId)
    requestAnimationFrame(() => {
      listboxRef.current?.querySelector<HTMLElement>(`[data-chat-row="${CSS.escape(chatId)}"]`)?.focus()
    })
  }

  const selectChat = useCallback((chat: ChatItem, focusTarget: 'composer' | 'sidebar' = 'composer') => {
    // @@@5856 点话题**不整屏切走**(spec:「开出来是分栏不切走」):主区切到它的来源那条线,
    // 话题自己开成右边的分栏。❌ 不许 setActiveChatId(话题) —— 那正是「把 topic 当群」的那条路,
    // 而且哪怕只有一帧也会被看见。
    if (chat.kind === 'topic' && chat.source_chat_id) {
      setActiveChatId(chat.source_chat_id)
      // focusComposer:焦点要落在**分栏自己**的输入框上。
      // ❌ 不许走 onChatSelected('composer') —— 那聚焦的是左边来源线的输入框,顺手打字回车
      // 就发进了大群,正是「消息隔离」要防的那个方向(找茬第十轮实测)。
      requestTopicSplit({
        chatId: chat.id,
        name: chat.name ?? '',
        sourceChatId: chat.source_chat_id,
        focusComposer: focusTarget === 'composer',
      })
      onChatSelected?.('sidebar')
      return
    }
    if (chat.unread_locator) {
      void openUnreadChat(chat.id).catch((error) => {
        chatListLog.error({ error: String(error) }, 'unread locator open failed')
      })
    } else {
      setActiveChatId(chat.id)
    }
    onChatSelected?.(focusTarget)
  }, [onChatSelected, openUnreadChat, setActiveChatId])

  // 切换会话仍只负责导航;只有重复激活当前来源行才收起/展开话题,不触碰右侧分栏。
  const activateChatRow = (chat: ChatItem) => {
    if (chat.id !== activeChatId || !topicNesting.bySource.get(chat.id)?.length) {
      selectChat(chat)
      return
    }
    setCollapsedTopicSources((previous) => {
      const next = new Set(previous)
      if (next.has(chat.id)) next.delete(chat.id)
      else next.add(chat.id)
      return next
    })
  }

  useEffect(() => {
    if (activeTab !== 'chats') return
    const handleGlobalShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (
        event.composedPath().some(
          (node) =>
            node instanceof HTMLElement &&
            node.closest('[role="dialog"], [role="menu"], [role="listbox"], [data-slot="popover-content"], [data-slot="popover-popup"], [data-slot="sheet-content"]'),
        )
      ) return

      const shortcut = chatListShortcutFor(event)
      if (!shortcut) return

      const path = event.composedPath()
      // @@@5856 话题分栏里那个输入框也算「在聊天输入框里」。它 surface="aside",刻意不挂主 composer
      // 那个 test-id(那是全局唯一锚点)⇒ 不认它的话,焦点一落进分栏,⌘↑/⌘↓ 就被下面那道
      // 「在别的文本控件里就放行给它」的闸吃掉,整条快捷键在分栏里是死的。
      const composerSelector = `[data-testid="${AUTOMATION_TEST_IDS.chatComposer}"], [data-testid="topic-split-pane"]`
      const insideChatComposer = path.some(
        (node) =>
          node instanceof HTMLElement &&
          (node.matches(composerSelector) || node.closest(composerSelector)),
      )
      const insideOtherTextControl = path.some(
        (node) =>
          node instanceof HTMLElement &&
          (node.matches('input, textarea, [contenteditable="true"], [role="textbox"]') ||
            node.closest('input, textarea, [contenteditable="true"], [role="textbox"]')),
      )
      if (insideOtherTextControl && !insideChatComposer && shortcut.kind !== 'search') return

      event.preventDefault()
      if (shortcut.kind === 'search') {
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
        return
      }

      const targetId =
        shortcut.kind === 'select'
          ? visibleChatIds[shortcut.index] ?? null
          // @@@5856 游标是「现在选中的那一行」,选中话题时那是**子行**,不是来源线。
          // 用 activeChatId 当游标会在有话题的线上原地打转:它停在来源线不动,
          // nextChatId 每次都返回同一条子行(找茬第十轮实测:连按 6 次读数一字不变)。
          : nextChatId(visibleChatIds, activeTopicChatId ?? activeChatId, shortcut.direction)
      const target = targetId ? chats.find((chat) => chat.id === targetId) : undefined
      if (!target) return
      const focusTarget = insideChatComposer ? 'composer' : 'sidebar'
      selectChat(target, focusTarget)
      if (focusTarget === 'sidebar') focusChatRow(targetId)
    }

    window.addEventListener('keydown', handleGlobalShortcut)
    return () => window.removeEventListener('keydown', handleGlobalShortcut)
  }, [activeChatId, activeTopicChatId, activeTab, chats, selectChat, visibleChatIds])

  const handleChatKeyDown = (event: Parameters<KeyboardEventHandler<HTMLDivElement>>[0], chat: ChatItem) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      focusChatRow(nextChatId(visibleChatIds, chat.id, event.key === 'ArrowDown' ? 1 : -1))
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      focusChatRow(
        event.key === 'Home'
          ? visibleChatIds[0] ?? null
          : visibleChatIds[visibleChatIds.length - 1] ?? null,
      )
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      activateChatRow(chat)
      return
    }
  }

  return (
    <Pane paneRole="nav" mobile={mobile} style={NAV_PANE_STYLE}>
      <HeaderSearch mobile={mobile} active={activeTab === 'chats' && !hidden} value={searchQuery} onChange={setSearchQuery} placeholder={t('chatList.search')} testId={AUTOMATION_TEST_IDS.chatListSearchInput}>{(searchButton) => (
      <PaneHeader
        title={tMain('shell.chats')}
        mobile={mobile}
        style={mobile ? NAV_HEADER_STYLE : NAV_HEADER_STYLE_DESKTOP}
        actions={
          <>
            {searchButton}
            {/*
              「新建 Agent」**只留在桌面**。owner 2026-09-06:手机端这个入口挪到「任务」页右上角 ——
              agent 是跑在某台机器上的东西,入口该和机器在同一屏。
              ⚠️ 桌面不跟着摘:桌面的「任务」tab 是会话页那张 IDE 面,它自带新建入口,
              而桌面对话页摘掉就等于把一个既有入口无声删掉 —— 那不是 owner 说的事。
              空态提示按形态分两句(见 chatList.emptyHint / emptyHintMobile),❌ 不许让提示
              指着一颗此形态下不渲染的按钮(#4221 的墓碑就立在那儿)。
            */}
            {!mobile && onOpenAgentCreateDraft ? (
              <Button
                variant="ghost"
                size="sm"
                data-testid={AUTOMATION_TEST_IDS.chatCreateAgentDraftAction}
                onClick={onOpenAgentCreateDraft}
                title={t('chatList.createAgent')}
              >
                <Zap size={13} />
                <span data-button-label="">{t('chatList.createAgent')}</span>
              </Button>
            ) : null}

            <DropdownMenu.Root
              open={showPlusMenu}
              modal={false}
              onOpenChange={setShowPlusMenu}
            >
              <DropdownMenu.Trigger
                data-testid={CHAT_LIST_PLUS_BUTTON_SELECTOR}
                className="gg-icon-btn gg-ghost window-no-drag-region"
                data-size="md"
                data-mobile={mobile || undefined}
                data-on={showPlusMenu || undefined}
                aria-label={t('chatList.create')}
                title={t('chatList.create')}
              >
                <Plus />
              </DropdownMenu.Trigger>
              {showPlusMenu ? (
                <DropdownMenu.Content
                  aria-label={t('chatList.create')}
                  side="bottom"
                  align="end"
                  sideOffset={4}
                  style={PLUS_MENU_CONTENT_STYLE}
                >
                  <PlusMenuItems
                    onSessionCreate={onOpenSessionCreate
                      ? () => {
                          setShowPlusMenu(false)
                          onOpenSessionCreate()
                        }
                      : undefined}
                    onGroupChat={() => setShowGroupModal(true)}
                    onAddFriend={() => setShowAddFriendModal(true)}
                    onScan={onScan}
                    mobile={mobile}
                  />
                </DropdownMenu.Content>
              ) : null}
            </DropdownMenu.Root>
          </>
        }
      />
      )}</HeaderSearch>

      {!mobile && (
        <SearchField
          ref={searchInputRef}
          className="mx-3 mb-2 mt-1.5 w-auto shrink-0"
          data-testid={AUTOMATION_TEST_IDS.chatListSearchInput}
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder={t('chatList.search')}
          clearLabel={t('chatList.clearSearch')}
          onClear={() => setSearchQuery('')}
        />
      )}

      <div ref={listboxRef} role="listbox" aria-label={t('chatList.listLabel')} style={LIST_SCROLL_STYLE}>
        {/* #6158 列表行不再按 tab 卸载:聊天面在别的 tab 上由 MainLayout 隐藏而非卸载,行留着滚动位置才在。 */}
        {loadingChats && (
          <div style={LOADING_STATE_STYLE}>
            {t('common.loading')}
          </div>
        )}

        {!loadingChats && !hasSearchQuery && pinnedChats.length === 0 && normalChats.length === 0 && (
          <div
            style={EMPTY_STATE_WRAP_STYLE}
          >
            <PaneEmptyState
              icon={<MessageCircle size={26} color="var(--text-tertiary)" />}
              caption={t('chatList.empty')}
              hint={t(mobile ? 'chatList.emptyHintMobile' : 'chatList.emptyHint')}
            />
          </div>
        )}
        {!loadingChats && hasSearchQuery && pinnedChats.length === 0 && normalChats.length === 0 && (
          <div style={NO_RESULTS_STYLE}>
            {t('chatList.noResults')}
          </div>
        )}

        {/* Pinned section */}
        {!loadingChats && pinnedChats.length > 0 && (
          <>
            {pinnedChats.map(renderChatRow)}
            {/* #1323 模块1 做减法(owner 授权):删除「折叠置顶聊天」分隔/折叠条——SSOT 列表无此元素,
                置顶会话恒常展示。连带移除 pinnedExpanded 状态。 */}
          </>
        )}

        {/* Normal chats */}
        {!loadingChats && normalChats.map(renderChatRow)}

      </div>

      <Sheet open={showAddFriendModal} onClose={() => setShowAddFriendModal(false)} desktopWidth="360px" desktopMaxHeight="480px" ariaLabel={t('chatList.addContact')}>
        {showAddFriendModal ? <AddFriendContent onClose={() => setShowAddFriendModal(false)} /> : null}
      </Sheet>

      <Sheet open={showGroupModal === true} onClose={() => setShowGroupModal(false)} onClosed={() => { if (typeof showGroupModal === 'string') { setActiveChatId(showGroupModal); onChatSelected?.(); setShowGroupModal(false) } }} desktopWidth="min(440px, 100%)" desktopMaxHeight="min(88vh, calc(100dvh - 32px))" testId="create-group-modal" ariaLabel={t('createGroup.title', { ns: 'contacts' })}>
        {showGroupModal === true ? <CreateGroupChatForm
          onClose={() => setShowGroupModal(false)}
          onCreated={setShowGroupModal}
        />
        : null}
      </Sheet>
    </Pane>
  )
}
