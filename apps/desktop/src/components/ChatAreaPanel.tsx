import { GroupRenameContext, useChatCommands } from './chat/use-chat-commands'
import { useState, useRef, useEffect, useCallback, useMemo, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { motion, AnimatePresence } from 'framer-motion'
import { DUR_FAST_MS, tween } from '@/styles/motion'
import type { FlowListHandle } from '@/lib/flowList'
import { ChevronLeft, MessageCircle, Zap } from '@/lib/icons'
import { downloadAttachment } from '@/lib/attachmentBytes'
import { createSessionpageChatSendPreflight } from '@/lib/sessionpage-session-recovery'
import type { SidebarTab } from '@gugu/core/shared/enums/sidebarTabModels'
import { resolveOrLoud } from '@gugu/core/shared/resolveOrLoud'
import { useIsAssistantAvatar } from '../lib/avatarIdentity'
import { useChatStore } from '../store/chatContext'
import { ChatLineScope } from '../store/chatLineScope'
import { useContactsStore } from '../store/contactsContext'
import { useAuth } from '../store/auth'
import { AgentSettingsModal } from './agentsettings/AgentSettingsModal'
import type { AgentConversationActivity, GroupCollabSnapshot, MessageItem } from '@gugu/core/shared/types/chat'
import { chatService } from '../lib/chat'
import { useUnreadLocatorNavigation } from '../hooks/useUnreadLocatorNavigation'
import { useSourceMessageReveal } from '../hooks/useSourceMessageReveal'
import { useChatHistoryPagination } from './chat/useChatHistoryPagination'
import { useGroupCollabRemovedAgentGate } from '../hooks/useGroupCollabRemovedAgentGate'
import { useGroupCollabLoader, EMPTY_GROUP_COLLAB } from '../hooks/useGroupCollabLoader'
import { useTopicScopedMemberProfile } from '../hooks/useTopicScopedMemberProfile'
import { ForwardMessageDialog } from './chat/ForwardMessageDialog'
import { AUTOMATION_TEST_IDS } from '../lib/automationDom'
import { UI_EVENTS } from '../lib/uiEvents'
import { drainTopicSplitRequest, requestTopicSplit } from '../lib/topicSplitRequest'
import { buildGroupRosterCandidates } from '../lib/mention'
import { topicMentionCandidates } from './chat/topicMentionModels'
import { resolveGroupRunningIndicator } from '../lib/agentRunningStatusModels'
import { groupRunningTokens } from '../lib/groupRunningTokenModels'
import type { AgentLocation } from '@gugu/core/shared/ui/agentHeaderStatusModels'
import { useReadReceiptPanel } from '@/hooks/useReadReceiptPanel'
import { agentComposerModel, isRetiredCloudAgentChat } from '../lib/agentComposerModel'
import { useAgentRunningStatus } from '../hooks/useAgentRunningStatus'
import { useAgentStream } from '../hooks/useAgentStream'
import { useStructurallyShared } from '../hooks/useStructurallyShared'
import { RunningBarSlot, RunningTokenBar } from './RunningTokenBar'
import { deriveAgentRunningState } from '../lib/agentRunningVerb'
import { AgentConversationNoticeSlot } from './AgentTurnFailureBar'
import { latestRecentAction } from './agentRecentActionModel'
import { useAgentDisplayStatuses, useAgentRecentActivity } from '../hooks/useAgentDisplayStatus'
import { groupAgentStatusIndicatorProps } from '../lib/groupAgentStatus'; import { AgentNeedsUserGlyph } from './AgentNeedsUserGlyph'
import { composerCardLine } from '../lib/composerCardCopy'
import { useMessageFilePreview } from './chat/useMessageFilePreview'
import { AgentComposerNotices } from './chat/AgentComposerNotices'
import { useAgentSessionpagePresentation } from './chat/AgentSessionpagePresentation'
import type { MemberProfileCardModel, MemberProfileChatTarget } from './MemberProfileCard'
import { AgentChatHero } from './chat/AgentChatHero'
import { useShownAgentStatus } from './chat/useAgentsOnCloudComputer'
import { AgentHeaderStatusLine } from './chat/AgentHeaderStatusLine'
import { MemberProfilePopover } from './MemberProfilePopover'
import { ReadReceiptPopover } from './ReadReceiptPopover'
import { useListenModeEditControls } from './chat/useListenModeEditControls'
import { useMessageColumnMinWidth } from './chat/useMessageColumnMinWidth'
import { RightPanel } from './chat/RightPanel'; import { isGroupManagerRole } from '../lib/groupMemberPermissions'
import {
  buildMemberProfileMap,
  type ActiveMemberProfile,
  type MemberProfileSide,
  toIdentityProfile,
} from './memberProfileModels'
import { ChatMessageComposer, type ComposerAttachAction } from './chat/ChatMessageComposer'
// @@@5856 消息列表抽成共享组件(话题分栏也用它)——见 MessageList.tsx 头部注释。
import { MessageList, type MessageListRowProps } from './chat/MessageList'
import { useTaskChatRows } from './assistant/useTaskChatRows'
import { MessageLoadFailure } from './chat/MessageLoadFailure'
import { AgentFirstConversationEmpty } from './chat/AgentFirstConversationEmpty'
import { MessageListSkeleton } from './chat/MessageListSkeleton'; import { ChatBottomDock } from './chat/ChatBottomDock'
import { ChatHeaderActions } from './chat/ChatHeaderActions'
import { useFollowingTail, useTailPinning } from './chat/useFollowingTail'
import { useConversationScrollMemory } from './chat/useConversationScrollMemory'
import {
  AGENT_HERO_OVERHANG_PX, isAgentHeroBird, type AgentHeaderStatus,
} from './chat/chatPresentation'
import { sessionComposerDockBandClassName } from '../session/renderer/features/sessions/session-composer-styles'
import { GroupTabContent } from './appSlot/GroupTabContent'; import { useChatOpener } from './appSlot/useChatOpener'; import { ChatPlusMenu, ChatTabPage, ChatTabPortals } from './appSlot/ChatTabHosts'; import { useTabsReading } from './appSlot/useTabsReading'
import { folderItem, isFolderItem } from '../session/renderer/features/chats/chat-tabs/chat-panel-item'; import { closeChatTab, closeInfoTab, focusedChatTab, infoTabOf, openInfoTab, openPanelItem, panelFull, panelTabsOf, setPanelFull, showChatOnly, type ChatPanelTab } from '../session/renderer/features/chats/chat-tabs/chat-layouts'
import { useTopicSurface } from '@/hooks/useTopicSurface'
import { chatDisplayName, isRoomChat } from '@gugu/core/shared/ui/chatModels'
import { topicService } from '@/lib/topics'
import { useAgentFloodNotice } from '@/hooks/useAgentFloodNotice'
import { TopicSplitPane } from './chat/TopicSplitPane'
import { useToast } from './toastContext'
import { rendererLogger } from '../lib/log'
import { safeFailureLine } from '@/session/renderer/features/sessions/gugu-reason'
import { PaneEmptyState } from './ui/PaneEmptyState'
import { PaneHeader } from './ui/Pane'
import { ChatBlockHead } from './chat/ChatBlockHead'
import { useMessageSelectMode } from './chat/useMessageSelectMode'
import { IconButton } from './ui/IconButton'
import { ChatTailNotice } from './chat/ChatTailNotice'
import { ChatSearchControls } from './chat/ChatSearch'
import { useChatSearch } from './chat/useChatSearch'
export { ChatNotificationLevelControl } from './chat/ChatNotificationLevelControl'
import { ChatSettingsPanel } from './chat/ChatSettingsPanel'
import { useChatSlotProjectName } from '../lib/shellSlots'
import { useChatHasMessages } from '../lib/chatSummariesBridge'
import { ChatPartSlot } from '../session/renderer/lib/chat-slot'
interface ChatAreaPanelProps {
  /** 这块面显示哪条会话:对话页给列表选中的那条,「助理」App 给和它的私聊(#7199);不给 = 跟着那条活的线(store/chatLineScope.tsx)。 */
  chatId?: string | null
  viewportKey?: string
  activeTab: SidebarTab
  /** The main navigation route owns unscoped unread requests; explicit panes receive their scroller. */
  navigationTarget?: boolean
  /** 常驻但不可见(新建 agent/任务的创建面盖在它上面):与切到别的 tab 同一套门控 —— 不算「看见」、不接全局快捷键。 */
  hidden?: boolean
  mobile?: boolean
  // @@@chat-open-nonce (#461) - changes each time the chat pane is (re)opened on mobile, even for the same
  // chat (where activeChatId doesn't change). Used to re-trigger the scroll-window reset (collapse + bottom).
  openNonce?: number
  onBack?: () => void
  /** #7199「助理」App 里那块:头栏只在搜索时出现(头像、搜索、设置在 App 自己那一排),输入框「和 X 聊天」+「+」;typing = 接在消息流末尾、取代运行条的「它在处理」。 */
  chrome?: { placeholder: string; attachGlyph: ReactNode; attachMenu?: readonly ComposerAttachAction[]; typing?: ReactNode; hideRunningStatus?: boolean }
  /** Block tab-strip slots for actions, title, topics and right-panel tabs; absent on standalone/phone headers. */
  blockHost?: { actions: HTMLElement | null; title: HTMLElement | null; tabs: HTMLElement | null }
  onOpenUserChat?: (target: MemberProfileChatTarget) => void; onOpenSessionpageAgent?: (agentUserId: string, view?: 'code' | 'general') => Promise<void>; onOpenSessionpageAgentFile?: (agentUserId: string, path: string) => Promise<void>
}

// ── ChatAreaPanel ──────────────────────────────────────────────────────────────
// @@@group-agent-status-bar (#518) - in group chats, a compact row of agent avatars between the last

// @@@1696 GroupAgentStatusLine / GroupAgentStatusBar 已删 —— 群聊运行态统一到共享 RunningTokenBar（见渲染点）：
// 竖排多行纯文字「{名} 正在执行 …」+ hover 抛工具名 → 改横排单行流光 token + 去术语计数卡，与单聊同一套。
// 运行中占位只剩 RunningTokenBar 一种形状(#6448 删掉了已无人引用的 AgentTypingIndicator;
// #2186 删掉了它上面的 StreamingAgentBubble 纯转发壳)。


const chatAreaLog = rendererLogger('chat/area-panel')

export function ChatAreaPanel({ chatId, ...surface }: ChatAreaPanelProps) {
  return chatId === undefined ? <ChatAreaSurface {...surface} /> : <ChatLineScope chatId={chatId}><ChatAreaSurface {...surface} /></ChatLineScope>
}

function ChatAreaSurface({ viewportKey = 'chats', activeTab, navigationTarget = false, hidden = false, mobile = false, openNonce, onBack, chrome, blockHost, onOpenUserChat, onOpenSessionpageAgent, onOpenSessionpageAgentFile }: Omit<ChatAreaPanelProps, 'chatId'>) {
  const { toast } = useToast()
  const { t } = useTranslation('messaging')
  const { getImRepository, subscribeAccountRevision, identitiesById, chats, activeChat, activeChatId, messages, loadingMessages, messagesError, refreshMessages, sendMessage, toggleReaction, memberReadSeqs, clearMessages, deleteMessage, sendAttachments, pinChat, deleteChat, leaveGroup, setChatNotificationLevel, loadOlderMessages, messageWindow, unreadEntry, jumpToUnreadEntry, loadNewerMessages, loadMessageAnchor, returnToLatestMessages, markMessageVisible, setFollowingTail, threadScope, setActiveChatId, setDraft } = useChatStore('getImRepository', 'subscribeAccountRevision', 'identitiesById', 'chats', 'activeChat', 'activeChatId', 'messages', 'loadingMessages', 'messagesError', 'refreshMessages', 'sendMessage', 'toggleReaction', 'memberReadSeqs', 'clearMessages', 'deleteMessage', 'sendAttachments', 'pinChat', 'deleteChat', 'leaveGroup', 'setChatNotificationLevel', 'loadOlderMessages', 'messageWindow', 'unreadEntry', 'jumpToUnreadEntry', 'loadNewerMessages', 'loadMessageAnchor', 'returnToLatestMessages', 'markMessageVisible', 'setFollowingTail', 'threadScope', 'setActiveChatId', 'setDraft')
  const { user } = useAuth()
  const surfaceVisible = activeTab === 'chats' && !hidden
  const { contacts } = useContactsStore()
  const surfaceElement = useRef<HTMLDivElement>(null)
  const [showAgentSettings, setShowAgentSettings] = useState(false)
  const [showHeaderMenu, setShowHeaderMenu] = useState(false)
  const search = useChatSearch(activeChatId, surfaceVisible, messages, surfaceElement, viewportKey)
  const { searchMode, setSearchMode, searchQuery, setSearchQuery, isFiltering, displayedMessages } = search
  const filePreviewCloseRef = useRef<() => void>(() => {})
  const [quoteText, setQuoteText] = useState<{ messageId?: string; senderName: string; content: string } | null>(null)
  // @@@message-forward (#899) / @@@multi-select (#988) - messages pending forward; single-forward
  // sets [msg], batch sets the selected list. Opens ForwardMessageDialog when non-empty.
  const [forwardMessages, setForwardMessages] = useState<MessageItem[]>([])
  // @@@avatar-click-mention (#518) - clicking an agent avatar in the group bar sets this; ChatMessageComposer
  // consumes it (insert "@name " + register the mention target) then clears via onMentionInserted.
  const [mentionToInsert, setMentionToInsert] = useState<{ id: string; name: string } | null>(null)
  // @@@whisper (#820) — 悄悄话目标：设置后 ChatMessageComposer 进入悄悄话模式，发送强制 isWhisper+toUserIds。
  const [whisperTarget, setWhisperTarget] = useState<{ userId: string; displayName: string } | null>(null)
  const [groupCollabSnapshot, setGroupCollabSnapshot] = useState<GroupCollabSnapshot>(EMPTY_GROUP_COLLAB)
  const [activeMessageProfile, setActiveMessageProfile] = useState<ActiveMemberProfile | null>(null)
  const peerIdentity = identitiesById[activeChat?.peer_user_id ?? '']
  const isAgentChat = activeChat?.kind === 'ai' || peerIdentity?.type === 'agent'
  const isGroupChat = activeChat?.kind === 'group'
  // @@@5856 场所型会话 = 群 + 话题:都有自己的名字、成员、文件与响应档位。头栏的搜索/工作区/成员
  // 三颗按钮问的是这个,不是「是不是群」。判据的唯一真源在 @gugu/core/shared/ui/chatModels。
  const isRoomChatSurface = activeChat ? isRoomChat(activeChat.kind) : false
  // 场所型(群/话题)读自己的 name/avatar;私聊读对端。名字与对话列表、⌘K 面板、「来自 X」同一个函数(chatDisplayName)。
  const activeChatName = activeChat ? chatDisplayName(activeChat, peerIdentity?.display_name) : ''
  const activeChatAvatar = isRoomChatSurface ? (activeChat?.avatar ?? null) : (peerIdentity?.avatar ?? null)
  const assistantPeer = useIsAssistantAvatar(activeChat?.peer_user_id ?? '')
  const agentChatContact = isAgentChat
    ? contacts.find((c) => c.id === activeChat?.peer_user_id) ?? null
    : null
  const retiredCloudAgentChat = isRetiredCloudAgentChat({
    isAgentChat,
    agentType: agentChatContact?.agent_type,
    chatDeviceId: peerIdentity?.device_id,
    contactDeviceId: agentChatContact?.device_id,
  })
  // #1312 — every right-side surface (settings, announcement, members, workspace, history, topic split,
  // file preview) occupies the SAME right slot as a flex sibling that narrows the message column; the
  // agent-settings modal rides along. If two open at once they stack and the layout collapses (the chat
  // list gets squeezed out). So opening any one MUST close the others — mutual exclusion, mirroring
  // the existing right-surface mutex (handleOpenWorkspacePanel).
  // @@@1485 review-followup / #1312：右侧同槽位 surface 全互斥的**单一** close helper。各 opener 原来手枚举
  // 其余 surface 的 setX(false)（O(n²) 漂移）——已漏掉 群公告(showAnnounce) 多路（#1497 Scale review CONFIRMED:
  // 设置/工作区/历史/agent设置/话题分栏/成员列表 任一开时 群公告 仍可叠加）。统一在此一处关全部，
  // opener 只 close+开自己。
  // 群信息(成员、公告、设置)、群文件夹、App、话题是这条线页签条上的页签(chat-tabs,owner 10-26),与抽屉不争同一格:这里只关抽屉。
  const closeRightSurfaces = useCallback(() => {
    setShowAgentSettings(false)
    filePreviewCloseRef.current()
  }, [])
  // @@@message-forward (#899) - open the forward picker; the dialog calls handleForwardTo to fan out.
  const handleForward = useCallback((msg: MessageItem) => setForwardMessages([msg]), [])

  const filePreview = useMessageFilePreview({ onForward: handleForward, mobile, visible: surfaceVisible, closeRightSurfaces, toast })
  const openFilePreview = filePreview.open
  filePreviewCloseRef.current = filePreview.close
  // @@@2234 中栏 min-width 自适应(有右栏展开时按内容区实宽让位,右栏永不被 overflow:hidden 裁切)—— 逻辑见 hook。
  const { messageColumnMinWidth, attachPanelsRow } = useMessageColumnMinWidth(filePreview.isOpen, mobile)
  const handleOpenSettingsDrawer = useCallback(() => { if (activeChatId) openInfoTab(activeChatId) }, [activeChatId])
  const projectName = useChatSlotProjectName()
  const emptyProject = useChatHasMessages(projectName !== null ? activeChatId ?? undefined : undefined) === false
  const handleOpenAgentSettings = useCallback(() => {
    closeRightSurfaces()
    setShowAgentSettings(true)
  }, [closeRightSurfaces])
  const openConversationOrAgentSettings = useCallback(() => {
    if (isAgentChat && agentChatContact) handleOpenAgentSettings()
    else handleOpenSettingsDrawer()
  }, [isAgentChat, agentChatContact, handleOpenAgentSettings, handleOpenSettingsDrawer])
  // @@@1577 M1 — 运行中状态单一 SSOT。运行态(activity 事件 + presence)在此一处调和,头部/DM 浮动条/composer
  // 全读 `running`,杜绝过去「浮动条单源 activity、头部调和、群单源 presence」的双显/不一致/回复即消失。
  const running = useAgentRunningStatus({
    agentUserId: isAgentChat ? activeChat?.peer_user_id ?? null : null,
    chatId: activeChatId,
    // @@@1577 M3 phase2 — 运行态/清活动是唯一真耦合面(读 rootId 且必须配对清的 list),收 ThreadScope 单一对象
    // (store 派生)。@@@5856 thread 视图退役后 rootId 恒为 null,这条键退化为「按会话」。
    scope: threadScope,
    peerDisplayName: activeChatName,
    peerAvatar: activeChatAvatar,
  })
  // @@@recent-actions (#518/#437) - presence 的最近工具动作,经 header 状态 chip 的 pop-out(hover/长按)展示。
  const sessionpageAgent = useAgentSessionpagePresentation(isAgentChat ? activeChat : null, peerIdentity ?? null, running, mobile, onOpenSessionpageAgent, onOpenSessionpageAgentFile)
  const agentRecentActions = isAgentChat ? sessionpageAgent.recentActions?.actions ?? running.recentActions : []
  const agentLastActiveAt = isAgentChat ? sessionpageAgent.recentActions?.lastActionAt ?? running.lastActionAt : null
  // #1319 — anchor for the header ⋯ menu. The menu is portalled to document.body and positioned with
  // position:fixed off this button's rect, so an ancestor's overflow:hidden (the header) can't clip it.
  const moreButtonRef = useRef<HTMLButtonElement>(null)
  // @@@chat-view-window (#461) - 消息列表(lib/flowList.ts)自己管滚动位置;这是它的命令式句柄(定位 / 贴底)。
  const listRef = useRef<FlowListHandle | null>(null)
  // #1708 来源消息跳转高亮：被点的消息 id（闪一下后清空）。
  const [flashMessageId, setFlashMessageId] = useState<string | null>(null)
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isAtBottomRef = useRef(true)

  // @@@local-sync (#948) — 群名册内存镜像 cache(首帧 roster + #1877 删 Agent 收敛),与 loader / removed-agent-gate 共享 → 在此声明后传入两个 hook。
  const groupRosterMemoryCacheRef = useRef<Map<string, GroupCollabSnapshot>>(new Map())

  // @@@1877 删本机 Agent 后群名册即时收敛闸门(即时剔除 + 内存/持久/SWR-merge 三层 reseed 封堵，见 useGroupCollabRemovedAgentGate):
  const { prune: pruneRemovedAgentsFromCollab, mergeAndPrune: mergeGroupCollabPruned } = useGroupCollabRemovedAgentGate(user?.id, setGroupCollabSnapshot, groupRosterMemoryCacheRef)

  // @@@2169 群协作加载子系统(SWR 首帧 + 权威加载)抽到 useGroupCollabLoader,给冻结 god 文件抵消行数。
  const { loadGroupCollab, resetGroupCollabForChat, error: groupCollabError } = useGroupCollabLoader({
    activeChatId,
    isRoomChat: isRoomChatSurface, chatKind: activeChat?.kind,
    userId: user?.id, getImRepository,
    setGroupCollabSnapshot,
    groupRosterMemoryCacheRef,
    pruneRemovedAgentsFromCollab,
    mergeGroupCollabPruned,
  })

  // Reset transient state when active chat changes
  useEffect(() => {
    // @@@1503 — 右侧 surface 关闭归一到 closeRightSurfaces()(workspace/history/groupThread/agentSettings/drawer/
    // announce 一把全关)。原先这里只零散关 drawer/announce/workspace、**漏了 showAgentSettings**(+ history/
    // groupThread 在下方第二个 effect 里)→ 在 A 会话开着 Agent 设置面板时切到 B,面板残留泄漏。归一后切会话与
    // opener 走同一 SSOT helper;下方冗余的第二个 reset effect 一并删除。
    closeRightSurfaces()
    setShowHeaderMenu(false)
    setQuoteText(null)
    isAtBottomRef.current = true
    // @@@2169/@@@group-collab-swr - invalidate 在途加载 + 取消后台重试 + 按 in-memory cache 重铺首帧,细节见 useGroupCollabLoader。
    resetGroupCollabForChat()
    setActiveMessageProfile(null)
    setWhisperTarget(null)
    // @@@chat-open-nonce (#461) - also reset on mobile reopen of the SAME chat (openNonce bump), where
    // activeChatId is unchanged — so isAtBottomRef doesn't stay stale-false from a prior scroll-up.
  }, [activeChatId, isRoomChatSurface, openNonce, closeRightSurfaces, resetGroupCollabForChat])

  // @@@chat-open-nonce (#461) - reload on openNonce too, symmetric with the reset effect (which clears
  useEffect(() => {
    loadGroupCollab()
  }, [loadGroupCollab, openNonce])

  const groupRename = useChatCommands({
    chatId: activeChatId, visible: surfaceVisible, surface: surfaceElement,
    canRename: isGroupChat && isGroupManagerRole(groupCollabSnapshot.humans.find((h) => h.id === user?.id)?.role),
    openSettings: handleOpenSettingsDrawer,
  })

  useEffect(() => {
    if (!activeChatId || !isRoomChatSurface || !user?.id) return
    const refreshTimers = new Set<number>()
    // @@@ collab-refetch-coalesce (#597) — see git history for full context.
    let pendingReload: number | null = null
    const handleCollabChange = () => {
      if (pendingReload !== null) return
      pendingReload = window.setTimeout(() => {
        refreshTimers.delete(pendingReload as number)
        pendingReload = null
        loadGroupCollab()
      }, 300)
      refreshTimers.add(pendingReload)
    }
    const handleRevision = (operations: readonly { payload: unknown }[]) => {
      if (operations.some((operation) => (operation.payload as { chat_id?: unknown })?.chat_id === activeChatId)) handleCollabChange()
    }
    const unsubscribeGroup = subscribeAccountRevision('group_collab_changed', handleRevision)
    const unsubscribeMembers = subscribeAccountRevision('chat_members_changed', handleRevision)
    const handleLocalCollabChange = (event: Event) => {
      const detail = (event as CustomEvent<{ chatId?: string }>).detail
      if (detail?.chatId === activeChatId) handleCollabChange()
    }
    window.addEventListener(UI_EVENTS.groupCollabChanged, handleLocalCollabChange)
    return () => {
      refreshTimers.forEach((timer) => window.clearTimeout(timer))
      window.removeEventListener(UI_EVENTS.groupCollabChanged, handleLocalCollabChange)
      unsubscribeGroup()
      unsubscribeMembers()
    }
  }, [activeChatId, isRoomChatSurface, loadGroupCollab, subscribeAccountRevision, user?.id])

  const openMessageMemberProfile = useCallback((
    member: MemberProfileCardModel,
    anchor: HTMLElement,
    preferredSide: MemberProfileSide,
    openedFrom: 'main' | 'aside' = 'main',
  ) => {
    setActiveMessageProfile({
      member,
      anchor,
      preferredSide,
      openedFrom,
    })
  }, [])

  // A chat's tabs (a group's, a topic's, a private chat's — 主人 10-05) hold Apps' pages and files, the folder among them
  // (真源 §2.4), beside the messages on the task's tab engine (chat-tabs/chat-layouts): asked of the chat every way in.
  const opener = useChatOpener(activeChatId)
  const inBlock = Boolean(blockHost)
  const tabs = useTabsReading(() => {
    if (!activeChatId) return { folder: null as ChatPanelTab | null, page: null as ChatPanelTab | null, chatUp: true, infoShown: false }
    const panels = panelTabsOf(activeChatId)
    const focused = focusedChatTab(activeChatId)
    // In a block the folder is pressed while it is on screen; without a strip (the phone) while it is the page in front.
    const folder = panels.find((tab) => isFolderItem(tab.item) && (inBlock ? tab.shown : tab.tabId === focused?.tabId)) ?? null
    const full = panels.find((tab) => panelFull(activeChatId, tab.tabId)) ?? null
    const info = infoTabOf(activeChatId)
    return { folder, page: full, chatUp: inBlock ? !full : focused?.kind !== 'panel', infoShown: inBlock ? Boolean(info?.shown) : focused?.kind === 'info' }
  }, [activeChatId, inBlock])
  const handleOpenFolder = useCallback(() => { if (activeChatId) { closeRightSurfaces(); openPanelItem(activeChatId, folderItem()) } }, [activeChatId, closeRightSurfaces])
  const handleCloseWorkspacePanel = useCallback(() => { if (activeChatId && tabs.folder) closeChatTab(activeChatId, tabs.folder.tabId) }, [activeChatId, tabs.folder])
  // A block draws its shown tabs in the engine's slots; without a strip, one focused page covers the chat (topics too).
  const coverChat = (page: ReactNode) => mobile ? <RightPanel>{page}</RightPanel> : <div className="absolute inset-0 z-20 flex flex-col bg-[var(--bg-primary)]">{page}</div>
  const inTabs = (topicPane: ReactNode, infoPage: () => ReactNode) => !activeChatId ? null : blockHost ? <ChatTabPortals chatId={activeChatId} panel={panelContent} topic={() => topicPane} info={infoPage} /> : <ChatTabPage chatId={activeChatId} panel={(tab) => coverChat(panelContent(tab))} topic={() => topicPane} info={() => coverChat(infoPage())} />
  const panelContent = (tab: ChatPanelTab) => activeChatId ? <GroupTabContent chatId={activeChatId} tabId={tab.tabId} item={tab.item} tabbed={Boolean(blockHost)} inWindow={tab.inWindow} mobile={mobile} visible={surfaceVisible} onForward={handleForward} onOpenWith={opener.openWith} /> : null

  const topicSurface = useTopicSurface({
    chat: activeChat, messages,
    userId: user?.id ?? null,
    closeRightSurfaces,
    subscribeAccountRevision,
    onCreateFailed: (error) => toast(t('topic.openFailed'), 'error', safeFailureLine(String((error as Error)?.message ?? error))),
    embedded: Boolean(blockHost),
  })
  const topicSplitOpen = Boolean(topicSurface.splitTopic)
  // @@@5856 分栏标题块要说清「引自哪一句」。三态必须分开(pending 还没读到 / null 读到了「没这条」/
  // 有字 = 预览),合并任意两种都会让它说假话:首帧闪「已删除」、读取失败也渲染成「已删除」。
  // @@@3922 另把它 subject-scope(渲染期比对),否则从话题 A 切到 B 时 B 会顶着 A 的预览一个往返。
  const splitTopicChatIdForPreview = topicSurface.splitTopic?.chatId ?? null
  const [sourcePreviewState, setSourcePreviewState] = useState<{
    forTopicChatId: string | null
    preview: string | null | 'pending' | 'unreadable'
  }>({ forTopicChatId: null, preview: 'pending' })
  useEffect(() => {
    const topicChatId = splitTopicChatIdForPreview
    if (!topicChatId) { setSourcePreviewState({ forTopicChatId: null, preview: 'pending' }); return }
    setSourcePreviewState({ forTopicChatId: topicChatId, preview: 'pending' })
    let cancelled = false
    // @@@5856 三态如实转述:'readable' → 预览;'gone' → null(说「已删除」);
    // 'unreadable' → 那一行什么都不说。❌ 不许把后者并进「已删除」——消息没被删,别人都看得见。
    void topicService.getSourceState(topicChatId)
      .then((state) => {
        if (cancelled) return
        const preview = state.kind === 'readable' ? state.preview : state.kind === 'gone' ? null : 'unreadable'
        setSourcePreviewState({ forTopicChatId: topicChatId, preview })
      })
      .catch((error: unknown) => {
        // 读失败 ≠ 消息被删。留在 pending:那一行什么都不说,❌ 不谎报「已删除」。
        chatAreaLog.error({ error, topicChatId }, 'topic source message preview failed')
        if (!cancelled) setSourcePreviewState({ forTopicChatId: topicChatId, preview: 'pending' })
      })
    return () => { cancelled = true }
  }, [splitTopicChatIdForPreview])
  const topicSourceMessagePreview: string | null | 'pending' | 'unreadable' =
    sourcePreviewState.forTopicChatId === splitTopicChatIdForPreview
      ? sourcePreviewState.preview
      : 'pending'

  // @@@5856 **话题不整屏打开** —— owner 2026-09-19:「怎么还有把一个 topic 当做群的形式表达」。
  // 会话列表点话题走的是「切到来源线 + 往盒子里放一条请求」,聊天区在这里把它取出来开成分栏。
  // 挂载时取一次(列表点的时候聊天区可能根本还没挂 —— 一个会话都没选时主区是空状态),
  // 收到事件再取一次(已经挂着的那种情况)。
  // 依赖只取 openSplit 这一个 —— useTopicSurface 返回的是新对象字面量,整个拿来当依赖会每帧重挂监听。
  const openSplit = topicSurface.openSplit
  // 待办里属于**当前这条线**的那条请求,取出来开成分栏。三个时机各取一次:
  // 挂载时(列表点下去那会儿主区可能还是空状态,聊天区根本没挂)、收到事件时(已经挂着)、
  // 以及 activeChatId 变成来源线之后(点的那一刻显示的还是上一条线,当场取会把分栏记错线)。隐藏着不取:手机从列表点回同一个群会 bump openNonce,
  // 重置 effect 在那次提交里 closeRightSurfaces,事件里当场开的分栏会被它关掉 ⇒ 等露出来那次提交、排在重置之后再取。
  // 每次「带着聚焦要求开出来」都换一个号,分栏据此把焦点交给自己的输入框;用号而不是布尔:同一条话题连点两次也要再聚焦一次。
  const [splitFocusToken, setSplitFocusToken] = useState(0)
  const drainSplitRequest = useCallback(() => {
    const request = drainTopicSplitRequest(surfaceVisible ? activeChatId : null)
    if (!request) return
    openSplit({ chatId: request.chatId, name: request.name }, request.toggle)
    if (request.focusComposer) setSplitFocusToken((token) => token + 1)
  }, [activeChatId, openSplit, surfaceVisible])
  useEffect(() => {
    drainSplitRequest()
    window.addEventListener(UI_EVENTS.openTopicSplit, drainSplitRequest)
    return () => window.removeEventListener(UI_EVENTS.openTopicSplit, drainSplitRequest)
  }, [drainSplitRequest])
  // 兜底收口:万一还是有谁把主区设成了一条话题(系统通知、未读定位、老深链),当场换回同一种形态。
  // ❌ 不靠「把每个入口都记得改对」—— 漏一处就又冒出一个全宽的话题。
  // 走的是与列表同一条路(投进盒子 + 切线),❌ 不在这儿直接 openSplit:那会把分栏记在话题自己名下。
  useEffect(() => {
    if (activeChat?.kind !== 'topic' || !activeChat.source_chat_id) return
    requestTopicSplit({ chatId: activeChat.id, name: activeChat.name ?? '', sourceChatId: activeChat.source_chat_id })
    setActiveChatId(activeChat.source_chat_id)
  }, [activeChat?.kind, activeChat?.id, activeChat?.name, activeChat?.source_chat_id, setActiveChatId])
  // 分栏现在显示哪条(关掉是 null)。会话列表据此给子行高亮 ——
  // 分栏也能从消息上的锚点打开,所以这个真值只能从这儿广播出去。
  const splitTopicChatId = topicSurface.splitTopic?.chatId ?? null
  useEffect(() => {
    window.dispatchEvent(new CustomEvent(UI_EVENTS.topicSplitChanged, { detail: { chatId: splitTopicChatId } }))
  }, [splitTopicChatId])

  // 锚点卡只交出 chatId;名字从同一份话题清单里取 —— ❌ 两处不各存一份(改名后会打架)。
  const openTopicFromAnchor = useCallback((topicChatId: string) => {
    const topic = topicSurface.topics.find((item) => item.chat_id === topicChatId)
    if (!topic) return
    topicSurface.openSplit({ chatId: topic.chat_id, name: topic.name })
  }, [topicSurface])
  const agentFlood = useAgentFloodNotice(activeChatId, messages)

  // @@@1503 — 原「切换聊天关历史/群 thread 面板」那个 reset effect 已并入上方主 reset 的
  // closeRightSurfaces()(history/分栏/成员列表都在 helper 内),reset 路径归一到单一 SSOT。

  const handleMessageVisible = useCallback((message: MessageItem) => {
    if (surfaceVisible && message.chat_id === activeChatId) markMessageVisible(message)
  }, [activeChatId, surfaceVisible, markMessageVisible])

  // @@@5856 话题分栏的已读由分栏自己那条线承担(它是一条真的 chat,走 store 常规已读路径),
  // 原「群 thread panel 无 IntersectionObserver ⇒ 手工补标已读」那段随面板一并退役。

  const handleQuote = useCallback((msg: MessageItem) => {
    setQuoteText({
      messageId: msg.id,
      senderName: msg.sender_user_id ? (identitiesById[msg.sender_user_id]?.display_name ?? '') : '',
      content: msg.content_type === 'attachment' ? t('chatArea.attachment') : msg.content_type === 'card' ? composerCardLine(msg.content ?? '') : (msg.content ?? ''),
    })
  }, [identitiesById, t])

  // @@@multi-select (#988) - 多选模式、选中集和批量动作。
  const { selectMode, selectedIds, exitSelectMode, enterSelectMode, toggleSelect, handleBatchForward, handleBatchDelete } = useMessageSelectMode({ activeChatId, mobile, messages, deleteMessage, setForwardMessages })

  // @@@message-forward (#899) / @@@multi-select (#988) - fan out every pending message into every
  // selected target chat. On success (and if we were in batch select), leave select mode.
  const handleForwardTo = useCallback(async (targetChatIds: string[]) => {
    if (!user || forwardMessages.length === 0) return
    for (const msg of forwardMessages) {
      for (const targetChatId of targetChatIds) {
        await chatService.forwardMessage(msg.id, targetChatId, user.id)
      }
    }
    if (selectMode) exitSelectMode()
  }, [forwardMessages, user, selectMode, exitSelectMode])

  // Listen for RPC-triggered quote
  useEffect(() => {
    const handler = (e: Event) => {
      const { messageId, senderName = '', content } = (e as CustomEvent).detail as {
        messageId?: string
        senderName?: string
        content: string
      }
      setQuoteText({ messageId, senderName, content })
    }
    window.addEventListener(UI_EVENTS.quoteMessage, handler)
    return () => window.removeEventListener(UI_EVENTS.quoteMessage, handler)
  }, [])

  const handleDelete = useCallback((messageId: string) => {
    deleteMessage(messageId).catch((err) => {
      console.error('[ChatAreaPanel] deleteMessage failed', err)
    })
  }, [deleteMessage])

  const { rows: chatListRows, listedMessages, notice: taskChatNotice, threeParty } = useTaskChatRows(displayedMessages, user?.id, activeChat?.peer_user_id, surfaceVisible, isFiltering ? searchQuery : '')
  const chatResetKey = `${activeChatId ?? ''}#${openNonce ?? 0}#${messageWindow?.viewVersion ?? 0}`
  const { scrollerEl, scrollerRef, setScrollerRef, prepareForSavedPosition, isPreservingPosition, forgetSavedPosition, openLocation, revealMessage } = useConversationScrollMemory({
    chatId: activeChatId, viewportKey, activationKey: activeChatId ?? '', enabled: !isFiltering, discardSaved: !!unreadEntry,
    messageIds: chatListRows.map((row) => row.message.id), isAtBottomRef, setFollowingTail, loadMessageAnchor,
  })
  const onHistoryError = useCallback((error: unknown) => toast(error instanceof Error ? error.message : String(error), 'error'), [toast])
  const unreadNavigationPending = useUnreadLocatorNavigation({ activeChatId, navigationTarget, revealMessage, enabled: surfaceVisible && !isFiltering, onNavigate: () => search.setSearchMode(false), scrollerRef, setFlashMessageId, flashTimerRef })
  const { viewportAtBottom, onAtBottomChange } = useFollowingTail({ resetKey: chatResetKey, unreadNavigationPending: !!unreadNavigationPending, hasNewer: !!messageWindow?.hasNewer, loading: !!messageWindow?.loading, isPreservingPosition, isAtBottomRef, setFollowingTail })
  useChatHistoryPagination({ resetKey: chatResetKey, messages, enabled: !isFiltering && !unreadNavigationPending, scroller: scrollerEl, atBottom: viewportAtBottom, loadOlder: loadOlderMessages, loadNewer: loadNewerMessages, window: messageWindow, onError: onHistoryError })

  // #1708 来源消息(群右栏工作区 App 的 gugu.showMessage):不在加载段里的先按锚点载进来,再定位 + 闪烁;载不到 → fail-loud toast。
  const showMessage = useSourceMessageReveal({ activeChatId, viewportKey, navigationTarget, enabled: surfaceVisible, ready: !isFiltering && tabs.chatUp, onNavigate: () => { setSearchMode(false); if (activeChatId && tabs.page) setPanelFull(activeChatId, tabs.page.tabId, false); else if (activeChatId && mobile) showChatOnly(activeChatId) }, rows: chatListRows, listRef, isAtBottomRef, setFollowingTail, setFlashMessageId, flashTimerRef, revealMessage, onMissing: () => toast(t('chatArea.source.notVisible'), 'error') })

  const { pinToBottom, onTotalListHeightChanged } = useTailPinning({ resetKey: chatResetKey, messages: listedMessages,
    enabled: !isFiltering && !unreadNavigationPending, messageWindow, scrollerEl, scrollerRef, listRef, isAtBottomRef,
    isPreservingPosition, prepareForSavedPosition, forgetSavedPosition, returnToLatest: returnToLatestMessages, onError: onHistoryError })

  const handleReaction = useCallback((messageId: string, emoji: string) => {
    void toggleReaction(messageId, emoji).catch((error) => toast(t('message.actions.react'), 'error', safeFailureLine(String((error as Error)?.message ?? error))))
  }, [toggleReaction, toast, t])

  // Stable rowProps — only changes when underlying data does, so visible rows are
  // not remounted on unrelated ChatAreaPanel re-renders.
  const { status: agentHeaderStatus, presentation: agentHeaderPresentation } = sessionpageAgent
  const directRunningToken = sessionpageAgent.runningToken
  // @@@agent-header-status (#994b) — 单聊头文案「{状态} · {本机/云端} · {引擎}」。引擎/位置同走 running(presence payload):
  //  · 引擎 = payload.agentType · 位置 = payload.deviceId(本机)。payload 在但缺 agent_type=数据异常 → fail loud(不静默省引擎段)。
  const agentHeaderEngine = isAgentChat ? running.agentType : null
  const agentHeaderEngineMissing = Boolean(isAgentChat && running.engineMissing)
  const agentHeaderLocation: AgentLocation | null = isAgentChat ? running.location : null
  useEffect(() => {
    if (agentHeaderEngineMissing) {
      console.error('[ChatAreaPanel] 单聊 agent 无 agent_type(取不到引擎)', activeChat?.peer_user_id)
    }
  }, [agentHeaderEngineMissing, activeChat?.peer_user_id])
  // @@@acp-no-offline-gate (#1099) - ACP 下设备在线即可触达、发消息自动启动会话;**offline 不再禁用输入**
  // (那是 terminal 时代「先唤醒再发」模型,发消息即触达自启)。会话正在起也不禁用:对用户它就是 working,
  // 消息照常收下、由宿主在会话就绪后投递(spec agent-status);removed(agent 已删)真不能发。
  // 话题分栏有自己的 composer;主 composer 始终发送这条线自己的消息。
  const agentComposer = agentComposerModel({
    status: agentHeaderStatus, retiredCloud: retiredCloudAgentChat,
  })
  const agentComposerDisabled = agentComposer.disabled
  const agentComposerDisabledReason = agentComposer.disabledReason
    ? t(`composer.agent.disabledReason.${agentComposer.disabledReason}`)
    : undefined
  const agentComposerPlaceholder = agentComposer.placeholder
    ? t(`composer.agent.placeholder.${agentComposer.placeholder}`)
    : undefined
  const groupAgentIds = useMemo(() => groupCollabSnapshot.agents.map((agent) => agent.id), [groupCollabSnapshot.agents])
  // 主输入框能点名谁 = 这条线自己的名册。❌ 不许把来源线成员并进来 ——
  // 分栏开着时 activeChat **就是**来源线,并进去等于把 member_user_ids 原样灌进主线候选,
  // 而 buildGroupRosterCandidates 会滤掉 account_status==='removed' 的 agent、member_user_ids 不会 ⇒
  // 一开分栏,主线的 @ 候选里就多出已经被移除的 agent(找茬第十轮)。
  const composerGroupMembers = useMemo(
    () => buildGroupRosterCandidates(groupCollabSnapshot, identitiesById),
    [groupCollabSnapshot, identitiesById],
  )
  // 分栏那一份要宽一档:话题里能点名的人 = 话题现有成员 ∪ **来源线**的成员(spec:被 @ 就是被拉进来)。
  // 私聊线投影里没有 member_user_ids,退到对端。话题自己的成员也并进来(3a,见 topicMentionCandidates)。
  const splitTopicMemberIds = useMemo(
    () => (splitTopicChatId ? chats.find((chat) => chat.id === splitTopicChatId)?.member_user_ids : undefined),
    [chats, splitTopicChatId],
  )
  const splitMentionMembers = useMemo(() => {
    if (!topicSplitOpen || !activeChat) return composerGroupMembers
    return topicMentionCandidates(composerGroupMembers,
      activeChat.member_user_ids ?? (activeChat.peer_user_id ? [activeChat.peer_user_id] : []), splitTopicMemberIds, identitiesById)
  }, [composerGroupMembers, identitiesById, activeChat, topicSplitOpen, splitTopicMemberIds])
  // @@@group-presence-batched - One refcounted store subscription per agent in the panel; the dot in chat header,
  // group collab panel and member profile cards reads the same fused status at the same moment.
  const groupAgentStatuses = useAgentDisplayStatuses(groupAgentIds)
  const shownAgent = useShownAgentStatus() // #7199 画头像 / 状态字用的那一份;在跑、提醒照旧读原读数
  const groupAgentRecentActivity = useAgentRecentActivity(groupAgentIds)
  // 群的运行 token:群聊页的运行条和手机话题页挂的那条是同一份。
  const groupRunTokens = groupRunningTokens({ agents: groupCollabSnapshot.agents, statuses: groupAgentStatuses, identities: identitiesById, currentUserId: user?.id, recentActivity: groupAgentRecentActivity })
  // 群 thread panel 的运行中占位指示器(panel 内没有主线浮动条)。它和浮动条读**同一个** agent 态:
  // DM 里就是本会话那个 agent,群里挑「任一成员在跑」里的第一个来画身份(纯函数在 agentRunningStatusModels)。
  const activeAgentActivity = useMemo<AgentConversationActivity | null>(
    () => searchMode ? null : isRoomChatSurface
      ? resolveGroupRunningIndicator({ chatId: activeChatId, threadRootId: threadScope.rootId, agentIds: groupAgentIds, statuses: groupAgentStatuses, identities: identitiesById })
      : running.runningActivity,
    [searchMode, isRoomChatSurface, activeChatId, running.runningActivity, groupAgentIds, groupAgentStatuses, identitiesById, threadScope.rootId],
  )
  // 每条新消息/每次会话行补丁都会重拼这张表;内容没变就沿用旧引用,否则每条可见气泡的 memo 都被打穿。
  const messageMemberProfiles = useStructurallyShared(useMemo((): Record<string, MemberProfileCardModel> => {
    if (isRoomChatSurface) return buildMemberProfileMap(groupCollabSnapshot, identitiesById, shownAgent.statuses(groupAgentStatuses), messages.map((message) => message.sender_user_id)) // 退群成员的消息也要有名字 (#5610)
    if (!activeChat || !user) return {}
    const profiles: Record<string, MemberProfileCardModel> = {}
    const ownIdentity = identitiesById[user.id]
    if (ownIdentity) profiles[user.id] = toIdentityProfile(ownIdentity)
    const peerProfile = activeChat.peer_user_id && peerIdentity ? toIdentityProfile(peerIdentity, 'member', 'direct', undefined, shownAgent.status(activeChat.peer_user_id, agentHeaderStatus)) : null
    if (peerProfile) profiles[peerProfile.id] = peerProfile
    return profiles
  }, [activeChat, agentHeaderStatus, groupAgentStatuses, groupCollabSnapshot, identitiesById, isRoomChatSurface, messages, peerIdentity, shownAgent, user]))

  const liveStream = useAgentStream(activeChatId, threadScope.rootId) // @@@1196-q5 thread-scoped
  // @@@1577 phase3 — canonical (chat,thread) 键单一派生(消手拼 chatId:rootId)。
  // @@@acp-stream (#966)/@@@1577 — 流式首 chunk 引导 started activity（#2115 god-file 抽取,行为不变,详见 hook 头注）。
  const renderedActiveMessageProfile = useMemo((): ActiveMemberProfile | null => {
    if (!activeMessageProfile) return null
    const latest = messageMemberProfiles[activeMessageProfile.member.id]
    return latest ? { ...activeMessageProfile, member: latest } : activeMessageProfile
  }, [activeMessageProfile, messageMemberProfiles])

  const { readReceiptPanel, onShowReadReceipt: handleShowReadReceipt, onCloseReadReceipt } = useReadReceiptPanel({
    chatId: activeChatId, messages: displayedMessages, memberReadSeqs, memberProfiles: messageMemberProfiles,
  })

  // @@@1241 — wire listen-mode editing into the message-area avatar popover (agent owner → own agent).
  const messageListenEditControlsFor = useListenModeEditControls({ chatId: activeChat?.id ?? null, currentUserId: user?.id ?? null, onReload: loadGroupCollab })
  // 从话题分栏点开的名片:档位读写话题自己那行,❌ 不是来源群的(见 hook 头注)。
  const shownMessageProfile = useTopicScopedMemberProfile({ profile: renderedActiveMessageProfile, topicChatId: topicSurface.splitTopic?.chatId ?? null, currentUserId: user?.id ?? null, groupEditControlsFor: messageListenEditControlsFor })
  const drawerMemberProfiles = useMemo(() => Object.values(messageMemberProfiles).filter((profile) => profile.membership !== 'former'), [messageMemberProfiles])

  // #2098 owner 定:已读回执逐条显示 → 去掉原「只挂末条」的 lastOwnMessageId/threadLastOwnMessageId 计算。
  // 每条本人消息独立按 is_mine 显环;sending/failed/retracted/read=0 由气泡内既有门(MessageBubble)逐条滤除。

  const rowProps = useMemo<MessageListRowProps>(() => ({
    rows: chatListRows,
    messages: listedMessages,
    threeParty,
    isFiltering,
    mobile,
    highlight: isFiltering ? searchQuery : undefined,
    flashMessageId,
    memberReadSeqs,
    isAgentChat,
    isGroupChat: isRoomChatSurface,
    memberProfiles: messageMemberProfiles,
    onReaction: handleReaction,
    onShowReadReceipt: handleShowReadReceipt,
    onQuote: handleQuote, onShowMessage: showMessage,
    onForward: handleForward,
    onDelete: handleDelete,
    onVisible: handleMessageVisible,
    onOpenMemberProfile: Object.keys(messageMemberProfiles).length > 0 ? openMessageMemberProfile : undefined,
    // @@@5856 消息 ⋯ 菜单「开话题」→ 从这条消息开一条真的话题并分栏打开。
    // 悄悄话的守卫内联在 MessageBubble(`onOpenTopic && !msg.is_whisper`,按每条消息判、那边冻结
    // 没有注释位):话题名截自来源消息且对全线可见 ⇒ 拿悄悄话开就是公开它。判据见 chatAreaRoomSurface5856。
    // 话题里不再提供这一项(单层不嵌套),私聊同样可以开话题 —— 话题的来源是「一条已有消息」,
    // 不是「一个群」(product spec:必须有来源)。
    onOpenTopic: activeChat?.kind === 'topic' ? undefined : topicSurface.openTopicFromMessage,
    topicAnchors: topicSurface.anchorsByMessageId,
    onOpenTopicAnchor: openTopicFromAnchor,
    agentFloodNoticeMessageId: agentFlood.noticeMessageId,
    onAgentFloodUndone: agentFlood.reload,
    onOpenFile: openFilePreview, onOpenLocalFileLink: sessionpageAgent.openFileLink, onMentionMember: isFiltering ? undefined : setMentionToInsert,
    selectMode,
    selectedIds,
    onToggleSelect: toggleSelect,
    onEnterSelectMode: enterSelectMode,
  }), [
    chatListRows,
    flashMessageId,
    listedMessages, threeParty,
    isFiltering,
    mobile,
    searchQuery,
    memberReadSeqs,
    isAgentChat,
    isRoomChatSurface,
    messageMemberProfiles,
    handleReaction,
    handleShowReadReceipt,
    handleQuote, showMessage,
    handleForward,
    handleDelete,
    handleMessageVisible,
    openMessageMemberProfile,
    activeChat?.kind, topicSurface.openTopicFromMessage, topicSurface.anchorsByMessageId, openTopicFromAnchor,
    agentFlood.noticeMessageId, agentFlood.reload,
    openFilePreview, sessionpageAgent.openFileLink,
    selectMode,
    selectedIds,
    toggleSelect,
    enterSelectMode,
  ])

  const emptyCaption = activeTab === 'chats'
    ? t('chatArea.empty.chats')
    : activeTab === 'contacts'
      ? t('chatArea.empty.contacts')
      : ''

  if (!activeChatId || !activeChat) { // #6158 别的 tab 上由 MainLayout 隐藏整面,❌ 在这里换成空态 —— 树留着,分栏/右栏/滚动才在
    return (
      // @@@empty-pane-drag (#3905) 空态不渲染对话头 ⇒ 右列一寸拖拽车道都没有;空态无可点内容,整块当把手。
      <div
        className="window-drag-region"
        style={{
          flex: 1,
          height: '100%',
          background: 'var(--bg-primary)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}>
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
          <PaneEmptyState icon={<MessageCircle size={26} color="var(--text-tertiary)" />} caption={emptyCaption} />
        </div>
      </div>
    )
  }

  // 头栏「状态 · 位置 · 引擎」那一句(AgentHeaderStatusLine);agent 单聊不显示成字,只给读屏与名字的悬停提示,状态由头像身体表达。
  // #7199 宿主闲时收回着:presentation 是 null(不画状态),位置与引擎照写(❌ 整句一起没了,和 Agent 设置里那一句对不上)。
  const agentStatus: AgentHeaderStatus | null = agentHeaderStatus
    ? { peerId: activeChat.peer_user_id ?? '', presentation: agentHeaderPresentation ?? null, location: agentHeaderLocation, engine: agentHeaderEngine, engineMissing: agentHeaderEngineMissing }
    : null
  const agentHero = isAgentChat && !searchMode && !!activeChat.peer_user_id
  // 块的页签条最后那枚之后的「+」(gugu-dev#181 第 ⑥ 步);页签本身由会话页的页签引擎画(chat-tabs)。
  const blockTabs = blockHost?.tabs && activeChatId ? createPortal(<ChatPlusMenu chatId={activeChatId} />, blockHost.tabs) : null
  const roomMemberTotal = isRoomChatSurface ? groupCollabSnapshot.humans.length + groupCollabSnapshot.agents.length : 0
  const headerActions = (
    <>
      <ChatHeaderActions
        isGroupChat={isGroupChat}
        isRoomChat={isRoomChatSurface}
        searchMode={searchMode}
        folderShown={tabs.folder !== null}
        infoShown={tabs.infoShown}
        showHeaderMenu={showHeaderMenu}
        mobile={mobile}
        // 块里没有标题后面那个「(N)」,人数挂在成员按钮上(原型「👥 4」)。
        memberCount={blockHost && roomMemberTotal > 0 ? roomMemberTotal : undefined}
        moreButtonRef={moreButtonRef}
        onEnterSearchMode={() => setSearchMode(true)}
        onOpenFolder={handleOpenFolder}
        onCloseWorkspacePanel={handleCloseWorkspacePanel}
        onOpenInfo={(page) => { if (activeChatId) openInfoTab(activeChatId, page) }}
        onCloseInfo={() => { if (activeChatId) closeInfoTab(activeChatId) }}
        onToggleHeaderMenu={() => setShowHeaderMenu((v) => !v)}
        onCloseHeaderMenu={() => setShowHeaderMenu(false)}
      />
      {sessionpageAgent.openAction}
    </>
  )

  // 群信息 / 会话信息(owner 10-26):成员、公告、设置合成一枚页签,和群文件夹同一套;从成员钮开就落在成员那一页。
  const infoPage = () => activeChat && activeChatId ? (
    <GroupRenameContext.Provider value={groupRename}><ChatSettingsPanel
      key={infoTabOf(activeChatId)?.info.at}
      initialPage={infoTabOf(activeChatId)?.info.page}
      activeChat={activeChat}
      messages={messages}
      onClose={() => closeInfoTab(activeChatId)}
      onClearMessages={clearMessages}
      onOpenSearch={() => {
        setSearchQuery('')
        setSearchMode(true)
      }}
      onSetNotificationLevel={(level) => setChatNotificationLevel(activeChat.id, level)}
      onTogglePinned={(pinned) => pinChat(activeChat.id, pinned)}
      memberProfiles={drawerMemberProfiles}
      currentUserId={user?.id ?? null}
      onOpenUserChat={onOpenUserChat}
      onWhisper={isGroupChat ? (target) => setWhisperTarget({ userId: target.id, displayName: target.displayName }) : undefined}
      groupCollabSnapshot={groupCollabSnapshot}
      groupCollabError={groupCollabError}
      groupAgentStatuses={groupAgentStatuses}
      onReloadGroupCollab={loadGroupCollab}
      onLeaveGroup={() => leaveGroup(activeChat.id)}
      onDissolveGroup={() => deleteChat(activeChat.id, true)}
      mobile={mobile}
    /></GroupRenameContext.Provider>
  ) : null

  const topicPane = topicSurface.splitTopic && (
    <TopicSplitPane
      viewportKey={`${viewportKey}:topic`} navigationTarget={navigationTarget}
      topic={topicSurface.splitTopic} sourceChatId={activeChatId!}
      messages={topicSurface.splitLine.messages} history={topicSurface.splitLine}
      loading={topicSurface.splitLine.loadingMessages}
      memberProfiles={messageMemberProfiles}
      visibleChats={chats}
      sourceMessagePreview={topicSourceMessagePreview}
      focusComposerToken={splitFocusToken}
      memberReadSeqs={topicSurface.splitLine.memberReadSeqs}
      onOpenFile={(file) => {
        const split = topicSurface.splitTopic; openFilePreview(file, undefined, split ? () => topicSurface.openSplit(split) : undefined)
      }}
      onDownloadFile={(file) => {
        void downloadAttachment(file.source, file.fileName).catch((error) => toast(t('chatArea.downloadFailed'), 'error', safeFailureLine(String((error as Error)?.message ?? error))))
      }}
      mentionMembers={splitMentionMembers}
      onSend={topicSurface.sendInSplit}
      onSendAttachments={topicSurface.sendAttachmentsInSplit}
      agentStatuses={groupAgentStatuses}
      runningTokens={mobile ? groupRunTokens : undefined}
      runningPreviewChatId={activeChatId}
      onOpenMemberProfile={Object.keys(messageMemberProfiles).length > 0
        ? (member, anchor, side) => openMessageMemberProfile(member, anchor, side, 'aside')
        : undefined}
      onOpenAttachment={(file, message) => { const split = topicSurface.splitTopic; openFilePreview(file, message, split ? () => topicSurface.openSplit(split) : undefined) }}
      onClose={topicSurface.closeSplit}
      embedded={Boolean(blockHost)}
      currentUserId={user?.id ?? null}
      mobile={mobile}
      onReaction={(id, emoji) => void topicSurface.splitLine.toggleReaction(id, emoji)
        .catch((error) => toast(t('message.actions.react'), 'error', safeFailureLine(String((error as Error)?.message ?? error))))}
      onForward={handleForward} visible={surfaceVisible}
      onDelete={(id) => void topicSurface.splitLine.deleteMessage(id)
        .catch((error) => toast(t('message.actions.delete'), 'error', safeFailureLine(String((error as Error)?.message ?? error))))}
    />
  )

  return (
    <div ref={surfaceElement} data-chat-surface={activeChatId}
      style={{
        flex: 1,
        // #1312 兜底: minWidth:0 让 ChatAreaPanel 能收缩到 flex basis 以下，避免内部右侧面板(工作区/历史,
        // flexShrink:0 的固定宽度)在异常并存时把整个 MainLayout 行撑开、反向挤压左侧会话列表。
        minWidth: 0,
        height: '100%',
        background: 'var(--bg-primary)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      {/* Title bar — @@@ui-ruler 会话头 = PaneHeader。原来这里自己拍高度(padding 15px 顶 + align-items:flex-start),
          与会话列表/通讯录/发现/设置四个列头的 47/52/77 各不相同;现在四处同吃 --pane-header-h,标题坐在同一条基线上。
          @@@822 右侧窗控留白(Windows/Linux 138px、Mac/web 0)不再撑出一套自己的 padding,只加在 PaneHeader 的
          paddingRight 上。@@@1375 owner: header 与正文同色,只用 divider 一条线区分。 */}
      {blockHost && <ChatBlockHead host={blockHost} actions={headerActions} chat={activeChat} name={activeChatName} avatar={activeChatAvatar} isAgent={isAgentChat} identitiesById={identitiesById} />}
      {blockTabs}
      {((!chrome && !blockHost) || searchMode) && <PaneHeader
        divider={!agentHero} className={agentHero ? 'gg-agent-header' : undefined} data-chat-area-header=""
        mobile={mobile}
        style={{
          background: 'var(--bg-primary)',
          paddingRight: 'calc(var(--pane-pad-x) + var(--titlebar-controls-width))',
          // agent 单聊:小鸟比头栏高几像素,允许它探出头栏(见 tokens.css .gg-agent-header)。
          overflow: agentHero ? 'visible' : 'hidden',
        }}
        leading={!searchMode && mobile && onBack ? (
          <IconButton
            size="lg"
            aria-label={t('chatArea.backToList')}
            title={t('common.back')}
            onClick={onBack}
          >
            <ChevronLeft />
          </IconButton>
        ) : null}
        /* @@@5856 这里曾有一支「话题全宽打开时顶栏画面包屑」。owner 2026-09-19 把全宽形态整个拿掉之后,
           主区永远不会是一条话题(chats_topic_source_chk 保证话题必有来源,收口会把它换成来源线 + 分栏),
           那一支就永远走不到了 ⇒ 删。面包屑本身搬进了分栏的标题块。 */
        title={searchMode ? null : agentHero ? (
          <AgentChatHero
            agentId={activeChat.peer_user_id!}
            name={activeChatName}
            avatarUrl={activeChatAvatar}
            presentation={agentHeaderPresentation ?? null}
            mobile={mobile}
            status={agentStatus}
            onOpen={openConversationOrAgentSettings}
          />
        ) : (
          <div style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            {/* @@@1146 对话头按设计稿(.top 仅 标题+状态行,无头像;单聊点
                名称→设置)：删除咕咕旧版 WeChat 式头像,点「名称」开会话资料抽屉(名称带 no-drag 才可点)。 */}
            <span
              style={{
                display: 'flex', alignItems: 'center', gap: 'var(--spacing-xs)', minWidth: 0,
                fontSize: 'var(--font-title)', lineHeight: 'var(--lh-title)',
              }}
            >
              <span
                role="button"
                tabIndex={0}
                className="window-no-drag-region"
                onClick={openConversationOrAgentSettings}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openConversationOrAgentSettings() } }}
                title={isAgentChat && agentChatContact ? t('chatArea.agentSettings') : t('chatArea.conversationProfile')}
                aria-label={isAgentChat && agentChatContact ? t('chatArea.agentSettings') : t('chatArea.conversationProfile')}
                style={{ color: 'var(--fg)', fontWeight: 600, letterSpacing: '-0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, cursor: 'pointer' }}
              >
                {activeChatName}
              </span>
              {/* @@@group-count (#1102) 群名后成员数 (N) — 对齐设计稿 #single-name 群头 `创业产品 (4)`
                  (faint-fg, 常规字重)。计数从 群名旁移过来,与下方成员状态行解耦。 */}
              {isRoomChatSurface && (() => {
                const total = groupCollabSnapshot.humans.length + groupCollabSnapshot.agents.length
                if (total === 0) return null
                return (
                  <span style={{ color: 'var(--faint-fg)', fontWeight: 400, flexShrink: 0 }}>
                    ({total})
                  </span>
                )
              })()}
              {/* @@@single-head (#957/#1234) agent 标识 ⚡bolt — 逐字节抄设计稿 #single-name .bolt(琥珀 #e0a13a, 12px, 明暗一致)。 */}
              {isAgentChat && (
                <span aria-hidden style={{ color: 'var(--agent-bolt)', flexShrink: 0, display: 'inline-flex' }}>
                  <Zap size={12} />
                </span>
              )}
              {/* #1099 触点2: 头栏「host 陈旧」黄色 ⚠ 警告角标已删 —— ACP 下不在 DM 头栏对 agent 做
                  terminal 时代的离线/陈旧告警(设计稿仅 ⚡ + 状态点)。该 badge 仍存在于
                  chat-list/group 等 surface(它本质是「主机 gugu 版本过旧」提示,与 offline 正交)。 */}
            </span>
            {isGroupChat && (() => {
              // #single-name 群头 .st: 绿点 ● + 完整成员名(`P7测试、林小满、Atlas、Borealis`),无「· N 人」
              // 点击 header 展开成员抽屉。溢出由 ellipsis 收。
              const members = [...groupCollabSnapshot.humans, ...groupCollabSnapshot.agents]
                .map((m) => identitiesById[m.id]?.display_name ?? '')
                .filter(Boolean)
              const total = members.length
              if (total === 0) return null
              const names = members.join('、')
              const statusIndicatorProps = groupAgentStatusIndicatorProps(shownAgent.members(groupCollabSnapshot.agents, groupAgentStatuses), groupAgentStatuses)
              return (
                <span
                  title={names}
                  style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-xs)', fontSize: 'var(--font-body)', lineHeight: 'var(--lh-body)', color: 'var(--muted-fg)', minWidth: 0 }}
                >
                  {statusIndicatorProps ? <span {...statusIndicatorProps}>{statusIndicatorProps['data-agent-display-status'] === 'needs_user' ? <AgentNeedsUserGlyph size={8} /> : null}</span> : null}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{names}</span>
                </span>
              )
            })()}
            {agentStatus ? <AgentHeaderStatusLine {...agentStatus} /> : null}
          </div>
        )}
        actions={searchMode ? null : headerActions}
      >
        <AnimatePresence initial={false}>
          {searchMode && (
            /* ── Search mode ── */
            <motion.div
              className="window-no-drag-region"
              key="search"
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={tween(DUR_FAST_MS)}
              style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 'var(--spacing-sm)' }}
            >
              <ChatSearchControls search={search} />
            </motion.div>
          )}
        </AnimatePresence>
      </PaneHeader>}

      <div
        ref={attachPanelsRow}
        style={{
          flex: 1,
          minHeight: 0,
          minWidth: messageColumnMinWidth,
          display: 'flex',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        <div data-testid="session-chat-panel" className="relative isolate flex min-h-0 min-w-0 flex-1 flex-col">
        {opener.overlay}
        {emptyProject ? <ChatPartSlot chatId={activeChat.id} part="empty" className="flex min-h-0 min-w-0 flex-1 flex-col" /> : <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          {/* Pinned message banner */}
          {activeChat.pinned_message_id && (
            <div
          style={{
            background: 'var(--bg-elevated)',
            borderBottom: '1px solid var(--border-color)',
            padding: '6px 14px',
            fontSize: 'var(--font-body)',
            color: 'var(--text-secondary)',
            flexShrink: 0,
            cursor: 'pointer',
          }}
        >
          {t('chatArea.pinnedMessage')}
        </div>
      )}

      {/* Message list —— 有行就画列表,与 loading 无关:加载中已有的行(盘缓存/乐观发送)照样可见,
          列表不会因为 loading 翻转被卸载重挂。骨架只在「在加载且一行都没有」时占位。 */}
      {taskChatNotice}{loadingMessages && chatListRows.length === 0 && <MessageListSkeleton />}

      {/* #7199 没读出来 ≠ 没聊过:读失败时说读不到 + 重试,❌ 往下落进首次对话欢迎页 / 「暂无消息」。 */}
      {messagesError && !(loadingMessages && chatListRows.length === 0) && (
        <MessageLoadFailure error={messagesError} inline={chatListRows.length > 0} onRetry={() => refreshMessages(activeChatId ?? undefined)} />
      )}

      {!loadingMessages && !messagesError && chatListRows.length === 0 && (
        /* @@@2186 — agent 运行态(activeAgentActivity)且尚无消息:空态让位、保留空白 list 容器。这曾由
           rows 里的恒空 agentActivity 行隐式保证(它把 rows 撑成非空、让列表挂载),该行因零高刷
           console error 被移除后,契约收进这一个 rows===0 分支;不挂空 rows 的列表,
           首条消息落库 rows>0 时列表正常挂载。 */
        activeAgentActivity ? (
          <div data-testid={AUTOMATION_TEST_IDS.chatMessageList} style={{ flex: 1 }} />
        ) : searchMode && searchQuery.trim() ? (
          <div style={{ flex: 1, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-body)', padding: '40px 0' }}>
            {t('chatArea.searchNoResults', { query: searchQuery })}
          </div>
        ) : isAgentChat ? (
          <AgentFirstConversationEmpty name={resolveOrLoud(activeChatName, `agent chat greeting ${activeChat?.id}`)} onPick={(s) => { if (activeChatId) setDraft(activeChatId, s) }} />
        ) : (
          <div style={{ flex: 1, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-body)', padding: '40px 0' }}>
            {t('chatArea.noMessages')}
          </div>
        )
      )}

      {chatListRows.length > 0 && (
        <MessageList
          resetKey={chatResetKey}
          listRef={listRef}
          scrollerRef={setScrollerRef}
          rows={chatListRows}
          rowProps={rowProps} footer={chrome?.typing}
          initialTopMostItemIndex={openLocation()} topInset={agentHero && !mobile && isAgentHeroBird(activeChatAvatar, assistantPeer) ? AGENT_HERO_OVERHANG_PX : 0}
          followTail={!unreadNavigationPending && !messageWindow?.hasNewer && messageWindow?.change !== 'newer'} unreadAbove={unreadEntry ? { messageId: unreadEntry.locator.message_id, messageSeq: unreadEntry.locator.message_seq, label: t('chatArea.unreadAbove', { count: unreadEntry.locator.unread_count }), onSeen: unreadEntry.onSeen, onJump: () => void jumpToUnreadEntry(scrollerRef.current).catch(onHistoryError) } : null}
          onAtBottomChange={onAtBottomChange}
          onTotalListHeightChanged={onTotalListHeightChanged}
        />
      )}

      <ChatTailNotice window={messageWindow} hidden={searchMode} onClick={pinToBottom} />

      {/* @@@1506 - Agent 运行状态：输入框上方的轻量浮动文字（owner #1506：无重白板，打字时也能瞥见）。群聊列出在跑的 agent（可点 → @mention）；
          单聊是运行中/思考中（流式正文仍留消息流）。运行条那一行是固定高的一行(群、agent 私聊才有),没有底,消息从它后面滚过;运行条出现、消失不改变布局。 */}
      <ChatBottomDock reserve={chatListRows.length === 0} above={(isRoomChatSurface || isAgentChat) && <RunningBarSlot>
      {!searchMode && !chrome?.hideRunningStatus && (isRoomChatSurface ? (
        // @@@1696 群聊运行态：横排单行「运行 token」(流光动词) + cap +N。数据 = 在跑(transient)的 agent，
        // stateKey 由 presence recentActions 的最新 kind 派生，展示文案由 RunningTokenBar 翻译；
        // toolCount 近似用近 5 分钟 actions.length。onTokenClick 仍 @mention。
        <RunningTokenBar
          testId="group-agent-running-status"
          // @@@6357 悬浮 token = MessagePreview(它最近在做的事,不按 chat 过滤,#6573)。
          previewChatId={activeChatId}
          tokens={groupRunTokens}
          onTokenClick={(id) => {
            const agent = groupCollabSnapshot.agents.find((a) => a.id === id)
            if (agent) setMentionToInsert({ id: agent.id, name: identitiesById[agent.id]?.display_name ?? '' })
          }}
        />
      ) : directRunningToken && !chrome?.typing ? (
        // @@@1696/@@@1861/@@@1993 单聊 = 同一运行 token 的退化态(N=1)。稳定 key 优先级为
        // thinking → live tool kind → presence recent action → running；当前 locale 只在 RunningTokenBar 消费。
        <RunningTokenBar
          testId="agent-running-status"
          // @@@6357 私聊同一张卡。
          previewChatId={activeChatId}
          tokens={[
            {
              id: directRunningToken.agentId,
              name: directRunningToken.displayName,
              avatarUrl: directRunningToken.avatar,
              avatarSeed: directRunningToken.agentId,
              stateKey: deriveAgentRunningState(
                liveStream,
                latestRecentAction(agentRecentActions, agentLastActiveAt),
              ),
              toolCount: liveStream?.toolCount ?? agentRecentActions.length,
              lastActiveAt: agentLastActiveAt,
            },
          ]}
        />
      ) : null)}</RunningBarSlot>}>
      {/* #2115 — 普通 ACP 回合终态失败条（运行条同槽位;重试=CAS error→pending 重排原命令,详见 Slot）。 */}
      {!searchMode && <AgentConversationNoticeSlot sessionpageNotices={sessionpageAgent.sessionpageNotices} failureExplained={sessionpageAgent.failureExplained} chatId={activeChatId} threadRootId={threadScope.rootId} profiles={messageMemberProfiles} />}
      {/* Input area — white card with rounded border floating in gray.
          @@@multi-select (#988) — 多选态用底部批量操作条替换输入框（同槽位 + 同 --bg-primary 外壳）。 */}
      {selectMode ? (
        // Desktop selection and editing use the same ACP slot frame; phone spacing stays local.
        <div className={mobile && blockHost ? `${sessionComposerDockBandClassName} pt-3` : undefined} style={{ background: mobile ? 'var(--bg-primary)' : undefined, padding: mobile ? (blockHost ? undefined : '10px 8px max(8px, env(safe-area-inset-bottom))') : 0, flexShrink: 0 }}>
          <div
            data-testid="message-select-bar"
            style={{ display: 'flex', flexWrap: mobile ? 'wrap' : undefined, alignItems: 'center', gap: 10, padding: '8px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-surface)', background: 'var(--bg-secondary)' }}
          >
            <span style={{ flex: mobile ? '1 0 100%' : 1, fontSize: 'var(--font-body)', color: 'var(--text-secondary)', paddingLeft: 4 }}>{t('chatArea.selectedMessages', { count: selectedIds.size })}</span>
            <button
              onClick={exitSelectMode}
              style={{ height: mobile ? undefined : 30, minHeight: mobile ? 44 : undefined, flex: mobile ? '1 1 0' : undefined, minWidth: mobile ? 0 : undefined, padding: '0 14px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-control)', background: 'var(--bg-elevated)', color: 'var(--text-secondary)', fontSize: 'var(--font-body)', cursor: 'pointer' }}
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={handleBatchForward}
              disabled={selectedIds.size === 0}
              style={{ height: mobile ? undefined : 30, minHeight: mobile ? 44 : undefined, flex: mobile ? '1 1 0' : undefined, minWidth: mobile ? 0 : undefined, padding: '0 14px', border: 'none', borderRadius: 'var(--radius-control)', background: selectedIds.size > 0 ? 'var(--accent)' : 'var(--border-subtle)', color: 'var(--surface-white)', fontSize: 'var(--font-body)', cursor: selectedIds.size > 0 ? 'pointer' : 'default' }}
            >
              {t('forward.title')}
            </button>
            <button
              onClick={handleBatchDelete}
              disabled={selectedIds.size === 0}
              style={{ height: mobile ? undefined : 30, minHeight: mobile ? 44 : undefined, flex: mobile ? '1 1 0' : undefined, minWidth: mobile ? 0 : undefined, padding: '0 14px', border: '1px solid var(--danger)', borderRadius: 'var(--radius-control)', background: 'var(--bg-elevated)', color: 'var(--danger)', fontSize: 'var(--font-body)', cursor: selectedIds.size > 0 ? 'pointer' : 'default', opacity: selectedIds.size > 0 ? 1 : 0.5 }}
            >
              {t('message.actions.delete')}
            </button>
          </div>
        </div>
      ) : (
        // ChatBottomDock owns the shared desktop frame; keep phone padding and safe area unchanged.
        <div data-chat-composer="" className={mobile && blockHost ? `${sessionComposerDockBandClassName} pt-3` : undefined} style={{ background: mobile ? 'var(--bg-primary)' : undefined, padding: mobile ? (blockHost ? undefined : '8px 10px max(10px, env(safe-area-inset-bottom))') : 0, borderTop: mobile ? '1px solid var(--border-subtle)' : undefined, flexShrink: 0 }}>
        {/* #1099: offline「唤醒 Agent」状态栏已删(ACP 发消息即触达自启)。removed 显提示栏。 */}
        {/* agent 会话 composer 通知区：已注销 Agent 的禁用说明。 */}
        {isAgentChat ? <AgentComposerNotices disabledReason={agentComposerDisabled ? (agentComposerDisabledReason ?? null) : null} agentUserId={activeChat?.peer_user_id ?? null} agentName={activeChatName} /> : null}
        <ChatMessageComposer
          beforeSend={createSessionpageChatSendPreflight(isAgentChat, activeChat?.peer_user_id, t('agent.taskpage.recoveryFailed.unknown'))}
          onSend={async (content, opts) => {
            await sendMessage(content, opts)
          }}
          placeholder={agentComposerPlaceholder ?? chrome?.placeholder} attachGlyph={chrome?.attachGlyph} attachMenu={chrome?.attachMenu}
          onSendAttachments={async (files, opts) => {
            await sendAttachments(files, opts)
          }}
          quoteContent={quoteText}
          onQuoteConsumed={() => setQuoteText(null)}
          mentionToInsert={mentionToInsert}
          onMentionInserted={() => setMentionToInsert(null)}
          chatId={activeChatId} hidden={!surfaceVisible}
          isGroupChat={isRoomChatSurface}
          groupMembers={composerGroupMembers} currentUserId={user?.id ?? null} agentStatuses={groupAgentStatuses} messages={messages}
          disabled={agentComposerDisabled}
          disabledReason={agentComposerDisabledReason}
          whisperTarget={whisperTarget}
          onExitWhisper={() => setWhisperTarget(null)}
        />
      </div>
      )}
      </ChatBottomDock>

          {/* @@@1145 点 Agent 名 → Agent 设置面板(替旧右侧会话资料抽屉)。 */}
          {showAgentSettings && agentChatContact ? (
            <AgentSettingsModal agent={agentChatContact} onClose={() => setShowAgentSettings(false)} />
          ) : null}

        </div>}
        </div>

        {inTabs(topicPane, infoPage)}

        {filePreview.panel}
      </div>
      {shownMessageProfile ? (
        <MemberProfilePopover
          profile={shownMessageProfile.profile}
          // @@@5856 从话题分栏点开的卡片 ❌ 不给悄悄话:这个动作落在**主线**的输入框上,
          // 而用户此刻在看的是话题 —— 发出去会落进源群。要在话题里悄悄话,得先有话题自己的入口。
          onClose={() => setActiveMessageProfile(null)}
          onOpenChat={shownMessageProfile.profile.member.id !== user?.id && onOpenUserChat ? (target) => {
            setActiveMessageProfile(null)
            onOpenUserChat(target)
          } : undefined}
          onWhisper={isGroupChat && shownMessageProfile.profile.openedFrom !== 'aside' ? (target) => {
            setActiveMessageProfile(null)
            setWhisperTarget({ userId: target.id, displayName: target.displayName })
          } : undefined}
          editControls={shownMessageProfile.editControls}
          testId={AUTOMATION_TEST_IDS.messageAvatarProfileMenu}
        />
      ) : null}
      {readReceiptPanel ? (
        <ReadReceiptPopover
          anchor={readReceiptPanel.anchor}
          readers={readReceiptPanel.readers}
          unreaders={readReceiptPanel.unreaders}
          testId="message-read-receipt-panel"
          onClose={onCloseReadReceipt}
        />
      ) : null}
      {forwardMessages.length > 0 && activeChatId ? (
        <ForwardMessageDialog
          messages={forwardMessages}
          chats={chats}
          // 被转发的消息知道自己从哪条 chat 来。写死 activeChatId 会在分栏转发时排掉「来源群」
          // (最自然的目的地),而话题自己反而留在列表里 —— 选中就是原地复制一份还挂「转发」。
          sourceChatId={forwardMessages[0]?.chat_id ?? activeChatId}
          onForward={handleForwardTo}
          onClose={() => setForwardMessages([])}
        />
      ) : null}
    </div>
  )
}
