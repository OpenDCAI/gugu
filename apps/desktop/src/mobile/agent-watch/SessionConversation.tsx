import { registerNativeComposer } from '@/lib/nativeComposerHandoff'
import { useNativeConversationRead } from '@/hooks/useNativeConversationRead'
import { useConversationVisibility } from '@/components/chat/useConversationVisibility'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { attachmentMimeTypeSchema, toolImageUrl, type PromptAttachment } from '@gugu/session-core/acp/client'
import { openImageViewer } from '@/lib/imageViewer'
import { PhoneTaskDraftRecovery } from '../local-agent/PhoneTaskDraftRecovery'
import { machineRpc, fetchToolImage } from './sessionpage-rpc'
import { phoneTimelineClient } from '../local-agent/phoneTimelineClient'
import type { ChatCommands, ChatView } from '@gugu/session-chat-ui'
import type { ComposerAttachment, PromptEditorRef } from '@gugu/session-ui/react/components'
import { MessageProvider } from '@gugu/session-ui/react/components'
import { ThemeProvider } from '@gugu/session-ui/react/primitives'
import { appendToDraft } from '@/store/chatContext'
import { useLocale } from '@/i18n'
import { useTheme } from '@/store/theme'
import { useChatDraft } from '@/components/chat/useChatDraft'
import { useConversationQueue } from '@/components/chat/useConversationQueue'
import { SessionTranscriptView } from '@/components/assistant-ui/session-transcript-view.aui'
import { AgentConversationComposer } from '@renderer/lib/chat/agent-conversation-view'
import { useComposerFileUploads } from '@renderer/features/sessions/acp/use-composer-file-uploads'
import { fileMentionsFor, composePromptText } from '@renderer/features/sessions/acp/composer-file-paths'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import type { SettlementResponse, SessionpageSessionRespondResult, SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import type { AgentWatchTimeline } from './agent-watch-store'
import type { PendingSend } from './pending-sends'
import { sessionAttachmentRpc, stopBackgroundTask } from './sessionpage-rpc'
import { ConversationSettlements } from '@/components/chat/ConversationSettlements'
import { useConversationOptions } from '@/components/chat/useConversationOptions'
import { useOpenedOutputOpener } from './opened-output-opener'
import { dismissSubagent } from '@renderer/features/sessions/view/subagent-dismissals'
import { usePhoneBackgroundTasks } from './background-tasks'
import { followConversationLink } from '@/lib/followConversationLink'
import { openMessageSender } from '@/lib/openMessageSender'
import { classifyFileLink } from '@gugu/core/shared/ui/guguLink'
import { ComposerAttachButton } from '@/components/chat/ComposerAttachButton'
import { messageForUser } from '@/lib/userFacingError'
import { nativeUserAttachmentCommands } from './native-user-attachments'
import { usePhoneSessionQuotes } from './use-phone-session-quotes'

/** The phone supplies session data and RPC actions to the same project conversation UI. */
export function SessionConversation({ timeline, deviceId, sessionId, agentName, agentUserId, draft, onDraftApplied, phoneHost = false, nativeRecord = false,
  machineLabel, sessionRuntime, respondingItemId, onRespond, onSend, pendingSends, sending, agentWorking,
  onStop, stopping, footerNotice, onLoadOlder, onAtBottom, emptyNote,
}: {
  timeline: AgentWatchTimeline; deviceId: string; sessionId: string; agentName: string; agentUserId?: string | null
  draft?: { text: string }; onDraftApplied?: () => void; phoneHost?: boolean; nativeRecord?: boolean; machineLabel?: string
  sessionRuntime: SessionpageSessionSummary['runtime']; respondingItemId: string | null
  onRespond: (input: SettlementResponse) => Promise<SessionpageSessionRespondResult>; onSend: (text: string, attachments?: PromptAttachment[]) => Promise<void>
  pendingSends: readonly PendingSend[]; sending: boolean; agentWorking: boolean
  headerRunning?: boolean
  onStop: () => void; stopping: boolean; footerNotice?: ReactNode; onLoadOlder: () => Promise<void>
  onAtBottom?: () => void; onLoadToolImage?: (itemId: string, index: number) => Promise<void>; emptyNote?: ReactNode
}) {
  const { resolvedLocale } = useLocale()
  const { theme } = useTheme()
  const visibility = useConversationVisibility(true)
  const reading = useNativeConversationRead(deviceId, phoneHost ? undefined : sessionId, visibility.shown, () => timeline.turns)
  const view = useRef<ChatView | null>(null)
  const [dismissals, setDismissals] = useState(0)
  const [backgroundError, setBackgroundError] = useState<string | null>(null)
  const editor = useRef<PromptEditorRef | null>(null)
  const inFlight = useRef(false)
  const input = useRef<HTMLInputElement>(null)
  const composerDraft = useChatDraft(`session:${deviceId}/${sessionId}`)
  const { text: draftText, setText: setDraftText } = composerDraft
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [attachmentWaiting, setAttachmentWaiting] = useState(false)
  const paths = useRef(new Map<string, string>())
  const applied = useRef<typeof draft>(undefined)
  // Hydrate before applying an App handoff, so the old mirror cannot overwrite its new text.
  useEffect(() => { if (editor.current?.getText() !== draftText) editor.current?.setText(draftText) }, [draftText])
  useEffect(() => {
    if (!draft || applied.current === draft) return
    applied.current = draft
    const next = appendToDraft(editor.current?.getText() ?? draftText, draft.text)
    setDraftText(next)
    editor.current?.setText(next)
    onDraftApplied?.()
  }, [draft, onDraftApplied, draftText, setDraftText])
  const options = useConversationOptions({ deviceId, sessionId, local: false, phoneHost })
  const queue = useConversationQueue({ deviceId, sessionId, local: false, phoneHost }, timeline.queuedPrompts, agentWorking, options.steers)
  const quotes = usePhoneSessionQuotes({ deviceId, sessionId, timeline, draftText, setDraftText, queue: queue.props, onLoadOlder, editor, view })
  const editorState = useRef({ text: draftText, edit: quotes.composer.queuedPromptEdit })
  editorState.current = { text: draftText, edit: quotes.composer.queuedPromptEdit }
  const receiveEditor = useCallback((handle: PromptEditorRef | null) => {
    editor.current = handle
    if (!handle) return
    const initial = editorState.current.edit?.text ?? editorState.current.text
    if (handle.getText() !== initial) handle.setText(initial)
  }, [])
  const uploads = useComposerFileUploads({ sessionId: () => sessionId, deviceLabel: () => machineLabel ?? null,
    setAttachments, onUploaded: (id, file) => paths.current.set(id, file.mentionPath), translate: translateSessionMessage,
    uploadRpc: sessionAttachmentRpc(deviceId, phoneHost) })
  const addFiles = (files: File[]) => {
    for (const file of files) {
      const id = crypto.randomUUID()
      void uploads.add({ id, name: file.name, kind: file.type.startsWith('image/') ? 'image' : 'file', mimeType: file.type }, {
        kind: 'file', name: file.name, mimeType: file.type, size: file.size,
        slice: async (start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer()),
      })
    }
  }
  const handoff = useRef({ addFiles, setDraftText, draftText })
  handoff.current = { addFiles, setDraftText, draftText }
  useEffect(() => {
    if (!visibility.shown) return
    return registerNativeComposer(sessionId, value => {
      const target = handoff.current
      target.addFiles(value.files ?? [])
      const next = appendToDraft(editor.current?.getText() ?? target.draftText, value.text)
      target.setDraftText(next); editor.current?.setText(next)
    })
  }, [sessionId, visibility.shown])
  const submit = async (value: string) => {
    if (sending || stopping || inFlight.current) return
    inFlight.current = true
    const sentQuote = quotes.capture()
    try {
      setAttachmentWaiting(uploads.unsettled())
      if (!await uploads.waitForUploads()) return
      setAttachmentWaiting(false)
      const sentAttachments = attachments
      const images: PromptAttachment[] = sentAttachments.flatMap(file => {
        const path = paths.current.get(file.id)
        const mimeType = attachmentMimeTypeSchema.safeParse(file.mimeType)
        return !phoneHost && sessionRuntime === 'acp' && path && mimeType.success ? [{ type: 'local-file' as const, originalPath: path, name: file.name, mimeType: mimeType.data }] : []
      })
      const imagePaths = new Set(images.flatMap(image => image.type === 'local-file' ? [image.originalPath] : []))
      const text = composePromptText(value, fileMentionsFor(sentAttachments.filter(file => !imagePaths.has(paths.current.get(file.id) ?? '')), paths.current))
      if (!text && !images.length) return
      composerDraft.setText(''); composerDraft.flush(); editor.current?.setText('')
      setAttachments(current => current.filter(file => !sentAttachments.some(sent => sent.id === file.id)))
      try {
        await onSend(quotes.prompt(text, sentQuote), images)
        quotes.consume(sentQuote)
        view.current?.setScrollMode({ kind: 'tail' })
        for (const file of sentAttachments) { paths.current.delete(file.id); uploads.forget(file.id) }
      } catch {
        const live = editor.current?.getText() ?? ''
        const restored = appendToDraft(value, live)
        composerDraft.setText(restored); editor.current?.setText(restored)
        setAttachments(current => [...sentAttachments.filter(file => !current.some(kept => kept.id === file.id)), ...current])
      }
    } finally { setAttachmentWaiting(false); inFlight.current = false }
  }
  const recoveryState = useRef({ text: composerDraft.text, attachments })
  recoveryState.current = { text: composerDraft.text, attachments }
  const recoveryComposer = useMemo(() => ({ getState: () => recoveryState.current, setText: composerDraft.setText }), [composerDraft.setText])
  const outputs = useOpenedOutputOpener({ deviceId, sessionId, onQuote: text => composerDraft.setText(value => appendToDraft(value, text)) })
  const background = usePhoneBackgroundTasks(deviceId, sessionId, timeline.turns, dismissals, !phoneHost)
  const turns = timeline.turns
  const attachmentTurns = useRef(turns)
  attachmentTurns.current = turns
  const userAttachments = useMemo(() => nativeUserAttachmentCommands({
    turns: () => attachmentTurns.current,
    readImage: async (itemId, attachmentId) => {
      const result = await machineRpc(deviceId).sessionTimeline.sessionNativeAttachment({ conversationId: sessionId, itemId, attachmentId })
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    },
    readPathImage: async path => {
      const client = machineRpc(deviceId)
      const resolved = await client.sessionCreate.resolveAttachmentPath(sessionId, path)
      if (!resolved.success) throw new Error('图片附件无法读取')
      const result = await client.app.readUserImageDataUrl(resolved.data)
      if (!result.success) throw new Error(result.error)
      return result.dataUrl
    },
    openImage: (url, name, thumb) => openImageViewer([{ url, alt: name, thumb }], 0),
    openFile: outputs.openFile,
    unavailable: () => translateSessionMessage('attachmentViewer.unavailable'),
    onError: error => setBackgroundError(messageForUser(error)),
  }), [deviceId, sessionId, outputs.openFile])
  const commands: ChatCommands = {
    ...(nativeRecord && !phoneHost ? userAttachments : {}),
    classifyLink: classifyFileLink, onOpenLink: followConversationLink, onOpenSender: openMessageSender,
    conversationAgentSession: () => sessionId, conversationAgentUserId: () => agentUserId ?? null,
    ...quotes.commands,
    onDismissBackgroundTask: ({ entryId }) => { dismissSubagent(sessionId, entryId); setDismissals(value => value + 1) },
    resolveToolImage: async (itemId, index) => toolImageUrl(await (phoneHost ? phoneTimelineClient.fetchToolImage(deviceId, sessionId, itemId, index) : nativeRecord ? machineRpc(deviceId).sessionTimeline.sessionNativeToolImage({ conversationId: sessionId, itemId, index }).then(result => { if (!result.ok) throw new Error(result.error.message); if (!result.value.ok) throw new Error(result.value.message); return result.value.image }) : fetchToolImage(deviceId, sessionId, itemId, index))),
    onViewImages: ({ urls, index, thumb }) => { openImageViewer(urls.map(url => ({ url, alt: '', thumb })), index) }, ...outputs.handlers, conversationAgentName: () => agentName, onStop,
    onStopBackgroundTask: ({ stopId }) => {
      setBackgroundError(null)
      void stopBackgroundTask(deviceId, sessionId, stopId).catch(error => setBackgroundError(messageForUser(error)))
    },
  }
  const composer = <>
    <ConversationSettlements sessionId={sessionId} settlements={timeline.settlements} runtime={sessionRuntime} mobile machine={machineLabel} busyItemId={respondingItemId} respond={onRespond} />
    {footerNotice}
    {backgroundError ? <div role="alert">{backgroundError}</div> : null}
    {phoneHost ? <PhoneTaskDraftRecovery deviceId={deviceId} sessionId={sessionId} composer={recoveryComposer} sending={sending} /> : null}
    {queue.error ? <div role="alert">{queue.error}</div> : null}
    {quotes.composer.preview}
    <input ref={input} type="file" hidden multiple onChange={event => { addFiles(Array.from(event.target.files ?? [])); event.target.value = '' }} />
    <AgentConversationComposer {...options.props} {...queue.props} queuedPrompts={[...queue.props.queuedPrompts, ...pendingSends.slice(1).map(send => ({ id: send.id, text: send.text, origin: 'manual' as const, locked: true }))]} mobile isWorking={agentWorking} canSubmit={!sending && !stopping && (!!composerDraft.text.trim() || attachments.length > 0)}
      onStop={agentWorking ? onStop : undefined} editorApiRef={receiveEditor} editorOptions={{ clearOnSubmit: false, enterBehavior: 'newline' }}
      queuedPromptEdit={quotes.composer.queuedPromptEdit} onChangeQueuedPromptEdit={quotes.composer.changeQueuedPromptEdit} onFinishQueuedPromptEdit={quotes.composer.finishQueuedPromptEdit} renderQueuedPromptText={quotes.composer.renderQueuedPromptText}
      onInputChange={composerDraft.setText} onSubmit={value => { void submit(value) }} onSubmitWhileWorking={value => { void submit(value) }}
      attachmentStatus={attachmentWaiting ? translateSessionMessage('composer.attachmentWaiting') : undefined}
      attachments={attachments} onAttachmentsChange={next => { uploads.keepOnly(new Set(next.map(file => file.id))); setAttachments(next) }}
      onRetryAttachment={uploads.retry} onFilesDropped={addFiles} onImageFilesDropped={addFiles}
      toolbarExtra={<><ComposerAttachButton disabled={sending} mobile onPickFile={() => input.current?.click()} /></>} />
  </>
  return <ThemeProvider theme={theme} target="documentElement"><MessageProvider locale={resolvedLocale} translate={translateSessionMessage}>
    <div ref={visibility.ref} className="relative flex min-h-0 flex-1 flex-col"><SessionTranscriptView uri={sessionId} turns={turns} pendingPrompt={pendingSends[0] ?? null} mobile commands={commands} backgroundTasks={background}
      onReachStart={() => { void quotes.loadOlder() }} composerContent={composer} shown={visibility.shown} onAtBottomChange={atBottom => { if (atBottom) onAtBottom?.() }} onVisibleItems={reading.onVisibleItems} onReady={ready => { view.current = ready; reading.onReady(ready) }} className="relative min-h-0 flex-1" />
    {turns.length === 0 ? emptyNote : null}</div>{outputs.panel}{options.confirmation}
  </MessageProvider></ThemeProvider>
}
