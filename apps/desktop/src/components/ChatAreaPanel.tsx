import { useState, useRef, useEffect, useCallback, useMemo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { motion, AnimatePresence } from 'framer-motion'
import { DUR_FAST_MS, tween } from '@/styles/motion'
import type { FlowListHandle } from '@/lib/flowList'
import { ChevronLeft, MessageCircle, Zap } from '@/lib/icons'
import { downloadAttachment, openAttachmentImage } from '@/lib/attachmentBytes'
import { createSessionpageChatSendPreflight } from '@/lib/sessionpage-session-recovery'
import type { SidebarTab } from '@gugu/core/shared/enums/sidebarTabModels'
import { resolveOrLoud } from '@gugu/core/shared/resolveOrLoud'
import { useChatStore } from '../store/chatContext'
import { ChatLineScope } from '../store/chatLineScope'
import { useContactsStore } from '../store/contactsContext'
import { useAuth } from '../store/auth'
import { AgentSettingsModal } from './agentsettings/AgentSettingsModal'
import type { AgentConversationActivity, GroupCollabSnapshot, MessageItem } from '@gugu/core/shared/types/chat'
import { chatService, type ChatFileItem } from '../lib/chat'
import { useUnreadLocatorNavigation } from '../hooks/useUnreadLocatorNavigation'
import { useSourceMessageReveal } from '../hooks/useSourceMessageReveal'
import { useChatHistoryPagination } from './chat/useChatHistoryPagination'
import { useGroupCollabRemovedAgentGate } from '../hooks/useGroupCollabRemovedAgentGate'
import { useGroupCollabLoader, EMPTY_GROUP_COLLAB } from '../hooks/useGroupCollabLoader'
import { useTopicScopedMemberProfile } from '../hooks/useTopicScopedMemberProfile'
import { ForwardMessageDialog } from './chat/ForwardMessageDialog'
import { AUTOMATION_TEST_IDS } from '../lib/automationDom'
import { UI_EVENTS } from '../lib/uiEvents'; import { isChatSearchTarget } from '../lib/chatSearchTarget'
import { drainTopicSplitRequest, requestTopicSplit } from '../lib/topicSplitRequest'
import { useTopicsPanelRequest } from '../hooks/useTopicsPanelRequest'
import type { HistoryTab } from './historyPanelModels'
import { buildGroupRosterCandidates } from '../lib/mention'
import { topicMentionCandidates } from './chat/topicMentionModels'
import { resolveGroupRunningIndicator } from '../lib/agentRunningStatusModels'
import { GROUP_AGENT_BAR_MAX, groupRunningTokens } from '../lib/groupRunningTokenModels'
import type { AgentLocation } from '@gugu/core/shared/ui/agentHeaderStatusModels'
import { useReadReceiptPanel } from '@/hooks/useReadReceiptPanel'
import { agentComposerModel, isRetiredCloudAgentChat } from '../lib/agentComposerModel'
import { useAgentRunningStatus } from '../hooks/useAgentRunningStatus'
import { useAgentStream } from '../hooks/useAgentStream'
import { useStructurallyShared } from '../hooks/useStructurallyShared'
import { RunningTokenBar } from './RunningTokenBar'
import { deriveAgentRunningState } from '../lib/agentRunningVerb'
import { AgentConversationNoticeSlot } from './AgentTurnFailureBar'
import { latestRecentAction } from './agentRecentActionModel'
import { useAgentDisplayStatuses, useAgentRecentActivity } from '../hooks/useAgentDisplayStatus'
import { groupAgentStatusIndicatorProps } from '../lib/groupAgentStatus'; import { AgentNeedsUserGlyph } from './AgentNeedsUserGlyph'; import { parseComposerCard } from '@gugu/core/shared/ui/taskCardModels'
import { useMessageFilePreview } from './chat/useMessageFilePreview'
import { AgentComposerNotices } from './chat/AgentComposerNotices'
import { useAgentSessionpagePresentation } from './chat/AgentSessionpagePresentation'
import { AnnouncementDrawer } from './chat/AnnouncementDrawer'
import type { MemberProfileCardModel, MemberProfileChatTarget } from './MemberProfileCard'
import { AgentChatHero } from './chat/AgentChatHero'
import { useShownAgentStatus } from './chat/useAgentsOnCloudComputer'
import { AgentHeaderStatusLine } from './chat/AgentHeaderStatusLine'
import { MemberProfilePopover } from './MemberProfilePopover'
import { ReadReceiptPopover } from './ReadReceiptPopover'
import { useListenModeEditControls } from './chat/useListenModeEditControls'
import { useMessageColumnMinWidth } from './chat/useMessageColumnMinWidth'
import { RightPanel } from './chat/RightPanel'; import { isGroupManagerRole } from '../lib/groupMemberPermissions'; import { SettingsPageHead } from './chat/groupSettingsUi'; import { useBackLayer } from './ui/sheetStack'
import {
  buildMemberProfileMap,
  type ActiveMemberProfile,
  type MemberProfileSide,
  toIdentityProfile,
} from './memberProfileModels'
import { InputArea, type ComposerAttachAction } from './chat/InputArea'
// @@@5856 消息列表抽成共享组件(话题分栏也用它)——见 MessageList.tsx 头部注释。
import { MessageList, type MessageListRowProps } from './chat/MessageList'
import { useTaskChatRows } from './assistant/useTaskChatRows'
import { MessageLoadFailure } from './chat/MessageLoadFailure'
import { AgentFirstConversationEmpty } from './chat/AgentFirstConversationEmpty'
import { MessageListSkeleton } from './chat/MessageListSkeleton'
import { sendAttachmentBatch } from './chat/sendAttachmentBatch'
import { ChatHeaderActions } from './chat/ChatHeaderActions'
import { classifyFeedChange } from './chat/scrollControl'
import { useFollowingTail } from './chat/useFollowingTail'
import { useConversationScrollMemory } from './chat/useConversationScrollMemory'
import {
  COLOR_ACCENT,
  COLOR_ON_ACCENT,
  AGENT_HERO_OVERHANG_PX, isAgentHeroBird, type AgentHeaderStatus,
} from './chat/chatPresentation'
import { GroupFolderSlot } from './appSlot/GroupFolderSlot'; import { useOpenApp } from './appSlot/useOpenApp'; import { GROUP_PANEL_WIDTHS, groupSlotMemory, type FileToOpen } from './appSlot/groupSlotMemory'; import { SidePanelSplit, type PanelForm } from '../session/renderer/lib/layout/side-panel-split'
import { HistoryPanel, type HistoryTopicItem, type HistoryFileItem } from './HistoryPanel'
import { useTopicSurface, type TopicSurface } from '@/hooks/useTopicSurface'
import { isRoomChat } from '@gugu/core/shared/ui/chatModels'
import { topicService } from '@/lib/topics'
import { MemberListPanel } from './chat/MemberListPanel'
import { useAgentFloodNotice } from '@/hooks/useAgentFloodNotice'
import { TopicSplitPane } from './chat/TopicSplitPane'
import { latestTopicSourceIdOf } from './chat/topicSplitModels'
import { ImportedHistoryPanel } from './ImportedHistoryPanel'
import { useToast } from './toastContext'
import { rendererLogger } from '../lib/log'
import { PaneEmptyState } from './ui/PaneEmptyState'
import { PaneHeader } from './ui/Pane'
import { IconButton } from './ui/IconButton'
import { Button } from './ui/Button'
import { SearchField } from './ui/SearchField'
import { loadImportedSessionHistories, type ImportedSessionHistory } from '../lib/importedHistoryReader'
export { ChatNotificationLevelControl } from './chat/ChatNotificationLevelControl'
import { ChatSettingsPanel } from './chat/ChatSettingsPanel'
interface ChatAreaPanelProps {
  /** 这块面显示哪条会话:对话页给列表选中的那条,「助理」App 给和它的私聊(#7199);不给 = 跟着那条活的线(store/chatLine.ts)。 */
  chatId?: string | null
  activeTab: SidebarTab
  /** 常驻但不可见(新建 agent/任务的创建面盖在它上面):与切到别的 tab 同一套门控 —— 不算「看见」、不接全局快捷键。 */
  hidden?: boolean
  mobile?: boolean
  // @@@chat-open-nonce (#461) - changes each time the chat pane is (re)opened on mobile, even for the same
  // chat (where activeChatId doesn't change). Used to re-trigger the scroll-window reset (collapse + bottom).
  openNonce?: number
  onBack?: () => void
  /** #7199「助理」App 里那块:头栏只在搜索时出现(头像、搜索、设置在 App 自己那一排),输入框「和 X 聊天」+「+」;typing = 接在消息流末尾、取代运行条的「它在处理」。 */
  chrome?: { placeholder: string; attachGlyph: ReactNode; attachMenu?: readonly ComposerAttachAction[]; typing?: ReactNode; hideRunningStatus?: boolean }
  onOpenUserChat?: (target: MemberProfileChatTarget) => void; onOpenSessionpageAgent?: (agentUserId: string, view?: 'code' | 'general') => Promise<void>; onOpenSessionpageAgentFile?: (agentUserId: string, path: string) => Promise<void>
}

type ImportedHistoryState = {
  chatId: string | null
  histories: ImportedSessionHistory[]
  loading: boolean
  error: string | null
}

const EMPTY_IMPORTED_HISTORY_STATE: ImportedHistoryState = {
  chatId: null,
  histories: [],
  loading: false,
  error: null,
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

function ChatAreaSurface({ activeTab, hidden = false, mobile = false, openNonce, onBack, chrome, onOpenUserChat, onOpenSessionpageAgent, onOpenSessionpageAgentFile }: Omit<ChatAreaPanelProps, 'chatId'>) {
  const { toast } = useToast()
  const { t } = useTranslation('messaging')
  const { getImRepository, subscribeAccountRevision, identitiesById, chats, activeChat, activeChatId, messages, loadingMessages, messagesError, refreshMessages, sendMessage, toggleReaction, memberReadSeqs, clearMessages, deleteMessage, appendMessage, removeMessage, pinChat, deleteChat, leaveGroup, setChatNotificationLevel, loadOlderMessages, hasMoreOlder, loadingOlder, messageWindow, unreadNavigationPending, unreadEntry, jumpToUnreadEntry, loadNewerMessages, loadMessageAnchor, returnToLatestMessages, markMessageVisible, setFollowingTail, threadScope, setActiveChatId, setDraft } = useChatStore('getImRepository', 'subscribeAccountRevision', 'identitiesById', 'chats', 'activeChat', 'activeChatId', 'messages', 'loadingMessages', 'messagesError', 'refreshMessages', 'sendMessage', 'toggleReaction', 'memberReadSeqs', 'clearMessages', 'deleteMessage', 'appendMessage', 'removeMessage', 'pinChat', 'deleteChat', 'leaveGroup', 'setChatNotificationLevel', 'loadOlderMessages', 'hasMoreOlder', 'loadingOlder', 'messageWindow', 'unreadNavigationPending', 'unreadEntry', 'jumpToUnreadEntry', 'loadNewerMessages', 'loadMessageAnchor', 'returnToLatestMessages', 'markMessageVisible', 'setFollowingTail', 'threadScope', 'setActiveChatId', 'setDraft')
  const { user } = useAuth()
  const surfaceVisible = activeTab === 'chats' && !hidden
  const { contacts } = useContactsStore()
  const [showDrawer, setShowDrawer] = useState(false); const surfaceElement = useRef<HTMLDivElement>(null)
  const [showAgentSettings, setShowAgentSettings] = useState(false)
  // #986 群公告：群聊 ⋮ 下拉菜单 + 右侧抽屉。
  const [showAnnounce, setShowAnnounce] = useState(false)
  const [showHeaderMenu, setShowHeaderMenu] = useState(false)
  // @@@history (#957) — 历史侧面板（线程/导入历史/消息附件），与工作区面板互斥（设计稿同槽位）。
  const [historyPanelOpen, setHistoryPanelOpen] = useState(false)
  const [historyOpenRequest, setHistoryOpenRequest] = useState<{ tab?: HistoryTab; nonce: number }>({ nonce: 0 })
  const [historyFiles, setHistoryFiles] = useState<ChatFileItem[]>([])
  const [historyFilesLoading, setHistoryFilesLoading] = useState(false)
  const [importedHistoryState, setImportedHistoryState] = useState<ImportedHistoryState>(EMPTY_IMPORTED_HISTORY_STATE)
  const importedHistoryLoadRef = useRef(0)
  const [workspaceForm, setWorkspaceForm] = useState<PanelForm>('closed') // the workspace App's slot: the session page's three forms
  // @@@5856 成员列表面板开关(与 workspace/history/话题分栏 同槽位互斥)。头栏 👥 接的就是它 ——
  // 此前那颗按钮接的是群设置抽屉,于是成员列表本身在产品里没有任何入口(owner 2026-09-18 指出)。
  const [memberListOpen, setMemberListOpen] = useState(false)
  // closeRightSurfaces 在 topicSurface 之前声明,而它要关分栏 ⇒ 经 ref 取当前实例,避免声明顺序打结。
  const topicSurfaceRef = useRef<TopicSurface | null>(null)
  // ⚠️ ❌ 不要在这里读 topicSurfaceRef —— 它要到本文件更靠后才赋值,这一行读到的是**上一帧**的
  // 分栏状态。它喂 rightPanelOpen → useMessageColumnMinWidth(#2234 那条「右栏永不被裁切」),
  // 差一帧就是开分栏那一帧 min-width 算错。分栏开没开是本地状态,直接存一份。
  const [topicSplitOpen, setTopicSplitOpen] = useState(false)
  const [searchMode, setSearchMode] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const filePreviewCloseRef = useRef<() => void>(() => {})
  const [quoteText, setQuoteText] = useState<{ messageId?: string; senderName: string; content: string } | null>(null)
  // @@@message-forward (#899) / @@@multi-select (#988) - messages pending forward; single-forward
  // sets [msg], batch sets the selected list. Opens ForwardMessageDialog when non-empty.
  const [forwardMessages, setForwardMessages] = useState<MessageItem[]>([])
  // @@@multi-select (#988) - 多选模式 + 选中消息 id 集。进多选预选触发消息，退出时清空。
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  // @@@avatar-click-mention (#518) - clicking an agent avatar in the group bar sets this; InputArea
  // consumes it (insert "@name " + register the mention target) then clears via onMentionInserted.
  const [mentionToInsert, setMentionToInsert] = useState<{ id: string; name: string } | null>(null)
  // @@@whisper (#820) — 悄悄话目标：设置后 InputArea 进入悄悄话模式，发送强制 isWhisper+toUserIds。
  const [whisperTarget, setWhisperTarget] = useState<{ userId: string; displayName: string } | null>(null)
  const lastNavigationRef = useRef(0)
  const [groupCollabSnapshot, setGroupCollabSnapshot] = useState<GroupCollabSnapshot>(EMPTY_GROUP_COLLAB)
  const [activeMessageProfile, setActiveMessageProfile] = useState<ActiveMemberProfile | null>(null)
  const peerIdentity = identitiesById[activeChat?.peer_user_id ?? '']
  const isAgentChat = activeChat?.kind === 'ai' || peerIdentity?.type === 'agent'
  const isGroupChat = activeChat?.kind === 'group'
  // @@@5856 场所型会话 = 群 + 话题:都有自己的名字、成员、文件与响应档位。头栏的搜索/工作区/成员
  // 三颗按钮问的是这个,不是「是不是群」。判据的唯一真源在 @gugu/core/shared/ui/chatModels。
  const isRoomChatSurface = activeChat ? isRoomChat(activeChat.kind) : false
  // 场所型(群/话题)读自己的 name/avatar;私聊读对端。话题没有 peer_user_id,走错分支就是一条无名会话。
  const activeChatName = isRoomChatSurface ? (activeChat?.name ?? '') : (activeChat?.peer_alias?.trim() || peerIdentity?.display_name || '')
  const activeChatAvatar = isRoomChatSurface ? (activeChat?.avatar ?? null) : (peerIdentity?.avatar ?? null)
  // @@@1145 单聊 Agent 的联系人档(供 AgentSettingsModal 取完整资料)。点名时优先弹设置面板;
  // 找不到联系人(极少)则回落旧抽屉,不丢可达性。
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
  // the existing workspace↔history mutex (handleOpenWorkspacePanel/handleOpenHistoryPanel).
  // @@@1485 review-followup / #1312：右侧同槽位 surface 全互斥的**单一** close helper。各 opener 原来手枚举
  // 其余 surface 的 setX(false)（O(n²) 漂移）——已漏掉 群公告(showAnnounce) 多路（#1497 Scale review CONFIRMED:
  // 设置/工作区/历史/agent设置/话题分栏/成员列表 任一开时 群公告 仍可叠加）。统一在此一处关全部，
  // opener 只 close+开自己。
  const closeRightSurfaces = useCallback(() => {
    setWorkspaceForm('closed')
    setHistoryPanelOpen(false)
    topicSurfaceRef.current?.closeSplit()
    setMemberListOpen(false)
    setShowAgentSettings(false)
    setShowDrawer(false)
    setShowAnnounce(false)
    filePreviewCloseRef.current()
  }, [])
  // @@@message-forward (#899) - open the forward picker; the dialog calls handleForwardTo to fan out.
  const handleForward = useCallback((msg: MessageItem) => setForwardMessages([msg]), [])

  const filePreview = useMessageFilePreview({ onForward: handleForward, mobile, visible: surfaceVisible, closeRightSurfaces, toast, downloadFailed: t('chatArea.downloadFailed') })
  const openFilePreview = filePreview.open
  filePreviewCloseRef.current = filePreview.close
  // @@@2234 中栏 min-width 自适应(有右栏展开时按内容区实宽让位,右栏永不被 overflow:hidden 裁切)—— 逻辑见 hook。
  const rightPanelOpen = historyPanelOpen || topicSplitOpen || memberListOpen || showDrawer || showAnnounce || filePreview.isOpen; const { messageColumnMinWidth, attachPanelsRow } = useMessageColumnMinWidth(rightPanelOpen, mobile)
  const handleOpenSettingsDrawer = useCallback(() => {
    closeRightSurfaces()
    setShowDrawer(true)
  }, [closeRightSurfaces])
  const handleOpenAgentSettings = useCallback(() => {
    closeRightSurfaces()
    setShowAgentSettings(true)
  }, [closeRightSurfaces])
  // @@@1485 review：群公告也走具名 opener（与其余 5 个 opener 一致 + 受 exhaustive-deps 保护，避免内联漏改）。
  const handleOpenAnnounce = useCallback(() => {
    closeRightSurfaces()
    setShowAnnounce(true)
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
  const searchInputRef = useRef<HTMLInputElement>(null)
  // #1319 — anchor for the header ⋯ menu. The menu is portalled to document.body and positioned with
  // position:fixed off this button's rect, so an ancestor's overflow:hidden (the header) can't clip it.
  const moreButtonRef = useRef<HTMLButtonElement>(null)
  // @@@chat-view-window (#461) - 消息列表(lib/flowList.ts)自己管滚动位置;这是它的命令式句柄(定位 / 贴底)。
  const listRef = useRef<FlowListHandle | null>(null)
  // #1708 来源消息跳转高亮：被点的消息 id（闪一下后清空）。
  const [flashMessageId, setFlashMessageId] = useState<string | null>(null)
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isAtBottomRef = useRef(true)

  // fiResetChatRef: which chat the feed change classifier is currently baselined for.
  // baselineRef: skip new-message/prepend bookkeeping on the initial messages snapshot after a switch.
  // lastTrackRef: previous (window's earliest message id, newest id) to classify a window change as
  // reveal/slide (front delta → firstItemIndex) vs append (new message at the end).
  const fiResetChatRef = useRef<string | null>(null)
  const baselineRef = useRef(true)
  const lastTrackRef = useRef<{ firstId: string | null; lastId: string | null }>({ firstId: null, lastId: null })
  const readReceiptInFlightRef = useRef<Set<string>>(new Set())
  // @@@local-sync (#948) — 群名册内存镜像 cache(首帧 roster + #1877 删 Agent 收敛),与 loader / removed-agent-gate 共享 → 在此声明后传入两个 hook。
  const groupRosterMemoryCacheRef = useRef<Map<string, GroupCollabSnapshot>>(new Map())

  // @@@1877 删本机 Agent 后群名册即时收敛闸门(即时剔除 + 内存/持久/SWR-merge 三层 reseed 封堵，见 useGroupCollabRemovedAgentGate):
  const { prune: pruneRemovedAgentsFromCollab, mergeAndPrune: mergeGroupCollabPruned } = useGroupCollabRemovedAgentGate(user?.id, setGroupCollabSnapshot, groupRosterMemoryCacheRef)

  // @@@2169 群协作加载子系统(SWR 首帧 + 权威加载)抽到 useGroupCollabLoader,给冻结 god 文件抵消行数。
  const { loadGroupCollab, resetGroupCollabForChat } = useGroupCollabLoader({
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
    setWorkspaceForm(groupSlotMemory.form(activeChatId)) // 摩擦单 F29: as it was left in this chat, full too
    setShowHeaderMenu(false)
    setImportedHistoryState(EMPTY_IMPORTED_HISTORY_STATE)
    importedHistoryLoadRef.current += 1
    setSearchMode(false)
    setSearchQuery('')
    setQuoteText(null)
    isAtBottomRef.current = true
    // @@@2169/@@@group-collab-swr - invalidate 在途加载 + 取消后台重试 + 按 in-memory cache 重铺首帧,细节见 useGroupCollabLoader。
    resetGroupCollabForChat()
    setActiveMessageProfile(null)
    setWhisperTarget(null)
    readReceiptInFlightRef.current.clear()
    // @@@chat-open-nonce (#461) - also reset on mobile reopen of the SAME chat (openNonce bump), where
    // activeChatId is unchanged — so isAtBottomRef doesn't stay stale-false from a prior scroll-up.
  }, [activeChatId, isRoomChatSurface, openNonce, closeRightSurfaces, resetGroupCollabForChat])

  // @@@chat-open-nonce (#461) - reload on openNonce too, symmetric with the reset effect (which clears
  useEffect(() => {
    loadGroupCollab()
  }, [loadGroupCollab, openNonce])

  useEffect(() => {
    // @@@drawer-test-control - Private JSON-RPC smoke opens the same drawer surface without reintroducing broad DOM click RPC.
    const handleOpenDetailsDrawer = () => {
      if (activeChatId) handleOpenSettingsDrawer()
    }
    window.addEventListener(UI_EVENTS.openChatDetailsDrawer, handleOpenDetailsDrawer)
    return () => window.removeEventListener(UI_EVENTS.openChatDetailsDrawer, handleOpenDetailsDrawer)
  }, [activeChatId, handleOpenSettingsDrawer])

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

  // A chat's workspace (a group's, a topic's, a private chat's) is an App (真源 §2.4, 主人 09-29): the panel is its slot; the App lists,
  // opens and follows changes itself (gugu.files.*), so nothing about the files is held here.
  const handleOpenWorkspacePanel = useCallback(() => {
    if (!activeChatId) return
    closeRightSurfaces() // 同槽位互斥（#1312），含 群公告（#1485 review）
    setWorkspaceForm(workspaceForm === 'closed' ? 'side' : workspaceForm) // full stays full (a link opening a file in it)
  }, [activeChatId, closeRightSurfaces, workspaceForm])
  const handleCloseWorkspacePanel = useCallback(() => setWorkspaceForm('closed'), [])
  useEffect(() => groupSlotMemory.setForm(activeChatId, workspaceForm), [activeChatId, workspaceForm]) // 摩擦单 F29
  // 摩擦单 F10: a file of this chat asked for by a link (MainLayout brought the chat up): its panel opens on that file —
  // now, or as soon as this chat is the one shown.
  const [fileToOpen, setFileToOpen] = useState<FileToOpen | null>(null)
  const takeAskedFile = useCallback(() => {
    const asked = groupSlotMemory.takeFile(activeChatId)
    if (!activeChatId || !asked) return
    handleOpenWorkspacePanel()
    setFileToOpen({ chatId: activeChatId, ...asked, request: Date.now() })
  }, [activeChatId, handleOpenWorkspacePanel])
  useEffect(() => {
    takeAskedFile()
    window.addEventListener(UI_EVENTS.chatAsked, takeAskedFile)
    return () => window.removeEventListener(UI_EVENTS.chatAsked, takeAskedFile)
  }, [takeAskedFile])

  // 「在本群打开」(app-redesign §5): an App opened from this chat opens in its panel here — a private chat's too (主人 10-05).
  const appToOpen = useOpenApp(activeChat?.id ?? null, handleOpenWorkspacePanel)
  const workspaceSlot = activeChatId ? <GroupFolderSlot visible={surfaceVisible} onForward={handleForward} chatId={activeChatId} onClose={handleCloseWorkspacePanel} appToOpen={appToOpen} fileToOpen={fileToOpen} full={workspaceForm === 'full'} onToggleFull={() => setWorkspaceForm(workspaceForm === 'full' ? 'side' : 'full')} /> : null

  // @@@history (#957) — 历史面板：开启时加载消息附件；「线程」复用 store 的 threadSummaries。
  const loadHistoryFiles = useCallback(async (chatId: string) => {
    if (!user) return
    setHistoryFilesLoading(true)
    try {
      setHistoryFiles(await chatService.getChatFiles(chatId, user.id))
    } catch (err) {
      console.error('[ChatAreaPanel] loadHistoryFiles failed', err)
      setHistoryFiles([])
    } finally {
      setHistoryFilesLoading(false)
    }
  }, [user])

  const loadImportedHistories = useCallback(async (chatId: string) => {
    const requestId = ++importedHistoryLoadRef.current
    setImportedHistoryState({ chatId, histories: [], loading: true, error: null })
    try {
      if (!user?.id) throw new Error('loadImportedSessionHistories: authenticated owner is required')
      const histories = await loadImportedSessionHistories(chatId, user.id)
      if (importedHistoryLoadRef.current === requestId) {
        setImportedHistoryState({ chatId, histories, loading: false, error: null })
      }
    } catch (err) {
      console.error('[ChatAreaPanel] loadImportedHistories failed', err)
      if (importedHistoryLoadRef.current === requestId) {
        setImportedHistoryState({
          chatId,
          histories: [],
          loading: false,
          error: err instanceof Error ? err.message : t('chatArea.importedHistoryLoadFailed'),
        })
      }
    }
  }, [user?.id, t])

  const handleOpenHistoryPanel = useCallback((tab?: HistoryTab) => {
    if (!activeChatId) return
    closeRightSurfaces() // #1312 互斥，含 群公告（#1485 review）
    setHistoryOpenRequest((previous) => ({ tab, nonce: previous.nonce + 1 }))
    setHistoryPanelOpen(true)
    void loadHistoryFiles(activeChatId)   // 「Attachments」tab，群聊与私聊共享
    if (!isRoomChatSurface) void loadImportedHistories(activeChatId)
  }, [activeChatId, isRoomChatSurface, loadHistoryFiles, loadImportedHistories, closeRightSurfaces])

  useTopicsPanelRequest(activeChatId, openNonce, handleOpenHistoryPanel)
  const handleCloseHistoryPanel = useCallback(() => setHistoryPanelOpen(false), [])

  const topicSurface = useTopicSurface({
    chat: activeChat,
    userId: user?.id ?? null,
    closeRightSurfaces,
    subscribeAccountRevision,
    onCreateFailed: () => toast(t('topic.openFailed'), 'error'),
  })
  topicSurfaceRef.current = topicSurface
  // 渲染期收口:分栏开没开以 surface 为准(它自己是 subject-scoped 的),❌ 不靠副作用补一刀。
  if (topicSplitOpen !== Boolean(topicSurface.splitTopic)) setTopicSplitOpen(Boolean(topicSurface.splitTopic))
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
    openSplit({ chatId: request.chatId, name: request.name })
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
  // 判据(为什么不是直接取末尾)写在 latestTopicSourceIdOf 上 —— 放纯函数里才判得了真假。
  const latestMessageIdForTopic = useMemo(() => latestTopicSourceIdOf(messages), [messages])
  const agentFlood = useAgentFloodNotice(activeChatId, messages)
  const handleOpenMemberList = useCallback(() => {
    closeRightSurfaces()
    setMemberListOpen(true)
  }, [closeRightSurfaces])

  // @@@1503 — 原「切换聊天关历史/群 thread 面板」那个 reset effect 已并入上方主 reset 的
  // closeRightSurfaces()(history/分栏/成员列表都在 helper 内),reset 路径归一到单一 SSOT。

  const handleMessageVisible = useCallback((msg: MessageItem) => {
    if (!activeChatId || !user || !surfaceVisible) return // #6158 隐藏态不算「看见」;activeTab 进 deps ⇒ 切回时 MessageList 重建 IntersectionObserver,此刻在视口里的行才被数成已读
    // @@@1659 — 只标记「属于当前活动 chat」的消息已读。切 chat 时上一会话的行可能仍短暂挂载,其
    // IntersectionObserver 回调在 activeChatId 已切换后才 fire → 拿旧 chat 的消息去 markMessageRead(新chat, 旧msgId)
    // → DB `mark_message_read` 查无(WHERE id=msg AND chat_id=chat,msg.chat_id≠activeChatId)抛
    // 「message not found in chat」刷屏(#1659;失败时 in-flight 守卫被删 → 重试 → 反复 39×)。补 chat 归属前置
    // 不变量从源头消除——不对错 chat 发标记(非吞 warning,是 markMessageRead 本就要求消息属于该 chat)。
    if (msg.chat_id !== activeChatId) return
    markMessageVisible(msg)
    if (!msg.to_user_ids?.includes(user.id)) return
    if (msg.sender_user_id === user.id) return
    if (msg.delivery_status === 'read') return
    if (readReceiptInFlightRef.current.has(msg.id)) return
    readReceiptInFlightRef.current.add(msg.id)
    chatService.markMessageRead(activeChatId, msg.id, user.id).catch((err) => {
      readReceiptInFlightRef.current.delete(msg.id)
      // @@@1659 — even past the chat-ownership guard above, the RPC can still raise「message not found in
      // chat」: a read-after-write race where the message reached the client via realtime broadcast (so it
      // carries the active chat_id and the IntersectionObserver fires) BEFORE its row is visible to the
      // RPC's read. This self-heals — last_read_seq is a MONOTONIC watermark, so the next visible message
      // advances the read mark past this one regardless. Logging it as a warning is noise (it also trips
      // strict runtime-error guards under load); swallow only this transient, surface every real failure.
      const message = (err as Error)?.message ?? String(err)
      if (/not found in chat/i.test(message)) return
      console.warn('[ChatAreaPanel] markMessageRead failed', err)
    })
  }, [activeChatId, surfaceVisible, user, markMessageVisible])

  // @@@5856 话题分栏的已读由分栏自己那条线承担(它是一条真的 chat,走 store 常规已读路径),
  // 原「群 thread panel 无 IntersectionObserver ⇒ 手工补标已读」那段随面板一并退役。

  const handleQuote = useCallback((msg: MessageItem) => {
    setQuoteText({
      messageId: msg.id,
      senderName: msg.sender_user_id ? (identitiesById[msg.sender_user_id]?.display_name ?? '') : '',
      content: msg.content_type === 'attachment' ? t('chatArea.attachment') : ((card) => card ? t(card.type === 'task' ? 'message.taskCard.line' : 'message.taskCard.scheduleLine', { text: card.text }) : (msg.content ?? ''))(msg.content_type === 'card' ? parseComposerCard(msg.content) : null),
    })
  }, [identitiesById, t])

  // @@@multi-select (#988) - 退出多选模式（清空选中）。批量动作完成后或点「取消」时调用。
  const exitSelectMode = useCallback(() => { setSelectMode(false); setSelectedIds(new Set()) }, [])
  useBackLayer(exitSelectMode, mobile && selectMode) // 手机多选态:安卓返回键先退出多选,❌ 直接退回会话列表

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

  // @@@multi-select (#988) - 进入多选模式：从 More 菜单「多选」触发，预选触发的那条消息。
  const enterSelectMode = useCallback((msg: MessageItem) => {
    setSelectMode(true)
    setSelectedIds(new Set([msg.id]))
  }, [])

  const toggleSelect = useCallback((messageId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(messageId)) next.delete(messageId)
      else next.add(messageId)
      return next
    })
  }, [])

  // @@@multi-select (#988) - 批量转发：把选中的消息送进 ForwardMessageDialog（onForward 走 handleForwardTo 扇出）。
  const handleBatchForward = useCallback(() => {
    const selected = messages.filter((m) => selectedIds.has(m.id))
    if (selected.length === 0) return
    setForwardMessages(selected)
  }, [messages, selectedIds])

  // @@@multi-select (#988) - 批量删除：循环复用单条 deleteMessage（无批量 RPC），与单条删除同语义（不加额外确认）。
  const handleBatchDelete = useCallback(() => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    for (const id of ids) {
      deleteMessage(id).catch((err) => {
        console.error('[ChatAreaPanel] batch deleteMessage failed', id, err)
      })
    }
    exitSelectMode()
  }, [selectedIds, deleteMessage, exitSelectMode])

  // @@@multi-select (#988) - 切换会话即退出多选 + 清空选中：否则上一个会话的选中集泄露到新会话，
  // 批量删除会对旧会话的消息 id 调用 deleteMessage（误删非当前会话的消息）、批量转发也会扇出错对象。
  useEffect(() => {
    setSelectMode(false)
    setSelectedIds(new Set())
  }, [activeChatId])

  // Upload + insert each pending attachment as its own attachment-typed message,
  // in order. The realtime subscription picks up the inserts and merges them
  // into the active chat's message list, so they render right above the text
  // message that follows.
  // Defensive fix: verify message insert success, clean up orphaned storage on failure.
  // 群 thread attachment 仍通过 opts.threadRootId 落入对应话题，与 sendMessage 文本路径一致。
  const handleSendAttachments = useCallback(async (files: File[], opts: { toUserIds?: string[] | null; isWhisper?: boolean; caption?: string; threadRootId?: string | null; isThreadRoot?: boolean; onSent?: (file: File, index: number) => void } = {}): Promise<string | undefined> => {
    if (files.length === 0) return undefined
    // @@@2188 fail-loud:会话/登录态缺失时静默 return 会让 composer 走成功路清空从未发出的附件。
    if (!activeChatId || !user) throw new Error(t('composer.attachmentContextMissing'))
    // @@@attachment-dm-recipient (#cleanse) - resolve DM peer recipient (parity with sendMessage):
    // a DM attachment must route to the peer, not leave to_user_ids NULL → 0 deliver commands.
    const explicitToUserIds = opts.toUserIds?.length ? opts.toUserIds : null
    // @@@attachment-ai-recipient - match sendMessage: resolve peer for 'dm' AND 'ai' (agent chats).
    // Agent chats (kind 'ai') are the PRIMARY attachment-delivery case (sending files TO an agent).
    const toUserIds =
      explicitToUserIds ??
      ((activeChat?.kind === 'dm' || activeChat?.kind === 'ai')
        ? (activeChat?.peer_user_id ? [activeChat.peer_user_id] : null)
        : null)
    // 与文字发送同一条规矩(C3):发送把窗口钉回底部,占位气泡和确认行才落在看得见的尾巴上。
    if (!opts.threadRootId) {
      if (messageWindow?.hasNewer) await returnToLatestMessages()
      else setFollowingTail(true)
    }
    // @@@2188 并发上传、按序 insert→验证→onSent 回报提交、任一件失败即 fail-loud 的批执行器(抽出模块)。
    return sendAttachmentBatch({
      files, chatId: activeChatId, senderId: user.id, toUserIds,
      isWhisper: opts.isWhisper, threadRootId: opts.threadRootId, isThreadRoot: opts.isThreadRoot,
      caption: opts.caption, onSent: opts.onSent, appendMessage, removePlaceholder: removeMessage,
    })
  }, [activeChatId, user, appendMessage, removeMessage, messageWindow?.hasNewer, returnToLatestMessages, setFollowingTail, activeChat?.kind, activeChat?.peer_user_id, t])

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

  // Focus search input when entering search mode
  useEffect(() => {
    if (searchMode) setTimeout(() => searchInputRef.current?.focus(), 50)
  }, [searchMode])

  // @@@alt-f-search - Alt+F opens message search for the active chat. Use event.code (layout-
  // independent) since macOS Alt+F emits 'ƒ' as event.key.
  useEffect(() => {
    if (!activeChatId || !surfaceVisible) return // #6158 面板在别的 tab 上是隐藏不是卸载,全局快捷键不能替隐藏的它接
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.altKey && event.code === 'KeyF' && !event.metaKey && !event.ctrlKey && isChatSearchTarget(surfaceElement.current, activeChatId)) {
        event.preventDefault()
        setSearchQuery('')
        setSearchMode(true)
      }
    }
    const openSearch = (event: Event) => { const target = (event as CustomEvent<{ chatId?: string }>).detail?.chatId; if (target && target !== activeChatId) return; setSearchQuery(''); setSearchMode(true) }
    window.addEventListener('keydown', handleKeyDown); window.addEventListener(UI_EVENTS.openChatSearch, openSearch)
    return () => { window.removeEventListener('keydown', handleKeyDown); window.removeEventListener(UI_EVENTS.openChatSearch, openSearch) }
  }, [activeChatId, surfaceVisible])

  // @@@search-filtering - "search is open" (searchMode) is not the same as "the list is filtered".
  const isFiltering = searchMode && !!searchQuery.trim()

  // @@@chat-view-window (#461) - the normal (non-search) list renders the full in-memory window (the store
  // already bounds `messages` to MAX_WINDOW; MessageList lays the whole window out as document flow). An
  // earlier manual tail-slice (messages.slice(-visibleCount)) fought the then-virtualized list's anchoring:
  // every end-append slid the slice and bumped firstItemIndex, re-anchoring the viewport (see #780).
  const displayedMessages =
    isFiltering
      ? messages.filter((m) =>
          !m.retracted_at &&
          m.content_type !== 'attachment' &&
          (m.content ?? '').toLowerCase().includes(searchQuery.toLowerCase()),
        )
      : messages
  const { rows: chatListRows, listedMessages, notice: taskChatNotice, threeParty } = useTaskChatRows(displayedMessages, user?.id, activeChat?.peer_user_id, surfaceVisible, isFiltering ? searchQuery : '')
  const chatResetKey = `${activeChatId ?? ''}#${openNonce ?? 0}#${messageWindow?.viewVersion ?? 0}`
  const { scrollerEl, scrollerRef, setScrollerRef, prepareForSavedPosition, isPreservingPosition, forgetSavedPosition, openLocation, revealMessage } = useConversationScrollMemory({
    chatId: activeChatId, activationKey: activeChatId ?? '', enabled: !isFiltering, discardSaved: !!unreadEntry,
    messageIds: chatListRows.map((row) => row.message.id), isAtBottomRef, setFollowingTail, loadMessageAnchor,
  })
  const onHistoryError = useCallback((error: unknown) => toast(error instanceof Error ? error.message : String(error), 'error'), [toast])
  const { viewportAtBottom, onAtBottomChange } = useFollowingTail({ resetKey: chatResetKey, unreadNavigationPending: !!unreadNavigationPending, hasNewer: !!messageWindow?.hasNewer, loading: !!messageWindow?.loading, isPreservingPosition, isAtBottomRef, setFollowingTail })
  const firstItemIndex = useChatHistoryPagination({ resetKey: chatResetKey, messages, enabled: !isFiltering && !unreadNavigationPending, scroller: scrollerEl, atBottom: viewportAtBottom, loadOlder: loadOlderMessages, loadNewer: loadNewerMessages, window: messageWindow, onError: onHistoryError })

  // #1708 来源消息(群右栏工作区 App 的 gugu.showMessage):不在加载段里的先按锚点载进来,再定位 + 闪烁;载不到 → fail-loud toast。
  useSourceMessageReveal({ activeChatId, rows: chatListRows, listRef, isAtBottomRef, setFollowingTail, setFlashMessageId, flashTimerRef, revealMessage, onMissing: () => toast(t('chatArea.source.notVisible'), 'error') })
  useUnreadLocatorNavigation({activeChatId, rows: chatListRows, firstItemIndex, listRef, setFollowingTail: (following) => { isAtBottomRef.current = following; setFollowingTail(following) }, setFlashMessageId, flashTimerRef, hasMoreOlder, loadingOlder, loadOlderMessages, hasMoreNewer: messageWindow?.hasNewer, loadingNewer: messageWindow?.loading === 'newer', loadNewerMessages})
  // @@@5856 历史面板的「话题」tab —— 这条线上长出来的全部话题。
  // spec 的两个打开口之一就是「某条线顶栏的话题面板」;它读的与锚点卡是同一个数据源
  // (chat.list_topics_of_chat),两处不会各说各话。
  const historyTopics = useMemo<HistoryTopicItem[]>(() => topicSurface.topics.map((topic) => ({
    chatId: topic.chat_id,
    title: topic.name,
    participantCount: topic.participant_count,
    messageCount: topic.message_count,
    lastMessageAt: topic.last_message_at,
    isParticipant: topic.is_participant,
  })), [topicSurface.topics])
  const historyFileItems = useMemo<HistoryFileItem[]>(() => historyFiles.map((file) => file), [historyFiles])
  const visibleImportedHistoryState = importedHistoryState.chatId === activeChatId
    ? importedHistoryState
    : null

  if (fiResetChatRef.current !== chatResetKey) {
    fiResetChatRef.current = chatResetKey
    baselineRef.current = true
  }

  // @@@touch-bottom (#781 followup) - the old virtualized list's autoscrollToBottom under-shot on some
  // platforms: it left scrollTop short of (scrollHeight - clientHeight), so after EVERY pin (send /
  // open / new-msg button) the user can still scroll down a bit — "没触底", functional not visual. Set
  // scrollTop to the DOM truth directly. Synchronous, NOT a rAF/setTimeout: the pin paths (track effect
  // / button / #780 resize) all run AFTER the list's layout pass, so scrollHeight already reflects the
  // new content. Gated on isAtBottomRef so it never fights a deliberate scroll-up (user scrolled up ⇒
  // atBottomStateChange flips isAtBottomRef false ⇒ no-op). Single authoritative set — no layered timers.
  const clampToTrueBottom = useCallback(() => {
    const el = scrollerRef.current // @@@scroller-out-of-closures:闭包只读 ref,❌ 捕获 scrollerEl
    if (!el || isPreservingPosition() || !isAtBottomRef.current) return
    el.scrollTop = el.scrollHeight
  }, [scrollerRef, isPreservingPosition])

  const pinToBottom = useCallback(() => {
    forgetSavedPosition()
    // 已在回最新页(比如发送动作刚在 store 里发起)⇒ 不重开一次:重开会作废在途那次、白跑一趟。
    if (messageWindow?.hasNewer) { if (messageWindow.loading !== 'latest') void returnToLatestMessages().catch(onHistoryError); return }
    isAtBottomRef.current = true
    listRef.current?.autoscrollToBottom()
    clampToTrueBottom()
  }, [listRef, clampToTrueBottom, messageWindow?.hasNewer, messageWindow?.loading, returnToLatestMessages, onHistoryError, forgetSavedPosition])
  // #1315 — `scrollToBottom` (autoscroll+clamp WITHOUT setting isAtBottomRef first) was removed: its only
  // caller, the unread-bubble onClick, left the clamp gated-out (isAtBottomRef still false at click time)
  // and stopped ~80px short. The bubble now calls pinToBottom, which orders the flag before the clamp.

  // @@@scroll-bottom-resize (#780) - keep pinned to the bottom when the viewport shrinks shortly after open
  // (e.g. the async group-collab avatar bar renders and reduces the list height, leaving the initial pin
  // short of the true bottom). Re-pins ONLY while the user is already at the bottom, so it never fights a
  // deliberate scroll-up. autoscrollToBottom changes scrollTop, not clientHeight, so no feedback loop.
  // Depends on scrollerEl so it (re)attaches once MessageList actually mounts the scroller (gated behind
  // !loadingMessages), not just on this panel's first mount.
  useEffect(() => {
    const scroller = scrollerRef.current; if (!scroller) return
    let prevH = scroller.clientHeight
    const ro = new ResizeObserver(() => {
      const h = scroller.clientHeight
      if (h !== prevH) {
        prevH = h
        if (!isPreservingPosition() && isAtBottomRef.current) {
          listRef.current?.autoscrollToBottom()
          clampToTrueBottom()
        }
      }
    })
    ro.observe(scroller)
    return () => ro.disconnect()
  }, [scrollerEl, scrollerRef, clampToTrueBottom, isPreservingPosition])

  useEffect(() => {
    if (isFiltering || unreadNavigationPending) return
    const feed = listedMessages
    const firstId = feed.length ? feed[0].id : null
    const lastId = feed.length ? feed[feed.length - 1].id : null
    if (baselineRef.current) {
      if (feed.length === 0) return
      baselineRef.current = false
      lastTrackRef.current = { firstId, lastId }
      lastNavigationRef.current = messageWindow?.navigationVersion ?? 0
      if (messageWindow?.navigation === 'anchor') return
      if (prepareForSavedPosition()) return
      pinToBottom()
      return
    }
    // @@@1315 — one authoritative IM-scroll decision per window change (see scrollControl.ts):
    //   • at bottom → new message (mine OR received) snaps to the true bottom (symptom: 收到他人消息差一截)
    //   • scrolled up + received → unread bubble, no yank
    // Prepend index updates belong to useChatHistoryPagination, in the same render as the rows.
    const navigated = lastNavigationRef.current !== (messageWindow?.navigationVersion ?? 0)
    lastNavigationRef.current = messageWindow?.navigationVersion ?? 0
    if (navigated && (messageWindow?.navigation === 'older' || messageWindow?.navigation === 'newer' || messageWindow?.navigation === 'anchor')) { lastTrackRef.current = { firstId, lastId }; return }
    if (navigated && messageWindow?.navigation === 'latest') { pinToBottom(); lastTrackRef.current = { firstId, lastId }; return }
    // 往上翻时到的消息不在这里计数:窗口自己数(newMessageCount),它也数到被截在窗口外的行。
    if (classifyFeedChange(lastTrackRef.current, feed, isAtBottomRef.current).pin) pinToBottom()
    lastTrackRef.current = { firstId, lastId }
  }, [listedMessages, isFiltering, unreadNavigationPending, pinToBottom, prepareForSavedPosition, messageWindow?.navigationVersion, messageWindow?.navigation])

  const handleReaction = useCallback(
    (messageId: string, emoji: string) => {
      void toggleReaction(messageId, emoji).catch(() => toast(t('chatArea.operationFailed'), 'error')) // #1859 fire-and-forget 补 catch
    },
    [toggleReaction, toast, t],
  )

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
    onQuote: handleQuote,
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
    handleQuote,
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
      {(!chrome || searchMode) && <PaneHeader
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
        actions={searchMode ? null : (
          <>
            <ChatHeaderActions
              isGroupChat={isGroupChat}
              isRoomChat={isRoomChatSurface}
              searchMode={searchMode}
              workspacePanelOpen={workspaceForm !== 'closed'}
              memberListOpen={memberListOpen}
              historyPanelOpen={historyPanelOpen}
              showHeaderMenu={showHeaderMenu}
              mobile={mobile} modeButton={sessionpageAgent.openAction !== null}
              moreButtonRef={moreButtonRef}
              onEnterSearchMode={() => setSearchMode(true)}
              onOpenWorkspacePanel={handleOpenWorkspacePanel}
              onCloseWorkspacePanel={handleCloseWorkspacePanel}
              onOpenSettingsDrawer={handleOpenSettingsDrawer}
              onOpenMemberList={handleOpenMemberList}
              onCloseRightSurfaces={closeRightSurfaces}
              onOpenHistoryPanel={handleOpenHistoryPanel}
              onCloseHistoryPanel={handleCloseHistoryPanel}
              onToggleHeaderMenu={() => setShowHeaderMenu((v) => !v)}
              onCloseHeaderMenu={() => setShowHeaderMenu(false)}
              onOpenAnnouncement={handleOpenAnnounce}
            />
            {sessionpageAgent.openAction}
          </>
        )}
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
              <SearchField
                ref={searchInputRef}
                className="flex-1"
                data-testid={AUTOMATION_TEST_IDS.chatHeaderSearchInput}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => event.key === 'Escape' && (setSearchMode(false), setSearchQuery(''))}
                placeholder={t('chatArea.searchMessages')}
              />
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0"
                data-testid={AUTOMATION_TEST_IDS.chatHeaderSearchCancelButton}
                onClick={() => { setSearchMode(false); setSearchQuery('') }}
              >
                {t('common.cancel')}
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </PaneHeader>}

      <div
        ref={attachPanelsRow}
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        {/* @@@1572/2234 中栏地板(useMessageColumnMinWidth:有右栏且行宽 < 380+360 时让位,右栏不被裁;否则 380;mobile→0)挂在分栏根上。工作区开着时
            地板归分栏(左栏至少 240):它和会话页右栏是同一个分栏(SidePanelSplit:开合、全屏、拖宽)。手机上工作区是整页,在下面。 */}
        <SidePanelSplit form={mobile ? 'closed' : workspaceForm} resizeLabel={t('chatArea.openWith.resize')} widths={GROUP_PANEL_WIDTHS} unmountWhenClosed onCollapseWorkspace={handleCloseWorkspacePanel}
          className="flex-1" chatMinWidth={workspaceForm === 'closed' ? messageColumnMinWidth : 0} workspacePanel={workspaceSlot} chatColumn={
        <div
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
          initialTopMostItemIndex={openLocation()} topInset={agentHero && !mobile && isAgentHeroBird(activeChatAvatar) ? AGENT_HERO_OVERHANG_PX : 0}
          followTail={!unreadNavigationPending && !messageWindow?.hasNewer && messageWindow?.change !== 'newer'} unreadAbove={unreadEntry ? { messageId: unreadEntry.locator.message_id, messageSeq: unreadEntry.locator.message_seq, label: t('chatArea.unreadAbove', { count: unreadEntry.locator.unread_count }), onJump: () => void jumpToUnreadEntry().catch(onHistoryError) } : null}
          onAtBottomChange={onAtBottomChange}
          // 打开会话时的初始 pin 发生在最后一条消息完成布局之前（markdown/代码块/字体异步撑高），
          // 内容随后长高但 clientHeight 不变 → #780 的 ResizeObserver（只看视口高）不触发，
          // 最后一条消息被裁在容器外只剩一条边。总列表高度一变就重新钳底。
          // 除 isAtBottomRef 门控外再加实测几何门：快速上滚到顶时 ref 会 stale-true
          // 此刻 revealOlder prepend 旧页也会改变总高，
          // 无几何门会把用户刚滚上去的视口拽回底部。距底 >400px 视为主动离底，不钳。
          // rAF：该回调可能先于 DOM 布局提交触发（同步读 scrollHeight 拿旧值，实测钳完仍差 ~22px）。
          onTotalListHeightChanged={() => {
            requestAnimationFrame(() => {
              const el = scrollerRef.current
              if (!el || isPreservingPosition() || !isAtBottomRef.current) return
              if (el.scrollHeight - el.clientHeight - el.scrollTop > 400) return
              el.scrollTop = el.scrollHeight
            })
          }}
        />
      )}

      {/* New message count bubble */}
      {((messageWindow?.newMessageCount ?? 0) > 0 || messageWindow?.hasNewer) && !searchMode && (
        <div
          onClick={() => {
            // #1315 — use pinToBottom (NOT scrollToBottom): it sets isAtBottomRef.current=true BEFORE
            // autoscroll+clamp. clampToTrueBottom is gated on isAtBottomRef; the bubble is clicked from the
            // scrolled-up state (isAtBottomRef=false), so calling scrollToBottom first + setting the flag
            // after left the clamp gated-out → stuck ~80px short ("差一截" on the bubble-click path,
            // caught by the chat-scroll-im-1315 e2e). pinToBottom orders it correctly → true bottom.
            pinToBottom()
          }}
          style={{
            position: 'absolute',
            bottom: '180px',
            left: '50%',
            transform: 'translateX(-50%)',
            background: COLOR_ACCENT,
            color: COLOR_ON_ACCENT,
            padding: '4px 14px',
            borderRadius: 'var(--radius-xl)',
            fontSize: 'var(--font-caption)',
            cursor: 'pointer',
            zIndex: 'var(--z-float)',
            boxShadow: 'var(--shadow-lift)', // @@@shadow-lift (Refs #6105) 真浮层,走唯一那一档(--shadow-card 已随阴影清零删掉)
            whiteSpace: 'nowrap',
            userSelect: 'none',
          }}
        >
          {(messageWindow?.newMessageCount ?? 0) > 0 ? t('chatArea.newMessages', { count: messageWindow!.newMessageCount }) : t('chatArea.returnToLatest')}
        </div>
      )}

      {/* @@@1506 - Agent 运行状态：统一为输入框上方的轻量浮动文字（owner #1506：无重白板，打字时也能瞥见）。
          它是消息列表与输入区之间的 flexShrink:0 兄弟（不浮在消息列表上 → 不重蹈 #649/#1343 的 overlay
          「差一截」错觉），出现/消失改 scroller clientHeight → #780 ResizeObserver 自动重 pin 到真底。
          · 群聊：GroupAgentStatusBar 列出在执行的 agent（可点 → @mention），去底色后即浮动文字。
          · 单聊：运行中/思考中从消息列表行（#1102 in-list）移到这里；流式正文仍留消息流。 */}
      {!searchMode && !chrome?.hideRunningStatus && (isRoomChatSurface ? (
        // @@@1696 群聊运行态：横排单行「运行 token」(流光动词) + cap +N。数据 = 在跑(transient)的 agent，
        // stateKey 由 presence recentActions 的最新 kind 派生，展示文案由 RunningTokenBar 翻译；
        // toolCount 近似用近 5 分钟 actions.length。onTokenClick 仍 @mention。
        <RunningTokenBar
          testId="group-agent-running-status"
          cap={GROUP_AGENT_BAR_MAX}
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
          cap={1}
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
      ) : null)}
      {/* #2115 — 普通 ACP 回合终态失败条（运行条同槽位;重试=CAS error→pending 重排原命令,详见 Slot）。 */}
      {!searchMode && <AgentConversationNoticeSlot sessionpageNotices={sessionpageAgent.sessionpageNotices} failureExplained={sessionpageAgent.failureExplained} chatId={activeChatId} threadRootId={threadScope.rootId} profiles={messageMemberProfiles} />}
      {/* Input area — white card with rounded border floating in gray.
          @@@multi-select (#988) — 多选态用底部批量操作条替换输入框（同槽位 + 同 --bg-primary 外壳）。 */}
      {selectMode ? (
        // @@@1323-m4 item4 多选态批量条与 composer「同槽位+同外壳」→ padding 同步对标 SSOT `.comp`(12/22/18),否则切多选态槽位抖。
        <div style={{ background: 'var(--bg-primary)', padding: mobile ? '10px 8px max(8px, env(safe-area-inset-bottom))' : '12px 22px 18px', flexShrink: 0 }}>
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
        // @@@1323-m4 item4 composer 外层 padding 对标 SSOT `.comp{padding:12px 22px 18px}`（#1330 deferred 此项,#1327 合后补）。
        // 桌面左右 22 给输入区呼吸感;mobile 保窄边+安全区,顶部 hairline 与消息区分界(@@@1787 视觉验收:原先浮空无边界)。
        <div data-chat-composer="" style={{ background: 'var(--bg-primary)', padding: mobile ? '8px 10px max(10px, env(safe-area-inset-bottom))' : '12px 22px 18px', borderTop: mobile ? '1px solid var(--border-subtle)' : undefined, flexShrink: 0 }}>
        {/* #1099: offline「唤醒 Agent」状态栏已删(ACP 发消息即触达自启)。removed 显提示栏。 */}
        {/* agent 会话 composer 通知区：已注销 Agent 的禁用说明。 */}
        {isAgentChat ? <AgentComposerNotices disabledReason={agentComposerDisabled ? (agentComposerDisabledReason ?? null) : null} agentUserId={activeChat?.peer_user_id ?? null} agentName={activeChatName} /> : null}
        <InputArea
          beforeSend={createSessionpageChatSendPreflight(isAgentChat, activeChat?.peer_user_id, t('agent.taskpage.recoveryFailed.unknown'))}
          onSend={async (content, opts) => {
            await sendMessage(content, opts)
          }}
          placeholder={agentComposerPlaceholder ?? chrome?.placeholder} attachGlyph={chrome?.attachGlyph} attachMenu={chrome?.attachMenu}
          onSendAttachments={async (files, opts) => {
            await handleSendAttachments(files, opts)
          }}
          quoteContent={quoteText}
          onQuoteConsumed={() => setQuoteText(null)}
          mentionToInsert={mentionToInsert}
          onMentionInserted={() => setMentionToInsert(null)}
          chatId={activeChatId} hidden={!surfaceVisible}
          isGroupChat={isRoomChatSurface}
          groupMembers={composerGroupMembers} currentUserId={user?.id ?? null} agentStatuses={groupAgentStatuses}
          disabled={agentComposerDisabled}
          disabledReason={agentComposerDisabledReason}
          whisperTarget={whisperTarget}
          onExitWhisper={() => setWhisperTarget(null)}
        />
      </div>
      )}


          {/* @@@1145 点 Agent 名 → Agent 设置面板(替旧右侧会话资料抽屉)。 */}
          {showAgentSettings && agentChatContact ? (
            <AgentSettingsModal agent={agentChatContact} onClose={() => setShowAgentSettings(false)} />
          ) : null}

        </div>
        } />

        {/* 历史与其他右侧面板互斥;关闭即时卸载,避免退场后消息列跳宽。 */}
        <AnimatePresence>
          {historyPanelOpen && (
            <RightPanel key="history-panel" width={330} onClose={handleCloseHistoryPanel}>
              {isGroupChat ? (
                <HistoryPanel
                  key={`${activeChatId}:${historyOpenRequest.nonce}`}
                  initialTab={historyOpenRequest.tab}
                  mode="group"
                  mobile={mobile}
                  topics={historyTopics}
                  attachments={historyFileItems}
                  loading={historyFilesLoading}
                  onOpenTopic={(chatId, title) => {
                    setHistoryPanelOpen(false)
                    topicSurface.openSplit({ chatId, name: title })
                  }}
                  onCreateTopic={latestMessageIdForTopic ? () => {
                    setHistoryPanelOpen(false)
                    void topicSurface.openTopicFromMessage(latestMessageIdForTopic)
                  } : undefined}
                  onOpenFile={(f) => {
                    if (f.kind === 'image') void openAttachmentImage(f.source, f.fileName).catch(() => toast(t('chatArea.downloadFailed'), 'error'))
                    else openFilePreview(f)
                  }}
                  onDownloadFile={(f) => {
                    void downloadAttachment(f.source, f.fileName).catch(() => toast(t('chatArea.downloadFailed'), 'error'))
                  }}
                  onClose={handleCloseHistoryPanel}
                />
              /* @@@5856 这里曾有一支「话题的附件面板」。全宽形态拿掉之后主区永远不是一条话题,
                 那一支走不到 ⇒ 删;话题自己的附件由分栏那颗 🕐 开(TopicSplitPane,同一支 mode="topic")。 */
              ) : (
                <HistoryPanel
                  key={`${activeChatId}:${historyOpenRequest.nonce}`}
                  initialTab={historyOpenRequest.tab}
                  mode="private"
                  mobile={mobile}
                  attachments={historyFileItems}
                  topics={historyTopics}
                  onOpenTopic={(chatId, title) => {
                    setHistoryPanelOpen(false)
                    topicSurface.openSplit({ chatId, name: title })
                  }}
                  onCreateTopic={latestMessageIdForTopic ? () => {
                    setHistoryPanelOpen(false)
                    void topicSurface.openTopicFromMessage(latestMessageIdForTopic)
                  } : undefined}
                  importedHistory={(
                    <ImportedHistoryPanel
                      histories={visibleImportedHistoryState?.histories ?? []}
                      loading={visibleImportedHistoryState?.loading ?? true}
                      error={visibleImportedHistoryState?.error ?? null}
                    />
                  )}
                  loading={historyFilesLoading}
                  onOpenFile={(file) => {
                    if (file.kind === 'image') void openAttachmentImage(file.source, file.fileName).catch(() => toast(t('chatArea.downloadFailed'), 'error'))
                    else openFilePreview(file)
                  }}
                  onDownloadFile={(file) => {
                    void downloadAttachment(file.source, file.fileName).catch(() => toast(t('chatArea.downloadFailed'), 'error'))
                  }}
                  onClose={handleCloseHistoryPanel}
                />
              )}
            </RightPanel>
          )}
        </AnimatePresence>

        {/* The workspace on the phone: a whole page. No onClose on the shell: the slot keeps its own back layer (a file opened over it first, then the panel). */}
        <AnimatePresence>{mobile && workspaceForm !== 'closed' && <RightPanel key="workspace-panel">{workspaceSlot}</RightPanel>}</AnimatePresence>

        {filePreview.panel}

        {/* 会话/群设置、群公告:与成员列表同一个右栏外壳(RightPanel),同槽位互斥。 */}
        <AnimatePresence>
          {showDrawer && (
            <ChatSettingsPanel
              activeChat={activeChat}
              messages={messages}
              onClose={() => setShowDrawer(false)}
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
              onWhisper={isGroupChat ? (target) => {
                setShowDrawer(false)
                setWhisperTarget({ userId: target.id, displayName: target.displayName })
              } : undefined}
              groupCollabSnapshot={groupCollabSnapshot}
              groupAgentStatuses={groupAgentStatuses}
              onReloadGroupCollab={loadGroupCollab}
              onLeaveGroup={() => leaveGroup(activeChat.id)}
              onDissolveGroup={() => deleteChat(activeChat.id, true)}
              mobile={mobile}
            />
          )}
        </AnimatePresence>
        {/* 从页头 ⋯ 开的群公告 / 👥 开的名册没有上一层:页头与群设置同一个,桌面 ⊗、手机左上返回 = 关。
            返回键由页头接(SettingsPageHead),外壳不再接一次。从群设置里点进去的那两页在设置栈里(GroupMembersSection)。 */}
        {isGroupChat && showAnnounce ? (
          <RightPanel>
            <AnnouncementDrawer
              chatId={activeChat.id}
              isAdmin={isGroupManagerRole(groupCollabSnapshot.humans.find((h) => h.id === user?.id)?.role)}
              head={(title) => <SettingsPageHead title={title} onClose={() => setShowAnnounce(false)} mobile={mobile} />}
            />
          </RightPanel>
        ) : null}

        {/* @@@5856 话题分栏 —— 来源那条线留在左边继续能看能发,话题在右边独立收发。
            它取代了原来的群 thread 面板:那是同一个 chat 里的过滤视图,这是**另一条线**。
            与 workspace/history/成员列表 同槽位互斥(统一走 closeRightSurfaces)。 */}
        {/* @@@5856 成员列表 —— 头栏 👥 的落点。群与话题同一个面板:两者都有自己的成员名单,
            话题的那份可以比来源窄。与工作区/历史/话题分栏 同槽位互斥。 */}
        {memberListOpen && isRoomChatSurface && activeChatId && activeChat && (
          <RightPanel>
            <MemberListPanel
              chatId={activeChatId}
              chatKind={activeChat.kind === 'topic' ? 'topic' : 'group'}
              head={(title, actions) => <SettingsPageHead title={title} action={actions} onClose={() => setMemberListOpen(false)} mobile={mobile} />}
              chatName={activeChat.name}
              onMembersChanged={loadGroupCollab}
              onOpenUserChat={onOpenUserChat}
              onWhisper={(target) => setWhisperTarget({ userId: target.id, displayName: target.displayName })}
            />
          </RightPanel>
        )}

        {topicSurface.splitTopic && (
          <TopicSplitPane
            topic={topicSurface.splitTopic}
            messages={topicSurface.splitMessages}
            loading={topicSurface.splitLoading}
            memberProfiles={messageMemberProfiles}
            visibleChats={chats}
            sourceMessagePreview={topicSourceMessagePreview}
            focusComposerToken={splitFocusToken}
            memberReadSeqs={topicSurface.splitMemberReadSeqs}
            onOpenFile={(file) => {
              if (file.kind === 'image') void openAttachmentImage(file.source, file.fileName).catch(() => toast(t('chatArea.downloadFailed'), 'error'))
              else { const split = topicSurface.splitTopic; openFilePreview(file, undefined, split ? () => topicSurface.openSplit(split) : undefined) }
            }}
            onDownloadFile={(file) => {
              void downloadAttachment(file.source, file.fileName).catch(() => toast(t('chatArea.downloadFailed'), 'error'))
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
            onOpenAttachment={(file, message) => { const split = topicSurface.splitTopic; openFilePreview(file, message, split ? () => topicSurface.openSplit(split) : undefined) }} onRevealOlder={() => { void topicSurface.revealOlderInSplit() }}
            onClose={topicSurface.closeSplit}
            currentUserId={user?.id ?? null}
            mobile={mobile}
            // 分栏的表情/删除**等写入落库**再重验证这一栏(主线那两个 handler 是 fire-and-forget,同一 tick 重读
            // 必拿旧快照;修订回来时线级实时还会再落一次,这一下只是不等它,#6470)。❌ 不用 store 的 toggleReaction:
            // 它按 activeChatId 整体重拉并 trim 主线窗口。❌ 也不许 `user?.id ?? ''`。
            onReaction={(id, emoji) => { if (!user) return
              void chatService.toggleReaction(id, user.id, emoji).then(() => topicSurface.refreshSplit())
                .catch(() => toast(t('chatArea.operationFailed'), 'error')) }}
            onForward={handleForward} visible={surfaceVisible}
            onDelete={(id) => void deleteMessage(id)
              .then(() => topicSurface.refreshSplit())
              .catch(() => toast(t('chatArea.operationFailed'), 'error'))}
          />
        )}

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
