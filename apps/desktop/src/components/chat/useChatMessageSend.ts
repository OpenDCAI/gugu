import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { inferAttachmentKind } from '@gugu/core/shared/ui/attachmentModels'
import { buildRosterNameIndex, resolveOpeningAgentCall } from '@gugu/core/shared/rosterNameMatching.mjs'
import { firstMentionedUserId, resolveMentionUserIds, type MentionCandidate } from '@/lib/mention'
import { rememberGroupMention } from '@/lib/groupMentionRecall'
import { scheduleComposerFocus } from '@/lib/focusComposer'
import { rendererLogger } from '@/lib/log'
import { safeFailureLine } from '@/session/renderer/features/sessions/gugu-reason'
import { useToast } from '../toastContext'
import { revokeAttachmentPreviewUrls, withPreviewUrl, type ChatDraft, type MentionTarget, type PendingAttachment } from './useChatDraft'
import { contentWithQuote } from './messageQuoteContent'
import type { ChatMessageComposerProps } from './chatComposerModels'
import { useChatStore } from '../../store/chatContext'
import { WhisperDeliveryFailure } from '../../store/whisperDelivery'

/** Chat delivery owns recipients and rollback; the shared editor only submits its document. */
export function useChatMessageSend(props: ChatMessageComposerProps, draft: ChatDraft, members: MentionCandidate[], activeMentionTargets: MentionTarget[], inputRef: RefObject<HTMLElement | null>, mobile = false) {
  const { onSend, beforeSend, onSendAttachments, quoteContent, onQuoteConsumed, chatId, currentUserId, isGroupChat, disabled, disabledReason, whisperTarget, onExitWhisper } = props
  const { text, attachments, clear, flush, setMentionTargets, setAttachments, persistTo } = draft
  const { writeDraft } = useChatStore('writeDraft')
  const { t } = useTranslation('messaging')
  const { toast } = useToast()
  const [sendingContext, setSendingContext] = useState<{ visit: object; whisper: boolean } | null>(null)
  const sendingRef = useRef<typeof sendingContext>(null)
  const activeChatIdRef = useRef(chatId ?? null)
  activeChatIdRef.current = chatId ?? null
  // A visit, rather than just an id: leaving and returning while a send is pending
  // must not let its completion change the newly opened composer's privacy mode.
  const chatVisit = useRef({ chatId: chatId ?? null })
  if (chatVisit.current.chatId !== (chatId ?? null)) chatVisit.current = { chatId: chatId ?? null }
  const sending = !!sendingContext && (!sendingContext.whisper || sendingContext.visit === chatVisit.current)
  const activeWhisperPeer = useRef(whisperTarget?.userId)
  activeWhisperPeer.current = whisperTarget?.userId
  const [publicNoticeVisit, setPublicNoticeVisit] = useState<typeof chatVisit.current | null>(null)
  const failedWhisper = useRef<{ id: string; visit: typeof chatVisit.current; peer: string } | null>(null)
  // Retry is owned by the existing failed-message bubble. Its authoritative row
  // is also the completion signal for the original composer's privacy state.
  useEffect(() => {
    const failed = failedWhisper.current
    if (!failed) return
    if (failed.visit !== chatVisit.current || failed.peer !== whisperTarget?.userId) {
      failedWhisper.current = null
      return
    }
    const acknowledged = props.messages?.find(message => message.id === failed.id)
    if (!acknowledged || acknowledged.seq <= 0 || acknowledged.local_send_state) return
    failedWhisper.current = null
    setPublicNoticeVisit(failed.visit)
    onExitWhisper?.()
  }, [chatId, whisperTarget, props.messages, sending, onExitWhisper])
  const rosterNameIndex = useMemo(() => buildRosterNameIndex(props.groupMembers ?? []), [props.groupMembers])
  // `picked`: files sent straight from a picker page (phone photos) together with the draft's own attachments.
  const handleSend = useCallback(async (value?: string, picked: PendingAttachment[] = []) => {
    // 回车走 handleKeyDown 直达这里、不看按钮的 disabled:在途时再进就会把同一批附件重发一遍。
    if (sendingRef.current && (!sendingRef.current.whisper || sendingRef.current.visit === chatVisit.current)) return
    const sendingVisit = chatVisit.current
    const pendingSend = { visit: sendingVisit, whisper: !!whisperTarget }
    const submittedAt = performance.now()
    const typed = (value ?? text).trim()
    const batch = picked.length ? [...attachments, ...picked] : attachments
    const pendingFiles = batch.map((a) => a.file)
    const multimodalImage = pendingFiles.some((file) => inferAttachmentKind(file) === 'image')
    if (disabled) {
      toast(disabledReason || t('composer.disabled'), 'info')
      return
    }
    if (!typed && pendingFiles.length === 0) return
    const content = contentWithQuote(typed, quoteContent)
    // @@@whisper (#820) — 悄悄话模式下覆盖 toUserIds + 附加 isWhisper flag；禁用 @提及。
    const replyToMessageId = quoteContent?.messageId ?? null
    const explicitRecipientIds = resolveMentionUserIds(
      typed,
      activeMentionTargets.map((target) => target.userId),
      members,
      !!isGroupChat,
    )
    const rosterRecipientIds = !whisperTarget && isGroupChat && explicitRecipientIds.length === 0 && !replyToMessageId
      ? resolveOpeningAgentCall(rosterNameIndex, typed)
      : []
    const sendOptions = whisperTarget
      ? {
          toUserIds: [whisperTarget.userId],
          replyToMessageId,
          isWhisper: true,
        }
      : {
          // @@@1703 — union picker selections with @tokens typed inline. Typing "@Name " without selecting the
          // picker left mentionTargets empty → to_user_ids=null → the DB non-@ branch drops passive members
          // (listen_mode = active) → silence. Parse the typed text for member @tokens too so a typed
          // @mention hard-triggers identically to a picked one.
          // #1641 human-only send adapter: an opening call resolved against the already-subscribed group
          // roster becomes the same structural recipient as @. The DB trigger still reads no message text.
          toUserIds: [...new Set(explicitRecipientIds.length ? explicitRecipientIds : rosterRecipientIds)],
          replyToMessageId,
        }

    // Snapshot current attachments so we can roll back on failure
    const snapshotAttachments = batch
    // 按批内序号认领已提交件(同一个 File 对象可能被排进队两次,按对象认领会把两件都算成已发)。
    const committed = new Set<number>()
    // 带引用回复时文字单独走 onSend(它带 replyToMessageId),不挂成图片说明——否则引用关系丢失。
    const captionOnImage = multimodalImage && !replyToMessageId
    sendingRef.current = pendingSend
    setSendingContext(pendingSend)
    try {
      // C1:先清空输入框、先上屏乐观气泡。会话就绪不再挡在前面(它可能要重开会话,气泡迟迟不出):
      // 文字消息把它交给 outbox 在投递前 await,失败时气泡变「未送达」可重试,❌ 退回输入框。
      clear()
      flush()
      onQuoteConsumed?.()
      scheduleComposerFocus('message-sent', { target: () => inputRef.current, mobileShell: mobile })
      if (pendingFiles.length > 0 && onSendAttachments) await beforeSend?.()

      if (pendingFiles.length > 0 && onSendAttachments) {
        await onSendAttachments(pendingFiles, { toUserIds: sendOptions.toUserIds, replyToMessageId: !typed && replyToMessageId ? replyToMessageId : undefined, isWhisper: !!whisperTarget, caption: captionOnImage ? content || undefined : undefined, onSent: (_file, index) => { committed.add(index) } })
      }
      if (typed && (!captionOnImage || !onSendAttachments)) {
        await onSend(content, { ...sendOptions, beforeDeliver: beforeSend, submittedAt })
      }
      // Successful send → object URLs are no longer needed
      revokeAttachmentPreviewUrls(snapshotAttachments)
      if (!mobile && isGroupChat && currentUserId && chatId && !whisperTarget) {
        const first = firstMentionedUserId(typed, explicitRecipientIds, members)
        if (first !== undefined) rememberGroupMention(currentUserId, chatId, first)
      }
      // @@@whisper (#820) — clear whisper mode after a successful send.
      if (chatVisit.current === sendingVisit && activeWhisperPeer.current === whisperTarget?.userId) {
        setPublicNoticeVisit(whisperTarget ? sendingVisit : null)
        if (whisperTarget) onExitWhisper?.()
      }
    } catch (err) {
      // The outbox already owns this failed row and its retry. Restoring the same
      // text as a new draft would duplicate a later retry; keep the private target.
      if (err instanceof WhisperDeliveryFailure) {
        if (whisperTarget && chatVisit.current === sendingVisit && activeWhisperPeer.current === whisperTarget.userId) {
          failedWhisper.current = { id: err.clientMessageId, visit: sendingVisit, peer: whisperTarget.userId }
        }
        revokeAttachmentPreviewUrls(snapshotAttachments)
        return
      }
      const reason = String((err as Error)?.message ?? err)
      rendererLogger('chat/send').error({ chatId, error: reason }, 'message send failed')
      // Rollback restores only UNSENT intent. @@@2188 - the send is phased (attachments commit one by
      // one, reported via onSent; text last): units already in the conversation must NOT return to the
      // draft, or a retry re-sends them (duplicate attachment). The uncommitted remainder stays recoverable.
      const unsentAttachments = snapshotAttachments.filter((_a, index) => !committed.has(index))
      // @@@draft-attachment (#1872) - restore WITHOUT contaminating the wrong chat: send is async, so the
      // user may have switched away mid-flight (composer stays mounted, chatId differs). Restore into the
      // LIVE composer only when still on the sending chat; otherwise re-persist into the ORIGINAL chat's
      // store (its restore path picks it up on return) — never leaking a private file into another chat.
      const restoredMentions = sendOptions.toUserIds.length > 0 ? activeMentionTargets : []
      // `?? null` so a composer with no chat context (chatId undefined) still matches the null-initialized
      // ref and restores locally — the "switched away" branch only applies to a real chatId change.
      if (activeChatIdRef.current === (chatId ?? null)) {
        // Reuse the same File objects but mint fresh preview URLs (the old ones may already be revoked).
        // 合并而非覆盖:多件逐一上传的空档里用户可能又加了附件、又打了字,整体替换会把它们吞掉。
        writeDraft(chatId, { at: 'start', text: typed })
        setMentionTargets((current) => [...restoredMentions, ...current.filter((m) => !restoredMentions.some((r) => r.userId === m.userId))])
        setAttachments((current) => [...unsentAttachments.map(withPreviewUrl), ...current])
      } else if (chatId) {
        persistTo(chatId, { text: typed, mentions: restoredMentions, attachments: unsentAttachments })
      }
      // Drop the now-stale snapshot URLs (replaced by fresh ones above, or unused when persisting to store).
      revokeAttachmentPreviewUrls(snapshotAttachments)
      toast(t('composer.sendFailed', { reason: safeFailureLine(reason) }), 'error')
    } finally {
      if (sendingRef.current === pendingSend) {
        sendingRef.current = null
        setSendingContext(null)
      }
    }
  }, [beforeSend, chatId, currentUserId, text, attachments, activeMentionTargets, members, rosterNameIndex, isGroupChat, onSend, onSendAttachments, quoteContent, onQuoteConsumed, t, toast, disabled, disabledReason, whisperTarget, onExitWhisper, writeDraft, setMentionTargets, setAttachments, clear, persistTo, flush, inputRef, mobile])

  return { sending, handleSend, returnedToPublic: publicNoticeVisit === chatVisit.current && !whisperTarget }
}
