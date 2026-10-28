import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChatItem } from '@gugu/core/shared/types/chat'
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
import { dmRecord, dmRecordIds, mergeDmRecord } from './agent-dm-record'
import { useConversationOptions } from './useConversationOptions'
import { useConversationQueue } from './useConversationQueue'
import { ConversationSettlements } from './ConversationSettlements'
import { toolImageUrl } from '@gugu/session-core/acp/client'
import { openImageViewer } from '@/lib/imageViewer'
import { usePhoneBackgroundTasks } from '@/mobile/agent-watch/background-tasks'
import { dismissSubagent } from '@renderer/features/sessions/view/subagent-dismissals'
import type { ChatView } from '@gugu/session-chat-ui'
import { createSessionpageChatSendPreflight } from '@/lib/sessionpage-session-recovery'
import { followLink } from '@/lib/guguLinks'
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

type Chrome = { attachGlyph: import('react').ReactNode; attachMenu?: readonly ComposerAttachAction[]; composerHeader?: import('react').ReactNode }

type Target = { deviceId: string; sessionId: string; local: boolean }

/** DM navigation ends here. No agent DM is rendered by the legacy IM page. */
export function AgentDmConversation({ chat, shown, mobile = false, onBack, chrome }: {
  chat: ChatItem; shown: boolean; mobile?: boolean; onBack?: () => void; chrome?: Chrome
}) {
  const { session } = useAgentDmSession(chat.peer_user_id ?? null)
  const target = session.state === 'ready' ? session : null
  return <DmConversation key={`${chat.id}/${target?.sessionId ?? 'im'}`} chat={chat} target={target} shown={shown} mobile={mobile} onBack={onBack} chrome={chrome} />
}

function DmConversation({ chat, target, shown, mobile, onBack, chrome }: {
  chat: ChatItem; target: Target | null; shown: boolean; mobile: boolean; onBack?: () => void; chrome?: Chrome
}) {
  const view = useRef<ChatView | null>(null)
  const { toast } = useToast()
  const filePreview = useMessageFilePreview({ mobile, visible: shown, closeRightSurfaces: () => {}, toast })
  const [dismissals, setDismissals] = useState(0)
  const { t } = useTranslation('messaging')
  const { identitiesById, messages, messagesError, refreshMessages, sendMessage, sendAttachments,
    loadOlderMessages, markMessageVisible, setFollowingTail, retrySend, writeDraft } = useChatStore('identitiesById', 'messages', 'messagesError', 'refreshMessages',
      'sendMessage', 'sendAttachments', 'loadOlderMessages', 'markMessageVisible', 'setFollowingTail', 'retrySend', 'writeDraft')
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
  const byId = useMemo(() => new Map(messages.map(message => [message.id, message])), [messages])
  const aliases = useMemo(() => dmRecordIds(turns), [turns])
  useEffect(() => () => setFollowingTail(false), [setFollowingTail])
  const onVisibleItems = useCallback((ids: readonly string[]) => {
    if (!shown) return
    for (const id of ids) {
      for (const messageId of byId.has(id) ? [id] : aliases.get(id) ?? []) {
        const message = byId.get(messageId)
        if (message) markMessageVisible(message)
      }
    }
  }, [shown, byId, aliases, markMessageVisible])
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
    return followLink(href)
  }
  const composer = <>
    <ConversationSettlements sessionId={target?.sessionId ?? `dm:${chat.id}`} settlements={read.timeline.settlements} runtime="acp" mobile={mobile} busyItemId={read.respondingItemId} respond={read.respond} />
    {chrome?.composerHeader}
    {error ? <MessageLoadFailure error={error} inline onRetry={async () => { await refreshMessages(chat.id); read.reload() }} /> : null}
    {messages.filter(message => message.local_send_state === 'failed').map(message => <button key={message.id} type="button" data-failed-message={message.id} onClick={() => retrySend(message.id)}>{t('message.sendFailed')} · {t('agent.dm.retry')}</button>)}
    {read.actionError ? <div role="alert">{read.actionError}</div> : null}
    {queue.error ? <div role="alert">{queue.error}</div> : null}
    <ChatMessageComposer chatId={chat.id} hidden={!shown} attachGlyph={chrome?.attachGlyph} attachMenu={chrome?.attachMenu}
      beforeSend={createSessionpageChatSendPreflight(true, chat.peer_user_id, t('agent.taskpage.recoveryFailed.unknown'))}
      disabled={gate.disabled} disabledReason={gate.disabledReason ? t(`composer.agent.disabledReason.${gate.disabledReason}`) : undefined} conversation={{ ...options.props, ...queue.props, isWorking: working,
      onStop: target ? () => { void read.cancel() } : undefined }}
      onSend={async (text, options) => { await sendMessage(text, options) }} onSendAttachments={async (files, options) => { await sendAttachments(files, options) }} />
  </>
  return <div data-testid="agent-dm-conversation" data-agent-user-id={chat.peer_user_id ?? undefined} className="relative flex h-full min-h-0 flex-1">
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
    {!chrome && <PaneHeader title={name} titleLevel="panel" mobile={mobile}
      leading={onBack ? <IconButton aria-label={t('chatArea.back')} onClick={onBack}><ArrowLeft /></IconButton> : undefined} />}
    {options.confirmation}
    <SessionTranscriptView uri={target?.sessionId ?? `dm:${chat.id}`} turns={turns} mobile={mobile} shown={shown}
      commands={{ ...(target ? outputs.handlers : {}), onOpenFile: target ? ({ path }) => outputs.openFile(path) : undefined, classifyLink: classifyFileLink, onOpenLink: openAttachment, conversationAgentName: () => name, onConversationReply: id => view.current?.scrollToItem(id, { align: 'center' }),
        onStopBackgroundTask: target && client.stopBackgroundTask ? ({ stopId }) => { void client.stopBackgroundTask!(target.deviceId, target.sessionId, stopId).catch(error => toast(messageForUser(error), 'error')) } : undefined,
        onDismissBackgroundTask: target ? ({ entryId }) => { dismissSubagent(target.sessionId, entryId); setDismissals(value => value + 1) } : undefined,
        resolveToolImage: target ? async (itemId, index) => toolImageUrl(await client.fetchToolImage(target.deviceId, target.sessionId, itemId, index)) : undefined,
        onViewImages: ({ urls, index, thumb }) => openImageViewer(urls.map(url => ({ url, alt: '', thumb })), index),
        onStop: target ? () => { void read.cancel() } : undefined }}
      activeTurnId={target && !read.timeline.turns.at(-1)?.outcome ? read.timeline.turns.at(-1)?.id ?? null : null} onVisibleItems={onVisibleItems} composerContent={composer} backgroundTasks={background} onReady={ready => { view.current = ready }}
      onAtBottomChange={atBottom => setFollowingTail(shown && atBottom)}
      onReachStart={() => { if (target) void read.loadOlder(); else void loadOlderMessages() }}
      className="relative min-h-0 flex-1" />
    </div>
    {filePreview.panel}{outputs.panel}
  </div>
}
