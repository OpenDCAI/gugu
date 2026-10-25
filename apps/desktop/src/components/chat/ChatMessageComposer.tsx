import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { formatAttachmentSize } from '@gugu/core/shared/ui/attachmentModels'
import { ChatComposer, MessageProvider, type ComposerAttachment, type MentionItem, type PromptEditorRef } from '@gugu/session-ui/react/components'
import { ThemeProvider } from '@gugu/session-ui/react/primitives'
import { useLocale } from '@/i18n'
import { registerComposerFocusTarget, scheduleComposerFocus } from '@/lib/focusComposer'
import { activeMentionPicks, MENTION_ALL_USER_ID, type MentionCandidate } from '@/lib/mention'
import { filterMentionCandidates, isMentionQueryActive } from '@/lib/mentionMatch'
import { AUTOMATION_TEST_IDS } from '@/lib/automationDom'
import { UI_EVENTS } from '@/lib/uiEvents'
import { APP_COMPOSE_EVENT } from '../../session/shared/extensions/app-runtime-protocol'
import { SLASH_COMMANDS } from '@/lib/slashCommands'
import { useContactsStore } from '../../store/contactsContext'
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
import { ComposerVerbs } from './ComposerVerbs'
import { useComposerVerbTakeover } from './useComposerVerbTakeover'
import { parseGroupFileLink } from '@gugu/core/shared/ui/guguLink'
import { ChatComposerContextBands } from './ChatComposerContextBands'
import { AgentMentionOptionLabel, AgentMentionSelectionNotice } from './AgentMentionStatusNotice'
import { mentionOptionStatusProps } from './agentMentionStatusModels'
import type { ChatMessageComposerProps } from './chatComposerModels'
export type { ComposerAttachAction } from './ComposerAttachButton'

const EMPTY_MEMBERS: NonNullable<ChatMessageComposerProps['groupMembers']> = []
const EMPTY_STATUSES: NonNullable<ChatMessageComposerProps['agentStatuses']> = {}

/** Chat-specific delivery and context around the same editor used by ACP tasks. */
export function ChatMessageComposer(props: ChatMessageComposerProps) {
  const { chatId, isGroupChat, groupMembers = EMPTY_MEMBERS, currentUserId, agentStatuses = EMPTY_STATUSES, disabled = false, disabledReason,
    placeholder, attachGlyph, attachMenu, mentionToInsert, onMentionInserted, quoteContent,
    whisperTarget, surface = 'main', hidden = false } = props
  const { t } = useTranslation('messaging')
  const { resolvedLocale } = useLocale()
  const { theme } = useTheme()
  const mobile = useMobileShell()
  const draft = useChatDraft(chatId)
  const { text, setText, mentionTargets, setMentionTargets, attachments, setAttachments, flush } = draft
  const editorApiRef = useRef<PromptEditorRef | null>(null)
  const inputRef = useRef<HTMLElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const isMain = surface === 'main'
  const inChatSlot = useInChatSlot()
  const projectName = useChatSlotProjectName()
  const takenOver = useComposerVerbTakeover(chatId, setText)
  const { contacts } = useContactsStore()
  const members = useMemo<MentionCandidate[]>(() => isGroupChat ? [
    { id: '__all__', name: t('composer.mentionAll'), type: 'all' },
    ...groupMembers.filter((member) => member.id !== currentUserId).map((member) => ({ ...member, alias: contacts.find((contact) => contact.id === member.id)?.alias })),
  ] : [], [isGroupChat, groupMembers, currentUserId, contacts, t])
  const activeTargets = activeMentionPicks(text, mentionTargets, members)
  const { sending, handleSend } = useChatMessageSend(props, draft, members, activeTargets, inputRef)
  const { byEngine, renderMentionIcon: renderSessionMentionIcon } = useSessionAgentCreationTools()
  const renderMentionIcon = useCallback<NonNullable<Parameters<typeof ChatComposer>[0]['renderMentionIcon']>>((attrs) => {
    if (attrs.id === MENTION_ALL_USER_ID) return <Avatar name={attrs.name ?? attrs.label} size={14} variant="group"
      memberAvatars={members.filter((member) => member.type !== 'all').map((member) => ({ id: member.id, name: member.name, avatar: member.avatar ?? null }))} />
    return renderSessionMentionIcon(attrs)
  }, [members, renderSessionMentionIcon])
  const localProvider = useMemo(() => createLocalSessionMentionProvider({ creationToolsByEngine: byEngine }), [byEngine])
  const decorate = useCallback((item: MentionItem): MentionItem => ({ ...item,
    annotation: isGroupChat && !members.some((member) => `aid:${member.id}` === item.label) ? t('composer.notInGroup') : undefined,
  }), [isGroupChat, members, t])
  const mentionProvider = useMemo(() => ({
    allowSpaces: true,
    emptyLabel: isGroupChat && !whisperTarget ? t('composer.mentionNoMatch') : undefined,
    isQueryActive: (query: string) => !!isGroupChat && !whisperTarget && isMentionQueryActive(query, members),
    async search(query: string) {
      if (!isGroupChat || whisperTarget || !isMentionQueryActive(query, members)) return []
      return filterMentionCandidates(members, query).map((member): MentionItem => ({
        id: member.type === 'all' ? MENTION_ALL_USER_ID : member.id,
        label: member.name, name: member.name, kind: 'custom', role: member.type === 'all' ? undefined : member.type,
        optionLabel: <span {...mentionOptionStatusProps(member, agentStatuses)}><AgentMentionOptionLabel member={member} status={agentStatuses[member.id]} /></span>,
      }))
    },
    resolve(target: string, label: string): MentionItem | null {
      const file = parseGroupFileLink(target)
      if (file) return { id: target, label: target, name: label, kind: 'file',
        description: file.version === undefined ? label : `${label} · ${t('filePill.picked', { version: file.version })}` }
      if (!target.startsWith('aid:')) return null
      return decorate({ id: target, label: target, name: label, role: 'agent', kind: 'custom' })
    },
    async resolveSession(id: string) {
      const item = await localProvider.resolveSession(id)
      return item ? decorate(item) : null
    },
  }), [isGroupChat, whisperTarget, members, agentStatuses, decorate, localProvider, t])
  const { dataDropTypes, onDataDropped, invitation } = useChatTaskDrop({ chatId, isGroupChat: isGroupChat && !mobile, groupMembers, currentUserId, provider: mentionProvider, editorApiRef, enabled: !hidden && !disabled })
  const receiveInput = useCallback((element: HTMLElement | null) => { inputRef.current = element }, [])
  const enqueueFiles = useCallback((files: File[]) => {
    if (files.length) setAttachments((pending) => [...pending, ...files.map(makePendingAttachment)])
  }, [setAttachments])

  useEffect(() => isMain ? registerComposerFocusTarget(() => inputRef.current) : undefined, [isMain])
  useEffect(() => {
    const editor = editorApiRef.current
    if (editor && editor.getText() !== text) editor.setText(text)
  }, [text, chatId])
  useEffect(() => {
    if (!mentionToInsert) return
    editorApiRef.current?.insertMention({ id: mentionToInsert.id, label: mentionToInsert.name, name: mentionToInsert.name, kind: 'custom' })
    onMentionInserted?.()
  }, [mentionToInsert, onMentionInserted])
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
  useEffect(() => {
    // App composition appends through the store; preserve typing in either composer surface first.
    const beforeCompose = (event: Event) => {
      if ((event as CustomEvent<{ chatId: string }>).detail?.chatId === chatId) flush()
    }
    window.addEventListener(APP_COMPOSE_EVENT, beforeCompose, true)
    return () => window.removeEventListener(APP_COMPOSE_EVENT, beforeCompose, true)
  }, [chatId, flush])

  const composerAttachments: ComposerAttachment[] = attachments.map((attachment) => ({
    id: attachment.id, name: attachment.file.name, kind: attachment.kind === 'image' ? 'image' : 'file',
    previewUrl: attachment.previewUrl ?? undefined, mimeType: attachment.file.type, meta: formatAttachmentSize(attachment.file.size),
  }))
  const onMentionInsert = (item: MentionItem) => {
    const member = members.find((candidate) => candidate.id === item.id || `aid:${candidate.id}` === item.label)
    if (!member) return
    const userId = member.type === 'all' ? MENTION_ALL_USER_ID : member.id
    setMentionTargets((picks) => picks.some((pick) => pick.userId === userId) ? picks : [...picks, { userId, displayName: member.name }])
  }
  const editorOptions = { inputTestId: surface === 'aside' ? AUTOMATION_TEST_IDS.chatComposerAside : AUTOMATION_TEST_IDS.chatComposer,
    inputRef: receiveInput, clearOnSubmit: false, enterBehavior: mobile ? 'newline' as const : 'submit' as const }
  return <ThemeProvider theme={theme} target="documentElement">
    <MessageProvider locale={resolvedLocale} translate={translateSessionMessage}>
      <div title={disabledReason} data-chat-composer-host="" data-mobile-group={mobile && isGroupChat || undefined} data-sending={sending} hidden={hidden} style={{ display: takenOver ? 'none' : undefined }}>
        <input ref={fileInputRef} type="file" multiple hidden onChange={(event) => { enqueueFiles(Array.from(event.target.files ?? [])); event.target.value = '' }} />
        <ChatComposerContextBands {...props} />
        <AgentMentionSelectionNotice members={members} mentionTargets={activeTargets} agentStatuses={agentStatuses} />
        {invitation}
        <ChatComposer key={chatId} editorApiRef={editorApiRef} editorOptions={editorOptions} mobile={mobile}
          disabled={disabled} disabledPlaceholder={placeholder ?? disabledReason} canSubmit={!sending && (!!text.trim() || attachments.length > 0)}
          placeholder={whisperTarget ? t('composer.whisperPlaceholder', { name: whisperTarget.displayName }) : placeholder ?? (mobile && isGroupChat ? t('composer.mobilePlaceholder') : projectName && !mobile ? t('composer.projectGroupPlaceholder', { name: projectName }) : t('composer.placeholder'))}
          onInputChange={setText} onSubmit={(value) => { void handleSend(value) }} onMentionInsert={onMentionInsert}
          mentionProvider={mentionProvider} renderMentionIcon={renderMentionIcon} dataDropTypes={dataDropTypes} onDataDropped={onDataDropped}
          onFilesDropped={enqueueFiles} onImageFilesDropped={enqueueFiles}
          attachments={composerAttachments} onAttachmentsChange={(next) => { const kept = attachments.filter((file) => next.some((item) => item.id === file.id)); revokeAttachmentPreviewUrls(attachments.filter((file) => !kept.includes(file))); setAttachments(kept) }}
          toolbarExtra={<><ComposerAttachButton glyph={attachGlyph} actions={attachMenu} disabled={disabled} mobile={mobile} onPickFile={() => fileInputRef.current?.click()} />{isMain && !mobile && <ComposerVerbs chatId={chatId} isGroupChat={!!isGroupChat} draft={text} onCarried={() => setText('')} />}</>}
          queryCommands={async (query) => SLASH_COMMANDS.filter((command) => command.trigger.slice(1).startsWith(query)).map((command) => ({ id: command.id, name: command.id, behavior: 'execute' as const }))}
          onCommand={(item) => SLASH_COMMANDS.find((command) => command.id === item.id)?.run({ setText: (update) => editorApiRef.current?.setText(update(editorApiRef.current.getText())), clearText: () => editorApiRef.current?.clear() })}
          className={inChatSlot ? sessionComposerDockedWidthClassName : undefined} />
      </div>
    </MessageProvider>
  </ThemeProvider>
}
