import { useAttachmentFileSelection } from '@/hooks/useAttachmentFileSelection'
import { useRejectedSessionInputCommands } from '@/hooks/useRejectedSessionInputCommands'
import { registerNativeComposer } from '@/lib/nativeComposerHandoff'
import { useNativeConversationRead } from '@/hooks/useNativeConversationRead'
import { useConversationVisibility } from '@/components/chat/useConversationVisibility'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { toolImageUrl } from '@gugu/session-core/acp/client'
import { openImageViewer } from '@/lib/imageViewer'
import { PhoneTaskDraftRecovery } from '../local-agent/PhoneTaskDraftRecovery'
import { machineRpc, fetchToolImage } from './sessionpage-rpc'
import { assistantTimelineClient, readConversationFile } from '@/components/assistant/assistantTimelineClient'
import { phoneTimelineClient } from '../local-agent/phoneTimelineClient'
import type { ChatCommands, ChatView } from '@gugu/session-chat-ui'
import type { ComposerAttachment, PromptEditorRef } from '@gugu/session-ui/react/components'
import { MessageProvider } from '@gugu/session-ui/react/components'
import { ThemeProvider } from '@gugu/session-ui/react/primitives'
import { appendToDraft } from '@/store/chatContext'
import { useLocale } from '@/i18n'
import { useTheme } from '@/store/theme'
import { useSessionConversationDraft } from './use-session-conversation-draft'
import { useMobileShell } from '@/hooks/useMobileShell'
import { usePhoneInputQueue } from './use-phone-input-queue'
import { phoneQueueReady, phoneWaitingReceipts } from './phone-input-queue'
import { SessionTranscriptView } from '@/components/assistant-ui/session-transcript-view.aui'
import { AgentConversationComposer } from '@renderer/lib/chat/agent-conversation-view'
import { useComposerFileUploads } from '@renderer/features/sessions/acp/use-composer-file-uploads'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import type { SettlementResponse, SessionpageSessionRespondResult, SessionpageSessionSummary, TurnFileRef } from '@gugu/session-core/session-record/contract'
import { chatService } from '@/lib/chat'
import { getRendererSession } from '@/lib/sessionPublication'
import type { AgentWatchTimeline } from './agent-watch-store'
import type { PendingSend } from './pending-sends'
import { stopBackgroundTask } from './sessionpage-rpc'
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
import { toast } from '@renderer/lib/hooks/use-toast'
import { nativeUserAttachmentCommands } from './native-user-attachments'
import { usePhoneSessionQuotes } from './use-phone-session-quotes'
import { EngineIcon } from '@/components/AgentHarnessIdentity'
import { engineLabel } from '@/lib/usage/engineLabel'
import { useQueuedSessionInputs, useSessionInputAccount } from '@/lib/sessionInputOutboxBridge'
import { localQueuedInputs } from './local-queued-inputs'
import type { SessionInput } from '@/lib/sessionInputOutbox'
import { projectRejectedSessionInputs } from '@/lib/pendingSessionInput'
import { projectPhonePendingInputs } from './phone-pending-inputs'
import { projectSessionPendingDeliveries } from '@/lib/pendingSessionDeliveries'
import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope'
import { useSessionLifeView } from './useSessionLifeView'
import { usePendingDeliveryHistory } from './usePendingDeliveryHistory'
import type { LifeView } from '@/session/shared/core/sessions/session-life'
import type { PendingPrompt } from '@gugu/session-chat-ui'
import { pendingPromptLanded } from '@session-chat/state/pending-prompt'
import { useMarkSeenWhenShown } from '@renderer/features/sessions/hooks/use-mark-seen-when-shown'
import { markNeedsYouTaskSeen } from '@/components/needsYou/useNeedsYouTasks'
import { rendererLogger } from '@/lib/log'

/** The phone supplies session data and RPC actions to the same project conversation UI. */
export function SessionConversation({ timeline, deviceId, sessionId, agentName, agentUserId, harness, draft, onDraftApplied, startupPrompt, phoneHost = false, local = false, nativeRecord = false, hostReachable = true,
  machineLabel, sessionRuntime, respondingItemId, onRespond, onSend, pendingSends, sending, agentWorking,
  onStop, stopping, footerNotice, onLoadOlder, onAtBottom, emptyNote, onBeforeSend,
  historyReady = true, historyCursor, queueReady = false, unseen = false,
}: {
  timeline: AgentWatchTimeline; deviceId: string; sessionId: string; agentName: string; agentUserId?: string | null
  /** 这条会话的 harness(claude-code / codex …):输入框里模型左边那颗锁着的标,同桌面会话页。 */
  harness?: string
  draft?: { text: string }; onDraftApplied?: () => void; phoneHost?: boolean
  /** The host's read bit for this task; showing the task clears it, as on the desktop task page. */
  unseen?: boolean
  /** The session is on this computer: read it over IPC (see `machineRpc`). */
  local?: boolean; nativeRecord?: boolean; hostReachable?: boolean; machineLabel?: string
  startupPrompt?: import('@gugu/session-chat-ui').PendingPrompt | null
  sessionRuntime: SessionpageSessionSummary['runtime']; respondingItemId: string | null
  onRespond: (input: SettlementResponse) => Promise<SessionpageSessionRespondResult>; onSend: (text: string, files?: TurnFileRef[]) => Promise<void>
  onBeforeSend?: () => void
  pendingSends: readonly PendingSend[]; sending: boolean; agentWorking: boolean
  headerRunning?: boolean
  onStop: () => void; stopping: boolean; footerNotice?: ReactNode; onLoadOlder: () => Promise<void>
  onAtBottom?: () => void; onLoadToolImage?: (itemId: string, index: number) => Promise<void>; emptyNote?: ReactNode
  historyReady?: boolean; historyCursor?: number | null
  /** A live foreground snapshot, not a cached/offline history window. */
  queueReady?: boolean
}) {
  const { resolvedLocale } = useLocale()
  const { theme } = useTheme()
  const visibility = useConversationVisibility(true)
  const localClient = local ? assistantTimelineClient(true) : null
  const reading = useNativeConversationRead(deviceId, phoneHost ? undefined : sessionId, visibility.shown, () => timeline.turns)
  useMarkSeenWhenShown(useMemo(() => ({
    seen: !unseen,
    markSeen: () => {
      markNeedsYouTaskSeen({ deviceId, local, phoneHost, session: { conversationId: sessionId } }).catch((error: unknown) => {
        rendererLogger('session/read').warn({ sessionId, error: String(error) }, 'The shown task could not be marked read')
      })
    },
  }), [unseen, deviceId, local, phoneHost, sessionId]), visibility.shown)
  const view = useRef<ChatView | null>(null)
  const [dismissals, setDismissals] = useState(0)
  const [backgroundError, setBackgroundError] = useState<string | null>(null)
  const editor = useRef<PromptEditorRef | null>(null)
  const inFlight = useRef<{ attachments: ReadonlySet<string>; waiting: boolean; cancelWait(): void } | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const sendTarget = useRef({ deviceId, sessionId, onSend, onBeforeSend })
  sendTarget.current = { deviceId, sessionId, onSend, onBeforeSend }
  const mobile = useMobileShell()
  const composerDraft = useSessionConversationDraft(deviceId, sessionId, !mobile && nativeRecord && !local && !phoneHost, editor)
  const { text: draftText, setText: setDraftText } = composerDraft
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const fileSelection = useAttachmentFileSelection(attachments, `${deviceId}/${sessionId}`)
  const [attachmentWaiting, setAttachmentWaiting] = useState(false)
  const applied = useRef<typeof draft>(undefined)
  const mirroredText = useRef(draftText)
  // Hydrate before applying an App handoff, so the old mirror cannot overwrite its new text.
  useLayoutEffect(() => {
    const previous = mirroredText.current
    mirroredText.current = draftText
    // Input can advance after this render. Only apply external changes to the document it observed.
    if (editor.current?.getText() === previous && previous !== draftText) editor.current.setText(draftText)
  }, [draftText])
  useEffect(() => {
    if (!draft || applied.current === draft) return
    applied.current = draft
    const next = appendToDraft(editor.current?.getText() ?? draftText, draft.text)
    setDraftText(next)
    editor.current?.setText(next)
    onDraftApplied?.()
  }, [draft, onDraftApplied, draftText, setDraftText])
  const options = useConversationOptions({ deviceId, sessionId, local, phoneHost, reachable: hostReachable }, harness ? engineLabel(harness) : agentName)
  const senderInputs = useQueuedSessionInputs(sessionId)
  const account = useSessionInputAccount()
  const life = useSessionLifeView(deviceId, sessionId, local, !phoneHost && hostReachable,
    timeline.queuedPrompts.length > 0 || pendingSends.length > 0 || senderInputs.length > 0)
  const localQueue = useRef<{ key: string; inputs: readonly SessionInput[] }>({ key: '', inputs: [] })
  const localQueueKey = `${account}/${deviceId}/${sessionId}`
  const localInputs = mobile && account ? localQueuedInputs(localQueue.current.key === localQueueKey ? localQueue.current.inputs : [],
    senderInputs, timeline.queuedPrompts, timeline.turns) : []
  localQueue.current = { key: localQueueKey, inputs: localInputs }
  const queue = usePhoneInputQueue({ deviceId, sessionId, local, phoneHost }, senderInputs, timeline.queuedPrompts,
    timeline.turns, agentWorking, stopping, phoneQueueReady(queueReady, phoneHost, life.view), options.steers,
    () => phoneQueueReady(queueReady, phoneHost, life.current()))
  const quotes = usePhoneSessionQuotes({ deviceId, sessionId, timeline, draftText, setDraftText, queue: queue.props, onLoadOlder, editor, view })
  const editorState = useRef({ text: draftText, edit: quotes.composer.queuedPromptEdit })
  editorState.current = { text: draftText, edit: quotes.composer.queuedPromptEdit }
  const receiveEditor = useCallback((handle: PromptEditorRef | null) => {
    editor.current = handle
    if (!handle) return
    const initial = editorState.current.edit?.text ?? editorState.current.text
    if (handle.getText() !== initial) handle.setText(initial)
  }, [])
  // 附件放进这个 agent 私聊的文件夹(P3;与通讯录「发消息」同一个 getOrCreateDM),这一轮带着引用发出去。
  const uploads = useComposerFileUploads({ setAttachments, translate: translateSessionMessage,
    to: async () => {
      const owner = getRendererSession()?.user.id
      if (!owner) throw new Error('attachments: not signed in')
      if (!agentUserId) throw Object.assign(new Error('attachments: no agent chat to place them in'), { code: 'task_identity_missing' })
      return { chatId: await chatService.getOrCreateDM(owner, agentUserId), owner, deviceId: local ? null : deviceId, sessionId }
    } })
  const addFiles = (files: File[]) => {
    for (const { id, file } of fileSelection.choose(files)) {
      void uploads.add({ id, name: file.name, kind: file.type.startsWith('image/') ? 'image' : 'file', mimeType: file.type }, file)
    }
  }
  const changeAttachments = (next: ComposerAttachment[]) => {
    const kept = new Set(next.map(file => file.id))
    const submission = inFlight.current
    if (submission?.waiting && [...submission.attachments].some(id => !kept.has(id))) {
      submission.cancelWait()
      inFlight.current = null
      setAttachmentWaiting(false)
    }
    uploads.keepOnly(kept)
    setAttachments(next)
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
  // An upload keeps the conversation where this submission began.
  const currentSendTarget = () => sendTarget.current.deviceId === deviceId && sendTarget.current.sessionId === sessionId
    ? sendTarget.current : { onSend, onBeforeSend }
  const checkBeforeSend = () => {
    try { currentSendTarget().onBeforeSend?.(); return true }
    catch (error) {
      toast({ title: translateSessionMessage('acpFailure.sendMessage'), description: messageForUser(error), variant: 'destructive' })
      return false
    }
  }
  const submit = async (value: string) => {
    if (sending || stopping || inFlight.current || !checkBeforeSend()) return
    const ownerId = getRendererSession()?.user.id
    let cancelWait!: () => void
    const cancelled = new Promise<false>(resolve => { cancelWait = () => resolve(false) })
    const submission = { attachments: new Set(attachments.map(file => file.id)), waiting: uploads.unsettled(), cancelWait }
    inFlight.current = submission
    try {
      setAttachmentWaiting(submission.waiting)
      if (!await Promise.race([uploads.waitForUploads(), cancelled]) || inFlight.current !== submission) return
      submission.waiting = false
      setAttachmentWaiting(false)
      const sentAttachments = attachments
      const files = uploads.files(sentAttachments.map(file => file.id))
      const text = value.trim()
      if ((!text && !files.length) || !checkBeforeSend()) return
      try {
        // A later reader gesture supersedes this local send, including while its commit waits.
        view.current?.setScrollMode({ kind: 'tail' })
        await currentSendTarget().onSend(text, files)
        if (getRendererSession()?.user.id !== ownerId) return
        composerDraft.committed(value)
        setAttachments(current => current.filter(file => !sentAttachments.some(sent => sent.id === file.id)))
        for (const file of sentAttachments) uploads.forget(file.id)
      } catch (error) {
        if (getRendererSession()?.user.id !== ownerId) return
        toast({ title: translateSessionMessage('acpFailure.sendMessage'), description: messageForUser(error), variant: 'destructive' })
      }
    } finally {
      if (inFlight.current === submission) { setAttachmentWaiting(false); inFlight.current = null }
    }
  }
  const recoveryState = useRef({ text: composerDraft.text, attachments })
  recoveryState.current = { text: composerDraft.text, attachments }
  const recoveryComposer = useMemo(() => ({ getState: () => recoveryState.current, setText: composerDraft.setText }), [composerDraft.setText])
  const quoteOutput = useCallback((text: string) => setDraftText(value => appendToDraft(value, text)), [setDraftText])
  const readOutput = useCallback((input: Parameters<typeof readConversationFile>[2]) => readConversationFile(true, deviceId, input), [deviceId])
  const outputs = useOpenedOutputOpener({ deviceId, sessionId, onQuote: quoteOutput, readFileChunk: local ? readOutput : undefined })
  const { openFile, handlers: outputHandlers } = outputs
  const background = usePhoneBackgroundTasks(deviceId, sessionId, timeline.turns, dismissals, !phoneHost, localClient?.fetchBackgroundTasks)
  const nativeTurns = timeline.turns
  const pendingInput = useRef<{ sessionId: string; prompts: readonly PendingPrompt[] }>({ sessionId, prompts: [] })
  const hostInputs = useMemo(() => {
    const inputs = [...(life.view?.pending.items ?? [])]
    for (const receipt of phoneWaitingReceipts(timeline.queuedPrompts)) if (!inputs.some(input => input.messageId === receipt.messageId)) inputs.push(receipt)
    return inputs
  }, [life.view?.pending.items, timeline.queuedPrompts])
  const projectedInputs = useMemo(() => projectPhonePendingInputs(pendingInput.current.sessionId === sessionId ? pendingInput.current.prompts : [],
    senderInputs, hostInputs, nativeTurns), [sessionId, senderInputs, hostInputs, nativeTurns])
  const projectedInput = projectedInputs[0]
  const pendingPrompt = projectedInput && startupPrompt?.id === projectedInput.id
    ? { ...projectedInput, starting: startupPrompt.starting } : projectedInput
  pendingInput.current = { sessionId, prompts: projectedInputs }
  const received = useRef<{ key: string; inputs: readonly PendingPrompt[] }>({ key: '', inputs: [] })
  const receivedKey = `${deviceId}/${sessionId}`
  // Phone-host jobs expose their waiting envelope through the existing native queue snapshot.
  const phonePending = useMemo<LifeView | null>(() => phoneHost ? { sessionId, version: 0, kind: 'ready', stage: null, hold: null,
    failure: null, lastExit: null, nativeSession: null, pending: { count: timeline.queuedPrompts.length,
      items: timeline.queuedPrompts.flatMap((input, seq) => readDeliveryEnvelope(input.text)
        ? [{ seq, messageId: input.id, text: input.text, preview: input.text, kind: 'session-direct' as const, state: 'queued' as const, failure: null }] : []) } } : null,
  [phoneHost, sessionId, timeline.queuedPrompts])
  const receivedInputs = useMemo(() => projectSessionPendingDeliveries(received.current.key === receivedKey ? received.current.inputs : [], phonePending ?? life.view, nativeTurns),
    [receivedKey, phonePending, life.view, nativeTurns])
  const receiptHistory = usePendingDeliveryHistory({ deviceId, sessionId, local, enabled: nativeRecord && !phoneHost,
    ready: historyReady, cursor: historyCursor, turns: nativeTurns, inputs: receivedInputs })
  const turns = receiptHistory.turns
  const settledInputs = useMemo(() => receivedInputs.filter(input => input.delivery?.state !== 'accepted' || !pendingPromptLanded(input, turns)), [receivedInputs, turns])
  received.current = { key: receivedKey, inputs: settledInputs }
  const pendingMessages = useMemo(() => [...settledInputs.filter(receiptHistory.visible), ...projectedInputs.slice(1), ...projectRejectedSessionInputs(senderInputs, nativeTurns), ...pendingSends.slice(1).map(send => ({
    ...send, held: true, baselineMessageIds: [...send.baseline], delivery: { state: 'sending' as const },
  }))], [settledInputs, projectedInputs, receiptHistory.visible, pendingSends, senderInputs, nativeTurns])
  const rejectedInputCommands = useRejectedSessionInputCommands(sessionId)
  const attachmentTurns = useRef(turns)
  attachmentTurns.current = turns
  const userAttachments = useMemo(() => nativeUserAttachmentCommands({
    turns: () => attachmentTurns.current,
    readImage: async (itemId, attachmentId) => {
      const result = await machineRpc(deviceId, local).sessionTimeline.sessionNativeAttachment({ conversationId: sessionId, itemId, attachmentId })
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    },
    readPathImage: async path => {
      const result = await machineRpc(deviceId, local).app.readUserImageDataUrl(path)
      if (!result.success) throw new Error(result.error)
      return result.dataUrl
    },
    openImage: (url, name, thumb) => openImageViewer([{ url, alt: name, file: { name }, thumb }], 0),
    openFile: outputs.openFile,
    unavailable: () => translateSessionMessage('attachmentViewer.unavailable'),
    onError: error => setBackgroundError(messageForUser(error)),
  }), [deviceId, sessionId, local, outputs.openFile])
  // Publishing new commands remeasures every Solid transcript row. Editing a
  // phone draft must not rebuild the history before its outbox commit can run.
  const commands = useMemo<ChatCommands>(() => ({
    ...rejectedInputCommands,
    onRetrySend: id => {
      const input = received.current.inputs.find(input => input.id === id && input.delivery?.state === 'unknown')
      if (!input) return rejectedInputCommands.onRetrySend?.(id)
      if (input.delivery?.retryable) void machineRpc(deviceId, local).sessions.lifeRetryUnknown(sessionId, id).catch(error => setBackgroundError(messageForUser(error)))
    },
    ...(nativeRecord && !phoneHost ? userAttachments : {}),
    classifyLink: classifyFileLink, onOpenLink: followConversationLink, onOpenSender: openMessageSender,
    onOpenFile: ({ path, source }) => openFile(path, source),
    conversationAgentSession: () => sessionId, conversationAgentUserId: () => agentUserId ?? null,
    ...quotes.commands,
    onDismissBackgroundTask: ({ entryId }) => { dismissSubagent(sessionId, entryId); setDismissals(value => value + 1) },
    resolveToolImage: async (itemId, index) => toolImageUrl(await (phoneHost ? phoneTimelineClient.fetchToolImage(deviceId, sessionId, itemId, index) : nativeRecord ? machineRpc(deviceId, local).sessionTimeline.sessionNativeToolImage({ conversationId: sessionId, itemId, index }).then(result => { if (!result.ok) throw new Error(result.error.message); if (!result.value.ok) throw new Error(result.value.message); return result.value.image }) : (localClient ?? { fetchToolImage }).fetchToolImage(deviceId, sessionId, itemId, index))),
    onViewImages: ({ urls, index, thumb }) => { openImageViewer(urls.map(url => ({ url, alt: '', thumb })), index) }, ...outputHandlers, conversationAgentName: () => agentName, onStop,
    onStopBackgroundTask: ({ stopId }) => {
      setBackgroundError(null)
      void (localClient?.stopBackgroundTask ?? stopBackgroundTask)(deviceId, sessionId, stopId).catch(error => setBackgroundError(messageForUser(error)))
    },
  }), [rejectedInputCommands, nativeRecord, phoneHost, userAttachments, openFile, outputHandlers, sessionId, agentUserId, quotes.commands, deviceId, local, localClient, agentName, onStop])
  const composer = <>
    <ConversationSettlements sessionId={sessionId} settlements={timeline.settlements} runtime={sessionRuntime} mobile machine={machineLabel} busyItemId={respondingItemId} respond={onRespond} />
    {footerNotice}
    {backgroundError ? <div role="alert">{backgroundError}</div> : null}
    {life.error || receiptHistory.error ? <div role="alert">{life.error ?? receiptHistory.error}</div> : null}
    {phoneHost ? <PhoneTaskDraftRecovery deviceId={deviceId} sessionId={sessionId} composer={recoveryComposer} sending={sending} /> : null}
    {queue.error ? <div role="alert">{queue.error}</div> : null}
    <input ref={input} type="file" hidden multiple onChange={event => { addFiles(Array.from(event.target.files ?? [])); event.target.value = '' }} />
    <AgentConversationComposer {...options.props} {...queue.props} {...lockedHarness(harness)} queuedPrompts={[...queue.props.queuedPrompts, ...localInputs.filter(input => !input.failure).map(input => ({ id: input.id, text: input.text, origin: 'manual' as const, locked: true }))]} mobile phoneActions={mobile} isWorking={agentWorking} canSubmit={!sending && !stopping && (!!composerDraft.text.trim() || attachments.length > 0)}
      onStop={agentWorking ? onStop : undefined} editorApiRef={receiveEditor} editorOptions={{ clearOnSubmit: false, enterBehavior: 'newline' }}
      queuedPromptEdit={quotes.composer.queuedPromptEdit} onChangeQueuedPromptEdit={quotes.composer.changeQueuedPromptEdit} onFinishQueuedPromptEdit={quotes.composer.finishQueuedPromptEdit} renderQueuedPromptText={quotes.composer.renderQueuedPromptText}
      onInputChange={composerDraft.setText} onSubmit={submit} onSubmitWhileWorking={submit}
      attachmentStatus={attachmentWaiting ? translateSessionMessage('composer.attachmentWaiting') : undefined}
      attachments={attachments} onAttachmentsChange={changeAttachments}
      onRetryAttachment={uploads.retry} onFilesDropped={addFiles} onImageFilesDropped={addFiles}
      toolbarExtra={<><ComposerAttachButton disabled={sending} mobile onPickFile={() => input.current?.click()} /></>} />
  </>
  return <ThemeProvider theme={theme} target="documentElement"><MessageProvider locale={resolvedLocale} translate={translateSessionMessage}>
    <div ref={visibility.ref} className="relative flex min-h-0 flex-1 flex-col"><SessionTranscriptView uri={sessionId} turns={turns} pendingPrompt={pendingPrompt ?? startupPrompt ?? pendingSends[0] ?? null} pendingMessages={pendingMessages} mobile commands={commands} backgroundTasks={background}
      onReachStart={() => { void quotes.loadOlder() }} composerContent={composer} shown={visibility.shown} onAtBottomChange={atBottom => { reading.onAtBottomChange(atBottom); if (atBottom) onAtBottom?.() }} onVisibleItems={reading.onVisibleItems} onReady={ready => { view.current = ready; reading.onReady(ready) }} className="relative min-h-0 flex-1" />
    {turns.length === 0 ? emptyNote : null}</div>{outputs.panel}{options.confirmation}
  </MessageProvider></ThemeProvider>
}

/** 模型左边那颗锁着的 harness 标(桌面会话页同一颗);不知道 harness 时照旧不画。 */
function lockedHarness(harness: string | undefined) {
  if (!harness) return {}
  return { hideLockedAgent: false, selectedAgent: harness, agentOptions: [{ id: harness, name: engineLabel(harness), icon: <EngineIcon engine={harness} size={14} /> }] }
}
