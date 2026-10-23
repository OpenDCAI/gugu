import { readShellSlots } from '@/lib/shellSlots'
import { assistantSlotKey } from '@/lib/assistantShellBridge'
import { useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { FilePreviewHost } from '../chat/filePreviewHost'
import { inferAttachmentKind } from '@gugu/core/shared/ui/attachmentModels'
import { useTranslation } from 'react-i18next'
import { ChatAreaPanel } from '../ChatAreaPanel'
import type { ComposerAttachAction } from '../chat/ComposerAttachButton'
import type { MemberProfileChatTarget } from '../MemberProfileCard'
import { Button } from '../ui/Button'
import { appendDraft } from '../../lib/assistantDraft'
import { requestIdeas } from '../../lib/assistantIdeas'
import { readAssistantShellBridge } from '../../lib/assistantShellBridge'
import { ArrowUpToLine, Mic, Plus, Sparkles } from '../../lib/icons'
import '../../i18n/registerVoiceNotesCatalog'
import { scheduleComposerFocus } from '../../lib/focusComposer'
import { useReportChatOnScreen } from '../../lib/onScreenChat'
import { useChatStore } from '../../store/chatContext'
import { ChatLineScope } from '@/store/chatLineScope'
import type { AssistantDm } from './useAssistantDm'
import { AssistantConversationProgress } from './AssistantConversationProgress'
import { useAssistantTyping } from './useAssistantTyping'
import { AssistantCustomizeCard } from './AssistantCustomizeCard'
import { useCustomizeCardOffered } from '../../lib/assistantSetupState'
import { useAuth } from '../../store/auth'
import { appState } from '../../session/renderer/lib/stores/app-state'
import { useVoiceNoteHandler } from './useVoiceNoteHandler'

export type AssistantChatHandlers = {
  onOpenUserChat?: (target: MemberProfileChatTarget) => void
  onOpenSessionpageAgent?: (agentUserId: string, view?: 'code' | 'general') => Promise<void>
  onOpenSessionpageAgentFile?: (agentUserId: string, path: string) => Promise<void>
}

/**
 * 「问它」「在对话中编辑」这类按钮交来的那句话:接在这条私聊输入框里已有的字后面,人看过再发(❌ 替人发、❌ 盖掉人写的)。
 * 带了文件(「分析健康报告」选的那份)就排进输入框的附件,与人自己点「+」选的同一个队列。
 */
function useAssistantDraft(chatId: string | null) {
  const { setDraft, draftAttachments, setDraftAttachments } = useChatStore('setDraft', 'draftAttachments', 'setDraftAttachments')
  const attachmentsRef = useRef(draftAttachments)
  attachmentsRef.current = draftAttachments
  useEffect(() => {
    const bridge = readAssistantShellBridge()
    if (!chatId || !bridge) return
    const apply = () => {
      const draft = bridge.takeChatDraft()
      if (draft === null) return
      if (draft.text) setDraft(chatId, (previous) => appendDraft(previous, draft.text))
      if (draft.files.length > 0) {
        const queued = attachmentsRef.current[chatId] ?? []
        setDraftAttachments(chatId, [...queued, ...draft.files.map((file) => ({ id: crypto.randomUUID(), file, kind: inferAttachmentKind(file) }))])
      }
    }
    apply()
    return bridge.subscribeChatDraft(apply)
  }, [chatId, setDraft, setDraftAttachments])
}

/**
 * 「+」菜单里的「录制语音笔记」:录音机在会话页那一侧,经桥登记;没登记(会话页还没挂上)就不出这一项,
 * 正在录时置灰(录音条在聊天上面)。
 */
function useVoiceNoteAction(): ComposerAttachAction[] | undefined {
  const { t } = useTranslation('voiceNotes')
  const { handler, recording: busy } = useVoiceNoteHandler()
  return useMemo(
    () => (handler ? [{ id: 'voice-note', label: t('record'), icon: <Mic />, disabled: busy, onSelect: () => void handler.start() }] : undefined),
    [handler, busy, t]
  )
}

/** 「分析健康报告」收的文件(与健康页那一格同一份:报告多是 PDF 或拍照 / 截图)。 */
const HEALTH_REPORT_ACCEPT = 'application/pdf,image/*'

/**
 * 「+」菜单里的「分析健康报告」:选一份 PDF / 图片,连同那句话排进输入框,人看过再发。
 * 文件选择框是这一格自己的一个隐藏 input;选好了走与健康页同一条桥(fillChatDraft)。
 */
function useHealthReportAction(): { action: ComposerAttachAction; input: ReactNode } {
  const { t } = useTranslation('assistant')
  const ref = useRef<HTMLInputElement>(null)
  const action = useMemo<ComposerAttachAction>(
    () => ({ id: 'health-report', label: t('health.analyzeReport'), icon: <ArrowUpToLine />, onSelect: () => ref.current?.click() }),
    [t]
  )
  const input = (
    <input
      ref={ref}
      type="file"
      accept={HEALTH_REPORT_ACCEPT}
      className="hidden"
      data-testid="assistant-chat-health-report-input"
      onChange={(event) => {
        const files = [...(event.target.files ?? [])]
        event.target.value = ''
        if (files.length > 0) readAssistantShellBridge()?.fillChatDraft(t('health.healthReportMessage'), files)
      }}
    />
  )
  return { action, input }
}

/** 「+」菜单里的「获取灵感」:胶囊隐藏了也一直在,点了打开会话页那一侧的灵感面板。 */
function useIdeasAction(): ComposerAttachAction {
  const { t } = useTranslation('assistant')
  return useMemo(() => ({ id: 'ideas', label: t('ideas.get'), icon: <Sparkles />, onSelect: requestIdeas }), [t])
}

/**
 * #7199 「助理」App 的「聊天」:就是和它的那条私聊,整套聊天面画在 App 里(owner:「这是这个 App 的核心，不能跳去私聊」)。
 * 按 chatId 订阅账户已有的聊天管线,不改变对话页的选中。
 */
function AssistantChatSlotContent({ dm, assistantId, assistantName, visible, ...handlers }: { dm: AssistantDm; assistantId: string; assistantName: string; visible: boolean } & AssistantChatHandlers) {
  const bridge = readAssistantShellBridge()
  const slots = readShellSlots()
  const target = useSyncExternalStore(
    (listener) => slots?.subscribeSlots(listener) ?? (() => undefined),
    () => slots?.getSlots().get(assistantSlotKey('file-preview')) ?? null,
  )
  const previewHost = useMemo(() => ({ target, onOpenChange: bridge?.setFilePreviewOpen }), [bridge, target])
  const { t } = useTranslation('assistant')
  const { chatId, failed, retry } = dm
  const ideas = useIdeasAction()
  const voice = useVoiceNoteAction()
  const healthReport = useHealthReportAction()
  const attachMenu = useMemo(() => [ideas, ...(voice ?? []), healthReport.action], [ideas, voice, healthReport.action])
  useReportChatOnScreen(visible ? chatId : null)
  useAssistantDraft(chatId)
  const typing = useAssistantTyping(chatId, assistantId, assistantName)
  // 开通后递的「自定义」卡(照 dots):接在消息流末尾,点它 = 打开资料页的自定义弹窗(会话页那棵树,经共享的导航 store)。
  const { user } = useAuth()
  const customizeOffered = useCustomizeCardOffered(user?.id)
  const footer = customizeOffered && user?.id ? (
    <>
      <AssistantCustomizeCard ownerUserId={user.id} name={assistantName} onOpen={() => appState.navigation.navigate('assistant', { tab: 'profile', sub: 'customize' })} />
      {typing}
    </>
  ) : typing
  // 点进「聊天」= 进入可输入语境,与对话页点进一条会话同一个 reason。
  useEffect(() => (visible && chatId ? scheduleComposerFocus('chat-entry') : undefined), [visible, chatId])

  if (!chatId) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-[var(--text-secondary)]" data-testid="assistant-chat-pending">
        <p>{failed ? t('chat.openFailed', { name: assistantName }) : t('chat.opening', { name: assistantName })}</p>
        {failed && <Button size="sm" onClick={retry}>{t('machine.retry')}</Button>}
      </div>
    )
  }
  // 助理 App 的聊天面:没有会话头(名字胶囊和搜索、齿轮在 App 顶上),输入框「和 X 聊天」、左边一个「+」。
  return (
    <>
      <FilePreviewHost.Provider value={previewHost}><ChatAreaPanel
        chatId={chatId}
        activeTab="chats"
        hidden={!visible}
        chrome={{ placeholder: t('chat.placeholder', { name: assistantName }), attachGlyph: <Plus />, attachMenu, typing: footer, hideRunningStatus: true }}
        {...handlers}
      /></FilePreviewHost.Provider>
      {healthReport.input}
    </>
  )
}

export function AssistantChatSlot(props: Parameters<typeof AssistantChatSlotContent>[0]) {
  return <ChatLineScope chatId={props.dm.chatId}><AssistantConversationProgress assistantId={props.assistantId} chatId={props.dm.chatId} visible={props.visible}>
    <AssistantChatSlotContent {...props} />
  </AssistantConversationProgress></ChatLineScope>
}
