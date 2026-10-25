// @@@1924 草稿单源化 — composer 的 text / @-mention targets / 排队附件，以 per-chat store 为**权威持久源**，
// 本地保一层薄镜像（standalone / 无 store context 时也能用，且承载 blob preview URL 这类运行时视图态）。
//
// 取代 InputArea 里为「本地 state ∥ store drafts 双源」写的一整套同步编排（载入-on-switch / flush-前会话 /
// 外部写入窄同步 / 三个 300ms 防抖存 / ref 镜像 / currentChatRef 追踪，共 8 条 effect）。这里收敛成：
//   - 镜像即时（textarea 读它，打字零延迟）；store 写入**防抖 300ms**（避免每键改共享 ChatContext →
//     ChatListPanel 等所有 useChatStore 消费者每键重渲染），切换 / 卸载时同步 flush 未落的编辑（不丢 sub-300ms）。
//   - 一条同步 effect 只在 store 与「上次同步快照」**分叉**时拉回镜像：切换（load 新会话）或外部写入
//     （suggestion chips 直写 store）。自己的防抖 flush 落回的值 == 快照 → 跳过（#951 不 rebound /
//     #1870 外部写入即反映，都成一次值比较，不再靠 deps 体操）。
//   - 跨会话隔离(#1872) + 发失败回原会话，天然来自「一切按 chatId 键于 store」。
import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react'
import { useChatStore, type DraftAttachment, type DraftMention } from '../../store/chatContext'
import { inferAttachmentKind, type AttachmentKind } from '@gugu/core/shared/ui/attachmentModels'
import { isRenderableImage } from '@gugu/core/shared/imageMime.mjs'

export interface MentionTarget {
  userId: string
  displayName: string
}

export interface PendingAttachment {
  id: string
  file: File
  previewUrl: string | null
  kind: AttachmentKind
}

// Stable empty singletons — the sync effect skips a dimension by reference-equality, so an empty store slot
// must resolve to the SAME array each run (a fresh `?? []` literal would defeat the skip → re-render churn).
const EMPTY_MENTIONS: DraftMention[] = []
const EMPTY_ATTACHMENTS: DraftAttachment[] = []
const PERSIST_DEBOUNCE_MS = 300

export function revokeAttachmentPreviewUrls(attachments: Pick<PendingAttachment, 'previewUrl'>[]): void {
  attachments.forEach((attachment) => {
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl)
  })
}

// Mint a fresh image preview URL for an attachment (null for non-images). Single source of truth for the
// "image ⇒ blob URL" rule, shared by the file-picker queue, the draft-restore path, and the send-failure
// rollback — the caller owns revoking the URL it gets back.
export function withPreviewUrl<T extends { file: File; kind: AttachmentKind }>(attachment: T): T & { previewUrl: string | null } {
  // heic/tiff 也是图,但 Chromium 画不出来:只给画得出的图铸预览,其余显示文件图标而不是一张坏图。
  const renderable = attachment.kind === 'image' && isRenderableImage(attachment.file.name, attachment.file.type)
  return { ...attachment, previewUrl: renderable ? URL.createObjectURL(attachment.file) : null }
}

// Strip the transient blob previewUrl before persisting to the per-chat draft store (store keeps only
// durable id/file/kind; the preview URL is regenerated on restore).
function toDraftAttachments(attachments: PendingAttachment[]): DraftAttachment[] {
  return attachments.map(({ id, file, kind }) => ({ id, file, kind }))
}

// Rehydrate stored draft attachments into live composer attachments, regenerating each image's preview URL.
function fromDraftAttachments(drafts: DraftAttachment[]): PendingAttachment[] {
  return drafts.map(withPreviewUrl)
}

export function makePendingAttachment(file: File): PendingAttachment {
  return withPreviewUrl({ id: crypto.randomUUID(), file, kind: inferAttachmentKind(file) })
}

const applyUpdate = <T>(u: SetStateAction<T>, prev: T): T => (typeof u === 'function' ? (u as (p: T) => T)(prev) : u)

export interface ChatDraft {
  text: string
  setText: (u: SetStateAction<string>) => void
  mentionTargets: MentionTarget[]
  setMentionTargets: (u: SetStateAction<MentionTarget[]>) => void
  attachments: PendingAttachment[]
  setAttachments: (u: SetStateAction<PendingAttachment[]>) => void
  // Empty the composer — words, @s, files, pills — as a send does before it goes.
  clear: () => void
  // Flush the current mirror to the active chat synchronously. Sends use this
  // after their optimistic clear so a transient unmount cannot resurrect the
  // pre-send draft before the debounce timer fires.
  flush: () => void
  // Persist a draft snapshot straight into a SPECIFIC chat's store slot (the send-failure rollback when the
  // user has already switched away: restore into the ORIGINAL chat, not the now-active one — #1872).
  persistTo: (targetChatId: string, snapshot: { text: string; mentions: MentionTarget[]; attachments: PendingAttachment[] }) => void
}

export function useChatDraft(chatId: string | null | undefined): ChatDraft {
  const { drafts, draftMentions, draftAttachments, setDraft, setDraftMentions, setDraftAttachments } = useChatStore(
    'drafts', 'draftMentions', 'draftAttachments', 'setDraft', 'setDraftMentions', 'setDraftAttachments',
  )
  const key = chatId ?? null
  const storeText = key ? drafts[key] ?? '' : ''
  const storeMentions = key ? draftMentions[key] ?? EMPTY_MENTIONS : EMPTY_MENTIONS
  const storeAtt = key ? draftAttachments[key] ?? EMPTY_ATTACHMENTS : EMPTY_ATTACHMENTS
  const observedStore = useRef({ text: storeText, mentions: storeMentions, attachments: storeAtt })

  // Local mirror = the composer's working copy (the textarea reads this). Store is the authoritative
  // persistent source; the mirror lets the composer work with no chat / a no-op store, and holds runtime
  // blob preview URLs the serializable store never keeps.
  const [text, setTextState] = useState('')
  const [mentionTargets, setMentionsState] = useState<MentionTarget[]>([])
  const [attachments, setAttachmentsState] = useState<PendingAttachment[]>([])

  // Always-current mirror values (avoid stale closures + side-effects inside setState updaters).
  const textRef = useRef(text)
  const mentionsRef = useRef(mentionTargets)
  const attachmentsRef = useRef(attachments)
  // Current chat key in a ref so setters/flush stay identity-STABLE — read the live key, don't close over it.
  const keyRef = useRef(key)
  keyRef.current = key

  // What we last reconciled with the store, per dimension + which chat (durable form). Since store writes are
  // debounced, the store lags the mirror while typing — but it only ever CHANGES to a value equal to this
  // snapshot (our own flush) or to a genuinely different one (external write / switch). Comparing the store
  // slot to this snapshot tells the two apart, so the sync effect never stomps mid-typing.
  const synced = useRef<{ chatId: string | null; text: string; mentions: DraftMention[]; attachments: DraftAttachment[] }>({
    chatId: null,
    text: '',
    mentions: EMPTY_MENTIONS,
    attachments: EMPTY_ATTACHMENTS,
  })

  // ── Debounced persistence: flush the reconciled snapshot to the store slot after typing pauses ──────────
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flushTo = useCallback((targetKey: string) => {
    const s = synced.current
    setDraft(targetKey, s.text)
    setDraftMentions(targetKey, s.mentions)
    setDraftAttachments(targetKey, s.attachments)
  }, [setDraft, setDraftMentions, setDraftAttachments])
  const cancelFlush = useCallback(() => {
    if (flushTimer.current) { clearTimeout(flushTimer.current); flushTimer.current = null }
  }, [])
  const scheduleFlush = useCallback(() => {
    if (!keyRef.current) return
    cancelFlush()
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null
      if (keyRef.current) flushTo(keyRef.current)
    }, PERSIST_DEBOUNCE_MS)
  }, [cancelFlush, flushTo])

  const setText = useCallback((u: SetStateAction<string>) => {
    const next = applyUpdate(u, textRef.current)
    textRef.current = next
    setTextState(next)
    if (keyRef.current) { synced.current.text = next; scheduleFlush() }
  }, [scheduleFlush])

  const setMentionTargets = useCallback((u: SetStateAction<MentionTarget[]>) => {
    const next = applyUpdate(u, mentionsRef.current)
    mentionsRef.current = next
    setMentionsState(next)
    if (keyRef.current) { synced.current.mentions = next; scheduleFlush() }
  }, [scheduleFlush])

  const setAttachments = useCallback((u: SetStateAction<PendingAttachment[]>) => {
    const next = applyUpdate(u, attachmentsRef.current)
    attachmentsRef.current = next
    setAttachmentsState(next)
    if (keyRef.current) { synced.current.attachments = toDraftAttachments(next); scheduleFlush() }
  }, [scheduleFlush])

  // 合并进那条会话的草稿槽,❌ 整段覆盖:发送在途时用户可能已切回那条会话打了新草稿(与同会话回滚同一规矩)。
  // 读的是**结算那一刻**的槽位(ref):persistTo 被发送时的闭包捕获,闭包里的值早就旧了。
  const storedRef = useRef({ drafts, draftMentions, draftAttachments })
  storedRef.current = { drafts, draftMentions, draftAttachments }
  const persistTo = useCallback((targetChatId: string, snapshot: { text: string; mentions: MentionTarget[]; attachments: PendingAttachment[] }) => {
    const stored = storedRef.current
    const existingText = stored.drafts[targetChatId] ?? ''
    const existingMentions = stored.draftMentions[targetChatId] ?? []
    setDraft(targetChatId, existingText.trim() ? `${snapshot.text}\n${existingText}` : snapshot.text)
    setDraftMentions(targetChatId, [...snapshot.mentions, ...existingMentions.filter((m) => !snapshot.mentions.some((r) => r.userId === m.userId))])
    setDraftAttachments(targetChatId, [...toDraftAttachments(snapshot.attachments), ...(stored.draftAttachments[targetChatId] ?? [])])
  }, [setDraft, setDraftMentions, setDraftAttachments])

  const flush = useCallback(() => {
    if (!flushTimer.current) return
    cancelFlush()
    const targetKey = keyRef.current
    if (targetKey) flushTo(targetKey)
  }, [cancelFlush, flushTo])

  const clear = useCallback(() => {
    setText('')
    setMentionTargets([])
    setAttachments([])
  }, [setText, setMentionTargets, setAttachments])

  // Load the current chat's stored draft into the mirror on a SWITCH, or pull an EXTERNAL store write into
  // the mirror (suggestion chips). Our own debounced flush lands a value equal to `synced` → skipped, so
  // typing is never stomped. On switch the outgoing chat's pending edits are flushed synchronously first.
  useEffect(() => {
    if (!key) return
    const s = synced.current
    const previous = observedStore.current
    observedStore.current = { text: storeText, mentions: storeMentions, attachments: storeAtt }

    if (s.chatId !== key) {
      // Chat switch: flush the outgoing chat's un-persisted edits (don't lose a sub-debounce draft), then load.
      if (s.chatId) { cancelFlush(); flushTo(s.chatId) }
      revokeAttachmentPreviewUrls(attachmentsRef.current)
      const rehydrated = fromDraftAttachments(storeAtt)
      textRef.current = storeText; setTextState(storeText)
      mentionsRef.current = storeMentions; setMentionsState(storeMentions)
      attachmentsRef.current = rehydrated; setAttachmentsState(rehydrated)
      s.chatId = key; s.text = storeText; s.mentions = storeMentions; s.attachments = storeAtt
      return
    }

    // Another composer can write another slot while this one still has unsaved words. Only a change
    // to this exact stored dimension is external; a different chat or an attachment update must not erase typing.
    if (storeText !== previous.text && storeText !== s.text) { textRef.current = storeText; setTextState(storeText); s.text = storeText }
    if (storeMentions !== previous.mentions && storeMentions !== s.mentions) { mentionsRef.current = storeMentions; setMentionsState(storeMentions); s.mentions = storeMentions }
    if (storeAtt !== previous.attachments && storeAtt !== s.attachments) {
      revokeAttachmentPreviewUrls(attachmentsRef.current)
      const rehydrated = fromDraftAttachments(storeAtt)
      attachmentsRef.current = rehydrated; setAttachmentsState(rehydrated); s.attachments = storeAtt
    }
  }, [key, storeText, storeMentions, storeAtt, cancelFlush, flushTo])

  // On unmount: flush any pending edit so a close-and-reopen keeps the draft, revoke the mirror's blob URLs,
  // and reset the synced chat marker so a StrictMode remount (refs survive) re-hydrates fresh preview URLs
  // instead of reusing the ones the cleanup just revoked (broken-thumbnail otherwise).
  useEffect(() => () => {
    if (flushTimer.current) { clearTimeout(flushTimer.current); flushTimer.current = null; if (keyRef.current) flushTo(keyRef.current) }
    revokeAttachmentPreviewUrls(attachmentsRef.current)
    synced.current.chatId = null
  }, [flushTo])

  return { text: key && synced.current.chatId !== key ? storeText : text, setText, mentionTargets, setMentionTargets, attachments, setAttachments, clear, persistTo, flush }
}
