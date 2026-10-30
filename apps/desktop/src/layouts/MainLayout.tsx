import { messageForUser } from '@/lib/userFacingError';
import type { AgentAttention } from '@gugu/core/shared/agentStatus'
import { notify } from '../lib/notices'
import { Sheet } from '../components/ui/Sheet'
import { PaneHeader } from '../components/ui/Pane'
import { RightPanelBackButton } from '../components/chat/RightPanel'
import { SessionAppFrame } from '../components/appSlot/SessionAppFrame'
import { installedExtensionsStore } from '../session/renderer/features/extensions/installed-extensions-store'
import { ResourceMonitorHost } from '@/session/renderer/features/settings/components/resource-monitor-host'
import { reaction } from 'mobx'
import { useCallback, useState, useEffect, useLayoutEffect, useRef } from 'react'
import '@/styles/desktop-shell.css'
import '@/session/renderer/features/assistant/assistant-today.css'
import '@/mobile/phone-shell.css'
import '@/mobile/phone-look.css'
import { usePhoneViewport } from '@/mobile/usePhoneViewport'
import { PhoneTabBar as MobileTabBar } from '@/mobile/PhoneTabBar'
import { Sidebar } from '../components/Sidebar'
import { returnToScreen } from '@/session/renderer/app/screen-layout-actions'
import { registeredViews } from '@/session/renderer/lib/layout/registered-views'
import { UpdateBanner } from '../components/UpdateBanner'
import { WindowControls } from '../components/WindowControls'
import { LowBalanceBanner } from '../components/LowBalanceBanner'
import { MOBILE_TABS, SIDEBAR_TABS, type SidebarTab } from '@gugu/core/shared/enums/sidebarTabModels'
import { AgentWatchPage, AgentWatchRoot } from '@/mobile/agent-watch/AgentWatchPage'
import { PhoneDeviceRoot } from '@/mobile/phone-device/PhoneDeviceRoot'
import { useAppShowSession } from '@/mobile/agent-watch/useAppShowSession'
import { translateSessionMessage } from '@/session/renderer/localization/locale-store'
import { MobileTabPager } from '@/mobile/MobileTabPager'
import { navigateMobile } from '@/mobile/navigateMobile'
import { PhoneLayer } from '@/mobile/PhoneLayer'
import { PhoneMeButton } from '@/mobile/PhoneMeButton'
import { PhonePartnersPage } from '@/mobile/partners/PhonePartnersPage'
import { useReportChatOnScreen } from '@/lib/onScreenChat'
import { useLinkNavigation } from '../hooks/useLinkNavigation'
import { readAssistantShellBridge } from '../lib/assistantShellBridge'
import { ChatListPanel } from '../components/ChatListPanel'
import { ChatAreaPanel } from '../components/ChatAreaPanel'
import type { MemberProfileChatTarget } from '../components/MemberProfileCard'
import { ContactsPanel } from '../components/ContactsPanel'
import { SettingsPanel } from '../components/SettingsPanel'
import { isSheetOpen, NATIVE_BACK_EVENT, useBackLayer } from '../components/ui/sheetStack'
import { EmdashSessionFrame, prewarmEmdashAssets } from '../components/sessionpage/EmdashSessionFrame'
import { useSessionpageAgentInstallNavigation } from '../components/sessionpage/sessionpageAgentInstallNavigation'
import { useOpenNewSessionOnDeviceHost } from '../components/sessionpage/openNewSessionOnDeviceHost'
import { MobileCreatePage } from '../components/MobileAgentCreatePage'
import { AcpAgentCreateComposer } from '../components/AcpAgentCreateComposer'
import type { ActiveSection } from '@gugu/core/shared/enums/settingsSectionModels'
import { ResizableChatListPane } from './ResizableChatListPane'
import {
  readStoredChatListPaneWidth,
  writeStoredChatListPaneWidth,
} from './ResizableChatListPaneStorage'
import { AuthUser } from '../store/auth'
import { useChatStore } from '../store/chatContext'
import { SearchIndexWiring } from '../store/searchIndexWiring'
import { sendAttachmentBatch } from '../components/chat/sendAttachmentBatch'
import { SharePosterDialog } from '../components/SharePosterDialog'
import { ExtensionConsentSheet } from '../components/extensionBundle/ExtensionConsentSheet'
import { ExtensionForwardHost } from '../components/extensionBundle/ExtensionForwardHost'
import { useSessionpageReveal } from '../hooks/useSessionpageReveal'
import { useOwnedAgentConversationEntry } from '../hooks/useOwnedAgentConversationEntry'
import { SessionInputOutboxHost } from '../hooks/useSessionInputOutbox'
import { NeedsYouHost } from '../components/needsYou/NeedsYouHost'
import { NeedsYouSlot } from '../components/needsYou/NeedsYouSlot'
import { AgentSharePopover } from '../components/sessionpage/AgentSharePopover'
import { SESSIONPAGE_SHARE_ANCHOR_SELECTOR } from '../lib/sessionpageShareAnchor'
import { readSessionpageViewRequestBridge } from '../lib/sessionpageViewRequestBridge'
import { createContactQrPayload, createGuguQrScanUrl } from '@gugu/core/shared/qrPayload'
import { GUGU_ANDROID_DOWNLOAD_URL } from '../lib/appLinks'
import { ContactsProvider } from '../store/contacts'
import { DevicesProvider } from '../store/devices'
import { ServerLoginApproveHost } from '../mobile/server-login/ServerLoginApproveHost'
import { AssistantShellHost } from '../components/assistant/AssistantShellHost'
import { ChatSlotHost } from '../components/ChatSlotHost'
import { ChatListSlotHost } from '../components/ChatListSlotHost'
import { AssistantTaskChatOpener } from '../components/assistant/AssistantTaskChatOpener'
import { FeedbackHost } from '../components/FeedbackHost'
import { AssistantCloseHost } from '../components/assistant/AssistantCloseHost'
import { MobileAssistantTab } from '../mobile/assistant/MobileAssistantTab'
import { PhoneAssistantRow } from '../mobile/assistant/PhoneAssistantRow'
import { usePhoneAssistant } from '../mobile/assistant/usePhoneAssistant'
import { useBackgroundUsageSync } from '../components/usage/useBackgroundUsageSync'
import { useContactsStore } from '../store/contactsContext'
import { chatService } from '../lib/chat'
import { readAgentCreateDefaults, rememberAgentCreateProject } from '../lib/agentCreateDefaults'
import { rememberedAgentCreateProject } from '@gugu/core/shared/ui/agentCreateDefaultsModels'
import { createOptimisticAgentChat, createOptimisticDmChat, createOptimisticGroupChat } from '@gugu/core/shared/ui/chatModels'
import { agentFailureNeedsModelChoice, agentFailureReason } from '@gugu/core/shared/agentQuotaReason'
import { pushToHost as pushTrayBadgeEnabled } from '../lib/trayBadgeSetting'
import { hydrateSidebarTint } from '../lib/sidebarTint'
import { UI_EVENTS } from '../lib/uiEvents'
import { requestTopicSplit } from '../lib/topicSplitRequest'
import type { CreateContextBirthGroup } from '../lib/agentCreateContextBridge'
import { platform } from '../platform'
import { useToast } from '../components/toastContext'
import { askChat, closeTopicTab } from '../session/renderer/features/chats/chat-tabs/chat-layouts'
import { filePillText } from '../components/markdown/filePills'
import { APP_COMPOSE_EVENT, APP_OPEN_IN_CHAT_EVENT, APP_OPEN_WITH_EVENT, type AppComposeDetail, type AppOpenInChatDetail, type AppOpenWithDetail } from '../session/shared/extensions/app-runtime-protocol'
import { chatSlotKey } from '../lib/shellSlots'
import { assistantSlotKey } from '../lib/assistantShellBridge'
import { resourceChatIdOf } from '../session/shared/extensions/app-files-core'
import { getRendererAccessToken } from '../lib/sessionPublication'
import { resolveQrScanRoute, type QrScanRoute } from '../lib/qrScanRoute'
import { describeBarcodeScanError } from '../lib/barcodeScanError'
import { PlatformError } from '../platform/errors'
import { CameraPermissionSheet } from '../components/CameraPermissionSheet'
import { RemoteMachinesHost } from '../components/sessionpage/RemoteMachinesHost'
import type { ContactGroupChat, ContactUser } from '@gugu/core/shared/types/contacts'
import { followLink, openLink } from '../lib/guguLinks'
import { useMobileShell, readMobileShell } from '../hooks/useMobileShell'
import { membershipSettingsSection } from '../lib/billing/settingsDestination'
import { useMobileChatOpenNonce } from '../hooks/useMobileChatOpenNonce'
import { useAgentCreateContextBridge } from '../hooks/useAgentCreateContextBridge'
import { useTranslation } from 'react-i18next'
import { AUTOMATION_TEST_IDS } from '../lib/automationDom'
import type { SessionpageMessageHost } from '@shared/sessionpage-message-host'
import { scheduleComposerFocus, type ComposerFocusReason } from '../lib/focusComposer'
import { RETAINED_SURFACE_HIDDEN_STYLE } from '../lib/retainedSurface'
import { rendererLogger } from '../lib/log'
import { takeAssistantOpenRequest } from '../lib/firstRun'
import { appState } from '../session/renderer/lib/stores/app-state'
import { setComposerVerb } from '../lib/composerVerbBridge'
import { sessionPeek } from '../session/renderer/app/session-peek'

const openChatLog = rendererLogger('chat/open-dm')

interface MainLayoutProps {
  user: AuthUser
  effectsActive?: boolean
  onShellCommitted?: () => void
}

const ignoreShellCommit = () => {}

// ── InnerLayout ────────────────────────────────────────────────────────────────

function InnerLayout({
  user,
  effectsActive = true,
  onShellCommitted = ignoreShellCommit,
}: MainLayoutProps) {
  const { t } = useTranslation('main')
  const sessionHostAvailable = platform.capabilities.sessionHost
  const shellRootRef = useRef<HTMLDivElement>(null)
  const tabBarRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (shellRootRef.current) onShellCommitted()
  }, [onShellCommitted])
  // 首屏默认进「任务」——owner 定的第一个 tab。事件驱动的 setActiveTab('chats')
  // （新会话/通知点击）仍会切到聊天，只有冷启动的落地页改成会话页。
  // @@@web-target-gate - web 构建不呈现会话页,落地页回聊天。理由只有一条:会话页要驱动本机 agent
  // 进程与 pty,通道来自 preload 注入的桌面 API,浏览器给不了。⚠️「rollup 不产出入口」是这条
  // 的后果不是理由。
  // 移动 shell 同理:它的底部 tab 没有「任务」入口,落地在 'tasks' 会是一个进得去出不来的页。下面
  // 那条 effect 本来就会把它拨回 'chats',但 effect 在**首帧绘制之后**才跑 → 冷启动会真闪一帧空白
  // 内容区,所以在初始值这一层就判掉,❌ 不留给 effect 补救。判据与 useMobileShell 同一份
  // (readMobileShell):桌面 Electron 永远不是手机 shell(#3566),❌ 别在这里再量一次 innerWidth。
  const [externalContactId, setExternalContactId] = useState<string>()
  useEffect(() => {
    const open = (event: Event) => { setExternalContactId((event as CustomEvent<string>).detail); setActiveTab('contacts') }
    window.addEventListener(UI_EVENTS.openContact, open)
    return () => window.removeEventListener(UI_EVENTS.openContact, open)
  }, [])
  const [activeTab, setActiveTab] = useState<SidebarTab>(
    !sessionHostAvailable || readMobileShell() ? 'chats' : 'tasks',
  )
  useSessionpageReveal(setActiveTab)
  // The same live task directory drives pending actions and the existing rail attention priority.
  const [sessionAttention, setSessionAttention] = useState<AgentAttention>(null)
  const [mobilePane, setMobilePane] = useState<'list' | 'chat'>('list')
  const [settingsModalOpen, setSettingsModalOpen] = useState(false)
  // @@@1507 设置面板初始 section;侧栏「额度」直接开到 quota,齿轮入口回 account。
  const [settingsSection, setSettingsSection] = useState<ActiveSection>('account')
  useBackgroundUsageSync(user?.id ?? null, effectsActive)
  // 手机上「我的」是推进来的一层(owner 10-26:页头左上角自己的头像进),nav / detail 两层都没有底栏;桌面走设置弹窗。
  const [settingsPane, setSettingsPane] = useState<'nav' | 'detail'>('nav')
  const [watchCreateRequest, setWatchCreateRequest] = useState(0)
  // 手机上从群成员里点的「新建 Agent」:与 watchCreateRequest 一起递进去,null = 不进群。
  const [watchCreateGroup, setWatchCreateGroup] = useState<CreateContextBirthGroup | null>(null)
  const [openedPhoneApp, setOpenedPhoneApp] = useState<{ kind: string; name: string } | null>(null)
  const watchOpenRequest = useAppShowSession(() => { setOpenedPhoneApp(null); setActiveTab('tasks') })
  const { contacts, pendingRequestCount, setAgentPublic } = useContactsStore()
  // 会话页分享名片:{名字, agentUserId, conversationId(留着备用,浮层本身不摆)};咕咕号**每次渲染从通讯录读**(懒分配:开启公开后才有号,
  // 存进 state 就会停在「未分配」那一帧)。非空即渲染浮层 / SharePosterDialog。
  const [shareAgentCard, setShareAgentCard] = useState<{ name: string; agentUserId: string; sessionId: string } | null>(null)
  const shareAgentContact = shareAgentCard ? contacts.find((c) => c.id === shareAgentCard.agentUserId) : undefined
  const shareAgentNumber = (() => {
    const number = shareAgentContact?.gugu_number
    return typeof number === 'number' && Number.isInteger(number) && number > 0 ? number : null
  })()
  // 名字与咕咕号同理,**每次渲染从通讯录读**:存进 state 就会停在改名前的那一帧(改名在会话页「重命名」
  // 弹窗里做,#6091)。通讯录里查不到(还没同步进来)才退回打开浮层那一刻 main 给的那个名字。
  const shareAgentName = shareAgentContact
    ? (shareAgentContact.alias?.trim() || shareAgentContact.display_name)
    : (shareAgentCard?.name ?? '')
  // 先出可复制的浮层(链接/ID 能选能复制),海报是浮层里的次级动作 —— owner:「链接没法复制,agent id 也没法复制」。
  const [shareAgentPoster, setShareAgentPoster] = useState(false)
  // @@@share-popover-dismiss 浮层钉在会话页那个分享按钮上,而不是窗口右缘 —— 每次要用的时候现查,
  // ❌ 开浮层时存下节点:会话页重渲染会换掉按钮节点,存下来的那个会脱离文档(见 AgentSharePopover 的 anchor)。
  const resolveShareAnchor = useCallback(() => document.querySelector(SESSIONPAGE_SHARE_ANCHOR_SELECTOR), [])
  const {
    chats,
    activeChatId,
    setActiveChatId,
    refreshChats,
    upsertChat,
    appendMessage,
    sendMessageToChat,
    writeDraft,
    draftAttachments,
    setDraftAttachments,
  } = useChatStore('chats', 'activeChatId', 'setActiveChatId', 'refreshChats', 'upsertChat', 'appendMessage', 'sendMessageToChat', 'writeDraft', 'draftAttachments', 'setDraftAttachments')
  // A compose's images join the attachments already queued for its chat.
  const draftAttachmentsRef = useRef(draftAttachments)
  draftAttachmentsRef.current = draftAttachments
  // @@@5295 托盘角标开关存在渲染层,主进程每次启动都是默认开 —— 挂载时推一次真值。
  useEffect(() => { pushTrayBadgeEnabled() }, [])
  // index.html 的引导脚本已经落过一次;这里补一次,兜住属性被别处清掉的情况(与主题同办法)。
  useEffect(() => { hydrateSidebarTint() }, [])
  const mobile = useMobileShell()
  const phoneViewport = usePhoneViewport(mobile)
  const chatOpenNonce = useMobileChatOpenNonce(mobile, mobilePane)
  // #2549 对话页原地创建 Agent — draft-composer state, layered on the chats tab (not a new top-level
  // tab: #2509 already made 'tasks' the cold-boot landing tab, this must not fight that). Only
  // meaningful while activeTab==='chats'; derived showAgentCreateDraft is the single source every
  // render decision below reads, so leaving the chats tab always closes the draft in the SAME commit.
  const [agentCreateDraftOpen, setAgentCreateDraftOpen] = useState(false)
  // Visibility and mountedness are separate: selecting a conversation hides the fixed overlay but
  // keeps ComposerEmbedRoot mounted so reopening it restores the unsent draft. Top-level navigation
  // clears this retained state; stale drafts must not silently return after leaving Messages.
  const [agentCreateDraftRetained, setAgentCreateDraftRetained] = useState(false)
  // 群成员里点的「新建 Agent」带来的群:这次建的 agent 一出生就进它(createSession 的 birthChatId),建完人回到它。
  // 只跟着这一次草稿活:草稿一收(建成 / 离开消息 tab),它就跟着清掉。
  const [agentCreateBirthGroup, setAgentCreateBirthGroup] = useState<CreateContextBirthGroup | null>(null)
  const agentCreateBirthGroupRef = useRef(agentCreateBirthGroup)
  agentCreateBirthGroupRef.current = agentCreateBirthGroup
  useEffect(() => {
    if (!agentCreateDraftRetained) setAgentCreateBirthGroup(null)
  }, [agentCreateDraftRetained])
  const [sessionCreateOpen, setSessionCreateOpen] = useState(false)
  useSessionpageAgentInstallNavigation(sessionHostAvailable, setAgentCreateDraftOpen, setAgentCreateDraftRetained, setSessionCreateOpen, setActiveTab)
  useOpenNewSessionOnDeviceHost(sessionHostAvailable && !mobile, setSettingsModalOpen, setActiveTab)
  // @@@create-entry-is-not-a-task-host-capability (#4287) — sessionHost 只选**用哪套装配**(常驻会话页 composer /
  // ACP-only composer),❌ 不回答「这里能不能建 agent」:并成一个布尔就凭空多出「两套都不给」的第三档,而安卓
  // 出货面正是掉进那一档才整段时间没有入口(#3809 归并顺手带走的)。「没有在线设备」由 composer 自己 fail loud。
  const showAgentCreateDraft = agentCreateDraftOpen && activeTab === 'chats'
  const retainAgentCreateDraft = agentCreateDraftRetained && activeTab === 'chats'
  // 任务创建面是真·会话页专属(它建的是会话页 task/session),照旧由能力位把关。
  const showSessionCreate = sessionHostAvailable && sessionCreateOpen && activeTab === 'chats'
  const showCreateSurface = showAgentCreateDraft || showSessionCreate
  // #7199 手机上打开的是和个人助理那条私聊:整块换成助理 App(聊天 + 动态 / 任务 / 记忆 / 它的名字),「在看」由 App 按它摆着的那一格报。
  const phoneAssistant = usePhoneAssistant(mobile)
  const [assistantChatRequest, setAssistantChatRequest] = useState(0)
  const openAssistantChat = useCallback((chatId: string): boolean => {
    const assistantChatId = mobile ? phoneAssistant.chatId : readAssistantShellBridge()?.getSnapshot()?.chatId
    if (chatId !== assistantChatId) return false
    setAgentCreateDraftOpen(false)
    setActiveTab(mobile ? 'assistant' : 'tasks')
    if (mobile) setAssistantChatRequest((n) => n + 1)
    else appState.navigation.navigate('assistant')
    return true
  }, [mobile, phoneAssistant.chatId])
  const assistantOnPhone = mobile && !!phoneAssistant.chatId && activeChatId === phoneAssistant.chatId
  const unreadNavigationTarget = assistantOnPhone ? 'assistant' : 'chat'
  // 首次引导里点了「开通我的咕咕」(product spec,#7348):主界面挂上就打开咕咕那一格(开通流程自己从「住在哪」开始)。
  // 桌面 = 会话页的「助理」视图(同最左栏顶格那一下);手机 = 底栏咕咕那一格。这一格开不了时不跳,由人自己去看。
  useEffect(() => {
    if (!effectsActive) return
    if (mobile ? !phoneAssistant.available : !(sessionHostAvailable && platform.capabilities.agentRuntime)) return
    if (!takeAssistantOpenRequest(user.id)) return
    if (mobile) {
      setActiveTab('assistant')
      return
    }
    setActiveTab('tasks')
    appState.navigation.navigate('assistant')
  }, [effectsActive, mobile, phoneAssistant.available, sessionHostAvailable, user.id])
  // gugu-dev#181 桌面上没有单独的聊天页:对话是会话页这屏的一块,打开一条对话 = 请会话页把它那块摆出来(项目群摆项目块,
  // 那边判)。返回真实呈现槽标识;没有块宿主时返回 null,照旧落在聊天页。
  const chatsAreBlocks = !mobile && sessionHostAvailable
  const composerFocusCleanupRef = useRef<(() => void) | null>(null)
  // 门控与移动软键盘语义都在契约里（见 lib/focusComposer.ts）；这里只表达「用户从哪个入口进来的」。
  // chatId:落到这条对话那一格里的输入框(屏上可以并排几块对话,❌ 落进别的块)。
  const focusComposerForUserEntry = useCallback((reason: ComposerFocusReason, chatId?: string) => {
    composerFocusCleanupRef.current?.()
    const target = chatId
      ? () => document.querySelector<HTMLTextAreaElement>(`[data-chat-slot="${chatId}"] [data-testid="${AUTOMATION_TEST_IDS.chatComposer}"]`)
      : undefined
    composerFocusCleanupRef.current = scheduleComposerFocus(reason, { mobileShell: mobile, target })
  }, [mobile])
  useEffect(() => () => composerFocusCleanupRef.current?.(), [])
  const openOwnedAgent = useOwnedAgentConversationEntry({ ownerId: user.id, chats, contacts, mobile, onOpen: () => setActiveTab('tasks') })
  const openChatBlock = useCallback((chatId: string, focus?: ComposerFocusReason, peerId?: string, draft?: string, sourceChatId?: string): string | null => {
    if (!sourceChatId && openAssistantChat(chatId)) return mobile ? 'assistant' : assistantSlotKey('chat')
    if (openOwnedAgent(chatId, peerId, draft, sourceChatId)) { setActiveTab('tasks'); return 'tasks' }
    if (!chatsAreBlocks) return null
    const sessionPage = readSessionpageViewRequestBridge()
    if (!sessionPage) throw new Error(t('shell.errors.taskBridgeUnavailable'))
    setSettingsModalOpen(false)
    setActiveTab('tasks')
    if (sourceChatId) {
      if (!sessionPage.openGroupChat) throw new Error(t('shell.errors.taskBridgeUnavailable'))
      sessionPage.openGroupChat(sourceChatId, chatId)
    } else sessionPage.openChat(chatId, false)
    if (focus) focusComposerForUserEntry(focus, chatId)
    return chatSlotKey(chatId)
  }, [chatsAreBlocks, focusComposerForUserEntry, mobile, openAssistantChat, openOwnedAgent, t])
  const chatsRef = useRef(chats)
  chatsRef.current = chats
  const openChatTarget = useCallback((chatId: string): string => {
    setOpenedPhoneApp(null)
    const chat = chatsRef.current.find((candidate) => candidate.id === chatId)
    const topic = chat?.kind === 'topic' && chat.source_chat_id ? chat : null
    const shownChatId = topic?.source_chat_id ?? chatId
    const viewportKey = openChatBlock(shownChatId)
    if (!viewportKey) {
      setAgentCreateDraftOpen(false)
      setActiveTab('chats')
      setMobilePane('chat')
      setActiveChatId(shownChatId)
    }
    if (topic) requestTopicSplit({ chatId: topic.id, name: topic.name ?? '', sourceChatId: topic.source_chat_id! })
    return topic ? `${viewportKey ?? 'chats'}:topic` : viewportKey ?? 'chats'
  }, [openChatBlock, setActiveChatId])
  const [appDetail, setAppDetail] = useState<import('@gugu/core/shared/ui/guguLink').AppDetailLink>()
  useLinkNavigation({ ownerId: user.id, chats, contacts,
    openSender: (target, sourceChatId) => handleSwitchToChat(target, undefined, sourceChatId),
    openAppDetail: target => {
      if (target.deviceId || target.variant) throw new Error(translateSessionMessage('extensions.appLinkOnPhone'))
      setAppDetail(target)
      openSettingsSection('apps')
    },
    openFile: (chatId, target, source) => { openChatTarget(chatId); askChat(chatId, { itemId: target.itemId, ...(target.at ? { at: target.at } : {}), ...(source.message ? { message: source.message } : {}), ...(source.restore ? { restore: source.restore } : {}) }) },
    openApp: (chatId, extensionId, tab) => { openChatTarget(chatId); askChat(chatId, { app: extensionId, ...(tab ? { tab } : {}) }) },
    openOwnApp: (extensionId, tab) => { const page = installedExtensionsStore.allTabContributions.find((entry) => entry.kind === `${extensionId}.${tab}`); if (!page) throw new Error('App tab is unavailable'); setOpenedPhoneApp({ kind: page.kind, name: page.extensionName }) },
    openProject: (projectId) => { setOpenedPhoneApp(null); setActiveTab('tasks'); appState.navigation.navigate('project', { projectId }) },
    openChat: openChatTarget,
    openAssistant: (tasks) => { setOpenedPhoneApp(null); setActiveTab(mobile ? 'assistant' : 'tasks'); if (!mobile && (tasks || appState.navigation.currentViewId !== 'assistant')) appState.navigation.navigate('assistant', tasks ? { tab: 'tasks' } : {}); return tasks ? assistantSlotKey('task-chat') : mobile ? 'assistant' : assistantSlotKey('chat') },
  })
  // 手机底栏的格子:「消息 / 伙伴」(owner 10-26,#446);桌面壳不变。
  // 引用要稳:分页器按它定位(useLayoutEffect 依赖 tabs),每次渲染换一个新数组就会在滑动 / 吸附途中被未读数一类的更新拽回当前页。
  const tabs = mobile ? MOBILE_TABS : SIDEBAR_TABS
  // 手机上 'assistant' / 'tasks' / 'settings' 是推在列表首页上的一层(PhoneLayer,没有底栏);底下的分页器停在推它之前那一格,返回回到那里。
  const phoneLayerOpen = mobile && !MOBILE_TABS.includes(activeTab)
  const [phoneRootTab, setPhoneRootTab] = useState<SidebarTab>('chats')
  useEffect(() => {
    if (mobile && MOBILE_TABS.includes(activeTab)) setPhoneRootTab(activeTab)
  }, [mobile, activeTab])
  const pagerTab = phoneLayerOpen ? phoneRootTab : activeTab
  const exitPhoneLayer = useCallback(() => navigateMobile(() => setActiveTab(phoneRootTab), 'pop'), [phoneRootTab])
  const openPhoneAssistant = useCallback(() => navigateMobile(() => {
    setActiveTab('assistant')
    setAssistantChatRequest((n) => n + 1)
  }, 'push'), [])
  // 手机「伙伴」(#446):推进去的页没有底栏;「消息」右上「新项目」推进它的新项目页。
  const [partnersPushed, setPartnersPushed] = useState(false)
  const [projectChatFromPartners, setProjectChatFromPartners] = useState(false)
  const backFromPhoneChat = useCallback(() => navigateMobile(() => {
    setMobilePane('list')
    if (projectChatFromPartners) { setProjectChatFromPartners(false); setActiveTab('contacts') }
  }, 'pop'), [projectChatFromPartners])
  const [newProjectRequest, setNewProjectRequest] = useState(0)
  const openNewProject = useCallback(() => navigateMobile(() => {
    setActiveTab('contacts')
    setNewProjectRequest((n) => n + 1)
  }, 'push'), [])
  const onScreenChatId = useReportChatOnScreen(activeTab === 'chats' && !showCreateSurface && (!mobile || mobilePane === 'chat') && !assistantOnPhone ? activeChatId : null)
  // showAgentCreateDraft already derives "closed" the instant activeTab leaves 'chats', but the
  // underlying state must reset too — otherwise switching back to chats later silently resurrects a
  // stale draft the user never asked to reopen.
  useEffect(() => {
    if (activeTab !== 'chats') {
      if (agentCreateDraftOpen) setAgentCreateDraftOpen(false)
      if (agentCreateDraftRetained) setAgentCreateDraftRetained(false)
      if (sessionCreateOpen) setSessionCreateOpen(false)
    }
  }, [activeTab, agentCreateDraftOpen, agentCreateDraftRetained, sessionCreateOpen])
  // #2525/#2770 「返回/选会话保草稿」——退出创建面若把唯一会话页实例切回 workspace,
  // ComposerEmbedRoot 会卸载,用户写了一半的输入随之蒸发。只要仍在消息 tab,创建面是否覆盖内容区
  // 由 agentCreateDraftOpen 表达,内部 root 则保持 composer；离开消息 tab 才切回 workspace。
  const openAgentCreateDraft = useCallback(() => {
    setSessionCreateOpen(false)
    setAgentCreateDraftOpen(true)
    setAgentCreateDraftRetained(true)
    // 从别的入口打开 = 不进群;群成员那个入口在这之后再把群放上(同一批提交)。
    setAgentCreateBirthGroup(null)
  }, [])
  const openSessionCreate = useCallback(() => {
    if (!sessionHostAvailable) return
    setActiveTab('chats')
    setAgentCreateDraftOpen(false)
    setAgentCreateDraftRetained(false)
    setSessionCreateOpen(true)
    setMobilePane('list')
  }, [sessionHostAvailable])

  // 联系人页的「新建 Agent」。手机:去会话页建 agent 的那条路(先选机器),与会话页右上 + 同一条。
  // 桌面:落到同一个 composer 草稿 —— ⚠️ 必须先切回消息 tab:草稿面只在 activeTab==='chats' 渲染,
  // 上面那个 effect 还会在别的 tab 上把它复位;两个 setState 同批提交,effect 落地时已是 'chats'。
  const openAgentCreateDraftFromContacts = useCallback(() => {
    if (mobile) {
      setWatchCreateGroup(null)
      setActiveTab('tasks')
      setWatchCreateRequest((n) => n + 1)
      return
    }
    // gugu-dev#181 只有一个「新建会话」:桌面上就是会话页的新建会话页(不进群)。
    if (chatsAreBlocks) {
      setActiveTab('tasks')
      appState.navigation.navigate('new-session')
      return
    }
    setActiveTab('chats')
    openAgentCreateDraft()
  }, [chatsAreBlocks, mobile, openAgentCreateDraft])
  const sessionSlotRef = useRef<HTMLDivElement>(null)
  const composerSlotRef = useRef<HTMLDivElement>(null)
  const emdashFrameHomeRef = useRef<HTMLDivElement>(null)
  // Declared here (not further down with the rest of the chat-list-pane state) so the position-sync
  // effect below can depend on it without a temporal-dead-zone error — it needs to re-run whenever a
  // pane-width drag changes the composer/task slot's rect.
  const [chatListPaneWidth, setChatListPaneWidth] = useState(readStoredChatListPaneWidth)

  // Prewarm the embedded renderer so reaching a surface that needs it feels native. The gate is the
  // build target (sessionHost capability), not the shell width — the desktop Electron window never
  // becomes a mobile shell (#3566), and the mobile web/Capacitor shells reach the same session-page surface
  // (#2525 移动端全屏创建页) through the headless task host, so it must not be starved of the fetch it
  // is about to need.
  useEffect(() => {
    if (sessionHostAvailable) prewarmEmdashAssets()
  }, [sessionHostAvailable])
  // 任务 tab 在移动壳下**换一张页**,不是没有:手机端渲染「看管 agent」(机器 → 会话 → 时间线),
  // 桌面端才是会话页 Workspace(IDE 面)。owner 2026-09-05 拍板:手机端要有会话页入口,
  // 且会话页下面按设备分、能跳不同设备 —— 这推翻了 #1787「移动 tab 无任务入口」那一条。
  // ⚠️ `!sessionHostAvailable` 那一半**必须留**:桌面没有会话页宿主时 'tasks' 是一张空页;
  // 但移动端的看管页不吃会话页宿主(它走设备 RPC 问别的机器),所以不再因 mobile 拨走。
  useEffect(() => {
    if (!mobile && !sessionHostAvailable && activeTab === 'tasks') setActiveTab('chats')
  }, [mobile, activeTab, sessionHostAvailable])
  // 会话页常驻隐藏时,通知会话页卸下 document 级快捷键(⌘K 等会开出隐形弹层抢焦点)。
  // 布尔镜像兜会话页 bundle 尚未加载完的窗口期(embedded 启动时读取)。同一份会话页实例现在也
  // 承载对话页的创建草稿态(#2549),草稿态时它同样是可见/可交互的,不能被判「隐藏」。
  useEffect(() => {
    const visible = activeTab === 'tasks' || showCreateSurface
    const w = window as unknown as {
      __EMDASH_SET_VISIBLE__?: (v: boolean) => void
      __EMDASH_EMBED_VISIBLE__?: boolean
    }
    w.__EMDASH_EMBED_VISIBLE__ = visible
    w.__EMDASH_SET_VISIBLE__?.(visible)
  }, [activeTab, showCreateSurface])

  // #2549 — the ONE persistent session-page instance (EmdashSessionFrame, mounted once below at a JSX
  // position that NEVER changes) must appear either in the 任务-tab slot or the 对话-draft slot.
  // Two approaches were tried against a REAL streaming Claude Code session and rejected before this
  // one, in order:
  //   1. ReactDOM.createPortal with a changing container — unmounts/remounts the whole subtree on
  //      every target change (isolated repro), which would cold-boot the 14MB session-page instance
  //      (owner-measured ~30s) on every switch.
  //   2. Raw `dest.appendChild(frame)` in a useLayoutEffect, frame left at a stable JSX position —
  //      survived an isolated repro (including 40 forced unrelated parent re-renders), but CRASHED
  //      the real app: switching tabs mounts/unmounts SIBLING blocks ({activeTab==='chats' && …}),
  //      and React's commitPlacement inserts them via insertBefore(newSibling, referenceNode) where
  //      referenceNode is the frame wrapper's fiber-recorded DOM position — which the appendChild
  //      had silently moved elsewhere, so the reference goes stale and React throws
  //      "Failed to execute 'insertBefore': the node before which the new node is to be inserted is
  //      not a child of this node" the next time ANY sibling of the frame's ORIGINAL position
  //      mounts/unmounts, even if unrelated to the reparent target.
  // The frame's DOM node must therefore never move at all. Instead it's a position:fixed overlay
  // (base position:fixed;top:0;left:0;width:0;height:0 set in JSX so it's out of flow from the
  // first paint — no flash) that this effect sizes/positions to exactly cover whichever slot
  // (sessionSlotRef/composerSlotRef) is current, via getBoundingClientRect(). A hidden slot (display:
  // none, e.g. sessionSlotRef while on another tab) has a zero rect, which hides the overlay too — no
  // separate branch needed for "nothing should show". ResizeObserver + window resize + explicit
  // chatListPaneWidth / activeTab dependencies keep the rect in sync (activeTab: same commit as the tab switch, #6753).
  // 移动 shell 走同一套:全屏创建页的正文区就是 composerSlotRef 指的那个槽(两个 shell 的槽互斥
  // 渲染,共用一个 ref),量到的 rect 只是变成了整屏 —— ❌ 不为移动端另开一条定位分支。
  useLayoutEffect(() => {
    if (!sessionHostAvailable) return
    const frame = emdashFrameHomeRef.current
    const dest = showCreateSurface ? composerSlotRef.current : sessionSlotRef.current
    if (!frame || !dest) return
    let shown = false
    const syncRect = () => {
      const rect = dest.getBoundingClientRect()
      frame.style.top = `${rect.top}px`
      frame.style.left = `${rect.left}px`
      frame.style.width = `${rect.width}px`
      frame.style.height = `${rect.height}px`
      frame.dataset.emdashSlot = dest === sessionSlotRef.current ? 'task' : 'composer'
      shown = rect.width > 0 && rect.height > 0
      frame.style.pointerEvents = shown ? 'auto' : 'none'
      hide()
    }
    // Hidden, the frame's page is skipped (content-visibility): not drawn, focusable, findable or intersecting, so its
    // animations stop too. ❌ An inherited property (visibility, inert, a custom property) toggled on the frame restyles
    // every element of the page: 158–168 ms at 1000 chat rows on mac1, paid on each switch to and from Messages, ~2 ms this way.
    // A session opened beside an App in a chat's side panel (G1) is the frame's page, drawn over that panel: while the
    // frame is hidden (the chats tab) and holds one, the page stays and only the rest hides (visibility; the peeked page
    // says visible for itself), and the frame sits above the panels (z-float), not under them.
    const hide = () => {
      const peek = !shown && sessionPeek.current !== null
      frame.style.contentVisibility = shown || peek ? 'visible' : 'hidden'
      // Skipped, the page still hands its titlebar's app-region rects to the window: collapse them (lib/retainedSurface.ts).
      frame.style.transform = shown || peek ? '' : 'scale(0)'
      frame.style.visibility = peek ? 'hidden' : 'visible'
      frame.style.zIndex = peek ? 'calc(var(--z-float) + 1)' : '5'
    }
    syncRect()
    const ro = new ResizeObserver(syncRect)
    ro.observe(dest)
    window.addEventListener('resize', syncRect)
    const offPeek = reaction(() => sessionPeek.current !== null, hide)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', syncRect)
      offPeek()
    }
  }, [showCreateSurface, mobile, mobilePane, chatListPaneWidth, sessionHostAvailable, activeTab])

  // #2525 设备/项目默认值记忆 — 草稿开着时把 per-user 的创建上下文装到 window 桥上，供会话页
  // composer 的托盘读写。契约见 lib/agentCreateContextBridge.ts；规则在 core，这里只管装卸。
  // ⚠️ 这里原本还有一个 `!mobile`：写它的时候移动端根本没有 composer，那个门是对的。移动端全屏创建页
  // 落地后它就**过期**了 —— 移动草稿态挂的正是同一个 `ComposerEmbedRoot`，桥不装它会等满
  // BRIDGE_WAIT_MS 后 `missing=true`、打出「读不到创建上下文」并**挡住发送**（composer-embed-root
  // 的 fail-loud 分支）。所以按同一条判据收敛成只看构建目标：这不是「移动端不该有桌面会话页 tab」，
  // 而是「顺手把移动端的 composer 一起断了」。
  // 还要跟着 retainAgentCreateDraft 一起留着:返回/选会话时 composer 子树是**不卸载**的(草稿就活在
  // 那棵子树里),桥若跟着草稿态一起卸掉,下次进页托盘会退回 context-not-ready /「无可用设备」
  // 重新加载一遍(实测约 4s)——文字草稿留住了、上下文却每次重来,这跟本页「返回保草稿」的承诺不一致。
  // ACP-only 那一侧必须放行「所选设备不是本机」:手机上根本不存在本机可运行的设备(#3195)。
  const agentCreateContext = useAgentCreateContextBridge(
    showAgentCreateDraft || retainAgentCreateDraft,
    // 桌面也放行远端设备(#6264,见 RemoteMachinesHost / use-machine-create-target.tsx)。
    { allowRemoteDevice: true, birthGroup: agentCreateBirthGroup },
  )
  // ACP-only 装配没有会话页实例可盖,composer 就是它自己。挂载条件跟 retain 走(隐藏而不卸载),否则草稿会蒸发。
  const acpCreateComposer = sessionHostAvailable || !retainAgentCreateDraft ? null : (
    <AcpAgentCreateComposer context={agentCreateContext} onCreated={() => {
      setAgentCreateDraftOpen(false)
      setAgentCreateDraftRetained(false)
    }} />
  )

  // Which root the ONE session-page instance renders internally — 'composer' while the draft is open,
  // else the normal session-page Workspace. Independent of the reparent effect above (that moves WHERE
  // the frame's DOM sits; this decides WHAT it renders), mirrors the existing __EMDASH_SET_VISIBLE__
  // seed-then-set pattern for the bundle-not-yet-loaded window.
  useEffect(() => {
    if (!sessionHostAvailable) return
    const w = window as unknown as {
      __EMDASH_SET_EMBED_VIEW__?: (v: 'workspace' | 'composer' | 'session-create') => void
      __EMDASH_EMBED_VIEW__?: 'workspace' | 'composer' | 'session-create'
    }
    // retainAgentCreateDraft keeps the composer root MOUNTED while its overlay is hidden — that
    // mountedness is the desktop chat-selection and mobile-back draft guarantee.
    const view = showSessionCreate
      ? 'session-create'
      : showAgentCreateDraft || retainAgentCreateDraft
        ? 'composer'
        : 'workspace'
    w.__EMDASH_EMBED_VIEW__ = view
    w.__EMDASH_SET_EMBED_VIEW__?.(view)
  }, [showAgentCreateDraft, showSessionCreate, retainAgentCreateDraft, sessionHostAvailable])
  const { toast } = useToast()
  // @@@scan-orchestrate (#537) - the scan entry now lives in the chat-list "+" menu, but a decoded QR
  const [scanSeed, setScanSeed] = useState<{ route: QrScanRoute; token: number } | null>(null)
  const [cameraPermissionSheetOpen, setCameraPermissionSheetOpen] = useState(false)

  const previewChatListPaneWidth = useCallback((width: number) => {
    setChatListPaneWidth(width)
  }, [])

  const commitChatListPaneWidth = useCallback((width: number) => {
    setChatListPaneWidth(width)
    writeStoredChatListPaneWidth(width)
  }, [])

  // @@@1507 直达指定设置 section(侧栏「额度」→ quota)。移动端无设置弹窗:直达「我的」tab 对应 detail 面。
  const openSettingsSection = useCallback((section: ActiveSection) => {
    setSettingsSection(section)
    if (mobile) {
      navigateMobile(() => { setSettingsPane('detail'); setActiveTab('settings') }, 'push')
      return
    }
    setSettingsModalOpen(true)
  }, [mobile])

  // 会话页要打开设置(⌘, / 应用菜单 / 命令面板 / 浏览器工具栏「管理配置」):设置只有这一个弹窗(product spec)。
  // 指了格就落到那一格;没指就照原样打开(上次停在哪一格就是哪一格)。
  useEffect(() => {
    const open = (event: Event) => {
      const section = (event as CustomEvent<{ section?: ActiveSection }>).detail?.section
      if (section) openSettingsSection(section)
      else setSettingsModalOpen(true)
    }
    // Feedback replaces the settings modal; sibling modal focus layers otherwise block its form.
    const closeForFeedback = () => setSettingsModalOpen(false)
    window.addEventListener(UI_EVENTS.openSettings, open)
    window.addEventListener(UI_EVENTS.sessionpageOpenFeedback, closeForFeedback)
    return () => {
      window.removeEventListener(UI_EVENTS.openSettings, open)
      window.removeEventListener(UI_EVENTS.sessionpageOpenFeedback, closeForFeedback)
    }
  }, [openSettingsSection])

  const selectTab = useCallback((tab: SidebarTab) => {
    if (tab === 'settings') {
      setSettingsSection('account')
      // 手机上「我的」整屏推进来(owner 10-26,页头左上角自己的头像);桌面仍走设置弹窗
      if (mobile) {
        navigateMobile(() => {
          setSettingsPane('nav')
          setActiveTab('settings')
        }, 'push')
        return
      }
      setSettingsModalOpen(true)
      return
    }
    setSettingsModalOpen(false)
    setActiveTab(tab)
    if (tab === 'chats') {
      setMobilePane(mobile ? 'list' : activeChatId ? 'chat' : 'list')
      if (activeChatId) focusComposerForUserEntry('tab-return')
    }
  }, [activeChatId, focusComposerForUserEntry, mobile])

  // #7199 手机上和个人助理的那条私聊就是底栏「助理」那一格(owner 10-16「点进去成两个 app 了」):对话列表、通知、联系人「发消息」
  // 打开它都切到那一格的聊天,❌ 在对话页里另开一屏。在画出来之前换过去,对话页 ❌ 先闪一帧那条私聊。
  useEffect(() => {
    if (!mobile || !phoneAssistant.available) return
    const open = () => setActiveTab('assistant')
    window.addEventListener(UI_EVENTS.openAssistantConnectors, open)
    return () => window.removeEventListener(UI_EVENTS.openAssistantConnectors, open)
  }, [mobile, phoneAssistant.available])
  useLayoutEffect(() => {
    if (!assistantOnPhone || activeTab !== 'chats' || mobilePane !== 'chat' || !phoneAssistant.available) return
    setMobilePane('list')
    setActiveTab('assistant')
    setAssistantChatRequest((n) => n + 1)
  }, [assistantOnPhone, activeTab, mobilePane, phoneAssistant.available])
  // 这一格只在手机壳里、且开得了个人助理时才有:跨到桌面宽度 / 管家说这里没开放,回对话页。
  useEffect(() => {
    if (activeTab === 'assistant' && (!mobile || !phoneAssistant.available)) setActiveTab('chats')
  }, [activeTab, mobile, phoneAssistant.available])

  // 手机上会话列表被打开的会话 / 全屏创建页整页盖住(隐藏不卸载)。
  const chatListHidden = mobile && (mobilePane === 'chat' || showCreateSurface)
  // 底栏只在「消息 / 伙伴」两张列表首页(owner 10-26,#446):打开的对话、全屏创建页、推进来的一层(咕咕 / 项目 / 我的)都没有它,
  // 返回一步回到有底栏的那层。列表页上键盘弹起时保留原锚点,由键盘盖住,❌ 跟着滚动 / 聚焦另外收放。
  // 横滑切 tab 用同一份判据(#6730):tab 栏在,点和滑都能换 tab;钻进全屏子页两样都不行 —— 横滑归子页所有,
  // 全屏创建页的出口只有左上返回箭头(#2525),横滑会把草稿连页一起掀掉。
  const tabBarVisible = mobile && !chatListHidden && !phoneLayerOpen && !partnersPushed
  // 手机上四个 tab 页常驻在分页器里,横滑时相邻页整页可见 ⇒ 离开的 tab 回到它的根上(与从前「切走即卸载、
  // 回来是根」同一个结果),拖过去看到的总是那个 tab 的浏览层。会话页、联系人页各自按 activeTab 复位。
  // 「我的」连 section 一起复位:手机设置由壳受控,离开时回到 account,
  // 再次直达 account(充值)也能覆盖面板里上次看的页,不依赖不同 section 才换 key。
  // 推进来的一层盖在对话上时(通知、链接从对话里打开项目)底下的对话不动,返回回到它。
  useEffect(() => {
    if (!mobile) return
    if (activeTab === 'contacts') setMobilePane('list')
    if (activeTab !== 'settings') {
      setSettingsPane('nav')
      setSettingsSection('account')
    }
  }, [mobile, activeTab])


  useEffect(() => {
    const handler = (event: Event) => {
      const { chatId } = (event as CustomEvent<{ chatId?: unknown }>).detail ?? {}
      if (typeof chatId !== 'string' || chatId.length === 0) return
      if (openChatBlock(chatId, 'notification-open')) return

      setActiveChatId(chatId)
      setAgentCreateDraftOpen(false)
      setActiveTab('chats')
      setMobilePane('chat')
      focusComposerForUserEntry('notification-open')
    }
    window.addEventListener(UI_EVENTS.notificationClicked, handler)
    return () => window.removeEventListener(UI_EVENTS.notificationClicked, handler)
  }, [focusComposerForUserEntry, openChatBlock, setActiveChatId])


  // 群成员面板的「新建 Agent 并加入本群」:桌面与对话页「新建 Agent」同一个创建页、手机与联系人页「新建 Agent」
  // 同一条(会话页选机器),只是都带上这个群。
  useEffect(() => {
    const onCreateInGroup = (event: Event) => {
      const { chatId } = (event as CustomEvent<{ chatId?: unknown }>).detail ?? {}
      if (typeof chatId !== 'string' || chatId.length === 0) return
      const name = chatsRef.current.find((chat) => chat.id === chatId)?.name || t('group.settings.groupFallback', { ns: 'messaging' })
      if (mobile) {
        setWatchCreateGroup({ chatId, name })
        setActiveTab('tasks')
        setWatchCreateRequest((n) => n + 1)
        return
      }
      // gugu-dev#181 桌面上:那个群的输入框换成「新任务」,把那个群摆出来 —— 建好的 agent 进这个群,结果回到这里。
      if (chatsAreBlocks) {
        setComposerVerb(chatId, 'task', undefined, { name, joinable: true })
        openChatBlock(chatId)
        return
      }
      setActiveTab('chats')
      openAgentCreateDraft()
      setAgentCreateBirthGroup({ chatId, name })
    }
    window.addEventListener(UI_EVENTS.createAgentInGroup, onCreateInGroup)
    return () => window.removeEventListener(UI_EVENTS.createAgentInGroup, onCreateInGroup)
  }, [chatsAreBlocks, mobile, openAgentCreateDraft, openChatBlock, t])
  const activeChatIdRef = useRef(activeChatId)
  activeChatIdRef.current = activeChatId
  useEffect(() => {
    const bringUp = (chatId: string | null, ask: (chatId: string, viewportKey?: string) => void, resource = false): boolean => {
      const addressed = chatsRef.current.find((candidate) => candidate.id === chatId)
      const chat = resource && addressed?.kind === 'topic' ? chatsRef.current.find((candidate) => candidate.id === addressed.source_chat_id) : addressed
      if (!chat) {
        toast(t('groupFile.notInGroup'), 'error')
        return false
      }
      ask(chat.id, openChatTarget(chat.id))
      window.dispatchEvent(new CustomEvent(UI_EVENTS.chatAsked, { detail: { chatId: chat.id } }))
      return true
    }
    // a gugu.dispatch draft into a chat — from a page anywhere, the phone's too: after that chat's draft, the chat
    // up and its composer focused (the slot of that chat, if open, gets out of the way: useSlotMakesWay).
    const onCompose = (event: Event) => {
      const detail = (event as CustomEvent<AppComposeDetail>).detail
      if (!detail) return
      if (openOwnedAgent(detail.chatId, undefined, {
        text: [detail.text, ...(detail.refs ?? []).map(filePillText)].filter(Boolean).join('\n'),
        files: detail.images?.map(image => new File([image.bytes], image.name, { type: image.type })), append: true,
      })) return
      const placed = (chatId: string) => {
        const text = [detail.text, ...(detail.refs ?? []).map(filePillText)].filter(Boolean).join('\n')
        if (text) writeDraft(chatId, { at: 'end', text })
        if (detail.images?.length) {
          const images = detail.images.map((image) => ({
            id: crypto.randomUUID(),
            file: new File([image.bytes], image.name, { type: image.type }),
            kind: 'image' as const,
          }))
          setDraftAttachments(chatId, [...(draftAttachmentsRef.current[chatId] ?? []), ...images])
        }
      }
      if (bringUp(detail.chatId, placed)) {
        const chat = chatsRef.current.find((candidate) => candidate.id === detail.chatId)
        focusComposerForUserEntry('quote-attached', chat?.kind === 'topic' ? chat.source_chat_id ?? undefined : detail.chatId)
      }
    }
    // gugu.files.openWith, wherever the page is (a chat's panel, an App's own page, a session's tab): the file's chat comes
    // up — the one on screen stays — and its panel opens it as the host resolved it, the way a link to it opens.
    const onOpenWith = (event: Event) => {
      const detail = (event as CustomEvent<AppOpenWithDetail>).detail
      if (detail) bringUp(detail.chatId, (chatId) => askChat(chatId, { itemId: detail.itemId, opener: detail, fromPage: true }), true)
    }
    // A card's Open action names a chat: it comes up, and its panel opens the App (ChatAreaPanel takes it).
    const onOpenInChat = (event: Event) => {
      const detail = (event as CustomEvent<AppOpenInChatDetail>).detail
      const named = detail?.chatId ?? activeChatIdRef.current
      if (!named || !detail) return
      const token = getRendererAccessToken()
      if (!token) { toast(t('groupFile.notInGroup'), 'error'); return }
      void resourceChatIdOf(token, named, user.id)
        .then((chatId) => bringUp(chatId, (id) => askChat(id, { app: detail.extensionId }), true))
        .catch((error: unknown) => toast(error instanceof Error ? error.message : String(error), 'error'))
    }
    window.addEventListener(APP_COMPOSE_EVENT, onCompose)
    window.addEventListener(APP_OPEN_WITH_EVENT, onOpenWith)
    window.addEventListener(APP_OPEN_IN_CHAT_EVENT, onOpenInChat)
    window.addEventListener(UI_EVENTS.openApp, onOpenInChat)
    return () => {
      window.removeEventListener(APP_COMPOSE_EVENT, onCompose)
      window.removeEventListener(APP_OPEN_WITH_EVENT, onOpenWith)
      window.removeEventListener(APP_OPEN_IN_CHAT_EVENT, onOpenInChat)
      window.removeEventListener(UI_EVENTS.openApp, onOpenInChat)
    }
  }, [focusComposerForUserEntry, openOwnedAgent, openChatTarget, writeDraft, setDraftAttachments, t, toast, user.id])


  // 选中变化 ⇒ shell 让位(收草稿面、移动壳下钻)。这条集中反应兜住只写得到 store 的入口(App 层的宿主),
  // 从前靠 agent 运行态广播代劳;各入口内联的同名调用保留,免掉一帧闪烁。
  // ⚠️ 只对**变化**反应:挂载时恰好有一条选中的会话 ≠ 用户此刻要进去。
  const shellFollowedChatIdRef = useRef(activeChatId)
  useEffect(() => {
    const previous = shellFollowedChatIdRef.current
    shellFollowedChatIdRef.current = activeChatId
    if (!activeChatId || previous === activeChatId || document.documentElement.dataset.mobileDirection) return
    setAgentCreateDraftOpen(false)
    setMobilePane('chat')
  }, [activeChatId])

  const failedDeliveries = useRef(new Map<string, Set<string>>())
  // One notice per task, with the actual cause and distinct source messages while it is visible.
  useEffect(() => {
    const handleSessionpageDeliverFailed = (event: Event) => {
      const detail = (event as CustomEvent).detail as { agentUserId?: string; messageId?: string | null; error?: string } | undefined
      if (!detail?.agentUserId) return
      // #7685 额度/模型类由运行条的 agent 状态位 + 恢复前只弹一次的提示说(AgentTurnFailureSlot)，❌ 每条失败的投递再弹一条。
      if (agentFailureNeedsModelChoice(agentFailureReason(detail.error))) return
      const agentId = detail.agentUserId
      const messages = failedDeliveries.current.get(agentId) ?? new Set<string>()
      failedDeliveries.current.set(agentId, messages)
      if (detail.messageId) messages.add(detail.messageId)
      const clear = () => {
        if (failedDeliveries.current.get(agentId) === messages) failedDeliveries.current.delete(agentId)
      }
      const contact = contacts.find((c) => c.id === agentId)
      const name = contact?.alias?.trim() || contact?.display_name || agentId
      notify({
        key: `sessionpage-delivery:${agentId}`,
        title: messageForUser(detail.error),
        description: messages.size
          ? t('shell.toast.taskDeliverFailedCount', { name, count: messages.size })
          : t('shell.toast.taskDeliverFailed', { name }),
        tier: 'error',
        onDismiss: clear,
        onAutoClose: clear,
      })
    }
    window.addEventListener(UI_EVENTS.sessionpageDeliverFailed, handleSessionpageDeliverFailed)
    return () => window.removeEventListener(UI_EVENTS.sessionpageDeliverFailed, handleSessionpageDeliverFailed)
  }, [contacts, t])

  // @@@sessionpage 分享 — 会话页头部点了「分享这个 agent 的名片」:main 只转达 agentUserId + 名字,咕咕号与
  // 头像从**通讯录同一份数据**取(自有 agent 就在 contacts 里),再交给既有的 SharePosterDialog 出卡片 ——
  // 与「群里点 agent 头像 → 名片 → 分享」走的是同一个组件、同一种 QR,不另做一套。
  // 无咕咕号 ≠ 不能分享:咕咕号是懒分配的(开启公开时才铸),浮层自己呈现「未分配 + 开启公开」这一态,
  // 号一到位就地变成可复制的名片(❌ 一句 toast 把人挡在外面)。
  useEffect(() => {
    const handleSessionpageShareAgent = (event: Event) => {
      const detail = (event as CustomEvent).detail as
        | { agentUserId?: string; displayName?: string; sessionId?: string }
        | undefined
      if (!detail?.agentUserId) return
      const contact = contacts.find((c) => c.id === detail.agentUserId)
      const name = contact?.alias?.trim() || contact?.display_name || detail.displayName || detail.agentUserId
      setShareAgentPoster(false)
      setShareAgentCard({ name, agentUserId: detail.agentUserId, sessionId: detail.sessionId ?? '' })
    }
    // 这个会话根本没有绑定 agent(还没 provision 完 / 非会话页 provider):点了也要有反应并说清原因,
    // ❌ 让入口点下去毫无动静(owner 实机反馈「分享按钮点击没反应」)。
    const handleUnavailable = (event: Event) => {
      const reason = (event as CustomEvent).detail
      toast(typeof reason === 'string' && reason ? reason : t('shell.toast.shareUnavailable'), 'info')
    }
    window.addEventListener(UI_EVENTS.sessionpageShareAgent, handleSessionpageShareAgent)
    window.addEventListener(UI_EVENTS.sessionpageShareAgentUnavailable, handleUnavailable)
    return () => {
      window.removeEventListener(UI_EVENTS.sessionpageShareAgent, handleSessionpageShareAgent)
      window.removeEventListener(UI_EVENTS.sessionpageShareAgentUnavailable, handleUnavailable)
    }
  }, [contacts, t, toast])

  const switchingRef = useRef(false)
  const handleSwitchToChat = async (target: ContactUser, draft?: string, sourceChatId?: string) => {
    const existing = chats.find((chat) => (
      (chat.kind === 'dm' || chat.kind === 'ai') && chat.peer_user_id === target.id
    ))
    // A group participant already owns its session; no DM record or network creation is needed to open it.
    if (!existing && sourceChatId && openOwnedAgent(undefined, target.id, draft, sourceChatId)) return
    if (existing) {
      if (draft) writeDraft(existing.id, draft)
      if (openChatBlock(existing.id, 'profile-chat', target.id, draft, sourceChatId)) {
        void refreshChats()
        return
      }

      setActiveChatId(existing.id)
      setAgentCreateDraftOpen(false)
      setActiveTab('chats')
      setMobilePane('chat')
      focusComposerForUserEntry('profile-chat')
      void refreshChats()
      return
    }

    // @@@no-unowned-agent-dm (#509) - a user may not open a private DM with an agent
    // you do not own. #1735: 原先仅 console.warn = 用户视角的静默 no-op（发现页点别人的公开
    // agent「什么都不发生」）——规则不变，反馈从静默升级为可见 toast（fail-loud）。
    if (target.type === 'agent' && target.owner_user_id != null && target.owner_user_id !== user.id) {
      console.warn('[chat] DM with an agent you do not own is not allowed; use the shared group', target.id)
      toast(t('shell.toast.unownedAgentDm'), 'error')
      return
    }

    if (switchingRef.current) return
    switchingRef.current = true
    try {
      const chatId = await chatService.getOrCreateDM(user.id, target.id)
      upsertChat(createOptimisticDmChat(chatId, target.id))
      if (draft) writeDraft(chatId, draft)
      if (openChatBlock(chatId, 'profile-chat', target.id, draft, sourceChatId)) {
        void refreshChats()
        return
      }
      setActiveChatId(chatId)
      setAgentCreateDraftOpen(false)
      setActiveTab('chats')
      setMobilePane('chat')
      focusComposerForUserEntry('profile-chat')
      void refreshChats()
    } catch (err) {
      // 点了「发消息」却开不了会话(断网、库拒绝…):❌ 留一个没人接的 rejection 让按钮看着像坏了(#6832)。
      openChatLog.error({ targetId: target.id, error: String(err) }, 'getOrCreateDM failed')
      toast(t('shell.toast.openChatFailed'), 'error', messageForUser(err))
    } finally {
      switchingRef.current = false
    }
  }

  const handleOpenProfileChat = (target: MemberProfileChatTarget) => {
    // The session may be on another machine: the one session entry decides how to open it (#626).
    if (target.session) return void followLink({ kind: 'session', sessionId: target.session.sessionId })
    const contact = contacts.find((item) => item.id === target.id)
    return handleSwitchToChat({
      id: target.id,
      display_name: target.displayName,
      avatar: target.avatar,
      email: target.email,
      bio: target.bio,
      type: target.type,
      alias: contact?.alias ?? null,
    })
  }

  // 手机上从群成员里建好 agent:回到那个群(与桌面 openAgentChat 的落点同一条规则)。
  const handleReturnToGroup = (chatId: string) => {
    if (openChatBlock(chatId, 'group-chat')) return
    setActiveChatId(chatId)
    setActiveTab('chats')
    setMobilePane('chat')
    focusComposerForUserEntry('group-chat')
  }

  const handleOpenGroupChat = (group: ContactGroupChat) => {
    upsertChat(createOptimisticGroupChat(group.id, group.name))
    if (openChatBlock(group.id, 'group-chat')) {
      void refreshChats()
      return
    }
    setActiveChatId(group.id)
    setAgentCreateDraftOpen(false)
    setActiveTab('chats')
    setMobilePane('chat')
    focusComposerForUserEntry('group-chat')
    void refreshChats()
  }

  const handleOpenSessionpageAgentFile = useCallback(async (
    agentUserId: string,
    path: string,
  ): Promise<void> => {
    const api = (window as unknown as {
      electronAPI?: { invoke?: (channel: string, ...args: unknown[]) => Promise<unknown> }
    }).electronAPI
    if (!api?.invoke) throw new Error(t('shell.errors.taskBridgeUnavailable'))
    // The session opens the one way; then its file there.
    if (!(await openLink({ kind: 'session', agentId: agentUserId }))) throw new Error(t('shell.errors.taskBridgeUnavailable'))
    await api.invoke('sessionpage:open-agent-file', agentUserId, path)
  }, [t])

  useEffect(() => {
    if (!sessionHostAvailable) return
    const w = window as typeof window & { __GUGU_SESSIONPAGE_MESSAGES__?: SessionpageMessageHost }
    const host: SessionpageMessageHost = {
      sendMessageToChat,
      // #4325 —— 创建面的首轮附件与聊天页 composer 用的是**同一个批执行器**:同样逐件
      // upload → insert → 读回验证,任一件失败即 throw(❌ 不静默 continue),已提交的由 onSent 回报。
      // 这里没有 create 专用的上传/消息类型/投递分支,只是把同一份实现暴露给创建 composer。
      async sendAttachmentsToChat(chatId, files, options) {
        // 逐件回报按**顺序**认领:sendAttachmentBatch 按 args.files 的顺序处理、每成功一件回报一次,
        // 所以移动游标是精确的。❌ 不按 File 实例做 identity 匹配 —— 同一个 File 被排两次时它会把
        // 第一件认领两遍,把另一件永远留在队列里(下次提交重复上传)。
        let sentCursor = 0
        await sendAttachmentBatch({
          files: files.map((entry) => entry.file),
          chatId,
          senderId: user.id,
          toUserIds: options.toUserIds,
          appendMessage,
          onSent: () => {
            const entry = files[sentCursor++]
            if (entry) options.onSent(entry.id)
          },
        })
      },
      async sendCardToChat(chatId, content) {
        await chatService.sendMessage(chatId, user.id, content, crypto.randomUUID(), 'card')
      },
      rememberedTaskProject: async (chatId, deviceId) => rememberedAgentCreateProject(await readAgentCreateDefaults(), deviceId, chatId),
      rememberTaskProject: async (chatId, deviceId, projectId) => { await rememberAgentCreateProject(deviceId, projectId, chatId) },
      // 对话页「新建 Agent」落地的唯一导航入口:创建结果直驱,不经广播转手 (#4314)。
      openAgentChat({ chatId, agentUserId }) {
        upsertChat(createOptimisticAgentChat(chatId, agentUserId))
        // 从群成员里建的:人回到那个群(agent 一出生就进群),第一句话和它的回答留在私聊里(owner 10-15 定)。
        const birthGroup = agentCreateBirthGroupRef.current
        setAgentCreateDraftOpen(false)
        setAgentCreateDraftRetained(false)
        if (openChatBlock(birthGroup?.chatId ?? chatId, birthGroup ? 'group-chat' : 'agent-created')) {
          void refreshChats()
          return
        }
        setActiveChatId(birthGroup?.chatId ?? chatId)
        setActiveTab('chats')
        setMobilePane('chat')
        // 新建 agent 落地就是一次「用户主动进入可输入语境」——他刚打完第一句话,下一句该能直接接着打。
        focusComposerForUserEntry(birthGroup ? 'group-chat' : 'agent-created')
        void refreshChats()
      },
    }
    w.__GUGU_SESSIONPAGE_MESSAGES__ = host
    return () => {
      if (w.__GUGU_SESSIONPAGE_MESSAGES__ === host) delete w.__GUGU_SESSIONPAGE_MESSAGES__
    }
  }, [appendMessage, focusComposerForUserEntry, openChatBlock, refreshChats, sendMessageToChat, setActiveChatId, sessionHostAvailable, upsertChat, user])

  useEffect(() => {
    if (!sessionHostAvailable) return
    const w = window as unknown as {
      __GUGU_SESSION_CREATED__?: (created: { projectId: string; sessionId: string }) => void
    }
    w.__GUGU_SESSION_CREATED__ = () => {
      setSessionCreateOpen(false)
      setMobilePane('list')
      toast(t('shell.toast.taskCreated'), 'success')
    }
    return () => {
      delete w.__GUGU_SESSION_CREATED__
    }
  }, [t, sessionHostAvailable, toast])

  const handleScan = async () => {
    let raw: string | null
    try {
      raw = await platform.scanQrCode()
    } catch (err) {
      // product spec:相机没开是「缺了干不了活」—— 当场拦下并给一步去开的路,❌ 只丢一句 toast。
      if (
        err instanceof PlatformError
        && err.code === 'BARCODE_SCAN_CAMERA_PERMISSION_DENIED'
        && platform.systemPermissions.includes('camera')
      ) {
        setCameraPermissionSheetOpen(true)
        return
      }
      // fail-loud (#1122): surface the real reason (permission / plugin / device) instead of a
      // generic failure — and never confuse it with a user cancel (which returns null below).
      const reason = describeBarcodeScanError(err, t)
      toast(t('shell.toast.scanFailed', { reason }), 'error')
      return
    }
    if (!raw) return // user cancelled
    const route = resolveQrScanRoute(raw)
    if (!route) {
      toast(t('shell.toast.qrUnrecognized'), 'error')
      return
    }
    setActiveTab('contacts')
    setScanSeed({ route, token: Date.now() })
  }

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.metaKey) {
        // ⌘1 =「消息」(gugu-dev#181):会话页侧栏里的「项目 | 对话」;没有会话页的形态落在聊天页。
        if (e.key === '1') {
          e.preventDefault()
          selectTab(sessionHostAvailable && !mobile ? 'tasks' : 'chats')
          if (sessionHostAvailable && !mobile && registeredViews()[appState.navigation.currentViewId].withoutSessionSidebar) returnToScreen()
        }
        else if (e.key === '2') { e.preventDefault(); selectTab('contacts') }
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [selectTab, sessionHostAvailable, mobile])

  // 手机壳里盖在页面上的层与 Sheet 同一个返回栈(ui/sheetStack.ts);任务 tab 那一层在 AgentWatchPage 里。
  useBackLayer(() => setSettingsModalOpen(false), mobile && settingsModalOpen)
  useBackLayer(() => setSessionCreateOpen(false), mobile && showSessionCreate)

  // 页面那一层:栈里没有层时,聊天详情退回列表。
  useEffect(() => {
    if (!mobile) return
    const handleNativeBack = () => {
      // 有层开着时返回键归栈顶那一层(同 Escape,见 ui/sheetStack.ts),这一层不动下面的页面。
      if (isSheetOpen()) return
      // 推进来的一层退到它自己的根(咕咕聊天段、我的、项目的根页由它自己的那层接)就整层退回列表首页。
      if (phoneLayerOpen) {
        (window as Window & { __guguNativeBackHandled?: boolean }).__guguNativeBackHandled = true
        exitPhoneLayer()
        return
      }
      if (activeTab !== 'chats' || mobilePane !== 'chat') return
      (window as Window & { __guguNativeBackHandled?: boolean }).__guguNativeBackHandled = true
      backFromPhoneChat()
    }
    window.addEventListener(NATIVE_BACK_EVENT, handleNativeBack)
    return () => window.removeEventListener(NATIVE_BACK_EVENT, handleNativeBack)
  }, [activeTab, mobile, mobilePane, phoneLayerOpen, exitPhoneLayer, backFromPhoneChat])

  // 「我的」tab 只存在于移动 shell;resize 跨到桌面时回落会话页、以设置弹窗承接
  useEffect(() => {
    if (!mobile && activeTab === 'settings') {
      setActiveTab(sessionHostAvailable ? 'tasks' : 'chats')
      setSettingsModalOpen(true)
    }
  }, [mobile, activeTab, sessionHostAvailable])

  return (
    <div
      ref={shellRootRef}
      data-phone-shell={mobile ? '' : undefined}
      data-gugu-shell-phase={effectsActive ? 'active' : 'committed-inert'}
      data-desktop-shell={mobile ? undefined : ''}
      // 手机全线一个底:咕咕页那套渐变 + 玻璃(owner 10-26),壳上挂 data-ta-scope 让 --ta-* 处处可用。
      data-ta-scope={mobile ? '' : undefined}
      style={{
        display: 'flex',
        width: '100vw',
        height: mobile ? phoneViewport.viewportHeight ?? '100dvh' : '100vh',
        position: mobile ? 'fixed' : undefined,
        top: mobile ? phoneViewport.viewportOffsetTop : undefined,
        left: mobile ? 0 : undefined,
        overflow: 'hidden',
        background: mobile ? 'var(--ta-panel-bg)' : 'var(--shell-bg)',
        // @@@mobile-safe-area-top (#1227) — Android 15+ (targetSdk 36) 强制 edge-to-edge：WebView
        //   绘到状态栏下，顶栏会被遮。整个移动 shell 顶部留状态栏安全区（box-sizing:border-box
        //   全局，100dvh 内收不溢出；env=0 在无刘海/桌面安全回退）。即 paddingTop:env(safe-area-inset-top)。
        paddingTop: mobile ? 'env(safe-area-inset-top)' : undefined,
      }}
    >
      {/* 低余额充值直达积分卡,桌面订阅、手机账户。 */}
      <LowBalanceBanner user={effectsActive ? user : null} onRecharge={() => openSettingsSection(membershipSettingsSection(mobile))} />
      {mobile && <UpdateBanner />}
      {!mobile && (
        <Sidebar
          activeTab={activeTab}
          onTabChange={selectTab}
          settingsOpen={settingsModalOpen}
          pendingContactsCount={pendingRequestCount}
          sessionAttention={sessionAttention}
        />
      )}

      <div
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          margin: 0,
          borderRadius: 'var(--radius-page)',
          overflow: 'hidden',
          position: 'relative',
          display: 'flex',
          flexDirection: mobile ? 'column' : 'row',
          boxShadow: 'none',
          background: mobile ? 'transparent' : 'var(--shell-bg)',
        }}
      >
        {/* 会话页常驻不卸载:会话页子应用启动重(14MB bundle + 运行时初始化),切走即销毁 →
            切回=整套重启(owner 实测 30s)。改为 display 隐藏,子应用/终端/agent 会话跨切换存活。
            挂不挂只看 sessionHost 能力(构建目标),不看 shell 宽度:桌面 Electron 永不进移动 shell(#3566),
            移动 shell(web 目标窄视口 / Capacitor)靠无头 sessionHost 承载 #2525 的全屏创建页,所以照挂不误。
            #2549:这份唯一实例现在也承载对话页创建草稿态——sessionSlotRef/composerSlotRef 是两个永远挂载
            (只 display 切换、绝不条件卸载)的空槽,只当位置量尺;真正的 <EmdashSessionFrame/> 挂在下面
            emdashFrameHomeRef 这个稳定 JSX 位置、DOM 节点自始至终不移动,由上面的 useLayoutEffect 用
            position:fixed + getBoundingClientRect 把它视觉盖到当前该去的那个槽上——❌ ReactDOM.
            createPortal 换 target(卸载重挂)、❌ 裸 appendChild 搬家(会在原父节点插入新兄弟时炸
            insertBefore),两条都在真流式会话上实测过,见 #2549。 */}
        {/* 移动 shell 下这个槽永远 display:none(移动端没有任务 tab)——正是「隐藏槽 = 零 rect =
            overlay 也隐藏」这条规则,让"创建页关掉后 frame 该藏起来"不需要任何额外分支。 */}
        {sessionHostAvailable && (
          <div ref={sessionSlotRef} style={{ flex: 1, minWidth: 0, overflow: 'hidden', display: !mobile && activeTab === 'tasks' ? 'flex' : 'none' }} />
        )}

        <MobileTabPager
          mobile={mobile}
          tabs={tabs}
          activeTab={pagerTab}
          covered={phoneLayerOpen}
          swipeable={tabBarVisible}
          onSettle={selectTab}
          tabBarRef={tabBarRef}
          pages={{
            // #6158 聊天面常驻(与上面会话页那格同法):切到别的 tab 只隐藏(见 lib/retainedSurface.ts),❌ 条件卸载、❌ 换 key 重挂 ——
            // 话题分栏/选中会话/滚动/分栏草稿全是本地状态。隐藏期间快捷键与「看见即已读」由 ChatAreaPanel/ChatListPanel 按 activeTab 门控(#6089)。
            // 手机壳里它是分页器的一页,不隐藏(横滑时相邻页要看得见),只 inert(MobileTabPager)。
            // gugu-dev#181 桌面上(有会话页)没有单独的聊天页:对话是会话页这屏的一块,列表在会话页侧栏「对话」里。
            chats: !chatsAreBlocks && (
              <div key="chat" style={{ display: 'flex', flexDirection: mobile ? 'column' : 'row', flex: 1, minWidth: 0, overflow: 'hidden', ...(activeTab === 'chats' || mobile ? undefined : RETAINED_SURFACE_HIDDEN_STYLE) }}>
                  {/* #2525 移动端全屏创建页:列表/会话/底部 tab 岛全部让位(display 隐藏而非卸载 ——
                      返回时列表滚动位置与会话状态原样还在),真正的 composer 由下面那份 fixed overlay
                      盖到本页正文槽上。 */}
                  <ResizableChatListPane
                    active={activeTab === 'chats'} mobile={mobile}
                    hidden={chatListHidden}
                    width={chatListPaneWidth}
                    onWidthChange={previewChatListPaneWidth}
                    onWidthCommit={commitChatListPaneWidth}
                  >
                    <ChatListPanel
                      activeTab={activeTab}
                      mobile={mobile}
                      hidden={chatListHidden}
                      lead={mobile && (phoneAssistant.available || sessionAttention === 'needs_user') ? <>{phoneAssistant.available && <PhoneAssistantRow state={phoneAssistant} onOpen={openPhoneAssistant} />}<NeedsYouSlot list /></> : undefined}
                      leadChatId={phoneAssistant.chatId}
                      headerLeading={mobile ? <PhoneMeButton user={user} onOpen={() => selectTab('settings')} /> : undefined}
                      onChatSelected={(focusTarget = 'composer') => navigateMobile(() => {
                        setProjectChatFromPartners(false)
                        setAgentCreateDraftOpen(false)
                        setSessionCreateOpen(false)
                        setMobilePane('chat')
                        if (focusTarget === 'composer') focusComposerForUserEntry('chat-entry')
                      }, 'push')}
                      onScan={handleScan}
                      onOpenAgentCreateDraft={openAgentCreateDraft}
                      onOpenSessionCreate={mobile && sessionHostAvailable ? openSessionCreate : undefined}
                      onNewProject={mobile ? openNewProject : undefined}
                    />
                  </ResizableChatListPane>
                  <div data-shell-chat-detail={mobile ? undefined : ''} style={{ flex: '1 1 auto', minWidth: 0, minHeight: 0, position: 'relative', display: mobile && (mobilePane !== 'chat' || showCreateSurface) ? 'none' : 'flex' }}>
                    {!mobile && acpCreateComposer && (
                      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: showAgentCreateDraft ? 'flex' : 'none' }}>{acpCreateComposer}</div>
                    )}
                    {/* 创建面打开时聊天区只隐藏不卸载(同 #6158 的常驻面):从前条件卸载,关掉创建面回来 = 整个面板重挂,
                        消息列表、滚动位置、分栏、群协作状态全部重来一遍,就是那一下白闪。 */}
                    <div className="flex min-h-0 min-w-0 flex-[1_1_auto]" style={showCreateSurface || assistantOnPhone ? RETAINED_SURFACE_HIDDEN_STYLE : undefined}>
                      <ChatAreaPanel
                        chatId={activeChatId}
                        navigationTarget={unreadNavigationTarget === 'chat'}
                        activeTab={activeTab}
                        hidden={showCreateSurface || onScreenChatId !== activeChatId}
                        mobile={mobile}
                        openNonce={chatOpenNonce}
                        onBack={mobile ? backFromPhoneChat : undefined}
                        onOpenUserChat={handleOpenProfileChat}
                        onOpenSessionpageAgentFile={!mobile && sessionHostAvailable ? handleOpenSessionpageAgentFile : undefined}
                      />
                    </div>
                  </div>
                  {mobile && showSessionCreate && (
                    <MobileCreatePage
                      slotRef={composerSlotRef}
                      onBack={() => setSessionCreateOpen(false)}
                      backLabel={t('shell.back')}
                      title={t('shell.newTask')}
                      testId="mobile-session-create-page"
                    />
                  )}
                </div>
            ),
            // 联系人面与聊天面同法常驻(lib/retainedSurface.ts):每次进来都重挂约 1,500 个组件。手机壳里本来就常驻。
            contacts: (
              <div key="contacts" style={{ flex: 1, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', ...(activeTab === 'contacts' || mobile ? undefined : RETAINED_SURFACE_HIDDEN_STYLE) }}>
                <div data-shell-contacts={mobile ? undefined : ''} style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
                  {mobile ? (
                    <PhonePartnersPage
                      user={user}
                      active={activeTab === 'contacts' || projectChatFromPartners}
                      externalContactId={externalContactId}
                      scanSeed={scanSeed}
                      newProjectRequest={newProjectRequest}
                      onOpenMe={() => selectTab('settings')}
                      onPushedChange={setPartnersPushed}
                      onLeave={() => navigateMobile(() => setActiveTab('chats'), 'pop')}
                      onSwitchToChat={handleSwitchToChat}
                      onOpenGroupChat={handleOpenGroupChat}
                      onOpenProjectGroup={(chatId) => navigateMobile(() => {
                        setProjectChatFromPartners(true)
                        openChatTarget(chatId)
                        closeTopicTab(chatId)
                      }, 'push')}
                    />
                  ) : (
                    <ContactsPanel externalContactId={externalContactId} activeTab={activeTab} mobile={mobile} scanSeed={scanSeed} onSwitchToChat={handleSwitchToChat} onOpenGroupChat={handleOpenGroupChat} onOpenAgentCreateDraft={openAgentCreateDraftFromContacts} />
                  )}
                </div>
              </div>
            ),
            // 桌面上 'settings' 落不到这里(下面那个 effect 改开设置弹窗);手机上「我的」是推进来的一层(见下)。
            settings: !mobile && activeTab === 'settings' && (
              <div key="settings" style={{ flex: 1, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex' }}>
                  <SettingsPanel
                    key={settingsSection}
                    inline
                    initialSection={settingsSection}
                    pane={settingsPane}
                    onPaneChange={setSettingsPane}
                  />
                </div>
              </div>
            ),
          }}
        />

        {/* 手机上推在「消息 / 伙伴」首页上的三层(owner 10-26,OpenDCAI/gugu#446):整屏、没有底栏,返回回到推它之前那一格。
            常驻只藏(PhoneLayer):草稿、滚动位置、各自往下钻的层级都在,同从前它们是分页器里的一页。 */}
        {mobile && (
          <>
            {/* #7199 咕咕:「消息」置顶第一行点进来;默认是和它的聊天,页头分段切 动态 / 任务 / 记忆,头像去资料。 */}
            {phoneAssistant.available && (
              <PhoneLayer open={activeTab === 'assistant'} testId="mobile-assistant-layer">
                <MobileAssistantTab state={phoneAssistant} visible={activeTab === 'assistant'} navigationTarget={unreadNavigationTarget === 'assistant'} chatRequest={assistantChatRequest} onExit={exitPhoneLayer} onOpenUserChat={handleOpenProfileChat} />
              </PhoneLayer>
            )}
            {/* 看管 agent(项目 → 会话 → 时间线),❌ 不是桌面那张会话页 IDE 面(那个 <720px 真不适配,它的槽在上面照旧 display:none)。 */}
            <PhoneLayer open={activeTab === 'tasks'} testId="mobile-sessions-layer">
              <div className="gg-aw-tab-slot">
                <AgentWatchPage
                  active={activeTab === 'tasks'}
                  onExit={exitPhoneLayer}
                  createRequest={watchCreateRequest}
                  createInGroup={watchCreateGroup}
                  openRequest={watchOpenRequest}
                  onOpenGroupChat={handleReturnToGroup}
                />
              </div>
            </PhoneLayer>
            {/* 「我的」:页头左上角自己的头像点进来;nav 层左上返回回列表首页,detail 再推一层。 */}
            <PhoneLayer open={activeTab === 'settings'} testId="mobile-settings-layer">
              <SettingsPanel
                mobile
                appDetail={appDetail}
                inline
                section={settingsSection}
                onSectionChange={setSettingsSection}
                pane={settingsPane}
                onPaneChange={(next) => navigateMobile(() => setSettingsPane(next), next === 'nav' ? 'pop' : 'push')}
                onClose={exitPhoneLayer}
              />
            </PhoneLayer>
          </>
        )}

        {/* #2549 — position:fixed overlay, sized/positioned by the useLayoutEffect above to cover
            whichever of sessionSlotRef/composerSlotRef is current. Base state here (0×0, hidden,
            unclickable) is what's visible before that effect's first run — never a flex participant,
            so this JSX position can stay fixed forever without any conditional-sibling insertBefore
            crash (see the effect's comment for why that matters). content-visibility over display:none so the
            page keeps its layout while hidden; pointerEvents mirrors visibility so a
            visually-hidden frame never eats clicks meant for whatever's actually on screen. */}
        {/* 门只看 sessionHost 能力,不看 shell 宽度(见 @@@web-target-gate;❌ 不是旧说法的「没有会话页
            资产」)。桌面 Electron 永不进移动 shell(#3566);移动 shell 里(web 目标窄视口 / Capacitor,
            sessionHost 在场时)这份实例要承载 #2525 的全屏创建页,也绝不能因为一次视口变化就被卸载
            (冷启动 ~30s、正在跑的会话/终端随之全灭)。 */}
        {sessionHostAvailable && (
          <div
            ref={emdashFrameHomeRef}
            style={{ position: 'fixed', top: 0, left: 0, width: 0, height: 0, overflow: 'hidden', contentVisibility: 'hidden', transform: 'scale(0)', pointerEvents: 'none', zIndex: 5 }}
          >
            <EmdashSessionFrame />
          </div>
        )}

        {effectsActive && <SessionInputOutboxHost accountId={user.id} />}{mobile && <AgentWatchRoot />}
        {mobile && platform.kind === 'capacitor' && <PhoneDeviceRoot />}

        {/* The mobile navigation is shell chrome, not state owned by a retained tab subtree. */}
        {tabBarVisible && (
          <MobileTabBar
            activeTab={pagerTab}
            onTabChange={selectTab}
            pendingContactsCount={pendingRequestCount}
            barRef={tabBarRef}
            tabs={tabs}
            viewport={phoneViewport}
          />
        )}

      </div>

      <ResourceMonitorHost />
      {settingsModalOpen && <SettingsPanel mobile={mobile} section={settingsSection} onSectionChange={setSettingsSection} onClose={() => setSettingsModalOpen(false)} />}
      {cameraPermissionSheetOpen && <CameraPermissionSheet onClose={() => setCameraPermissionSheetOpen(false)} />}
      <RemoteMachinesHost enabled={sessionHostAvailable} openSettingsSection={openSettingsSection} />

      {/* @@@sessionpage 分享 — 会话页头部触发。先出浮层:咕咕号 / Agent ID / 会话 ID / 邀请链接一张表,整行点击即复制;
          「生成名片海报」才打开既有 SharePosterDialog。owner 实机反馈:直接弹海报是错的形态,海报是一张图,链接和 ID 都复制不了。
          浮层只做分享(#6093):agent 名 / ID、会话 ID 归侧栏身份卡(#6092),改名归「重命名」弹窗(#6091)。 */}
      {shareAgentCard && !shareAgentPoster && (
        <AgentSharePopover
          name={shareAgentName}
          guguNumber={shareAgentNumber}
          agentUserId={shareAgentCard.agentUserId}
          anchor={resolveShareAnchor}
          inviteUrl={shareAgentNumber === null
            ? null
            : createGuguQrScanUrl(createContactQrPayload(shareAgentNumber), { downloadUrl: GUGU_ANDROID_DOWNLOAD_URL })}
          onOpenPoster={() => setShareAgentPoster(true)}
          // 开启公开 = 铸号(set_agent_public 的一部分);通讯录随 putIdentities 更新,号在下一帧就出现在浮层里。
          onMakePublic={() => setAgentPublic(shareAgentCard.agentUserId, true)}
          onClose={() => setShareAgentCard(null)}
        />
      )}
      {shareAgentCard && shareAgentPoster && shareAgentNumber !== null && (
        <SharePosterDialog
          title={shareAgentName}
          subtitle={t('shell.shareSubtitle', { number: shareAgentNumber })}
          qrValue={createGuguQrScanUrl(createContactQrPayload(shareAgentNumber), { downloadUrl: GUGU_ANDROID_DOWNLOAD_URL })}
          onClose={() => { setShareAgentPoster(false); setShareAgentCard(null) }}
        />
      )}
      {openedPhoneApp && (
        <Sheet fullScreenMobile onClose={() => setOpenedPhoneApp(null)} testId="app-link-page" ariaLabel={openedPhoneApp.name}>
          <PaneHeader mobile divider title={openedPhoneApp.name} leading={<RightPanelBackButton onBack={() => setOpenedPhoneApp(null)} />} />
          <SessionAppFrame kind={openedPhoneApp.kind} />
        </Sheet>
      )}
      <ExtensionForwardHost />
      {/* 摩擦单 F6: an install is consented to here, over whatever view is on screen. */}
      <ExtensionConsentSheet />
      <NeedsYouHost onAttentionChange={setSessionAttention} />

      {/* @@@822 frameless 自绘窗口控制(Windows/Linux 右上角 min/max/close);Mac/web 自渲染为 null。
          ⚠️ **必须挂在整棵壳的最后** —— Electron 把 Blink 收集到的 drag / no-drag 矩形按 **DOM 序**
          依次 union / subtract 成一块 SkRegion,后来者覆盖先来者。顶栏那条通栏 drag 带
          (`[-webkit-app-region:drag]`,会话页 inset-x-0 top-0 h-10)横跨到窗口右缘、盖住这三颗钮:
          控制条排在它**前面**时,它的 no-drag 会被后面那条 drag 重新并回去 ⇒ 三颗钮所在的点
          WM_NCHITTEST 回 HTCAPTION,系统当标题栏吃掉点击,按钮**完全按不动**。
          实测(chole/Windows 11,真鼠标点击 + WM_NCHITTEST):挂最前 ht=2、点最小化窗口不动;
          挂最后 ht=1、点最小化窗口收起。❌ 别把它移回上面去。 */}
      <WindowControls activeTab={activeTab} mobile={mobile} activeChatId={activeChatId} chats={chats} sessionHostAvailable={sessionHostAvailable} onSelectTab={selectTab} onOpenChat={(chatId) => { if (!chatId || !openChatBlock(chatId)) setActiveChatId(chatId) }} onNewAgent={openAgentCreateDraftFromContacts} onOpenSettings={openSettingsSection} />
      {/* #7199 「助理」App 在壳这一侧的那一半:发布云电脑 / 个人助理,把壳的组件画进 App 留的格子(lib/assistantShellBridge.ts)。 */}
      <AssistantTaskChatOpener visible={mobile ? activeTab === 'assistant' : activeTab === 'tasks'} onOpenUserChat={handleOpenProfileChat} onOpenSessionpageAgentFile={handleOpenSessionpageAgentFile} />
      <FeedbackHost />
      {/* #7350 关闭咕咕只有一份确认:设置、通讯录、agent 设置都只发一声(lib/assistantClose),这里按它住哪画。 */}
      <AssistantCloseHost />
      {!mobile && sessionHostAvailable && (
        <AssistantShellHost
          visible={activeTab === 'tasks'}
          onOpenUserChat={handleOpenProfileChat}
         
          onOpenSessionpageAgentFile={handleOpenSessionpageAgentFile}
        />
      )}
      {/* gugu-dev#181 项目块、对话块里的对话:会话页留格子(lib/shellSlots.ts 的 chat:<id>),这里画进去。 */}
      {!mobile && sessionHostAvailable && (
        <ChatSlotHost
          onOpenUserChat={handleOpenProfileChat}
         
          onOpenSessionpageAgentFile={handleOpenSessionpageAgentFile}
        />
      )}

    </div>
  )
}

// ── MainLayout ─────────────────────────────────────────────────────────────────

export function MainLayout({
  user,
  effectsActive = true,
  onShellCommitted,
}: MainLayoutProps) {
  const mobile = useMobileShell()
  return (
    <ContactsProvider active={effectsActive}>
      <DevicesProvider active={effectsActive}>
        {/* 批准页的机器移除与设置共用这份设备数据。 */}
        <ServerLoginApproveHost active={effectsActive} />
        {effectsActive && <SearchIndexWiring userId={user.id} />}
        <InnerLayout
          user={user}
          effectsActive={effectsActive}
          onShellCommitted={onShellCommitted}
        />
        {/* gugu-dev#181 会话页侧栏「对话」那一格(lib/shellSlots.ts 的 chat-list)和两枚页签上的未读数。
            在 InnerLayout 外面:切 tab 时 InnerLayout 整个重画,这张表不跟着重画。 */}
        {!mobile && platform.capabilities.sessionHost && <ChatListSlotHost />}
      </DevicesProvider>
    </ContactsProvider>
  )
}
