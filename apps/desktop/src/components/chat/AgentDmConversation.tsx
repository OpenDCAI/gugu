import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { useAuth } from '@/store/auth'
import { useChatStore } from '@/store/chatContext'
import { useAgentDmSession } from '@/hooks/useAgentDmSession'
import { useTimelineSession } from '@/mobile/agent-watch/use-timeline-session'
import { useOpenedOutputOpener } from '@/mobile/agent-watch/opened-output-opener'
import { readConversationFile, assistantTimelineClient } from '../assistant/assistantTimelineClient'
import { SessionTranscriptView } from '../assistant-ui/session-transcript-view.aui'
import { ChatMessageComposer } from './ChatMessageComposer'
import { PaneHeader } from '../ui/Pane'
import { IconButton } from '../ui/IconButton'
import { ArrowLeft } from '@/lib/icons'
import { displayedDmMessages, dmRecord, dmRecordIds, mergeDmRecord } from './agent-dm-record'
import { useConversationOptions } from './useConversationOptions'
import { useConversationQueue } from './useConversationQueue'
import { ConversationSettlements } from './ConversationSettlements'
import { toolImageUrl } from '@gugu/session-core/acp/client'
import { openImageViewer } from '@/lib/imageViewer'
import { usePhoneBackgroundTasks } from '@/mobile/agent-watch/background-tasks'
import { dismissSubagent } from '@renderer/features/sessions/view/subagent-dismissals'
import { createSessionpageChatSendPreflight } from '@/lib/sessionpage-session-recovery'
import { followConversationLink } from '@/lib/followConversationLink'
import { openMessageSender } from '@/lib/openMessageSender'
import { classifyFileLink } from '@gugu/core/shared/ui/guguLink'
import { agentComposerModel, isRetiredCloudAgentChat } from '@/lib/agentComposerModel'
import { useAgentDisplayStatus } from '@/hooks/useAgentDisplayStatus'
import { useContactsStore } from '@/store/contactsContext'
import type { ComposerAttachAction } from './ChatMessageComposer'
import { parseAttachmentContent } from '@gugu/core/shared/ui/attachmentModels'
import { useMessageFilePreview } from './useMessageFilePreview'
import { useToast } from '../toastContext'
import { messageForUser } from '@/lib/userFacingError'
import { MessageLoadFailure } from './MessageLoadFailure'
import { MessageProvider } from '@gugu/session-ui/react/components'
import { ThemeProvider } from '@gugu/session-ui/react/primitives'
import { useLocale } from '@/i18n'
import { useTheme } from '@/store/theme'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import { ConversationErrorBoundary } from './ConversationErrorBoundary'
import { useAgentDmRead } from './useAgentDmRead'
import { useConversationVisibility } from './useConversationVisibility'

type Chrome = { attachGlyph: import('react').ReactNode; attachMenu?: readonly ComposerAttachAction[]; composerHeader?: import('react').ReactNode }

type Target = { deviceId: string; sessionId: string; local: boolean }

/** DM navigation ends here. No agent DM is rendered by the legacy IM page. */
type Props = {
  chat: ChatItem; shown: boolean; mobile?: boolean; onBack?: () => void; chrome?: Chrome; embedded?: boolean; searchQuery?: string
}
export function AgentDmConversation(props: Props) {
  const { resolvedLocale } = useLocale()
  const { theme } = useTheme()
  return <ConversationErrorBoundary key={props.chat.id}><ThemeProvider theme={theme} target="documentElement">
    <MessageProvider locale={resolvedLocale} translate={translateSessionMessage}><AgentDmSession {...props} /></MessageProvider>
  </ThemeProvider></ConversationErrorBoundary>
}

function AgentDmSession({ chat, shown, mobile = false, onBack, chrome, embedded, searchQuery }: Props) {
  const { session } = useAgentDmSession(chat.peer_user_id ?? null)
  const target = session.state === 'ready' ? session : null
  return <DmConversation key={chat.id} chat={chat} target={target} shown={shown} mobile={mobile} onBack={onBack} chrome={chrome} embedded={embedded} searchQuery={searchQuery} />
}

function DmConversation({ chat, target, shown: requestedShown, mobile, onBack, chrome, embedded, searchQuery = '' }: {
  chat: ChatItem; target: Target | null; shown: boolean; mobile: boolean; onBack?: () => void; chrome?: Chrome; embedded?: boolean; searchQuery?: string
}) {
  const { ref, shown } = useConversationVisibility(requestedShown)
  const { toast } = useToast()
  const { user } = useAuth()
  const filePreview = useMessageFilePreview({ mobile, visible: shown, closeRightSurfaces: () => {}, toast })
  const [dismissals, setDismissals] = useState(0)
  const { t } = useTranslation('messaging')
  const { identitiesById, messages, messagesError, refreshMessages, sendMessage, sendAttachments,
    loadOlderMessages, loadMessageAnchor, unreadEntry, markMessageVisible, setFollowingTail, retrySend, writeDraft } = useChatStore('identitiesById', 'messages', 'messagesError', 'refreshMessages',
      'sendMessage', 'sendAttachments', 'loadOlderMessages', 'loadMessageAnchor', 'unreadEntry', 'markMessageVisible', 'setFollowingTail', 'retrySend', 'writeDraft')
  const { contacts } = useContactsStore()
  const contact = contacts.find(item => item.id === chat.peer_user_id)
  const presence = useAgentDisplayStatus(chat.peer_user_id)
  const identity = identitiesById[chat.peer_user_id ?? '']
  const gate = agentComposerModel({ status: presence.status, retiredCloud: isRetiredCloudAgentChat({ isAgentChat: true, agentType: contact?.agent_type, chatDeviceId: identity?.device_id, contactDeviceId: contact?.device_id }) })
  const name = chat.peer_alias || identity?.display_name || chat.name
  const client = assistantTimelineClient(target?.local === true, { trim: false })
  const read = useTimelineSession(client, mobile ? 'mobile' : 'desktop', target?.deviceId ?? null, target?.sessionId ?? null, shown && !!target)
  const turns = useMemo(() => target && read.timeline.turns.length
    ? mergeDmRecord(read.timeline.turns, messages, identitiesById) : dmRecord(messages, identitiesById),
    [target, read.timeline.turns, messages, identitiesById])
  const background = usePhoneBackgroundTasks(target?.deviceId ?? '', target?.sessionId ?? '', read.timeline.turns, dismissals, !!target, client.fetchBackgroundTasks)
  const outputs = useOpenedOutputOpener({ deviceId: target?.deviceId ?? '', sessionId: target?.sessionId ?? '',
    onQuote: text => writeDraft(chat.id, { at: 'end', text }),
    readFileChunk: target ? input => readConversationFile(target.local, target.deviceId, input) : undefined })
  const working = !!read.timeline.turns.at(-1) && !read.timeline.turns.at(-1)?.outcome
  const options = useConversationOptions(target)
  const queue = useConversationQueue(target, read.timeline.queuedPrompts, working, options.steers)
  const aliases = useMemo(() => dmRecordIds(turns), [turns])
  const visibleMessages = useMemo(() => displayedDmMessages(messages), [messages])
  const ignoredMessageIds = useMemo(() => messages.filter(message => !visibleMessages.includes(message)).map(message => message.id), [messages, visibleMessages])
  const reading = useAgentDmRead({ chat, shown, messages: visibleMessages, ignoredMessageIds, aliases, unreadEntry, loadMessageAnchor, markMessageVisible, setFollowingTail,
    onError: error => toast(messageForUser(error), 'error') })
  const view = reading.view
  useEffect(() => { view.current?.find(searchQuery) }, [searchQuery, view])
  const error = messagesError ?? (read.phase === 'error' ? new Error(read.error ?? '') : null)
  const openAttachment = (href: string) => {
    const message = messages.find(item => item.content_type === 'attachment' && (() => {
      const file = parseAttachmentContent(item.content, item)
      if (!file) return false
      return href === `gugu-message-file://${item.id}` || (file.source.kind === 'url' && href === file.source.url)
    })())
    if (message) {
      const file = parseAttachmentContent(message.content, message)
      if (file) { filePreview.open(file, message); return true }
    }
    return followConversationLink(href)
  }
  const composer = <>
    <ConversationSettlements sessionId={target?.sessionId ?? `dm:${chat.id}`} settlements={read.timeline.settlements} runtime="acp" mobile={mobile} busyItemId={read.respondingItemId} respond={read.respond} />
    {chrome?.composerHeader}
    {error ? <MessageLoadFailure error={error} inline onRetry={async () => { await refreshMessages(chat.id); read.reload() }} /> : null}
    {messages.filter(message => message.local_send_state === 'failed').map(message => <button key={message.id} type="button" data-failed-message={message.id} onClick={() => retrySend(message.id)}>{t('outbox.sendFailed')} · {t('agent.dm.retry')}</button>)}
    {read.actionError ? <div role="alert">{read.actionError}</div> : null}
    {queue.error ? <div role="alert">{queue.error}</div> : null}
    <ChatMessageComposer currentUserId={user?.id} chatId={chat.id} hidden={!shown} attachGlyph={chrome?.attachGlyph} attachMenu={chrome?.attachMenu}
      beforeSend={createSessionpageChatSendPreflight(true, chat.peer_user_id, t('agent.taskpage.recoveryFailed.unknown'))}
      disabled={gate.disabled} disabledReason={gate.disabledReason ? t(`composer.agent.disabledReason.${gate.disabledReason}`) : undefined} conversation={{ ...options.props, ...queue.props, isWorking: working,
      onStop: target ? () => { void read.cancel() } : undefined }}
      onSend={async (text, options) => { await sendMessage(text, options) }} onSendAttachments={async (files, options) => { await sendAttachments(files, options) }} />
  </>
  return <div ref={ref} data-testid="agent-dm-conversation" data-agent-user-id={chat.peer_user_id ?? undefined} className="relative flex h-full min-h-0 flex-1">
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
    {!embedded && !chrome && <PaneHeader title={name} titleLevel="panel" mobile={mobile}
      leading={onBack ? <IconButton aria-label={t('chatArea.backToList')} onClick={onBack}><ArrowLeft /></IconButton> : undefined} />}
    {options.confirmation}
    <SessionTranscriptView uri={`dm:${chat.id}`} turns={turns} mobile={mobile} shown={shown}
      commands={{ ...(target ? outputs.handlers : {}), onOpenFile: target ? ({ path }) => outputs.openFile(path) : undefined, classifyLink: classifyFileLink, onOpenLink: openAttachment, conversationAgentName: () => name, conversationAgentSession: () => target?.sessionId ?? null, conversationAgentUserId: () => chat.peer_user_id ?? null, onOpenSender: openMessageSender, onConversationReply: id => view.current?.scrollToItem(id, { align: 'center' }),
        conversationProcessNotice: processId => {
          const notice = visibleMessages.find(message => message.content_type === 'system' && processId === `im:${message.id}:process`)
          return notice ? { id: notice.id, text: notice.content ?? '' } : null
        },
        onStopBackgroundTask: target && client.stopBackgroundTask ? ({ stopId }) => { void client.stopBackgroundTask!(target.deviceId, target.sessionId, stopId).catch(error => toast(messageForUser(error), 'error')) } : undefined,
        onDismissBackgroundTask: target ? ({ entryId }) => { dismissSubagent(target.sessionId, entryId); setDismissals(value => value + 1) } : undefined,
        resolveToolImage: target ? async (itemId, index) => toolImageUrl(await client.fetchToolImage(target.deviceId, target.sessionId, itemId, index)) : undefined,
        onViewImages: ({ urls, index, thumb }) => openImageViewer(urls.map(url => ({ url, alt: '', thumb })), index),
        onStop: target ? () => { void read.cancel() } : undefined }}
      activeTurnId={target && !read.timeline.turns.at(-1)?.outcome ? read.timeline.turns.at(-1)?.id ?? null : null} onVisibleItems={reading.onVisibleItems} composerContent={composer} backgroundTasks={background} onReady={ready => { reading.onReady(ready); ready.find(searchQuery) }}
      onAtBottomChange={reading.onAtBottomChange}
      onReachStart={() => { if (target) void read.loadOlder(); else void loadOlderMessages() }}
      className="relative min-h-0 flex-1" />
    </div>
    {filePreview.panel}{outputs.panel}
  </div>
}
