import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { resolveReplyDelivery } from '@gugu/core/shared/replyDelivery'
import type { ImageViewerItem } from '@/lib/imageViewer'
import { getRendererSession } from '@/lib/sessionPublication'
import { composeInChat } from '@/session/shared/extensions/app-send-core'
import { composeChatDraft } from '@/lib/composeDraft'
import { downloadBlob } from '@/lib/download'
import { writeImageBlobToClipboard } from '@/lib/imageClipboard'
import { chatService } from '@/lib/chat'
import { buildGroupRosterCandidates, mentionAllName, resolveMentionUserIds } from '@/lib/mention'
import { topicMentionCandidates } from '../chat/topicMentionModels'
import { messageForUser } from '@/lib/userFacingError'
import { useChatStore } from '@/store/chatContext'
import { useToast } from '../toastContext'
import { annotateCaption, type AnnotateDocument } from './annotateModel'

export function useAnnotateSend(item: ImageViewerItem, doc: AnnotateDocument, output: () => Promise<Blob>, onDone: () => void) {
  const { t } = useTranslation('main', { keyPrefix: 'imageAnnotate' })
  const { conversations, chats, identitiesById } = useChatStore('conversations', 'chats', 'identitiesById')
  const { toast } = useToast()
  const [text, setText] = useState(''), [includeNotes, setIncludeNotes] = useState(true)
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const sending = useRef(false)
  const source = item.source, chat = chats.find(candidate => candidate.id === source?.chatId)
  const userId = getRendererSession()?.user.id
  const sourceKey = `${userId}:${source?.chatId}:${source?.messageId}`
  const [sourceRead, setSourceRead] = useState<{ key: string; message: MessageItem | null; error: string | null } | null>(null)
  useEffect(() => {
    if (!userId || !source?.messageId) return
    let active = true
    void chatService.getMessageById(source.messageId, userId).then(message => {
      if (!message || message.chat_id !== source.chatId || !resolveReplyDelivery({ senderUserId: userId, source: message })) throw new Error(t('originalUnavailable'))
      if (active) setSourceRead({ key: sourceKey, message, error: null })
    }).catch(failure => { if (active) setSourceRead({ key: sourceKey, message: null, error: messageForUser(failure) }) })
    return () => { active = false }
  }, [userId, source?.chatId, source?.messageId, sourceKey, t])
  const original = sourceRead?.key === sourceKey ? sourceRead : null
  const previewDelivery = original?.message ? resolveReplyDelivery({ senderUserId: userId, source: original.message }) : null
  const peer = previewDelivery?.isWhisper ? previewDelivery.toUserIds[0] : null
  const sendLabel = !original?.message ? t('replyToOriginal') : peer
    ? t('sendWhisperTo', { name: identitiesById[peer]?.display_name ?? t('whisperRecipient') })
    : t('sendTo', { name: chat?.name ?? t('sourceChat') })
  const filename = `${item.alt.replace(/\.[^/.]+$/, '') || 'image'}-annotated.png`
  const run = async (operation: () => Promise<void>) => {
    if (sending.current) return
    sending.current = true; setBusy(true); setError(null)
    try { await operation() }
    catch (failure) { setError(messageForUser(failure)) }
    finally { sending.current = false; setBusy(false) }
  }
  const compose = async (blob: Blob) => {
    if (!source) throw new Error(t('noSource'))
    const session = getRendererSession()
    if (!session) throw new Error(t('notSignedIn'))
    return composeInChat({ account: async () => ({ token: session.access_token, userId: session.user.id }) }, {
      chat: source.chatId, text: annotateCaption(doc, text, includeNotes),
      images: [{ name: filename, type: 'image/png', bytes: await blob.arrayBuffer() }],
    })
  }
  const send = () => run(async () => {
    const session = getRendererSession()
    if (!session || !source?.messageId) throw new Error(t('noSource'))
    const original = await chatService.getMessageById(source.messageId, session.user.id)
    if (!original || original.chat_id !== source.chatId) throw new Error(t('originalUnavailable'))
    const delivery = resolveReplyDelivery({ senderUserId: session.user.id, source: original })
    if (!delivery) throw new Error(t('originalUnavailable'))
    const blob = await output(), detail = await compose(blob)
    let toUserIds = delivery.toUserIds
    if (!delivery.isWhisper && (chat?.kind === 'group' || chat?.kind === 'topic') && detail.text.includes('@')) {
      const loaded = await chatService.getGroupCollab(source.chatId)
      const identities = { ...identitiesById, ...Object.fromEntries(loaded.identities.map(identity => [identity.id, identity])) }
      let candidates = buildGroupRosterCandidates(loaded.snapshot, identities)
      if (chat.kind === 'topic') {
        const origin = chats.find(candidate => candidate.id === chat.source_chat_id)
        candidates = topicMentionCandidates(candidates, origin?.member_user_ids ?? [], chat.member_user_ids, identities)
      }
      toUserIds = resolveMentionUserIds(detail.text, [], [...candidates, { id: 'all', name: mentionAllName(), type: 'all' }], true)
    }
    await conversations.actions(source.chatId).sendAttachments([new File([blob], filename, { type: 'image/png' })], {
      caption: detail.text.trim() || undefined, replyToMessageId: source.messageId, isWhisper: delivery.isWhisper, toUserIds,
    })
    onDone()
  })
  const putInComposer = () => run(async () => { composeChatDraft(await compose(await output())); onDone() })
  const copy = () => run(async () => { await writeImageBlobToClipboard(await output()); toast(t('copied'), 'success') })
  const save = () => run(async () => { if ((await downloadBlob(await output(), filename)).saved) toast(t('saved'), 'success') })
  const saveToFolder = () => run(async () => {
    if (!source) throw new Error(t('noSource'))
    const blob = await output()
    const { saveFilesToChatFolder } = await import('../appSlot/phoneAppHost')
    await saveFilesToChatFolder(source.chatId, [{ name: filename, bytes: await blob.arrayBuffer(), contentType: 'image/png' }], source.messageId ? [source.messageId] : undefined)
    toast(t('savedToFolder'), 'success')
  })
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!source?.messageId || event.isComposing || !(event.metaKey || event.ctrlKey) || event.key !== 'Enter') return
      if (!(event.target instanceof HTMLElement) || !event.target.closest('.ia-editor,.ia-completion-sheet')) return
      event.preventDefault(); event.stopPropagation(); void send()
    }
    window.addEventListener('keydown', keydown, true)
    return () => window.removeEventListener('keydown', keydown, true)
  })
  return { text, setText, includeNotes, setIncludeNotes, busy, error: error ?? original?.error ?? null, sendLabel, send, putInComposer, copy, save, saveToFolder,
    canSend: !!source?.messageId, canCompose: !!source?.chatId, chatName: chat?.name ?? t('sourceChat') }
}
