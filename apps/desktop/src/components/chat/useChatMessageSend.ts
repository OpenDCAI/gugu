import { useCallback, useMemo, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { inferAttachmentKind } from '@gugu/core/shared/ui/attachmentModels'
import { buildRosterNameIndex, resolveOpeningAgentCall } from '@gugu/core/shared/rosterNameMatching.mjs'
import { resolveMentionUserIds, type MentionCandidate } from '@/lib/mention'
import { scheduleComposerFocus } from '@/lib/focusComposer'
import { rendererLogger } from '@/lib/log'
import { safeFailureLine } from '@/session/renderer/features/sessions/gugu-reason'
import { useToast } from '../toastContext'
import { revokeAttachmentPreviewUrls, withPreviewUrl, type ChatDraft, type MentionTarget } from './useChatDraft'
import type { ChatMessageComposerProps } from './chatComposerModels'

/** Chat delivery owns recipients and rollback; the shared editor only submits its document. */
export function useChatMessageSend(props: ChatMessageComposerProps, draft: ChatDraft, members: MentionCandidate[], activeMentionTargets: MentionTarget[], inputRef: RefObject<HTMLElement | null>) {
  const { onSend, beforeSend, onSendAttachments, quoteContent, onQuoteConsumed, chatId, isGroupChat, disabled, disabledReason, whisperTarget, onExitWhisper } = props
  const { text, attachments, clear, flush, setText, setMentionTargets, setAttachments, persistTo } = draft
  const { t } = useTranslation('messaging')
  const { toast } = useToast()
  const [sending, setSending] = useState(false)
  const sendingRef = useRef(false)
  const activeChatIdRef = useRef(chatId ?? null)
  activeChatIdRef.current = chatId ?? null
  const rosterNameIndex = useMemo(() => buildRosterNameIndex(props.groupMembers ?? []), [props.groupMembers])
  const handleSend = useCallback(async (value?: string) => {
    // 回车走 handleKeyDown 直达这里、不看按钮的 disabled:在途时再进就会把同一批附件重发一遍。
    if (sendingRef.current) return
    const typed = (value ?? text).trim()
    const pendingFiles = attachments.map((a) => a.file)
    const multimodalImage = pendingFiles.some((file) => inferAttachmentKind(file) === 'image')
    if (disabled) {
      toast(disabledReason || t('composer.disabled'), 'info')
      return
    }
    if (!typed && pendingFiles.length === 0) return
    const content = typed
      ? quoteContent && !quoteContent.messageId
        ? `> [${quoteContent.senderName}]: ${quoteContent.content}\n${typed}`
        : typed
      : ''
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
          replyToMessageId: null as string | null,
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
    const snapshotAttachments = attachments
    // 按批内序号认领已提交件(同一个 File 对象可能被排进队两次,按对象认领会把两件都算成已发)。
    const committed = new Set<number>()
    // 带引用回复时文字单独走 onSend(它带 replyToMessageId),不挂成图片说明——否则引用关系丢失。
    const captionOnImage = multimodalImage && !replyToMessageId
    sendingRef.current = true
    setSending(true)
    try {
      // C1:先清空输入框、先上屏乐观气泡。会话就绪不再挡在前面(它可能要重开会话,气泡迟迟不出):
      // 文字消息把它交给 outbox 在投递前 await,失败时气泡变「未送达」可重试,❌ 退回输入框。
      clear()
      flush()
      onQuoteConsumed?.()
      scheduleComposerFocus('message-sent', { target: () => inputRef.current })
      if (pendingFiles.length > 0 && onSendAttachments) await beforeSend?.()

      if (pendingFiles.length > 0 && onSendAttachments) {
        await onSendAttachments(pendingFiles, { toUserIds: sendOptions.toUserIds, isWhisper: !!whisperTarget, caption: captionOnImage ? content || undefined : undefined, onSent: (_file, index) => { committed.add(index) } })
      }
      if (typed && (!captionOnImage || !onSendAttachments)) {
        await onSend(content, { ...sendOptions, beforeDeliver: beforeSend })
      }
      // Successful send → object URLs are no longer needed
      revokeAttachmentPreviewUrls(snapshotAttachments)
      // @@@whisper (#820) — clear whisper mode after a successful send.
      if (whisperTarget) onExitWhisper?.()
    } catch (err) {
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
        setText((current) => (current.trim() ? `${typed}\n${current}` : typed))
        setMentionTargets((current) => [...restoredMentions, ...current.filter((m) => !restoredMentions.some((r) => r.userId === m.userId))])
        setAttachments((current) => [...unsentAttachments.map(withPreviewUrl), ...current])
      } else if (chatId) {
        persistTo(chatId, { text: typed, mentions: restoredMentions, attachments: unsentAttachments })
      }
      // Drop the now-stale snapshot URLs (replaced by fresh ones above, or unused when persisting to store).
      revokeAttachmentPreviewUrls(snapshotAttachments)
      toast(t('composer.sendFailed', { reason: safeFailureLine(reason) }), 'error')
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }, [beforeSend, chatId, text, attachments, activeMentionTargets, members, rosterNameIndex, isGroupChat, onSend, onSendAttachments, quoteContent, onQuoteConsumed, t, toast, disabled, disabledReason, whisperTarget, onExitWhisper, setText, setMentionTargets, setAttachments, clear, persistTo, flush, inputRef])

  return { sending, handleSend }
}
