import { registerComposerFocusTarget, scheduleComposerFocus } from '@/lib/focusComposer'
import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUp, FileText, Plus, X } from '@/lib/icons'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { ComposerAttachButton, type ComposerAttachAction } from './ComposerAttachButton'; export type { ComposerAttachAction } from './ComposerAttachButton'
import { useToast } from '../toastContext'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import { formatAttachmentSize, inferAttachmentKind } from '@gugu/core/shared/ui/attachmentModels'
import { buildRosterNameIndex, resolveOpeningAgentCall } from '@gugu/core/shared/rosterNameMatching.mjs'
import { useChatDraft, revokeAttachmentPreviewUrls, withPreviewUrl, makePendingAttachment } from './useChatDraft' // @@@1924 草稿状态(text/@-mention/附件)单源化：以 per-chat store 为权威源、本地薄镜像，同步编排收进 useChatDraft。
import { ComposerVerbs } from './ComposerVerbs'; import { takeComposerCarry, useComposerVerb } from '../../lib/composerVerbBridge'; import { useChatSlotProjectName, useInChatSlot } from '../../lib/shellSlots'; import { sessionComposerBox, sessionComposerCardClassName, sessionComposerDockedWidthClassName, sessionComposerEmptyHeightPx } from '../../session/renderer/features/sessions/session-composer-styles'
// App 引用 pill:pills held in the row above the input (A, owner 10-14), sent under the words.
import { DraftRefPills } from './DraftRefPills'
import { withFilePills } from '../markdown/filePills'
import { UI_EVENTS } from '../../lib/uiEvents'
import {
  COLOR_ACCENT,
  COLOR_MUTED,
  focusTextareaAt,
  insertTextAtRange,
} from './chatPresentation'
import { SLASH_COMMANDS, type SlashCommand, type SlashCommandContext } from '../../lib/slashCommands'
import { activeMentionPicks, resolveMentionUserIds, MENTION_ALL_USER_ID, type GroupRosterCandidate, type MentionCandidate } from '@/lib/mention'
import { filterMentionCandidates, findMentionStart, isMentionQueryActive } from '@/lib/mentionMatch'
import { useContactsStore } from '../../store/contactsContext'
import { useComposerPopupPlacement } from './useComposerPopupPlacement'
import { useMentionKeyboardSelection } from './useMentionKeyboardSelection'
import { useMobileShell } from '../../hooks/useMobileShell'
import { AgentMentionOptionLabel, AgentMentionSelectionNotice } from './AgentMentionStatusNotice'
import { mentionOptionStatusProps, type AgentStatusById } from './agentMentionStatusModels'
// @@@1697 三分离(SSOT #1714 `.comp-dock` L147)：左右坞固定高 42(=单行框高)、place-items:center 居中按钮；配合外层 row align-items:flex-end，多行时中间只裹 textarea 的框往上长、坞贴底 → 按钮 y 不浮动。
const COMPOSER_BTN_DOCK: CSSProperties = { height: 42, display: 'grid', placeItems: 'center', flexShrink: 0 }
// 2a:附件/悄悄话/引用条上的关闭钮都是 IconButton sm(28 命中区),原来 14–20px 手写按钮点不中。
// 附件卡片:骑在右上角,实底 + 发丝边,图片上也看得清。
const COMPOSER_CHIP_REMOVE_STYLE: CSSProperties = {
  position: 'absolute', top: -10, right: -10,
  background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-circle)',
}
// 悄悄话细条:28 的命中区用负外边距吃进条的内边距,条不因此变高。
const COMPOSER_STRIP_BUTTON_STYLE: CSSProperties = { margin: '-4px -6px -4px 0' }
interface InputAreaProps {
  // @@@threads (#957) — opts 加可选 threadRootId：话题视图发送时由 ChatAreaPanel 注入活动话题 id。
  // @@@whisper (#820) — opts 加可选 isWhisper：悄悄话模式下强制设为 true。
  onSend: (content: string, opts?: { toUserIds?: string[] | null; replyToMessageId?: string | null; threadRootId?: string | null; isWhisper?: boolean; beforeDeliver?: () => Promise<void> }) => Promise<void>
  /** 发送前置(agent 私聊的会话就绪)。文字消息把它交给 onSend 的 beforeDeliver,在投递前跑,❌ 挡在上屏之前(C1)。 */
  beforeSend?: () => Promise<void>
  onSendAttachments?: (files: File[], opts?: { toUserIds?: string[] | null; isWhisper?: boolean; caption?: string; onSent?: (file: File, index: number) => void }) => Promise<void>
  quoteContent?: { messageId?: string; senderName: string; content: string } | null
  onQuoteConsumed?: () => void
  mentionToInsert?: { id: string; name: string } | null
  onMentionInserted?: () => void
  chatId?: string | null
  isGroupChat?: boolean
  groupMembers?: GroupRosterCandidate[]
  currentUserId?: string | null; agentStatuses?: AgentStatusById
  disabled?: boolean
  disabledReason?: string
  // @@@threads — 话题视图下占位文案改「回复话题…」(设计稿 switchThreadIn 行为)；缺省=主线文案。
  placeholder?: string
  attachGlyph?: ReactNode // #7199 助理 App 里是「+」;缺省回形针
  attachMenu?: readonly ComposerAttachAction[] // #7199 给了就把「+」做成菜单(文件 + 这几项);缺省点了直接选文件
  // @@@whisper (#820) — 悄悄话模式：设置后显示 banner + 发送带 isWhisper/toUserIds。
  whisperTarget?: { userId: string; displayName: string } | null
  onExitWhisper?: () => void
  surface?: 'main' | 'aside'; hidden?: boolean // @@@5856 主输入框还是副栏(话题分栏);只有主的登记全局聚焦落点,因果见 lib/focusComposer.ts
}

// @@@1459 框外按钮 dock：高度=单行框外高（border 2 + box pad 10 + 行高 20 + textarea pad 10 = 42），居中放 30px 按钮 → 单行时按钮与文本行居中对齐；框多行增高时 dock 不长高、按钮贴底，y 坐标稳定。

// 格子里那一框的底排,位置和间距同会话框(sessionComposerBox)。
const SLOT_TOOLBAR_STYLE = {
  gap: sessionComposerBox.toolbarGapPx,
  height: sessionComposerBox.toolbarControlPx,
  padding: `0 ${sessionComposerBox.toolbarInsetPx}px ${sessionComposerBox.toolbarInsetPx}px`,
  boxSizing: 'content-box',
} as const

export function InputArea({
  onSend,
  beforeSend,
  onSendAttachments,
  quoteContent,
  onQuoteConsumed,
  mentionToInsert,
  onMentionInserted,
  chatId,
  isGroupChat,
  groupMembers = [],
  currentUserId, agentStatuses = {},
  disabled = false,
  disabledReason,
  placeholder, attachGlyph, attachMenu,
  whisperTarget,
  onExitWhisper, surface = 'main', hidden = false,
}: InputAreaProps) {
  const { t } = useTranslation('messaging')
  // @@@1787 移动 shell 下 composer 正文放大(与移动气泡 14px 同档,13.5px 在手机上偏小)。
  const mobileShell = useMobileShell()
  const [sending, setSending] = useState(false)
  const sendingRef = useRef(false)
  // @@@1323-m4 composer focus 态：对标 SSOT `.box:focus-within{border-color:var(--fg)}`。
  // inline-style 无法用 CSS :focus-within，用 textarea onFocus/onBlur 驱动（主聚焦面）。
  const [composerFocused, setComposerFocused] = useState(false)
  // @@@drag-drop-attach (#845) - dragging files onto the composer uploads them (reuses enqueueFiles,
  // the same queue path as paste / file-picker). dragCounter avoids the flicker of dragenter/leave
  // firing on child element boundaries.
  const [isDragOver, setIsDragOver] = useState(false)
  const dragCounter = useRef(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const onMentionInsertedRef = useRef(onMentionInserted)
  const { toast } = useToast()
  // @@@per-chat-draft (#13) / @@@at-mention-draft (#951) / @@@draft-attachment (#1872) / @@@1924 —
  // composer 的 text / @-mention targets / 排队附件，以 per-chat store 为**权威源**、本地薄镜像。
  // 原来「本地 state ∥ store drafts 双源」的 8 条同步 effect（载入-on-switch / flush-前会话 / 外部写入窄同步 /
  // 三个 300ms 防抖存 / ref 镜像 / currentChatRef 追踪）全部收进 useChatDraft，塌成一条同步 effect——切换
  // 隔离(#1872) / mention round-trip(#951) / 外部写入(#1870) 都从「一切按 chatId 键于 store」天然得到。
  const { text, setText, mentionTargets, setMentionTargets, attachments, setAttachments, refs, setRefs, clear, persistTo, flush } = useChatDraft(chatId)
  const inChatSlot = useInChatSlot(); const slotProjectName = useChatSlotProjectName(); const verbTakesOver = useComposerVerb(chatId) !== null // gugu-dev#181 选了「新任务 / 定时任务」:会话页那一侧换上它的框,这个框整个收起
  useEffect(() => { const back = verbTakesOver || !chatId ? '' : takeComposerCarry(chatId); if (back) setText(back) }, [verbTakesOver, chatId, setText]) // 点了那个框标签上的 ×:写的话交回这里
  const activeChatIdRef = useRef<string | null>(chatId ?? null) // 发失败回滚判「是否还在发送时那个会话」用(异步 send 期间可能切走,#1872)
  activeChatIdRef.current = chatId ?? null

  // ── @ mention picker state ──────────────────────────────────────────────
  // 备注(owner 给联系人起的名字)也能搜到人;插入与投递仍用 display name。
  const { contacts } = useContactsStore()
  const aliasById = useMemo(() => new Map(contacts.flatMap((c) => (c.alias?.trim() ? [[c.id, c.alias.trim()] as const] : []))), [contacts])
  const members = useMemo<MentionCandidate[]>(() => (
    isGroupChat
      ? [
          { id: '__all__', name: t('composer.mentionAll'), type: 'all' },
          ...groupMembers
            .filter((member) => member.id !== currentUserId)
            .map((member) => (aliasById.has(member.id) ? { ...member, alias: aliasById.get(member.id) } : member)),
        ]
      : []
  ), [aliasById, currentUserId, groupMembers, isGroupChat, t])
  const rosterNameIndex = useMemo(
    () => buildRosterNameIndex(groupMembers),
    [groupMembers],
  )
  // mentionRange = { start, end } where start is the index of '@' and end is
  // current cursor position. null = popup closed.
  const [mentionRange, setMentionRange] = useState<{ start: number; end: number } | null>(null)
  const [mentionQuery, setMentionQuery] = useState('')

  // 去空格标点、拼音、咕咕号、备注都算(lib/mentionMatch)。
  const filteredMentions = useMemo(() => {
    if (mentionRange === null) return [] as MentionCandidate[]
    return filterMentionCandidates(members, mentionQuery)
  }, [members, mentionQuery, mentionRange])
  const { mentionIndex, setMentionIndex, activeMentionOptionRef } =
    useMentionKeyboardSelection(mentionQuery, mentionRange === null, filteredMentions)

  const closeMention = useCallback(() => {
    setMentionRange(null)
    setMentionQuery('')
  }, [])

  // Recompute mention state from current text + cursor. Triggered by
  // onChange / onSelect / onKeyUp.
  // 空格/标点不再直接关框(「Claude 2」「gpt-5.4」是名字的一部分):只有换行、名字打完、
  // 或一个都匹配不上且已经读得出是句子时才关。判定在 lib/mentionMatch。
  const updateMentionFromCursor = useCallback((value: string, cursor: number) => {
    if (!isGroupChat) return
    const start = findMentionStart(value, cursor)
    const query = start === null ? '' : value.slice(start + 1, cursor)
    if (start === null || !isMentionQueryActive(query, members)) {
      closeMention()
      return
    }
    setMentionRange({ start, end: cursor })
    setMentionQuery(query)
  }, [closeMention, isGroupChat, members])

  const acceptMention = useCallback((candidate: MentionCandidate) => {
    if (!mentionRange) return
    const ta = textareaRef.current
    const before = text.slice(0, mentionRange.start)
    const insert = `@${candidate.name} `
    const next = insertTextAtRange(text, insert, mentionRange.start, mentionRange.end)
    const cursor = before.length + insert.length
    setText(next)
    setMentionTargets((prev) => {
      const userId = candidate.type === 'all' ? MENTION_ALL_USER_ID : candidate.id
      if (prev.some((target) => target.userId === userId)) return prev
      return [...prev, { userId, displayName: candidate.name }]
    })
    closeMention()
    focusTextareaAt(ta, cursor)
  }, [closeMention, mentionRange, text, setText, setMentionTargets])

  // @@@token-boundary-mention (#951) a pick counts while its @displayName is still a mention in the text (activeMentionPicks).
  // @@@6200 derived in render — ❌ an effect rewriting picks per keystroke: fast typing turns those post-commit
  // writes into nested updates and React throws #185 mid-input (a dropped key, or a lost send).
  const activeMentionTargets = useMemo(() => activeMentionPicks(text, mentionTargets, members), [members, mentionTargets, text])

  // ── / Slash command picker state ─────────────────────────────────────────
  // slashRange = { start, end } where start=0 (the '/' char index) and end is
  // current cursor position. null = popup closed. Only activates when '/' is
  // typed at position 0 (start of the message).
  const [slashRange, setSlashRange] = useState<{ start: number; end: number } | null>(null)
  const [slashQuery, setSlashQuery] = useState('')
  const [slashIndex, setSlashIndex] = useState(0)
  const slashPopupClosed = slashRange === null

  const filteredSlashCommands = useMemo(() => {
    if (slashRange === null) return [] as SlashCommand[]
    const q = slashQuery.trim().toLowerCase()
    if (!q) return SLASH_COMMANDS
    return SLASH_COMMANDS.filter(
      (cmd) => cmd.trigger.toLowerCase().includes(q) || cmd.label.toLowerCase().includes(q),
    )
  }, [slashQuery, slashRange])

  // Reset highlight when slash popup opens/closes or query changes.
  useEffect(() => {
    setSlashIndex(0)
  }, [slashQuery, slashPopupClosed])

  const closeSlash = useCallback(() => {
    setSlashRange(null)
    setSlashQuery('')
  }, [])

  // Recompute slash state from current text + cursor.
  // Only opens when '/' is the first character and the cursor is still in the
  // leading word (no whitespace between '/' and cursor).
  const updateSlashFromCursor = useCallback((value: string, cursor: number) => {
    if (value[0] !== '/') {
      if (slashRange !== null) closeSlash()
      return
    }
    // Walk back from cursor; if we hit whitespace before reaching index 0, close.
    let i = cursor - 1
    while (i >= 1) {
      if (/\s/.test(value[i])) {
        if (slashRange !== null) closeSlash()
        return
      }
      i -= 1
    }
    // Cursor is still within the leading /word — keep popup open.
    setSlashRange({ start: 0, end: cursor })
    setSlashQuery(value.slice(1, cursor))
  }, [closeSlash, slashRange])

  const acceptSlash = useCallback((cmd: SlashCommand) => {
    const ctx: SlashCommandContext = {
      setText,
      clearText: () => setText(''),
    }
    // @@@slash (#821) - strip the leading "/token" FIRST (whatever was typed, incl. a partial query like
    // "/shr" when picking /shrug from the filtered list), so run() operates on clean text — commands that
    // append (e.g. /shrug) never leave a stray "/shr" prefix.
    setText((prev) => prev.replace(/^\/\S*\s?/, ''))
    cmd.run(ctx)
    closeSlash()
    scheduleComposerFocus('slash-command', { target: () => textareaRef.current })
  }, [closeSlash, setText])

  const pickerTriggerIndex = slashRange !== null ? slashRange.start : isGroupChat && mentionRange !== null ? mentionRange.start : null
  const { rootRef: composerRootRef, popupRef: pickerPopupRef, position: pickerPopupPosition } = useComposerPopupPlacement(textareaRef, pickerTriggerIndex,
    pickerTriggerIndex === null ? null : `${pickerTriggerIndex}:${text.length}:${filteredMentions.length}:${filteredSlashCommands.length}`)

  // composer 把自己的输入框登记给契约(#4315:聚焦的唯一实现在 lib/focusComposer.ts,这里不写 `.focus()`)。
  const isMainComposer = surface === 'main'
  useEffect(() => (isMainComposer ? registerComposerFocusTarget(() => textareaRef.current) : undefined), [isMainComposer])
  useEffect(() => {
    onMentionInsertedRef.current = onMentionInserted
  }, [onMentionInserted])

  const enqueueFiles = useCallback((files: File[]) => {
    if (!files.length) return
    setAttachments((prev) => [...prev, ...files.map(makePendingAttachment)])
  }, [setAttachments])

  useEffect(() => {
    // @@@composer-file-automation - JSON-RPC smoke needs the same queue path as a real file picker.
    const handleAttachFiles = (event: Event) => {
      const detail = (event as CustomEvent<{ files?: unknown }>).detail
      const files = Array.isArray(detail?.files)
        ? detail.files.filter((file): file is File => file instanceof File)
        : []
      enqueueFiles(files)
    }
    if (isMainComposer) window.addEventListener(UI_EVENTS.composerAttachFiles, handleAttachFiles)   // 只主栏听,见 uiEvents
    return () => window.removeEventListener(UI_EVENTS.composerAttachFiles, handleAttachFiles)
  }, [enqueueFiles, isMainComposer])

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const found = prev.find((a) => a.id === id)
      if (found) revokeAttachmentPreviewUrls([found])
      return prev.filter((a) => a.id !== id)
    })
  }, [setAttachments])

  // Grow with the content, then scroll only after the composer reaches its height cap.
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta || hidden || verbTakesOver) return // 收起时量出来是 0:等框回来再量
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 110)}px`
    ta.style.overflowY = ta.scrollHeight > ta.clientHeight ? 'auto' : 'hidden'
  }, [text, hidden, verbTakesOver])

  useEffect(() => {
    if (quoteContent) scheduleComposerFocus('quote-attached', { target: () => textareaRef.current })
  }, [quoteContent])

  // @@@avatar-click-mention (#518) - insert an @mention when an avatar in the group agent bar is
  useEffect(() => {
    if (!mentionToInsert) return
    const ta = textareaRef.current
    const start = ta?.selectionStart ?? ta?.value.length ?? 0
    const end = ta?.selectionEnd ?? ta?.value.length ?? 0
    const insert = `@${mentionToInsert.name} `
    const cursor = start + insert.length
    setText((prev) => insertTextAtRange(prev, insert, start, end))
    setMentionTargets((prev) =>
      prev.some((t) => t.userId === mentionToInsert.id)
        ? prev
        : [...prev, { userId: mentionToInsert.id, displayName: mentionToInsert.name }],
    )
    focusTextareaAt(ta, cursor)
    onMentionInsertedRef.current?.()
  }, [mentionToInsert, setText, setMentionTargets])

  const handleSend = useCallback(async () => {
    // 回车走 handleKeyDown 直达这里、不看按钮的 disabled:在途时再进就会把同一批附件重发一遍。
    if (sendingRef.current) return
    const typed = withFilePills(text.trim(), refs) // a failed send puts it back: its pills go back to the row (useChatDraft)
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
      scheduleComposerFocus('message-sent', { target: () => textareaRef.current })
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
      toast(t('composer.sendFailed', { reason: String((err as Error)?.message ?? err) }), 'error')
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }, [beforeSend, chatId, text, attachments, refs, activeMentionTargets, members, rosterNameIndex, isGroupChat, onSend, onSendAttachments, quoteContent, onQuoteConsumed, t, toast, disabled, disabledReason, whisperTarget, onExitWhisper, setText, setMentionTargets, setAttachments, clear, persistTo, flush])

  // 光标挪了(keyup / select):按新位置重算 slash 与 @ 两个弹框。
  const syncPopupsToCursor = (ta: HTMLTextAreaElement) => {
    const v = ta.value
    const cursor = ta.selectionStart ?? v.length
    if (v[0] === '/') {
      updateSlashFromCursor(v, cursor)
    } else {
      if (slashRange !== null) closeSlash()
      updateMentionFromCursor(v, cursor)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    // Slash popup intercepts navigation / accept / dismiss keys BEFORE mention branch.
    // Only one popup can be open at a time (enforced in updateSlashFromCursor /
    // updateMentionFromCursor via mutual exclusion: slash only opens at index 0 and
    // won't open if text starts with something other than '/'; mention won't open
    // unless '@' is found preceded by whitespace/start — these are structurally
    // disjoint as long as the user types one or the other at the start of input).
    if (slashRange !== null && filteredSlashCommands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashIndex((i) => (i + 1) % filteredSlashCommands.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashIndex((i) => (i - 1 + filteredSlashCommands.length) % filteredSlashCommands.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const pick = filteredSlashCommands[slashIndex] ?? filteredSlashCommands[0]
        if (pick) acceptSlash(pick)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        closeSlash()
        return
      }
    }
    if (mentionRange !== null && e.key === 'Escape') {
      e.preventDefault()
      closeMention()
      return
    }
    // Mention popup intercepts navigation / accept keys (an empty「没有匹配」popup lets Enter send).
    if (mentionRange !== null && filteredMentions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionIndex((i) => (i + 1) % filteredMentions.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionIndex((i) => (i - 1 + filteredMentions.length) % filteredMentions.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const pick = filteredMentions[mentionIndex] ?? filteredMentions[0]
        if (pick) acceptMention(pick)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // Paste handler: lifts files from clipboardData.items into the pending
  // attachment queue. Pure-text paste falls through to the textarea default.
  const handlePaste = (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items)
    const files: File[] = []
    for (const item of items) {
      if (item.kind === 'file') {
        const f = item.getAsFile()
        if (f) files.push(f)
      }
    }
    if (files.length > 0) {
      e.preventDefault()
      enqueueFiles(files)
      return
    }
    // Strip HTML: if clipboard has HTML but no text/plain, extract text content
    const hasHtml = items.some((i) => i.type === 'text/html')
    const hasPlain = items.some((i) => i.type === 'text/plain')
    if (hasHtml && !hasPlain) {
      e.preventDefault()
      const html = e.clipboardData.getData('text/html')
      const tmp = document.createElement('div')
      tmp.innerHTML = html
      const plain = tmp.innerText
      setText((prev) => {
        const ta = textareaRef.current
        const start = ta?.selectionStart ?? prev.length
        const end = ta?.selectionEnd ?? prev.length
        return prev.slice(0, start) + plain + prev.slice(end)
      })
    }
  }

  const handleFilePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? [])
    if (picked.length > 0) enqueueFiles(picked)
    // reset so picking the same file twice still triggers onChange
    e.target.value = ''
  }

  const canSend = !!text.trim() || attachments.length > 0 || refs.length > 0
  // Derive the textarea placeholder text.
  const textareaPlaceholder = disabled
    ? (placeholder || disabledReason || t('composer.disabled'))
    : whisperTarget
      ? t('composer.whisperPlaceholder', { name: whisperTarget.displayName })
      : (placeholder || (slotProjectName && !mobileShell ? t('composer.projectGroupPlaceholder', { name: slotProjectName }) : t('composer.placeholder')))
  const disabledHint = disabledReason || (disabled ? t('composer.disabled') : undefined)

  // gugu-dev#181 格子里(项目块、对话块)的排法:「+ 新任务 定时任务 … 发送」进框内底排(手机、格子外照旧:两坞在框外)。
  const inBar = inChatSlot && !mobileShell
  const attachButton = <ComposerAttachButton glyph={attachGlyph ?? (inBar ? <Plus /> : undefined)} actions={attachMenu} disabled={disabled} mobile={mobileShell} onPickFile={() => fileInputRef.current?.click()} />
  const verbs = surface === 'main' && !mobileShell && <ComposerVerbs chatId={chatId} isGroupChat={!!isGroupChat} draft={text} onCarried={() => setText('')} />
  const sendable = canSend && !disabled && !sending
  // @@@ui-ruler 发送钮 = ui/Button 的 primary 实底 + 药丸半径(--primary 与旧的 --accent 同值,
  // --primary-fg 与 --text-on-accent 同值 → 可发送态像素不变;尺寸 30 → --control-h-md 32、
  // 移动 44 由 size="icon" 自带)。手写的 onMouseEnter/onMouseLeave 改 style 那套 hover 删掉:
  // Button 自带 hover/press/disabled 三态。空态维持原来的「安静灰圆」而非淡掉的实底。
  const sendButton = (
    <Button
      variant="primary"
      size="icon"
      className="shrink-0 rounded-[var(--radius-capsule)] data-[disabled]:bg-[var(--muted)] data-[disabled]:text-[var(--faint-fg)]"
      onClick={handleSend}
      disabled={!sendable}
      aria-label={t('common.send')}
      title={t('common.send')}
    >
      <ArrowUp size={mobileShell ? 18 : 16} />
    </Button>
  )
  return (
    <div
      ref={composerRootRef}
      onDragEnter={(e) => {
        if (disabled) return
        if (!Array.from(e.dataTransfer.types).includes('Files')) return
        e.preventDefault()
        dragCounter.current += 1
        setIsDragOver(true)
      }}
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault()
      }}
      onDragLeave={() => {
        dragCounter.current = Math.max(0, dragCounter.current - 1)
        if (dragCounter.current === 0) setIsDragOver(false)
      }}
      onDrop={(e) => {
        if (!Array.from(e.dataTransfer.types).includes('Files')) return
        e.preventDefault()
        dragCounter.current = 0
        setIsDragOver(false)
        enqueueFiles(Array.from(e.dataTransfer.files ?? []))
      }}
      style={{
        position: 'relative',
        flexShrink: 0,
        outline: isDragOver ? '2px dashed var(--accent)' : 'none',
        outlineOffset: isDragOver ? -2 : 0,
        borderRadius: isDragOver ? 'var(--radius-control)' : 0,
      }}
    >
      {/* / Slash command popup — sits above the '/' line, left-aligned to it (pickerPopupPosition).
          Mirrors the @mention popup structure and CSS vars. */}
      {slashRange !== null && filteredSlashCommands.length > 0 && (
        <div
          ref={pickerPopupRef}
          style={{
            position: 'absolute',
            ...pickerPopupPosition,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-control)',
            boxShadow: 'var(--shadow-popover)',
            padding: '4px 0',
            minWidth: 180,
            maxHeight: 240,
            overflowY: 'auto',
            zIndex: 'var(--z-overlay-local)',
          }}
          role="listbox"
          aria-label={t('composer.slashCommands')}
        >
          {filteredSlashCommands.map((cmd, idx) => {
            const active = idx === slashIndex
            return (
              <div
                key={cmd.id}
                role="option"
                aria-selected={active}
                onMouseDown={(e) => { e.preventDefault(); acceptSlash(cmd) }}
                onMouseEnter={() => setSlashIndex(idx)}
                style={{
                  padding: '6px 12px',
                  cursor: 'pointer',
                  background: active ? 'var(--accent-tint-row)' : 'transparent',
                  fontSize: 'var(--font-body)',
                  color: 'var(--text-primary)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <span style={{ fontSize: 'var(--font-body)', fontWeight: 500, color: 'var(--text-primary)', minWidth: 56 }}>
                  {cmd.label}
                </span>
                <span style={{ fontSize: 'var(--font-caption)', color: 'var(--text-secondary)' }}>
                  {cmd.id === 'clear' ? t('composer.commands.clear') : t('composer.commands.shrug')}
                </span>
              </div>
            )
          })}
        </div>
      )}
      {/* @ Mention popup — sits above the line of the '@', left-aligned to it. Sibling
          of the input card so the card's overflow:hidden doesn't clip it. */}
      {isGroupChat && mentionRange !== null && (
        <div
          ref={pickerPopupRef}
          data-testid="mention-picker"
          style={{
            position: 'absolute',
            ...pickerPopupPosition,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-control)',
            boxShadow: 'var(--shadow-popover)',
            padding: '4px 0',
            minWidth: 180,
            maxHeight: 240,
            overflowY: 'auto',
            zIndex: 'var(--z-overlay-local)',
          }}
          role="listbox"
          aria-label={t('composer.mentionMembers')}
        >
          {/* 3a:一个都匹配不上时框不消失,明说「没有匹配的成员」—— 否则看起来像群里没这个人。 */}
          {filteredMentions.length === 0 && (
            <div
              data-testid="mention-no-match"
              style={{ padding: '6px 12px', fontSize: 'var(--font-body)', color: 'var(--text-secondary)' }}
            >
              {t('composer.mentionNoMatch')}
            </div>
          )}
          {filteredMentions.map((m, idx) => {
            const active = idx === mentionIndex
            return (
              <div
                key={m.id}
                ref={active ? activeMentionOptionRef : undefined}
                role="option"
                aria-selected={active}
                {...mentionOptionStatusProps(m, agentStatuses)}
                onMouseDown={(e) => { e.preventDefault(); acceptMention(m) }}
                // 程序化滚动不该让静止鼠标抢回键盘高亮。
                onMouseMove={() => setMentionIndex(idx)}
                style={{
                  padding: '6px 12px',
                  cursor: 'pointer',
                  // @@@mention-active-accent (#463 family) - the active @-mention row uses the same
                  background: active ? 'var(--accent-tint-row)' : 'transparent',
                  fontSize: 'var(--font-body)',
                  color: 'var(--text-primary)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <span style={{ fontSize: 'var(--font-caption)', color: 'var(--text-secondary)', minWidth: 32 }}>
                  {m.type === 'all' ? t('composer.memberType.all') : m.type === 'agent' ? t('composer.memberType.agent') : t('composer.memberType.member')}
                </span>
                <AgentMentionOptionLabel member={m} status={agentStatuses[m.id]} />
              </div>
            )
          })}
        </div>
      )}
      <AgentMentionSelectionNotice members={members} mentionTargets={activeMentionTargets} agentStatuses={agentStatuses} />
    {/* @@@1322 composer 外层 = 纯布局列容器（附件/悄悄话/引用条堆叠在 .box 上方）。
        边框/药丸/focus 态移到内层单行 .box（见下）。 */}
    <div
      className={inBar ? sessionComposerDockedWidthClassName : undefined} // 格子里与新任务框同宽(同一个常量)
      style={{ flexShrink: 0, display: verbTakesOver ? 'none' : 'flex', flexDirection: 'column', gap: '6px' }}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        onChange={handleFilePicked}
        style={{ display: 'none' }}
      />

      {/* Pending attachment preview — sits above the textarea so the chips don't
          collide with the quote strip / toolbar */}
      {(attachments.length > 0 || refs.length > 0) && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '6px',
            padding: '4px 2px',
          }}
        >
          <DraftRefPills refs={refs} onRemove={(link) => setRefs((held) => held.filter((ref) => ref.link !== link))} />
          {attachments.map((att) => (
            <div
              key={att.id}
              data-testid={AUTOMATION_TEST_IDS.pendingAttachmentPreview}
              style={{
                position: 'relative',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: att.kind === 'image' ? '0' : '4px 12px 4px 8px',
                borderRadius: 'var(--radius-control)',
                background: att.kind === 'image' ? 'transparent' : 'var(--bg-primary)',
                border: att.kind === 'image' ? 'none' : '1px solid var(--border-subtle)',
                maxWidth: '180px',
              }}
            >
              {att.kind === 'image' && att.previewUrl ? (
                <img
                  src={att.previewUrl}
                  alt={att.file.name}
                  style={{
                    width: '52px',
                    height: '52px',
                    objectFit: 'cover',
                    borderRadius: 'var(--radius-control)',
                    border: '1px solid var(--border-subtle)',
                  }}
                />
              ) : (
                <>
                  <FileText size={16} color={COLOR_MUTED} strokeWidth={1.7} />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                    <span
                      style={{
                        fontSize: 'var(--font-body)',
                        color: 'var(--text-primary)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        maxWidth: '120px',
                      }}
                    >
                      {att.file.name}
                    </span>
                    <span style={{ fontSize: 'var(--font-caption)', color: 'var(--text-tertiary)' }}>
                      {formatAttachmentSize(att.file.size)}
                    </span>
                  </div>
                </>
              )}
              {/* 2a:移除钮统一 IconButton sm(28 命中区),骑在卡片右上角;实底让它在图片上也看得见。 */}
              <IconButton
                size="sm"
                aria-label={t('composer.removeAttachment', { fileName: att.file.name })}
                onClick={() => removeAttachment(att.id)}
                style={COMPOSER_CHIP_REMOVE_STYLE}
              >
                <X />
              </IconButton>
            </div>
          ))}
        </div>
      )}

      {/* @@@whisper (#820) — 悄悄话 banner（输入框上方细条），显示收件人 + 退出按钮 */}
      {whisperTarget && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '4px 10px',
          background: 'var(--bg-primary)',
          borderRadius: 'var(--radius-control)',
          flexShrink: 0,
        }}>
          <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true" style={{ color: 'var(--faint-fg)', flexShrink: 0 }}>
            <path fill="currentColor" d="M2.69 6.705a.75.75 0 0 0-1.38.59zm12.897 6.624l-.274-.698zm-6.546.409a.75.75 0 1 0-1.257-.818zm-2.67 1.353a.75.75 0 1 0 1.258.818zM22.69 7.295a.75.75 0 0 0-1.378-.59zM19 11.13l-.513-.547zm.97 2.03a.75.75 0 1 0 1.06-1.06zm-8.72 3.34a.75.75 0 0 0 1.5 0zm5.121-.591a.75.75 0 1 0 1.258-.818zm-10.84-4.25A.75.75 0 0 0 4.47 10.6zm-2.561.44a.75.75 0 0 0 1.06 1.06zM12 13.25c-3.224 0-5.539-1.605-7.075-3.26a13.6 13.6 0 0 1-1.702-2.28a12 12 0 0 1-.507-.946l-.022-.049l-.004-.01l-.001-.001L2 7l-.69.296h.001l.001.003l.003.006l.04.088q.039.088.117.243c.103.206.256.496.462.841c.41.69 1.035 1.61 1.891 2.533C5.54 12.855 8.224 14.75 12 14.75zm3.313-.62c-.97.383-2.071.62-3.313.62v1.5c1.438 0 2.725-.276 3.862-.723zm-7.529.29l-1.413 2.17l1.258.818l1.412-2.171zM22 7l-.69-.296h.001v.002l-.007.013l-.028.062a12 12 0 0 1-.64 1.162a13.3 13.3 0 0 1-2.15 2.639l1.027 1.094a14.8 14.8 0 0 0 3.122-4.26l.039-.085l.01-.024l.004-.007v-.003h.001v-.001zm-3.513 3.582c-.86.806-1.913 1.552-3.174 2.049l.549 1.396c1.473-.58 2.685-1.444 3.651-2.351zm-.017 1.077l1.5 1.5l1.06-1.06l-1.5-1.5zM11.25 14v2.5h1.5V14zm3.709-.262l1.412 2.171l1.258-.818l-1.413-2.171zm-10.49-3.14l-1.5 1.5L4.03 13.16l1.5-1.5z"/>
          </svg>
          <span style={{ fontSize: 'var(--font-caption)', color: 'var(--faint-fg)', flex: 1 }}>
            {t('composer.whisperBanner', { name: whisperTarget.displayName })}
          </span>
          <IconButton size="sm" aria-label={t('composer.exitWhisper')} onClick={onExitWhisper} style={COMPOSER_STRIP_BUTTON_STYLE}>
            <X />
          </IconButton>
        </div>
      )}

      {/* Quote preview — 咕咕-style strip just above toolbar */}
      {quoteContent && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          padding: '4px 10px',
          gap: '8px',
          flexShrink: 0,
        }}>
          {/* Green left accent bar */}
          <div style={{ width: '3px', height: '26px', background: COLOR_ACCENT, borderRadius: '2px', flexShrink: 0 }} />
          {/* Quote info — no flex:1, content-width only */}
          <div style={{ overflow: 'hidden', maxWidth: '240px', padding: '5px 0' }}>
            {quoteContent.senderName && (
              <div style={{ fontSize: 'var(--font-body)', color: COLOR_ACCENT, fontWeight: 500, lineHeight: 'var(--lh-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {quoteContent.senderName}
              </div>
            )}
            <div style={{ fontSize: 'var(--font-body)', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', lineHeight: 'var(--lh-body)' }}>
              {quoteContent.content}
            </div>
          </div>
          {/* Cancel button */}
          <IconButton size="sm" aria-label={t('composer.cancelQuote')} onClick={onQuoteConsumed}>
            <X />
          </IconButton>
        </div>
      )}

      {/* @@@1697 三分离(SSOT #1714 `.comp-row/.comp-dock/.box` L145-154)：外层 row align-items:flex-end + 左右 dock(h=42 固定)
          夹中间只裹 textarea 的 box；多行时 box 往上长、坞按 flex-end 贴底 → 附件/发送按钮 y 不浮动(复原 #1459 结构)。 */}
      <div data-chat-composer-row="" style={{ display: 'flex', alignItems: 'flex-end', gap: '6px', flexShrink: 0 }}>
        {/* 左坞：上传按钮切出框外、贴底固定(SSOT `.comp-dock` L147 + `.gh` L152)。@@@4292 mobile:命中框 44×44，dock 高与之匹配。 */}
        {!inBar && <div style={mobileShell ? { ...COMPOSER_BTN_DOCK, height: 48 } : COMPOSER_BTN_DOCK}>{attachButton}</div>}
        {!inBar && verbs}

        {/* 中间框：只裹 textarea——border/圆角(--r-lg 12px)/focus/bg 在此层，独立增高(SSOT `.box` L148-149)。 */}
        <div
          className={inBar ? sessionComposerCardClassName : undefined} // 格子里:会话框那张卡(描边、无投影)
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex', flexDirection: inBar ? 'column' : undefined, minHeight: inBar ? sessionComposerEmptyHeightPx : undefined, // 格子里是一个大框:上面输入、下面一排按钮,空着时和会话框同高
            // #7333 视觉规范:主输入入口是一块表面色的卡,靠 composer 组合投影(1px 轮廓 + 近影 + 宽环境影)浮起来,
            // 圆角 --radius-thread(24);聚焦时在投影外再加一圈加深的轮廓。边框留成透明 1px,几何与原来逐像素相同。
            // 桌面曾落 8px 控件档、移动壳曾是胶囊,两处并入同一 token。
            ...(inBar ? {} : {
              border: '1px solid transparent', boxShadow: composerFocused ? 'var(--shadow-composer), 0 0 0 1px var(--border-strong)' : 'var(--shadow-composer)',
              background: 'var(--card)',
            }),
            borderRadius: 'var(--radius-thread)',
            padding: mobileShell ? '7px 15px' : inBar ? 0 : '5px 10px', // 格子里的内距在文字和底排身上,同会话框
          }}
        >
          {/* SSOT `.box textarea` L150：flex:1 / border:none / 13.5px / lineHeight 1.5 / padding 5px 0 / max-height 110。 */}
          <textarea
            ref={textareaRef}
            rows={1}
            data-testid={surface === 'aside' ? AUTOMATION_TEST_IDS.chatComposerAside : AUTOMATION_TEST_IDS.chatComposer}
            data-sending={sending ? 'true' : 'false'}
            value={text}
            placeholder={textareaPlaceholder}
            disabled={disabled}
            title={disabledHint}
            onChange={(e) => {
              const v = e.target.value
              setText(v)
              const cursor = e.target.selectionStart ?? v.length
              // Mutual exclusion: slash popup only at index 0, mention elsewhere.
              // When '/' is at position 0 and cursor is still in the leading token,
              // open slash picker and ensure mention is closed.
              if (v[0] === '/') {
                updateSlashFromCursor(v, cursor)
                if (mentionRange !== null) closeMention()
              } else {
                if (slashRange !== null) closeSlash()
                updateMentionFromCursor(v, cursor)
              }
            }}
            onKeyUp={(e) => {
              // Esc 的 keydown 已关框;它自己的 keyup 再按光标重算会把框当场重开(`@` 还在光标前)。
              if (e.key !== 'Escape') syncPopupsToCursor(e.currentTarget)
            }}
            onSelect={(e) => syncPopupsToCursor(e.currentTarget)}
            onFocus={() => setComposerFocused(true)}
            onBlur={() => {
              setComposerFocused(false)
              // Defer so onMouseDown on a popup option fires first.
              setTimeout(() => { closeMention(); closeSlash() }, 120)
            }}
            onKeyDown={handleKeyDown}
            onKeyDownCapture={(e) => { (e.currentTarget as HTMLTextAreaElement).dataset.lastKey = e.key }}
            onPaste={handlePaste}
            style={{
              flex: 1,
              minWidth: 0,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              resize: 'none',
              fontSize: 'var(--font-prose)', // #7333 输入与消息正文同一档 16(行高 1.5 = 24)
              // @@@1697 SSOT `.box textarea` L150: line-height 1.5 / max-height 110。
              lineHeight: 1.5,
              padding: inBar ? `${sessionComposerBox.textTopPx}px ${sessionComposerBox.textInsetPx}px ${sessionComposerBox.textBottomPx}px` : '5px 0',
              fontFamily: 'inherit',
              color: 'var(--text-primary)',
              opacity: disabled ? 0.55 : 1,
              overflow: 'hidden',
              ...(inBar ? { minHeight: sessionComposerBox.editorMinHeightPx, maxHeight: sessionComposerBox.editorMaxHeightPx } : { maxHeight: '110px' }),
              boxSizing: 'border-box',
            }}
          />
          {/* 格子里的底排:和会话框的底排同一套位置和间距(sessionComposerBox)。 */}
          {inBar && (
            <div className="flex items-center" style={SLOT_TOOLBAR_STYLE}>
              {attachButton}{verbs}<span className="flex-1" />{sendButton}
            </div>
          )}
        </div>

        {/* 右坞：发送按钮切出框外、贴底固定(SSOT `.comp-dock` L147 + `.snd` L154)。常驻：空态不卸载(防布局抖、移动端可 tap)。 */}
        {!inBar && <div style={mobileShell ? { ...COMPOSER_BTN_DOCK, height: 46 } : COMPOSER_BTN_DOCK}>{sendButton}</div>}
      </div>
    </div>
    </div>
  )
}
