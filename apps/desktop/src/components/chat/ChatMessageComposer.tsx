import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatAttachmentSize } from '@gugu/core/shared/ui/attachmentModels'
import { resolveReplyDelivery } from '@gugu/core/shared/replyDelivery'
import { ChatComposer, MessageProvider, type ComposerAttachment, type MentionItem, type PromptEditorRef } from '@gugu/session-ui/react/components'
import { ThemeProvider } from '@gugu/session-ui/react/primitives'
import { useLocale } from '@/i18n'
import { focusComposer, registerComposerFocusTarget, scheduleComposerFocus } from '@/lib/focusComposer'
import { useComposerEntryFocus } from '@/lib/composerEntryFocus'
import { activeMentionPicks, MENTION_ALL_USER_ID, type MentionCandidate } from '@/lib/mention'
import { isMentionQueryActive } from '@/lib/mentionMatch'
import { rankMentionCandidates } from '@/lib/mentionRanking'
import { useProjectGroupMembers } from '@/lib/projectGroupChatsBridge'
import { AUTOMATION_TEST_IDS } from '@/lib/automationDom'
import { UI_EVENTS } from '@/lib/uiEvents'
import { useContactsStore } from '../../store/contactsContext'
import { useChatStore } from '../../store/chatContext'
import { useTheme } from '../../store/theme'
import { useMobileShell } from '../../hooks/useMobileShell'
import { Avatar } from '../Avatar'
import { useInChatSlot, useChatSlotProjectName } from '../../lib/shellSlots'
import { createLocalSessionMentionProvider } from '../../session/renderer/lib/chat/local-session-mention-provider'
import { useSessionAgentCreationTools } from '../../session/renderer/lib/chat/use-session-agent-creation-tools'
import { sessionComposerDockedWidthClassName } from '../../session/renderer/features/sessions/session-composer-styles'
import { useChatTaskDrop } from './useChatTaskDrop'
import { translateSessionMessage } from '../../session/renderer/localization/locale-store'
import { useChatDraft, makePendingAttachment, revokeAttachmentPreviewUrls } from './useChatDraft'
import { useChatMessageSend } from './useChatMessageSend'
import { ComposerAttachButton } from './ComposerAttachButton'
import { PhoneAttachPanel, type PhoneAttachEntry } from './PhoneAttachPanel'
import { compressPhoto } from './compressPhoto'
import { IconButton } from '../ui/IconButton'
import { Camera, Image, Paperclip, Plus } from '@/lib/icons'
import { ComposerVerbs } from './ComposerVerbs'
import { useComposerVerbTakeover } from './useComposerVerbTakeover'
import { parseGroupFileLink } from '@gugu/core/shared/ui/guguLink'
import { ChatComposerContextBands } from './ChatComposerContextBands'
import { AgentMentionOptionLabel, AgentMentionSelectionNotice } from './AgentMentionStatusNotice'
import { mentionOptionStatusProps } from './agentMentionStatusModels'
import type { ChatMessageComposerProps } from './chatComposerModels'
import { AgentConversationComposer } from '@renderer/lib/chat/agent-conversation-view'
import { usePhoneNewTask } from '../../mobile/chat/PhoneNewTask'
import { useAttachmentFileSelection } from '@/hooks/useAttachmentFileSelection'
import { useGroupMentionHint } from './useGroupMentionHint'
import './group-mention-hint.css'
export type { ComposerAttachAction } from './ComposerAttachButton'
export type { ChatMessageComposerProps } from './chatComposerModels'

const EMPTY_MEMBERS: NonNullable<ChatMessageComposerProps['groupMembers']> = []
const EMPTY_STATUSES: NonNullable<ChatMessageComposerProps['agentStatuses']> = {}
const EMPTY_MESSAGES: NonNullable<ChatMessageComposerProps['messages']> = []

/** Chat-specific delivery and context around the same editor used by ACP tasks. */
export function ChatMessageComposer(props: ChatMessageComposerProps) {
  const { chatId, isGroupChat, groupMembers = EMPTY_MEMBERS, currentUserId, agentStatuses = EMPTY_STATUSES,
    placeholder, attachGlyph, attachMenu, mentionToInsert, onMentionInserted, quoteContent, onExitWhisper: exitWhisper,
    messages = EMPTY_MESSAGES, participantIds, surface = 'main', hidden = false } = props
  const [publicQuote, setPublicQuote] = useState<typeof quoteContent>(null)
  const replySource = quoteContent?.source
  const delivery = resolveReplyDelivery({ senderUserId: currentUserId, source: replySource,
    toUserIds: props.whisperTarget ? [props.whisperTarget.userId] : [],
    whisper: props.whisperTarget ? true : quoteContent && publicQuote === quoteContent ? false : undefined })
  const privatePeer = delivery?.isWhisper ? delivery.toUserIds[0] : undefined
  const whisperTarget = useMemo(() => privatePeer ? { userId: privatePeer, displayName: groupMembers.find((member) => member.id === privatePeer)?.name
    ?? (props.whisperTarget?.userId === privatePeer ? props.whisperTarget.displayName : quoteContent?.senderName ?? privatePeer) } : null,
  [privatePeer, groupMembers, props.whisperTarget, quoteContent?.senderName])
  const onExitWhisper = useCallback(() => { setPublicQuote(quoteContent); exitWhisper?.() }, [quoteContent, exitWhisper])
  const deliveryProps = { ...props, whisperTarget, onExitWhisper }
  const { t } = useTranslation('messaging')
  const replyUnavailable = !delivery || (!!quoteContent?.messageId && !replySource)
  const disabled = props.disabled || replyUnavailable
  const disabledReason = replyUnavailable ? t('composer.replyUnavailable') : props.disabledReason
  const { resolvedLocale } = useLocale()
  const { theme } = useTheme()
  const mobile = useMobileShell()
  const draft = useChatDraft(chatId)
  const { text, setText, mentionTargets, setMentionTargets, attachments, setAttachments } = draft
  const fileSelection = useAttachmentFileSelection(attachments, chatId)
  const editorApiRef = useRef<PromptEditorRef | null>(null)
  const inputRef = useRef<HTMLElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const photoInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  // 手机「+」面板开着没有。
  const [attachOpen, setAttachOpen] = useState(false)
  const isMain = surface === 'main'
  const inChatSlot = useInChatSlot()
  const projectName = useChatSlotProjectName()
  const takenOver = useComposerVerbTakeover(chatId)
  const { contacts } = useContactsStore()
  const { chats, identitiesById, writeDraft, registerDraftEditor } = useChatStore('chats', 'identitiesById', 'writeDraft', 'registerDraftEditor')
  // 手机项目群的「新任务」(电脑上是 ComposerVerbs 换上会话页那一侧的框;手机就地换成新任务的框)。
  const phoneTask = usePhoneNewTask({ chatId, enabled: mobile && isMain && !!isGroupChat, clear: () => writeDraft(chatId, '') })
  const projectMembers = useProjectGroupMembers()
  const projectMemberIds = projectMembers.get(chats.find((chat) => chat.id === chatId)?.source_chat_id ?? chatId ?? '')
  const members = useMemo<MentionCandidate[]>(() => isGroupChat ? [
    { id: '__all__', name: t('composer.mentionAll'), type: 'all' },
    ...groupMembers.filter((member) => member.id !== currentUserId).map((member) => ({ ...member, alias: contacts.find((contact) => contact.id === member.id)?.alias })),
  ] : [], [isGroupChat, groupMembers, currentUserId, contacts, t])
  const activeTargets = activeMentionPicks(text, mentionTargets, members)
  const { sending, handleSend } = useChatMessageSend({ ...deliveryProps, disabled, disabledReason }, draft, members, activeTargets, inputRef, mobile)
  const { byEngine, renderMentionIcon: renderSessionMentionIcon } = useSessionAgentCreationTools()
  const renderMentionIcon = useCallback<NonNullable<Parameters<typeof ChatComposer>[0]['renderMentionIcon']>>((attrs) => {
    if (attrs.id === MENTION_ALL_USER_ID) return <Avatar name={attrs.name ?? attrs.label} size={14} variant="group"
      memberAvatars={members.filter((member) => member.type !== 'all').map((member) => ({ id: member.id, name: member.name, avatar: member.avatar ?? null }))} />
    return renderSessionMentionIcon(attrs)
  }, [members, renderSessionMentionIcon])
  const localProvider = useMemo(() => createLocalSessionMentionProvider({ creationToolsByEngine: byEngine }), [byEngine])
  const decorate = useCallback((item: MentionItem): MentionItem => ({ ...item,
    annotation: isGroupChat && !members.some((member) => `aid:${member.id}` === item.label) ? t('composer.notInGroup') : item.annotation,
  }), [isGroupChat, members, t])
  const mentionProvider = useMemo(() => ({
    allowSpaces: true,
    emptyLabel: isGroupChat && !whisperTarget ? t('composer.mentionNoMatch') : undefined,
    isQueryActive: (query: string) => !!isGroupChat && !whisperTarget && isMentionQueryActive(query, members),
    async search(query: string) {
      if (!isGroupChat || whisperTarget || !isMentionQueryActive(query, members)) return []
      return rankMentionCandidates(members, query, { chatId, currentUserId, messages, participantIds, projectMemberIds,
        replyToMessageId: quoteContent?.messageId, now: Date.now() }).map((member): MentionItem => ({
        id: member.type === 'all' ? MENTION_ALL_USER_ID : member.id,
        label: member.rawName ? `aid:${member.id}` : member.name, name: member.rawName ?? member.name, kind: 'custom', role: member.type === 'all' ? undefined : member.type,
        annotation: member.rawName ? member.name.slice(member.rawName.length).trim() : undefined,
        optionLabel: <span {...mentionOptionStatusProps(member, agentStatuses)}><AgentMentionOptionLabel member={member} status={agentStatuses[member.id]} /></span>,
      }))
    },
    resolve(target: string, label: string): MentionItem | null {
      const file = parseGroupFileLink(target)
      if (file) return { id: target, label: target, name: label, kind: 'file',
        description: file.version === undefined ? label : `${label} · ${t('filePill.picked', { version: file.version })}` }
      if (!target.startsWith('aid:')) return null
      const member = members.find(candidate => `aid:${candidate.id}` === target)
      return decorate({ id: target, label: target, name: member?.rawName ?? member?.name ?? label, role: member?.type === 'human' ? 'human' : 'agent', kind: 'custom', annotation: member?.rawName ? member.name.slice(member.rawName.length).trim() : undefined })
    },
    async resolveSession(id: string) {
      const item = await localProvider.resolveSession(id)
      return item ? decorate(item) : null
    },
  }), [isGroupChat, whisperTarget, members, agentStatuses, decorate, localProvider, t, chatId, currentUserId, messages, participantIds, projectMemberIds, quoteContent?.messageId])
  const { dataDropTypes, onDataDropped, invitation } = useChatTaskDrop({ chatId, isGroupChat: isGroupChat && !mobile, groupMembers, provider: mentionProvider, editorApiRef, enabled: !hidden && !disabled })
  const receiveInput = useCallback((element: HTMLElement | null) => { inputRef.current = element }, [])
  const enqueueFiles = useCallback((files: File[]) => {
    const picked = fileSelection.choose(files)
    if (picked.length) setAttachments((pending) => [...pending, ...picked.map(({ file, id }) => makePendingAttachment(file, id))])
    return picked
  }, [fileSelection, setAttachments])
  // 照片 / 拍摄先原样进附件区,压完按 id 换成压缩件:这期间发送、删除、切会话都找不到这个 id,换不到别处去。
  const enqueuePhotos = useCallback((files: File[]) => {
    for (const { file, id } of enqueueFiles(files)) {
      void compressPhoto(file).then((compressed) => {
        if (compressed !== file) setAttachments((pending) => pending.map((item) => item.id === id ? { ...item, file: compressed, photo: { original: file, compressed } } : item))
      })
    }
  }, [enqueueFiles, setAttachments])

  useEffect(() => isMain ? registerComposerFocusTarget(() => inputRef.current) : undefined, [isMain])
  useComposerEntryFocus(chatId ? 'chat:' + chatId : null, isMain && !hidden && props.entryActive === true, () => {
    if (!disabled) focusComposer('chat-entry', { mobileShell: mobile, target: () => inputRef.current })
  })
  // 面板占的是键盘的位置:一点输入框(键盘要起来)就收起。
  useEffect(() => {
    const input = inputRef.current
    if (!attachOpen || !input) return
    const close = () => setAttachOpen(false)
    input.addEventListener('focus', close)
    return () => input.removeEventListener('focus', close)
  }, [attachOpen])
  useLayoutEffect(() => registerDraftEditor(chatId ?? null, () => editorApiRef.current), [chatId, registerDraftEditor])
  useEffect(() => {
    if (!mentionToInsert) return
    const member = members.find(candidate => candidate.id === mentionToInsert.id)
    editorApiRef.current?.insertMention({ id: mentionToInsert.id, label: member?.rawName ? `aid:${mentionToInsert.id}` : mentionToInsert.name, name: member?.rawName ?? member?.name ?? mentionToInsert.name, kind: 'custom' })
    onMentionInserted?.()
  }, [mentionToInsert, onMentionInserted, members])
  useEffect(() => {
    if (quoteContent) scheduleComposerFocus('quote-attached', { target: () => inputRef.current })
  }, [quoteContent])
  useEffect(() => {
    if (!isMain) return
    const attach = (event: Event) => {
      const files = (event as CustomEvent<{ files?: unknown }>).detail?.files
      if (Array.isArray(files)) enqueueFiles(files.filter((file): file is File => file instanceof File))
    }
    window.addEventListener(UI_EVENTS.composerAttachFiles, attach)
    return () => window.removeEventListener(UI_EVENTS.composerAttachFiles, attach)
  }, [isMain, enqueueFiles])

  const composerAttachments: ComposerAttachment[] = attachments.map((attachment) => ({
    id: attachment.id, name: attachment.file.name, kind: attachment.kind === 'image' ? 'image' : 'file',
    previewUrl: attachment.previewUrl ?? undefined, mimeType: attachment.file.type, meta: formatAttachmentSize(attachment.file.size),
    imageQuality: attachment.photo && (attachment.file === attachment.photo.compressed ? 'compressed' : 'original'),
  }))
  const onMentionInsert = (item: MentionItem) => {
    const member = members.find((candidate) => candidate.id === item.id || `aid:${candidate.id}` === item.label)
    if (!member) return
    const userId = member.type === 'all' ? MENTION_ALL_USER_ID : member.id
    setMentionTargets((picks) => picks.some((pick) => pick.userId === userId) ? picks : [...picks, { userId, displayName: member.name }])
  }
  // Aside candidates also include invitees from the source line; only actual topic members may be recalled.
  const recallMembers = members.filter((member) => !identitiesById[member.id]?.removed_at && (surface !== 'aside' || participantIds?.includes(member.id)))
  const { hint, ...hintEvents } = useGroupMentionHint({ accountId: currentUserId, chatId, members: recallMembers, text,
    enabled: !mobile && !!isGroupChat && !props.conversation && !disabled && !sending && !hidden && !takenOver && !whisperTarget,
    editor: editorApiRef, input: inputRef })
  const editorOptions = { inputTestId: surface === 'aside' ? AUTOMATION_TEST_IDS.chatComposerAside : AUTOMATION_TEST_IDS.chatComposer,
    inputRef: receiveInput, clearOnSubmit: false, enterBehavior: mobile ? 'newline' as const : 'submit' as const, emptyHint: hint }
  const Composer = props.conversation ? AgentConversationComposer : ChatComposer
  return <ThemeProvider theme={theme} target="documentElement">
    <MessageProvider locale={resolvedLocale} translate={translateSessionMessage}>
      <div {...hintEvents} title={disabledReason} data-chat-composer-host="" data-mobile-group={mobile && isGroupChat || undefined} data-phone-task={phoneTask.active || undefined} data-sending={sending} hidden={hidden || takenOver}>
        <input ref={fileInputRef} type="file" multiple hidden onChange={(event) => { enqueueFiles(Array.from(event.target.files ?? [])); event.target.value = '' }} />
        {mobile && <>
          {/* 照片 = 系统相册(只写 image/*:写多个类型时 Android 壳退回成文件选择器);拍摄 = 直接开相机。 */}
          <input ref={photoInputRef} type="file" accept="image/*" multiple hidden onChange={(event) => { enqueuePhotos(Array.from(event.target.files ?? [])); event.target.value = '' }} />
          <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" hidden onChange={(event) => { enqueuePhotos(Array.from(event.target.files ?? [])); event.target.value = '' }} />
        </>}
        <ChatComposerContextBands {...deliveryProps} />
        <AgentMentionSelectionNotice members={members} mentionTargets={activeTargets} agentStatuses={agentStatuses} />
        {invitation}
        {phoneTask.overlay}
        {phoneTask.band}
        <Composer {...props.conversation} key={chatId} editorApiRef={editorApiRef} editorOptions={editorOptions} mobile={mobile}
          disabled={disabled} disabledPlaceholder={placeholder ?? disabledReason} canSubmit={!sending && (!!text.trim() || attachments.length > 0)}
          placeholder={props.conversation ? undefined : phoneTask.placeholder ?? (whisperTarget ? t('composer.whisperPlaceholder', { name: whisperTarget.displayName }) : placeholder ?? (mobile && isGroupChat ? t('composer.mobilePlaceholder') : projectName && !mobile ? t('composer.projectGroupPlaceholder', { name: projectName }) : t('composer.placeholder')))}
          onInputChange={setText} onSubmitWhileWorking={props.conversation ? handleSend : undefined} onSubmit={value => phoneTask.active ? phoneTask.send(value) : handleSend(value)} onMentionInsert={onMentionInsert}
          mentionProvider={mentionProvider} renderMentionIcon={renderMentionIcon} dataDropTypes={dataDropTypes} onDataDropped={onDataDropped}
          onFilesDropped={enqueueFiles} onImageFilesDropped={enqueueFiles}
          attachments={composerAttachments} onAttachmentsChange={(next) => { const kept = attachments.filter((file) => next.some((item) => item.id === file.id)); revokeAttachmentPreviewUrls(attachments.filter((file) => !kept.includes(file))); setAttachments(kept) }}
          onAttachmentQualityChange={(id) => setAttachments((pending) => pending.map((item) => item.id === id && item.photo ? { ...item, file: item.file === item.photo.compressed ? item.photo.original : item.photo.compressed } : item))}
          toolbarExtra={<>{mobile
            ? <IconButton shape="pill" size="md" title={t('composer.attach')} aria-label={t('composer.attach')} aria-expanded={attachOpen} disabled={disabled} data-testid="chat-composer-attach-menu"
                onClick={() => { inputRef.current?.blur(); setAttachOpen((open) => !open) }}>{attachGlyph ?? <Plus />}</IconButton>
            : <ComposerAttachButton glyph={attachGlyph} actions={attachMenu} disabled={disabled} mobile={mobile} onPickFile={() => fileInputRef.current?.click()} />}{isMain && !mobile && !props.conversation && <ComposerVerbs chatId={chatId} isGroupChat={!!isGroupChat} draft={() => editorApiRef.current?.getText() ?? ''} onCarried={() => writeDraft(chatId, '')} />}</>}
          className={inChatSlot ? sessionComposerDockedWidthClassName : undefined} />
        {mobile && attachOpen && <PhoneAttachPanel onClose={() => setAttachOpen(false)} entries={[
          { id: 'photos', label: t('composer.photos'), icon: <Image />, onSelect: () => photoInputRef.current?.click() },
          { id: 'camera', label: t('composer.camera'), icon: <Camera />, onSelect: () => cameraInputRef.current?.click() },
          { id: 'file', label: t('composer.file'), icon: <Paperclip />, onSelect: () => fileInputRef.current?.click() },
          ...[...(attachMenu ?? []), ...(phoneTask.action ? [phoneTask.action] : [])].map((action): PhoneAttachEntry => ({ ...action, icon: action.icon ?? <Plus /> })),
        ]} />}
      </div>
    </MessageProvider>
  </ThemeProvider>
}
