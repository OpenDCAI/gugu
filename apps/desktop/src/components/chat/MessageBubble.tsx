import { notifyCopied } from '@/lib/copyFeedback'
import { useShownAgentName } from '@/hooks/useShownAgentName'
import { useAvatarIdentity } from '@/lib/avatarIdentity'
import { MESSAGE_BUBBLE_LAYOUT as layout } from '@gugu/core/shared/ui/messageBubbleLayout'
import { memo, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '../toastContext'; import { downloadAttachment } from '../../lib/attachmentBytes'
import { motion, AnimatePresence } from 'framer-motion'; import { MediaAttachmentBubble } from './MediaAttachmentBubble'; import { GroupAvatarSlot } from './StickyGroupAvatar'
import { MessageSenderAvatar } from './MessageSenderAvatar'; import { platform } from '../../platform'
import { useAuth } from '../../store/auth'; import { useLongPress } from '../../hooks/useLongPress'
import { UI_EVENTS } from '../../lib/uiEvents'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import { MessageMetaRow } from './MessageMetaRow'
import { useMentionRender } from './useMentionRender'
import { formatVoiceDuration, parseVoiceAttachmentContent } from '@gugu/core/shared/ui/voiceAttachmentModels'
import { parseAttachmentContent } from '@gugu/core/shared/ui/attachmentModels'; import { reactionLabel } from '@gugu/core/shared/ui/reactionCatalog'; import { i18n } from '../../i18n/runtime'; import type { MessageItem, MessageSendState, ReactionGroup } from '@gugu/core/shared/types/chat'
import { MemberProfileAvatarButton } from '../MemberProfileAvatarButton'
import type { MemberProfileCardModel } from '../MemberProfileCard'
import type { MemberProfileSide } from '../memberProfileModels'
import { COLOR_MUTED, readReceiptLabel } from './chatPresentation'
import { MessageSendStatus } from './MessageSendStatus'; import { safeFailureLine } from '@/session/renderer/features/sessions/gugu-reason'; import { keepAction } from './messageKeep'
import { Markdown } from '../markdown/Markdown'; import { classifyFileLink } from '@gugu/core/shared/ui/guguLink'
import { buildBubbleStyle } from './messageBubbleStyle'
import { ComposerCardView } from './ComposerCardView'
import { QuestionCardView } from './QuestionCardView'
import { WidgetBubble } from './WidgetBubble'
import { parseQuotedContent, partialQuotedContent, type QuoteSelection } from './messageQuoteContent'
import { DirectMessageQuote, MessageQuote } from './MessageQuote'
import { parseComposerCard } from '@gugu/core/shared/ui/taskCardModels'
import { parseWidgetMessage } from '@gugu/core/shared/ui/widgetModels'
import { HoverActionBar, MessageHoverRegion, MessageHoverTrigger } from './HoverActionBar'
import { DeferredEmojiQuickPicker } from './messageActionModules'
import { MsgMoreMenu } from './MsgMoreMenu'; import { PhoneTextSelection } from './PhoneTextSelection'; import { bubbleMenuGestures, usePhoneMessageMenu } from './phoneMessageMenuState'
import { canSourceTopic } from './topicSplitModels' // @@@5856 与顶栏那颗按钮共用同一个判据,❌ 不再写第二份
import { SystemMessageNotice } from './SystemMessageNotice'
import { BubbleSender, BubbleTime, ReadReceiptRing } from './MessageBubbleChrome'; import { fmtMsgTime } from './messageRowTime'
// Sending/failed state and its retry/discard menu live in MessageSendStatus.

function VoiceAttachmentBubble({
  fileName,
  durationMs,
  transcript,
  isMine,
}: {
  fileName: string
  durationMs: number
  transcript: string
  isMine: boolean
}) {
  const { t } = useTranslation('messaging')
  const accentColor = isMine ? 'var(--text-on-bubble-strong)' : 'var(--text-link)'
  const barColor = isMine ? 'var(--text-on-bubble-muted)' : 'var(--text-quote-author)'

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: '148px', maxWidth: '220px' }}>
      <div
        aria-hidden="true"
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: '3px',
          height: '20px',
          padding: '2px 0',
        }}
      >
        {[8, 14, 11, 17].map((height, idx) => (
          <span
            key={idx}
            style={{
              width: '3px',
              height: `${height}px`,
              borderRadius: 'var(--radius-capsule)',
              background: barColor,
            }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
        <span style={{ fontSize: 'var(--font-body)', fontWeight: 600, color: accentColor }}>
          {t('message.voice', { duration: formatVoiceDuration(durationMs) })}
        </span>
        <span
          style={{
            fontSize: 'var(--font-caption)',
            opacity: 0.72,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            maxWidth: '160px',
          }}
        >
          {fileName}
        </span>
        <span
          style={{
            fontSize: 'var(--font-caption)',
            opacity: 0.82,
            lineHeight: 1.4,
            display: '-webkit-box',
            WebkitBoxOrient: 'vertical',
            WebkitLineClamp: 2,
            overflow: 'hidden',
            maxWidth: '160px',
          }}
        >
          {transcript}
        </span>
      </div>
    </div>
  )
}

interface BubbleProps {
  msg: MessageItem
  onReaction: (messageId: string, emoji: string) => void
  // #1163 perf — 由父层(MessageListRow / thread map)按本消息预算好的发送/已读态(primitive 字符串)。
  // 旧版直接收整个 `memberReadSeqs` map 自己 derive：任一成员已读回执到达就换 map 引用 → 破 memo →
  // 全群可视气泡重渲。上移计算后，只有本消息状态真翻转时该 prop 才变，气泡才重渲。
  sendState?: MessageSendState; /** Comma-joined agent ids: a primitive keeps this row's memo. */ undeliveredTo?: string
  // @@@1345 已读回执做成进度圆环(替文字)：父层预算好的「已读数 / 收件总数」两个 primitive(memo 安全——
  // 传整个 memberReadSeqs map 会破 memo)。环填充比例=read/total；点击展开「谁已读/谁未读」名单(onShowReadReceipt)。
  // total===1 → 私聊(满环=已读/空环=未读)；total>1 → 群聊(部分填充)。仅本人已发(非撤回/非发送中)显示。
  readReceiptRead?: number
  readReceiptTotal?: number
  // @@@1313 点开已读名单（谁读谁没读）：稳定回调，父层（持 roster+profiles）弹名单，避免把 reader 列表作对象 prop 传进破 memo。
  onShowReadReceipt?: (messageId: string, anchor: HTMLElement) => void
  onQuote: (msg: MessageItem, selection?: QuoteSelection) => void; onShowMessage?: (id: string) => void
  onForward: (msg: MessageItem) => void
  onDelete: (messageId: string) => void
  isAgent?: boolean; hideAvatar?: boolean; streaming?: boolean // Live IM text shares the settled bubble's layout.
  memberProfile?: MemberProfileCardModel | null
  onOpenMemberProfile?: (
    member: MemberProfileCardModel,
    anchor: HTMLElement,
    preferredSide: MemberProfileSide,
  ) => void
  compactMobile?: boolean
  // @@@1484 是否群聊(group/channel)。仅群聊在 received 气泡上方显发送者名;DM/ai 1:1 头部已知对方,显名冗余。
  isGroup?: boolean
  // @@@5856 提供则「开话题」菜单项可用 → 从本消息开一条话题(product spec:必须有来源)。
  // 话题里的消息不传(单层不嵌套守卫)。
  onOpenTopic?: (messageId: string) => void; onOpenTopicAnchor?: (topicChatId: string) => void
  onOpenFile?: (meta: import('@gugu/core/shared/ui/attachmentModels').ParsedAttachment, message?: MessageItem) => void; onOpenLocalFileLink?: (path: string) => void
  // @@@whisper (#820) — memberProfiles map 用于 whisper 标签显示收件人名字。
  memberProfiles?: Record<string, MemberProfileCardModel>
  // @@@multi-select (#988) — 提供则 More 菜单「多选」项可用 → 进入多选模式并预选本消息。
  // 多选态的勾选框/选中底色/行点击在 MessageListRow 包裹层处理（pointer-events:none 禁用本气泡交互）。
  onEnterSelectMode?: (msg: MessageItem) => void
  // 连续消息合组（父层按「同发送者 + 无时间分隔线切断」判定）：true 时气泡里不再写名字、收紧行距；
  // 头像位置用等宽 spacer 占住，保证组内气泡与组首对齐。
  groupedWithPrev?: boolean; groupedWithNext?: boolean; showReplyQuote?: boolean // 下一条也属于这一组 ⇒ 头像不画在这里,画在组尾(Telegram 式,见 GroupAvatarSlot)
  // 气泡右下角不写时间(流式预览:回合还没落成一条消息)。
  hideTime?: boolean
  // 父层对每条本人消息都传 true（#2098 逐条已读：主列/话题视图均 showReadReceipt={is_mine}）→ 各自挂环；
  // 是否真渲染由气泡内门（is_mine + !retracted + 非 sending/failed + 有收件人）逐条决定；read=0 挂空环 = 已发出未读(#5649)。
  showReadReceipt?: boolean
}

export const MessageBubble = memo(function MessageBubble({
  msg,
  onReaction,
  sendState, undeliveredTo,
  readReceiptRead,
  readReceiptTotal,
  onShowReadReceipt,
  onQuote, onShowMessage,
  onForward,
  onDelete,
  isAgent = false, hideAvatar = false, streaming = false,
  memberProfile = null,
  onOpenMemberProfile,
  compactMobile = false,
  isGroup = false,
  onOpenTopic, onOpenTopicAnchor,
  onOpenFile, onOpenLocalFileLink,
  memberProfiles,
  onEnterSelectMode,
  groupedWithPrev = false, groupedWithNext = false, showReplyQuote = true,
  hideTime = false,
  showReadReceipt = true,
}: BubbleProps) {
  const { t } = useTranslation('messaging')
  const { toast } = useToast()
  const copyText = msg.content_type === 'widget' ? parseWidgetMessage(msg.content)?.text ?? '[Widget]' : msg.content ?? ''
  const handleCopyText = async (content = copyText) => {
    try {
      await platform.writeClipboardText(content)
      notifyCopied(t('message.copied'))
    } catch (error) {
      toast(t('actions.copyFailed', { ns: 'common' }), 'error', safeFailureLine(String((error as Error)?.message ?? error)))
    }
  }
  const [showMenu, setShowMenu] = useState(false)
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 })
  const phone = usePhoneMessageMenu(compactMobile && showMenu)
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const moreButtonRef = useRef<HTMLButtonElement>(null)
  const reactButtonRef = useRef<HTMLButtonElement>(null)
  const bubbleRef = useRef<HTMLDivElement>(null)
  const [menuLink, setMenuLink] = useState<HTMLAnchorElement | null>(null)
  const [menuSelection, setMenuSelection] = useState('')
  const { user } = useAuth()
  const voiceAttachment = msg.content_type === 'attachment'
    ? parseVoiceAttachmentContent(msg.content)
    : null
  const mediaAttachment = msg.content_type === 'attachment' && !voiceAttachment
    ? parseAttachmentContent(msg.content, msg)
    : null
  useEffect(() => {
    if (!showMenu && !showMoreMenu && !showEmojiPicker) return
    const closeFromSharedEvent = () => {
      setShowMenu(false)
      setShowMoreMenu(false)
      setShowEmojiPicker(false)
    }
    // Base UI owns outside-press dismissal; the custom event closes sibling menus before opening.
    document.addEventListener(UI_EVENTS.closeContextMenus, closeFromSharedEvent as EventListener)
    return () => {
      document.removeEventListener(UI_EVENTS.closeContextMenus, closeFromSharedEvent as EventListener)
    }
  }, [showMenu, showMoreMenu, showEmojiPicker])
  const messageActions = (close: () => void) => ({
    isRetracted: !!msg.retracted_at, content: copyText, hasHoverBar: !compactMobile, hasSelection: !compactMobile && !!menuSelection, onClose: close,
    onReply: () => { onQuote(msg); close() },
    onReact: (emoji: string) => { onReaction(msg.id, emoji); close() },
    onQuoteSelection: menuSelection && msg.content_type === 'text' ? () => { onQuote({ ...msg, content: menuSelection }, { originalContent: msg.content }); close() } : undefined,
    onCopy: (content = menuSelection || undefined) => { void handleCopyText(content); close() },
    onSelectText: compactMobile && msg.content_type === 'text' ? () => { phone.setSelecting(true); close() } : undefined,
    onCopyLink: menuLink ? () => { void handleCopyText(menuLink.href); close() } : undefined, onOpenLink: menuLink ? () => { menuLink.click(); close() } : undefined,
    onForward: () => { onForward(msg); close() }, onKeep: keepAction({ id: msg.id, mine: msg.is_mine, live: !!mediaAttachment && mediaAttachment.source.kind !== 'gone' }, close, toast, t),
    onDownload: mediaAttachment && mediaAttachment.source.kind !== 'gone' ? () => { void downloadAttachment(mediaAttachment.source, mediaAttachment.fileName).catch((error) => toast(t('chatArea.downloadFailed'), 'error', safeFailureLine(String((error as Error)?.message ?? error)))); close() } : undefined,
    onDelete: () => { onDelete(msg.id); close() },
    onSelect: onEnterSelectMode ? () => { onEnterSelectMode(msg); close() } : undefined,
    onOpenTopic: onOpenTopic && canSourceTopic(msg) ? () => { onOpenTopic(msg.id); close() } : undefined,
  })

  const captureMenuSelection = () => {
    const selection = window.getSelection()
    setMenuSelection(selection && bubbleRef.current?.contains(selection.anchorNode) && bubbleRef.current.contains(selection.focusNode) ? selection.toString() : '')
  }

  const openMenuAt = (x: number, y: number) => {
    captureMenuSelection()
    document.dispatchEvent(new CustomEvent(UI_EVENTS.closeContextMenus))
    setMenuPos({ x, y })
    setShowMenu(true)
  }

  const openMoreMenuFromButton = () => {
    captureMenuSelection()
    setMenuLink(null)
    document.dispatchEvent(new CustomEvent(UI_EVENTS.closeContextMenus))
    setShowMoreMenu(true)
  }

  const openEmojiPickerFromButton = () => {
    document.dispatchEvent(new CustomEvent(UI_EVENTS.closeContextMenus))
    setShowEmojiPicker(true)
  }

  // @@@mobile-message-menu - Android users need the same message menu without a desktop right-click.
  const longPress = useLongPress(({ x, y }) => openMenuAt(x, y))

  const isRetracted = !!msg.retracted_at

  // @@@whisper (#820) — resolve recipient name for whisper label (my side shows name, their side generic)
  const whisperRecipientName = msg.is_whisper && msg.is_mine && msg.to_user_ids?.[0]
    ? (memberProfiles?.[msg.to_user_ids[0]]?.displayName ?? null)
    : null

  // @@@2017 owner 终版 — 路由真源 → 高亮名单(backedNames)+ 兜底徽标名单(fallbackLabels),单重显示(见 hook)。
  const mentionRender = useMentionRender(msg, isGroup, memberProfiles)

  // gugu-dev#181 任务卡自己就是一个面,❌ 再套一层气泡。
  const card = msg.content_type === 'card' ? parseComposerCard(msg.content) : null
  const bubbleStyle = card ? { maxWidth: '100cqw' } : buildBubbleStyle(msg.is_mine, !!msg.is_whisper, compactMobile, groupedWithPrev)

  const avatarIsAgent = memberProfile?.type === 'agent' || (!msg.is_mine && isAgent)
  const senderIdentity = useAvatarIdentity(avatarIsAgent ? msg.sender_user_id ?? '' : '')
  const avatarName = useShownAgentName({ id: msg.sender_user_id, chatId: msg.chat_id, name: memberProfile?.displayName ?? '', createdAt: avatarIsAgent ? senderIdentity?.created_at ?? undefined : undefined })
  const avatarUrl = memberProfile?.avatar ?? null
  // @@@avatar-status-badge (#793 rollout) - the agent sender's status lives on its memberProfile
  // (populated for both group agents and the DM peer in ChatAreaPanel's messageMemberProfiles).
  // Pass it through so the avatar shows the unified status corner badge.
  // @@@msg-avatar (#1102) - 消息头像对齐设计稿 .av.s(28–32px 小号);原 md=40 偏大显「旧/重」。
  // @@@1355 sender avatars are projected only from the canonical sender URL.
  // Display-only naming never changes the sender id or profile actions.
  const avatar = <MessageSenderAvatar senderUserId={msg.sender_user_id} name={avatarName} avatarUrl={avatarUrl} seed={msg.is_mine ? user?.id : (msg.sender_user_id ?? undefined)} size="sm" isAgent={avatarIsAgent} harnessBadge={!compactMobile} agentStatus={avatarIsAgent ? memberProfile?.agentStatus : undefined} still />
  const canOpenProfile = !!memberProfile && !!onOpenMemberProfile

  if (msg.content_type === 'system') return <SystemMessageNotice message={msg} senderName={avatarName} onOpenTopic={onOpenTopicAnchor} />
  const showSender = isGroup && !msg.is_mine && !groupedWithPrev && !card && !!avatarName
  // 时间在气泡右下角:正文是文字 ⇒ 和最后一行同一行;引用回复、附件、小组件 ⇒ 单独占最后一行。任务卡自己的行尾写着时间。
  const showTime = !hideTime && !card
  const timeInline = isRetracted || (msg.content_type === 'text' && !parseQuotedContent(msg.content ?? '')?.replyText)
  const timeRoom = `"${fmtMsgTime(msg.created_at)}"`
  const replyQuote = msg.reply_to_message_id && showReplyQuote ? (isGroup ? <MessageQuote disclosure={{ showMarker: true, mobile: compactMobile }} msg={msg} quoterIsAgent={avatarIsAgent} memberProfiles={memberProfiles} onShowMessage={onShowMessage} /> : <DirectMessageQuote disclosure={{ showMarker: true, mobile: compactMobile }} msg={msg} quoterIsAgent={avatarIsAgent} memberProfiles={memberProfiles} onShowMessage={onShowMessage} />) : null
  return (
    <MessageHoverRegion enabled={!streaming && !compactMobile} forceOpen={showMoreMenu || showEmojiPicker}
      actions={<HoverActionBar
        isMine={msg.is_mine} anchorRef={bubbleRef}
        isRetracted={isRetracted}
        reactButtonRef={reactButtonRef}
        moreButtonRef={moreButtonRef}
        onReact={openEmojiPickerFromButton}
        onReply={() => { onQuote(msg) }}
        onMore={openMoreMenuFromButton}
      />}
      style={{
        display: 'flex',
        flexDirection: msg.is_mine ? 'row-reverse' : 'row',
        alignItems: 'flex-start',
        gap: layout.avatarGap,
        // @@@msg-air - 行间留白加大 + 头像与气泡间距加大，求轻量呼吸感。
        // 合组的后续消息收紧上下距（组内 1px，组间仍 5px），气泡簇视觉上归属同一发言。
        padding: `${groupedWithPrev ? 1 : 5}px ${layout.rowPadX}px`,
      }}
    >
      {/* Avatar — both sent and received；一组只在组尾画一个头像(sticky 贴滚动区底边),其余几条用等宽占位保持气泡对齐 */}
      {hideAvatar ? null : <GroupAvatarSlot wide={compactMobile} groupedWithPrev={groupedWithPrev} groupedWithNext={groupedWithNext}>{canOpenProfile ? (
        <MemberProfileAvatarButton
          member={memberProfile!}
          testId={AUTOMATION_TEST_IDS.messageAvatarProfileButton}
          avatarSize="sm"
          buttonSize={compactMobile ? 44 : 32}
          messageSenderId={msg.sender_user_id ?? undefined}
          onOpen={(event) => {
            onOpenMemberProfile!(memberProfile!, event.currentTarget, msg.is_mine ? 'left' : 'right')
          }}
        />
      ) : avatar}</GroupAvatarSlot>}

      {/* Bubble + meta */}
      <div
        data-message-bubble-column="true"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: msg.is_mine ? 'flex-end' : 'flex-start',
          // @@@2242 消息列的宽度契约(修复超宽块公式越出气泡)。这一列是 message row 的 flex item,也是整条渲染
          // 链里唯一能拿到「确定宽度」的锚点——气泡/markdown/公式往下全是 fit-content 或 flex-column 的 align-items
          // shrink-to-fit(宽度不确定)。不可断的超宽块公式(KaTeX 单个 inline-block)会把这条不确定链一路顶到公式
          // 内在宽度,而气泡的百分比 max-width 在内在尺寸计算里被当 none 忽略 → 气泡连同整列胀破越出聊天区。
          //   ① flexBasis 定成 70%/78% + minWidth:0 → 本列是确定宽度(= 可用宽的 70%),不再被内容顶宽;短消息里
          //   ② containerType:inline-size → 本列成为行内尺寸查询容器,气泡即可用 100cqw 拿到确定长度的 max-width
          //      真正封顶(见 bubbleStyle.maxWidth);封顶后气泡内的 .katex-display/pre 的 overflow-x-auto 才在气泡
          //      内横滚。直接给 flex 列上 container-type 会把 auto flex-basis 的内容尺寸算成 0 → 列塌成 0,故必须显式 flexBasis。
          flexBasis: `${100 * (compactMobile ? layout.column.phone : layout.column.desktop)}%`,
          maxWidth: `${100 * (compactMobile ? layout.column.phone : layout.column.desktop)}%`,
          minWidth: 0,
          containerType: 'inline-size',
          gap: '3px',
        }}
      >
        {/* @@@whisper (#820) — 悄悄话标签（设计稿 .whisper .lbl:标注字号 + --faint-fg; display:flex; align-items:center; gap:4px）
            is_mine=true → 「悄悄话给 {name} · 仅你与对方可见」；received → 「悄悄话 · 仅你可见」 */}
        {msg.is_whisper && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--font-caption)', lineHeight: 'var(--lh-caption)', color: 'var(--faint-fg)', padding: '0 2px' }}>
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="currentColor" d="M2.69 6.705a.75.75 0 0 0-1.38.59zm12.897 6.624l-.274-.698zm-6.546.409a.75.75 0 1 0-1.257-.818zm-2.67 1.353a.75.75 0 1 0 1.258.818zM22.69 7.295a.75.75 0 0 0-1.378-.59zM19 11.13l-.513-.547zm.97 2.03a.75.75 0 1 0 1.06-1.06zm-8.72 3.34a.75.75 0 0 0 1.5 0zm5.121-.591a.75.75 0 1 0 1.258-.818zm-10.84-4.25A.75.75 0 0 0 4.47 10.6zm-2.561.44a.75.75 0 0 0 1.06 1.06zM12 13.25c-3.224 0-5.539-1.605-7.075-3.26a13.6 13.6 0 0 1-1.702-2.28a12 12 0 0 1-.507-.946l-.022-.049l-.004-.01l-.001-.001L2 7l-.69.296h.001l.001.003l.003.006l.04.088q.039.088.117.243c.103.206.256.496.462.841c.41.69 1.035 1.61 1.891 2.533C5.54 12.855 8.224 14.75 12 14.75zm3.313-.62c-.97.383-2.071.62-3.313.62v1.5c1.438 0 2.725-.276 3.862-.723zm-7.529.29l-1.413 2.17l1.258.818l1.412-2.171zM22 7l-.69-.296h.001v.002l-.007.013l-.028.062a12 12 0 0 1-.64 1.162a13.3 13.3 0 0 1-2.15 2.639l1.027 1.094a14.8 14.8 0 0 0 3.122-4.26l.039-.085l.01-.024l.004-.007v-.003h.001v-.001zm-3.513 3.582c-.86.806-1.913 1.552-3.174 2.049l.549 1.396c1.473-.58 2.685-1.444 3.651-2.351zm-.017 1.077l1.5 1.5l1.06-1.06l-1.5-1.5zM11.25 14v2.5h1.5V14zm3.709-.262l1.412 2.171l1.258-.818l-1.413-2.171zm-10.49-3.14l-1.5 1.5L4.03 13.16l1.5-1.5z"/>
            </svg>
            {msg.is_mine
              ? whisperRecipientName
                ? t('message.whisperTo', { name: whisperRecipientName })
                : t('message.whisperBoth')
              : t('message.whisperOnlyYou')}
          </div>
        )}

        {/* @@@2017 元指示行 — 定向兜底徽标(仅旧数据:路由有、正文缺 @) + 转发指示;抽到 MessageMetaRow。 */}
        <MessageMetaRow
          replyProcessMessageId={msg.is_mine ? undefined : msg.id} targetingLabels={mentionRender.fallbackLabels} activitySource={msg.is_mine ? { chatId: msg.chat_id, messageId: msg.id } : undefined}
          sentByAgent={msg.sent_by_agent} agentSender={msg.is_mine ? msg.agent_sender : null} forwardedFromMessageId={msg.forwarded_from_message_id ?? null} viaApp={msg.via_app ?? null} viaAppSender={msg.is_mine ? null : avatarName}
        />
        {/* 气泡 + 表情回应这一块。工具条不再锚在这里:这一层是整列宽(70%/78%),锚在它的边上,
            短气泡的工具条会离气泡半屏远(owner 2a)。 */}
        <div style={{ width: '100%', minWidth: 0 }}>
        {/* 气泡行收成 fit-content(我方 marginLeft:auto 靠右),工具条锚在**这一行**的边上 = 贴着气泡。
            Design: .msg-actions{position:absolute}  agent → right:0 / own → left:0  */}
        <MessageHoverTrigger data-message-bubble-row="true" style={{ position: 'relative', display: 'flex', flexDirection: 'row', alignItems: 'flex-end', justifyContent: msg.is_mine ? 'flex-end' : 'flex-start', gap: '4px', width: 'fit-content', maxWidth: '100%', minWidth: 0, ...(msg.is_mine ? { marginLeft: 'auto' } : {}) }}>
          {msg.is_mine && !msg.retracted_at && sendState && (
            <MessageSendStatus state={sendState} messageId={msg.id} reason={msg.local_send_error} retryable={msg.local_send_retryable} blocks={msg.delivery_blocks} undeliveredTo={undeliveredTo ? undeliveredTo.split(',') : undefined} />
          )}

          {/* @@@1345 逐成员读回执做成进度圆环(替文字)：本人已发消息显示 ○ 环(填充比例=已读%)，
              点击展开「谁已读/谁未读」名单(onShowReadReceipt)。语义文案进 aria-label/title(a11y+可测)。
              @@@1460 与 MessageStatus 互斥：传输瞬态(sending/failed)只显 MessageStatus 小图标、不显环;
              有已读进度时只显环(MessageStatus 已 return null)→ 永远单一指示,无新老双勾。
              showReadReceipt：每条本人消息各自挂环（#2098 owner 要逐条，撤 #1779 只挂末条的降噪）。
              read=0 的空环 = 「已发出、还没人读」(#5649 owner 拍板四态:发送中/已发出/已读/失败;发送中已改成虚线流动环,与空环可区分)。
              任务卡不挂环:它是交给一个 agent 的事件(gugu-dev#181),接没接、做到哪看卡行尾的状态,❌ 再问谁读了。 */}
          {showReadReceipt && msg.is_mine && !card && !msg.retracted_at && sendState !== 'sending' && sendState !== 'undelivered' && sendState !== 'failed' && readReceiptTotal != null && readReceiptTotal > 0 && readReceiptRead != null && (
            <button
              type="button"
              data-testid="message-read-receipt"
              aria-label={readReceiptLabel(readReceiptRead, readReceiptTotal, t)}
              title={readReceiptLabel(readReceiptRead, readReceiptTotal, t)}
              onClick={onShowReadReceipt ? (e) => onShowReadReceipt(msg.id, e.currentTarget) : undefined}
              style={{
                border: 0, background: 'transparent',
                width: compactMobile ? 44 : 15, height: compactMobile ? 44 : 15,
                padding: 0, display: 'inline-flex',
                alignItems: 'center',
                cursor: onShowReadReceipt ? 'pointer' : 'default',
                flexShrink: 0,
                position: 'absolute', right: '100%', bottom: compactMobile ? -14 : 0, marginRight: compactMobile ? -8 : 4, justifyContent: 'center', zIndex: 1, // 回执晚到不挤窄正文;仍锚在气泡左侧,手机保留44px点击区。
              }}
            >
              <ReadReceiptRing read={readReceiptRead} total={readReceiptTotal} />
            </button>
          )}

          <div
            ref={bubbleRef}
            data-testid={AUTOMATION_TEST_IDS.messageBubbleActionTarget}
            style={phone.selecting ? { ...bubbleStyle, userSelect: 'text', WebkitUserSelect: 'text', WebkitTouchCallout: 'default' } : bubbleStyle} data-message-reply-footer={!showSender && !!replyQuote && showReplyQuote || undefined} data-bubble-tail={!card && !msg.is_whisper && !groupedWithNext ? (msg.is_mine ? 'mine' : 'other') : undefined}
            {...bubbleMenuGestures(longPress, openMenuAt, phone.selecting)}
            onPointerDownCapture={(e) => setMenuLink(e.target instanceof Element ? e.target.closest<HTMLAnchorElement>('a[href]') : null)}
          >
            {/* 名字只在群里收到的、一组的第一条上(DM 头栏已经说了是谁);任务卡自己写着是谁发的。 */}
            {showSender && <BubbleSender member={memberProfile} displayName={avatarName} senderId={msg.sender_user_id} replyMark={replyQuote} />}
            {isRetracted ? (
              // #1323 模块3 — 撤回文字 --text-tertiary→--muted-fg(原偏淡)
              <span className="msg-time-room-inline" style={{ color: 'var(--muted-fg)', fontStyle: 'italic', '--msg-time-room': timeRoom } as React.CSSProperties}>{t('message.retracted')}</span>
            ) : (
              <div className={timeInline ? 'msg-time-room' : undefined} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '4px', '--msg-time-room': timeRoom } as React.CSSProperties}>
                {card?.type === 'question' ? (
                  <QuestionCardView card={card} chatId={msg.chat_id} messageId={msg.id} agentUserId={msg.sender_user_id ?? ''} time={replyQuote ? <>{replyQuote}{fmtMsgTime(msg.created_at)}</> : fmtMsgTime(msg.created_at)} />
                ) : card ? (
                  <ComposerCardView card={card} isMine={msg.is_mine} isGroup={isGroup} chatId={msg.chat_id} senderName={avatarName} time={replyQuote ? <>{replyQuote}{fmtMsgTime(msg.created_at)}</> : fmtMsgTime(msg.created_at)} memberProfiles={memberProfiles} onOpenTopic={compactMobile && onOpenTopic && card.type === 'task' ? () => onOpenTopic(msg.id) : undefined} onOpenFile={onOpenFile} />
                ) : msg.content_type === 'widget' ? (
                  <WidgetBubble message={msg} />
                ) : msg.content_type === 'attachment' ? (
                  voiceAttachment ? (
                    <VoiceAttachmentBubble
                      fileName={voiceAttachment.fileName}
                      durationMs={voiceAttachment.durationMs}
                      transcript={voiceAttachment.transcript}
                      isMine={msg.is_mine}
                    />
                  ) : mediaAttachment ? (
                    <MediaAttachmentBubble meta={mediaAttachment} messageId={msg.id} isMine={msg.is_mine} onOpenFile={onOpenFile ? (file) => onOpenFile(file, msg) : undefined} senderName={avatarName} chatId={msg.chat_id} />
                  ) : (
                    <span style={{ color: 'var(--text-link)' }}>{t('message.attachment')}</span>
                  )
                ) : <div style={compactMobile ? { alignSelf: 'stretch', minWidth: 0, maxWidth: '100%' } : { display: 'contents' }}>{(() => {
                  const partial = partialQuotedContent(msg)
                  const raw = partial?.replyText ?? msg.content ?? ''
                  const quoted = partial ? null : parseQuotedContent(raw)
                  if (quoted && quoted.replyText) {
                    return (
                      // flex column + alignItems:flex-start → each child shrinks to its own content width
                      // quote block won't stretch the bubble beyond reply text width
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '4px' }}>
                        {quoted.replyText && (
                          <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                            {quoted.replyText}
                          </div>
                        )}
                        {/* overflow:hidden + maxWidth together cap max-content contribution to parent fit-content */}
                        <div style={{
                          display: 'inline-block',
                          overflow: 'hidden',
                          borderLeft: `3px solid ${msg.is_mine ? 'var(--bubble-quote-bar-mine)' : 'var(--bubble-quote-bar-other)'}`,
                          paddingLeft: '7px',
                          maxWidth: '160px',
                        }}>
                          {quoted.senderName && (
                            <div style={{ fontSize: 'var(--font-body)', lineHeight: 'var(--lh-body)', fontWeight: 600, opacity: 0.6, marginBottom: '1px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {quoted.senderName}
                            </div>
                          )}
                          <div style={{ fontSize: 'var(--font-body)', lineHeight: 'var(--lh-body)', opacity: 0.55, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {quoted.quoteText}
                          </div>
                        </div>
                      </div>
                    )
                  }
                  // #1515 段内 Shift+Enter 软换行渲成 <br> 仅对人类手打消息;agent/LLM 内容保持 CommonMark(软换行=空格)。
                  // @@@2017 群内定向消息:渲染注入 nonce marker 后的正文(mentionRender.content),并把本次 marker 传下 →
                  // 只有被 to_user_ids 背书的 @Name 才渲成 mention;非群/whisper → content=undefined 用原始 raw、marker 空。
                  return <Markdown trust="chat" content={partial ? raw : mentionRender.content ?? raw} onAccent={msg.is_mine} hardBreaks={!avatarIsAgent} mentionMarker={mentionRender.mentionMarker} onOpenLink={(href) => { const link = classifyFileLink(href); if (!isAgent || !onOpenLocalFileLink || link.kind !== 'workspace-file') return false; onOpenLocalFileLink(link.path); return true }} />
                })()}</div>}
              </div>
            )}
            {!card && (showTime || (!showSender && replyQuote)) && <BubbleTime iso={msg.created_at} isMine={msg.is_mine} inline={timeInline} replyMark={!showSender ? replyQuote : undefined} hideTime={!showTime} />}
          </div>
        </MessageHoverTrigger>

        {/* 表情回应与气泡同侧(#6428):这一层是整列宽,我方气泡行靠 marginLeft:auto 贴右,回应条不跟着贴右就留在整列最左。 */}
        {msg.reactions.length > 0 && (
          <ReactionBar
            reactions={msg.reactions}
            isMine={msg.is_mine}
            onToggle={(emoji) => onReaction(msg.id, emoji)}
          />
        )}
        </div>{/* closes bubble + reactions block */}
      </div>

      {/* ── More menu (hover-bar "More" button) — design #msgmenu, portalled ── */}
      {showMoreMenu && <MsgMoreMenu anchor={moreButtonRef} {...messageActions(() => setShowMoreMenu(false))} />}

      {/* ── 右键:指针处的同一份菜单。手机长按:同一份动作,气泡浮起、菜单贴在它上下(owner 11-05 方案 A;返回键先关它) ── */}
      {compactMobile
        ? phone.mounted && <MsgMoreMenu lift={{ open: showMenu, bubble: bubbleRef, touchY: menuPos.y, mine: msg.is_mine }} {...messageActions(() => setShowMenu(false))} />
        : showMenu && <MsgMoreMenu x={menuPos.x} y={menuPos.y} {...messageActions(() => setShowMenu(false))} />}
      {phone.selecting && <PhoneTextSelection bubble={bubbleRef} onCopy={(text) => { void handleCopyText(text || undefined); phone.setSelecting(false) }} onDone={() => phone.setSelecting(false)} />}

      {/* ── Emoji quick-picker (hover-bar "Add emoji" button) ── */}
      {showEmojiPicker && (
        <DeferredEmojiQuickPicker
          anchor={compactMobile ? bubbleRef : reactButtonRef}
          onPick={(emoji) => { onReaction(msg.id, emoji); setShowEmojiPicker(false) }}
          onClose={() => setShowEmojiPicker(false)}
        />
      )}
    </MessageHoverRegion>
  )
})

function ReactionBar({ reactions, isMine, onToggle }: {
  reactions: ReactionGroup[]
  isMine: boolean
  onToggle: (emoji: string) => void
}) {
  return (
    <div data-message-reactions="true" style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', justifyContent: isMine ? 'flex-end' : 'flex-start' }}>
      <AnimatePresence>
        {reactions.map((r) => (
          <motion.button
            key={r.emoji} title={reactionLabel(r.emoji, i18n.language) ?? undefined}
            onClick={() => onToggle(r.emoji)}
            whileTap={{ scale: 0.9 }}
            animate={r.my_reaction ? { scale: [1, 1.2, 1] } : { scale: 1 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            style={{
              background: r.my_reaction ? 'var(--live-soft)' : 'var(--input-bg)', // @@@live-accent (Refs #6105) 「我点过」是 selected 态
              border: r.my_reaction ? '1px solid var(--live)' : '1px solid transparent',
              borderRadius: 'var(--radius-surface)',
              padding: '1px 6px',
              fontSize: 'var(--font-caption)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '2px',
            }}
          >
            <span>{r.emoji}</span>
            <span style={{ fontSize: 'var(--font-caption)', color: COLOR_MUTED }}>{r.count}</span>
          </motion.button>
        ))}
      </AnimatePresence>
    </div>
  )
}
