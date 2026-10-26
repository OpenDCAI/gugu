import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { navigateMobile } from '../navigateMobile'
import { useTranslation } from 'react-i18next'
import { inferAttachmentKind } from '@gugu/core/shared/ui/attachmentModels'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { PaneHeader } from '@/components/ui/Pane'
import { SegmentedTabs } from '@/components/ui/SegmentedTabs'
import { Avatar } from '@/components/Avatar'
import { ChatAreaPanel } from '@/components/ChatAreaPanel'
import { FilePreviewHost } from '@/components/chat/filePreviewHost'
import { AssistantCustomizeCard } from '@/components/assistant/AssistantCustomizeCard'
import { useCustomizeCardOffered } from '@/lib/assistantSetupState'
import { useAuth } from '@/store/auth'
import type { AssistantChatHandlers } from '@/components/assistant/AssistantChatSlot'
import { useAssistantTyping } from '@/components/assistant/useAssistantTyping'
import { AssistantConversationProgress } from '@/components/assistant/AssistantConversationProgress'
import { useBackLayer } from '@/components/ui/sheetStack'
import type { AssistantHomePlace } from '@/lib/assistantHome'
import { assistantTintHue, assistantTintStyle } from '@/lib/assistantTint'
import { IdeasEntry } from '@/session/renderer/features/assistant/assistant-ideas'
import { scheduleComposerFocus } from '@/lib/focusComposer'
import { ArrowUpToLine, ChevronLeft, Mic, Plus, Search, Sparkles } from '@/lib/icons'
import { useReportChatOnScreen } from '@/lib/onScreenChat'
import { UI_EVENTS } from '@/lib/uiEvents'
import { showAssistantTaskChat, useOpenedAssistantTaskChat } from '@/lib/assistantTaskChat'
import { ShellSlot } from '@/session/renderer/features/assistant/assistant-shell'
import { useChatStore } from '@/store/chatContext'
import { ChatLineScope } from '@/store/chatLineScope'
import { PhoneHomeContext } from './phoneHome'
import { PhoneIdeas } from './PhoneIdeas'
import { PhoneMemory } from './PhoneMemory'
import { PhoneProfile } from './PhoneProfile'
import { PhoneTasks } from './PhoneTasks'
import { phoneNextRoute, phoneParentRoute, type PhoneParentRoute } from './phoneRoutes'
import { PhoneToday } from './PhoneToday'
import { PhoneVoiceBar } from './PhoneVoiceBar'
import { usePhoneVoiceNotes } from './phoneVoiceRuntime'
import { readinessOf, useCloudDevice, usePhoneMachine, type PhoneMachineState, type PhoneReadiness } from './phoneMachine'
import '@/session/renderer/features/assistant/assistant-today.css'
import './assistant-phone.css'

export const PHONE_TABS = ['chat', 'today', 'tasks', 'memory', 'profile'] as const
export type PhoneTab = (typeof PHONE_TABS)[number]
/** 页头分段里的几格;「资料」不占一格,点页头它的头像就是(owner 10-26 改版稿)。 */
const PHONE_SEGMENTS = PHONE_TABS.filter((id) => id !== 'profile')
/** 此刻摆着哪一页:某一格(往下钻到 `sub`)。 */
export type PhoneRoute = PhoneParentRoute<PhoneTab>

export type PhoneAssistant = { id: string; display_name: string; avatar: string | null; created_at: string | null }

/** 每一格拿到的:是谁、它那条私聊、它家里那台此刻能不能读、往聊天里填一句(只填不发)、往下钻。 */
export type PhonePageProps = {
  assistant: PhoneAssistant
  chatId: string
  ownerName: string | null
  /** 它家那台的设备 id(住云上 = 云端宿主,住人自己的电脑 = 那台电脑):读它家里的东西都问这一台。 */
  homeDeviceId: string | null
  /** 云端宿主那台(没有 = null):设备列表里「别的设备」按它排除。 */
  cloudDeviceId: string | null
  /** 它住哪(云上 / 哪台电脑,那台在不在线)。 */
  home: AssistantHomePlace | null
  /** 它家里此刻能不能读;云上收回着时要读的那一块由系统叫起来(PhoneMachineGate),住电脑 = 那台开着才读得到。 */
  readiness: PhoneReadiness
  /** 读写它家里文件用的工作区(各格共用一份,❌ 每格各开一次)。 */
  machine: PhoneMachineState
  /** 把这句话(和要带上的文件)填进和它聊天的输入框并回到聊天:只填不发,人看过再发。 */
  askInChat: (draft: string, files?: File[]) => void
  /** 这一格往下钻到哪(名字与桌面面板同一套:`note:<文件名>`、`routine:<id>`、`connector:<id>`…);首页 = null。 */
  sub: string | null
  go: (sub: string | null) => void
  /** 换到别的格(或它的子页),例如「动态」页「来源」里的「管理连接」去 <名字> 那一格的连接应用。 */
  open: (route: PhoneRoute) => void
}

/** 往下钻的页的上一层(手机自己的一张表,见 phoneRoutes)。 */
function backOf(route: PhoneRoute): PhoneRoute | null {
  const parent = phoneParentRoute(route)
  return parent ? { tab: route.tab, sub: parent.sub } : null
}

function routeDepth(route: PhoneRoute): number {
  const parent = phoneParentRoute(route)
  return parent ? 1 + routeDepth(parent) : 0
}

/** 「分析健康报告」收的文件(与健康页同一份:报告多是 PDF 或拍照 / 截图)。 */
const HEALTH_REPORT_ACCEPT = 'application/pdf,image/*'

/**
 * #7199 手机上的助理 App:「消息」置顶第一行推进来的整屏一层,没有底栏(owner 10-26,OpenDCAI/gugu#446,取代 10-16「咕咕底栏一直在」)。
 * 默认是和它的聊天。页头一行(owner 10-26:「header 占一点 footer 占一点 中间没多少空间」):
 * 返回 · 它的头像(点了去「资料」,它自己的设置也在那里)· 分段 聊天 / 动态 / 任务 / 记忆 · 搜索聊天记录(聊天时)。
 * 往下钻的页左上返回回上一层,顶层的返回回「消息」;安卓返回键:往下钻的页回上一层,别的格回聊天,聊天再退回「消息」。
 * 聊天就是和它的那条私聊(对话列表点它也是切到这里),整套聊天面常驻(切到别的格只藏起来:草稿、滚动位置都在);只有聊天那一段摆在眼前才算「在看」。
 * 底色、卡片、字号读 `--ta-*`(助理主页收到咕咕自己的 token 上),手机里 ❌ 自己写颜色。
 */
function MobileAssistantAppContent({
  chatId,
  assistant,
  ownerName,
  homeDeviceId,
  cloudDeviceId,
  home,
  visible,
  chatRequest, navigationTarget,
  onExit,
  ...chatHandlers
}: {
  chatId: string
  assistant: PhoneAssistant
  ownerName: string | null
  homeDeviceId: string | null
  cloudDeviceId: string | null
  home: AssistantHomePlace | null
  /** 底栏此刻停在「助理」这一格:切到别的格时 App 只藏不卸(分页器里常驻),❌ 还算「在看」。 */
  visible: boolean
  /** 每变一次 = 别处打开了和它的私聊:落在聊天那一段。 */
  chatRequest: number
  navigationTarget?: boolean
  /** 顶层的返回:退回「消息」。 */
  onExit?: () => void
} & AssistantChatHandlers) {
  const { t } = useTranslation('assistant')
  const [route, setRoute] = useState<PhoneRoute>({ tab: 'chat' })
  useEffect(() => {
    const open = () => setRoute({ tab: 'profile', sub: 'connectors' })
    window.addEventListener(UI_EVENTS.openAssistantConnectors, open)
    return () => window.removeEventListener(UI_EVENTS.openAssistantConnectors, open)
  }, [])
  const open = useCallback((target: PhoneRoute) => {
    const next = phoneNextRoute(route, target)
    const change = routeDepth(next) - routeDepth(route)
    navigateMobile(() => setRoute(next), change < 0 ? 'pop' : change > 0 ? 'push' : 'replace')
  }, [route])
  const tab = route.tab
  const opened = useOpenedAssistantTaskChat()
  useEffect(() => {
    if (opened?.request.assistantId === assistant.id) setRoute({ tab: 'tasks' })
  }, [opened, assistant.id])
  const taskChat = tab === 'tasks' && opened?.request.assistantId === assistant.id
  const sub = route.sub ?? null
  useEffect(() => {
    if (chatRequest > 0) setRoute({ tab: 'chat' })
  }, [chatRequest])
  const { writeDraft, draftAttachments, setDraftAttachments } = useChatStore('writeDraft', 'draftAttachments', 'setDraftAttachments')
  const attachmentsRef = useRef(draftAttachments)
  attachmentsRef.current = draftAttachments
  const [ideasOpen, setIdeasOpen] = useState(false)
  const [chatColumn, setChatColumn] = useState<HTMLDivElement | null>(null)
  const chatShown = useReportChatOnScreen(visible && tab === 'chat' ? chatId : null) === chatId
  const readiness = readinessOf(useCloudDevice(homeDeviceId))
  const machine = usePhoneMachine(homeDeviceId, assistant.id, readiness, home?.kind ?? 'cloud')
  // 「+」里的「录制语音笔记」:手机只录和传到它家里(phoneVoiceRuntime),转写在电脑上点「开始转写」;它在休息时录音先留在手机上,❌ 替人叫醒。
  const { t: tVoice } = useTranslation('voiceNotes')
  const voice = usePhoneVoiceNotes({ assistantId: assistant.id, deviceId: homeDeviceId, readiness, machine })
  const { disabled: voiceDisabled, start: voiceStart } = voice
  const back = backOf(route)
  // 安卓返回键:往下钻的页回上一层,别的格回聊天,聊天再退出(交给外壳:退回「消息」)。
  useBackLayer(() => taskChat ? showAssistantTaskChat(null) : open(back ?? { tab: 'chat' }), visible && tab !== 'chat')

  // 「问问它」这类:回到聊天并唤起键盘(人要接着打字);点分段里的「聊天」只切过去,不弹键盘(手机壳惯例)。
  const openChat = useCallback(() => {
    open({ tab: 'chat' })
    scheduleComposerFocus('composer-open', { mobileShell: true })
  }, [open])
  const askInChat = useCallback(
    (draft: string, files?: File[]) => {
      if (draft) writeDraft(chatId, { at: 'end', text: draft })
      if (files?.length) {
        const queued = attachmentsRef.current[chatId] ?? []
        setDraftAttachments(chatId, [...queued, ...files.map((file) => ({ id: crypto.randomUUID(), file, kind: inferAttachmentKind(file) }))])
      }
      openChat()
    },
    [chatId, openChat, writeDraft, setDraftAttachments],
  )

  const name = assistant.display_name
  const typing = useAssistantTyping(chatId, assistant.id, name)
  // 开通后递的「自定义」卡(照 dots):接在消息流末尾,点它 = 进资料页的自定义。
  const { user } = useAuth()
  const customizeOffered = useCustomizeCardOffered(user?.id)
  const chatFooter = customizeOffered && user?.id ? (
    <>
      <AssistantCustomizeCard ownerUserId={user.id} name={name} onOpen={() => open({ tab: 'profile', sub: 'customize' })} />
      {typing}
    </>
  ) : typing
  const reportInput = useRef<HTMLInputElement>(null)
  // 「+」里的:获取灵感(胶囊隐藏了也一直在)、录制语音笔记(正在录时置灰,录音条在聊天上面)、
  // 分析健康报告(选一份 PDF / 图片连同那句话排进输入框)。
  const attachMenu = useMemo(
    () => [
      { id: 'ideas', label: t('ideas.get'), icon: <Sparkles />, onSelect: () => setIdeasOpen(true) },
      { id: 'voice-note', label: tVoice('record'), icon: <Mic />, disabled: voiceDisabled, onSelect: voiceStart },
      { id: 'health-report', label: t('health.analyzeReport'), icon: <ArrowUpToLine />, onSelect: () => reportInput.current?.click() },
    ],
    [t, tVoice, voiceDisabled, voiceStart],
  )
  const page: PhonePageProps = { assistant, chatId, ownerName, homeDeviceId, cloudDeviceId, home, readiness, machine, askInChat, sub, go: (next) => open({ tab, sub: next ?? undefined }), open }
  const labels: Record<PhoneTab, string> = { chat: t('nav.chat'), today: t('nav.today'), tasks: t('nav.tasks'), memory: t('nav.memory'), profile: t('nav.profile') }

  // 它的主题色(小鸟身体的色相;照片头像没有 = 不写,走咕咕默认色),落在 `.ta-phone` 根上整页重算。
  const tint = useMemo(() => assistantTintStyle(assistantTintHue(assistant.id, assistant.avatar)) as CSSProperties | undefined, [assistant.id, assistant.avatar])

  return (
    <PhoneHomeContext.Provider value={home}>
    <div className="ta-phone" data-testid="mobile-assistant-app" data-tab={tab} data-sub={sub ?? ''} style={tint}>
      {/* 页头一行,与「消息」「伙伴」同一个 PaneHeader:返回(往下钻的页回上一层,顶层回「消息」)· 它的头像(去「资料」)· 分段 · 搜索(聊天段)。 */}
      <PaneHeader
        mobile
        className="ta-phone-head"
        data-testid="mobile-assistant-header" hidden={taskChat}
        leading={
          <>
            {back ? (
              <IconButton size="lg" aria-label={`${t('panel.back')} · ${labels[back.tab]}`} onClick={() => open(back)} data-testid="mobile-assistant-back">
                <ChevronLeft />
              </IconButton>
            ) : onExit ? (
              <IconButton size="lg" aria-label={t('panel.back')} onClick={onExit} data-testid="mobile-assistant-exit">
                <ChevronLeft />
              </IconButton>
            ) : null}
            <Button variant="ghost" className="ta-phone-identity" aria-pressed={tab === 'profile'} onClick={() => open({ tab: 'profile' })} aria-label={t('top.profile', { name })} data-testid="mobile-assistant-pill">
              <Avatar name={name} avatarUrl={assistant.avatar} seed={assistant.id} size={28} isAgent harnessBadge={false} />
            </Button>
          </>
        }
        title={
          <div className="ta-phone-seg">
            <SegmentedTabs
              ariaLabel={name}
              value={tab}
              onChange={(id) => { showAssistantTaskChat(null); open({ tab: id }) }}
              items={PHONE_SEGMENTS.map((id) => ({ value: id, label: labels[id], panelId: `assistant-${assistant.id}-${id}`, testId: `mobile-assistant-tab-${id}` }))}
            />
          </div>
        }
        actions={tab === 'chat' ? (
          <IconButton size="lg" aria-label={t('top.search')} onClick={() => window.dispatchEvent(new CustomEvent(UI_EVENTS.openChatSearch, { detail: { chatId, viewportKey: "assistant" } }))} data-testid="mobile-assistant-search">
            <Search />
          </IconButton>
        ) : null}
      />
      <div id={`assistant-${assistant.id}-chat`} role="tabpanel" aria-label={labels.chat} className="ta-phone-chat ta-chat" hidden={tab !== 'chat'} ref={setChatColumn}>
        <FilePreviewHost.Provider value={{}}><ChatAreaPanel viewportKey="assistant"
          chatId={chatId}
          navigationTarget={navigationTarget}
          activeTab="chats"
          mobile
          hidden={!chatShown}
          chrome={{ placeholder: t('chat.placeholder', { name }), attachGlyph: <Plus />, attachMenu, typing: chatFooter, hideRunningStatus: true }}
          {...chatHandlers}
        /></FilePreviewHost.Provider>
        {tab === 'chat' ? <IdeasEntry assistantId={assistant.id} column={chatColumn} busy={false} onOpen={() => setIdeasOpen(true)} /> : null}
      </div>
      {/* 录音条:在 App 根上而不是聊天那一段里 —— 切到别的格也看得到「还在录」。 */}
      <PhoneVoiceBar voice={voice} name={name} column={chatColumn} onChat={tab === 'chat'} open={open} />
      <input
        ref={reportInput}
        type="file"
        accept={HEALTH_REPORT_ACCEPT}
        className="hidden"
        data-testid="mobile-assistant-health-report-input"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])]
          event.target.value = ''
          if (files.length > 0) askInChat(t('health.healthReportMessage'), files)
        }}
      />
      {ideasOpen ? <PhoneIdeas assistant={assistant} chatId={chatId} askInChat={askInChat} onClose={() => setIdeasOpen(false)} /> : null}
      {tab === 'chat' ? null : (
        <main id={`assistant-${assistant.id}-${tab}`} role="tabpanel" aria-label={labels[tab]} className="ta-phone-body" data-testid={`mobile-assistant-${tab}`} hidden={taskChat}>
          {tab === 'today' ? <PhoneToday {...page} /> : null}
          {tab === 'tasks' ? <PhoneTasks {...page} /> : null}
          {tab === 'memory' ? <PhoneMemory {...page} /> : null}
          {tab === 'profile' ? <PhoneProfile {...page} /> : null}
        </main>
      )}
      {taskChat ? <ShellSlot name="task-chat" className="ta-task-chat-slot" /> : null}
    </div>
    </PhoneHomeContext.Provider>
  )
}

export function MobileAssistantApp(props: Parameters<typeof MobileAssistantAppContent>[0]) {
  return <ChatLineScope chatId={props.chatId}><AssistantConversationProgress assistantId={props.assistant.id} chatId={props.chatId} visible={props.visible}>
    <MobileAssistantAppContent {...props} />
  </AssistantConversationProgress></ChatLineScope>
}
