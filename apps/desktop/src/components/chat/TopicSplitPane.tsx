import { useUnreadLocatorNavigation } from '@/hooks/useUnreadLocatorNavigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { useTranslation } from 'react-i18next'
import { DUR_SLOW_MS, EASE_SPRING, tween } from '@/styles/motion'
import { ChevronLeft, X } from '@/lib/icons'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { visibleDeliveryMessages } from '@gugu/core/shared/ui/systemNotice'
import { composerCardPreview } from '@gugu/core/shared/ui/taskCardModels'
import type { GroupRosterCandidate } from '@/lib/mention'
import type { AgentStatusById } from './agentMentionStatusModels'
import type { MemberProfileCardModel } from '../MemberProfileCard'
import type { ParsedAttachment } from '@gugu/core/shared/ui/attachmentModels'
import type { MemberProfileSide } from '../memberProfileModels'
import { IconButton } from '../ui/IconButton'
import { PaneHeader } from '../ui/Pane'
import { useBackLayer } from '../ui/sheetStack'
import { ChatMessageComposer } from './ChatMessageComposer'
import { RunningBarSlot, RunningTokenBar, type RunningToken } from '../RunningTokenBar'
import { TopicBreadcrumb } from './TopicBreadcrumb'
import { MessageList, type ChatListRowItem, type MessageListRowProps } from './MessageList'
import { useToast } from '../toastContext'
import { useSourceMessageReveal } from '@/hooks/useSourceMessageReveal'
import type { FlowListHandle } from '@/lib/flowList'
import {
  TOPIC_SPLIT_MAX_WIDTH,
  TOPIC_SPLIT_MIN_WIDTH,
  clampTopicSplitWidth,
  maxTopicSplitWidthForAvailableWidth,
  quotePrefixOf,
  readStoredTopicSplitWidth,
  writeStoredTopicSplitWidth,
} from './topicSplitModels'
import { ResizablePane } from '@/layouts/ResizablePane'
import { prioritizeTopicParticipants } from './topicMentionModels'
import { useReadReceiptPanel } from '@/hooks/useReadReceiptPanel'
import { ReadReceiptPopover } from '../ReadReceiptPopover'
import { ChatBottomDock } from './ChatBottomDock'
import type { ChatConversation } from '@/store/useChatConversation'
import { useFollowingTail, useTailPinning } from './useFollowingTail'
import { useChatHistoryPagination } from './useChatHistoryPagination'
import { useConversationScrollMemory } from './useConversationScrollMemory'
import { ChatTailNotice } from './ChatTailNotice'
import { MessageLoadFailure } from './MessageLoadFailure'
import { MessageListSkeleton } from './MessageListSkeleton'

/**
 * @@@5856 话题分栏 —— 右侧那条独立收发的话题线(product spec)。
 *
 * 「开出来是分栏,不是切走」:来源那条线留在左边继续能看能发,这一栏独立收发。
 * 所以它自带头、自带消息流、自带输入框 —— 主 composer 仍然发主线,两边并行。
 *
 * 「没有开关,只有沉降」:这里的「收起分栏」是**界面动作**,不是话题状态。
 * ❌ 不许出现「关闭话题 / 完成」——文案必须把这两件事区分开,所以按钮说的是
 * 「收起分栏」并在 title 里补一句「话题不会关闭」。
 */
export type TopicSplitPaneProps = {
  visible?: boolean
  viewportKey?: string
  navigationTarget?: boolean
  topic: { chatId: string; name: string }
  history: ChatConversation
  messages: MessageItem[]
  loading: boolean
  memberProfiles: Record<string, MemberProfileCardModel>
  visibleChats: readonly { id: string; name: string; member_user_ids?: string[] }[]
  /**
   * 这条话题引自哪一句。四种值分开(见 TopicBreadcrumb):'pending' 还没读到 / 'unreadable' 读到了
   * 但这个人看不到 / null 来源消息确实被删了 / 有字 = 预览。从会话列表点进来的人,
   * 光看话题名说不出它从哪条消息长出来的 —— 这是「双向连接」上行的那一半。
   */
  sourceMessagePreview: string | null | 'pending' | 'unreadable'
  /**
   * 这个号一变就把焦点交给**这一栏**的输入框(用鼠标点话题进来的那条路)。
   * ❌ 不走 lib/focusComposer 那条全局契约:分栏这份 composer 是 surface="aside",
   * 刻意不登记为全局落点(登记了主线发完一条就会把光标送进话题里)。
   */
  focusComposerToken?: number
  /**
   * 这条**话题自己**的对端读位(不是来源线的)。空表 ⇒ 不画环。
   * ⚠️ ❌ 不许拿来源线那份顶上:画出来的是另一条线的读数,而错的环比没有环更坏。
   */
  memberReadSeqs: Record<string, number>
  onSend: (text: string, toUserIds: readonly string[] | null, replyToMessageId: string | null, isWhisper?: boolean) => Promise<void>
  /** 发附件。回形针在 ChatMessageComposer 里是无条件画的,不接这一口 = 挂得上发不出去。 */
  onSendAttachments: (files: File[], opts?: { toUserIds?: string[] | null; isWhisper?: boolean; caption?: string; onSent?: (file: File, index: number) => void }) => Promise<void>
  /**
   * 能在这一栏里 @ 到的人 = **来源线**的名册。spec:「招 agent 同理——建完之后 @ 它,它就进来了」,
   * 而服务端只放行来源线的成员,所以候选集就取来源线的,❌ 不取话题当前那几个(那样永远拉不进新人)。
   */
  mentionMembers: readonly GroupRosterCandidate[]
  /** @ 候选里那些 agent 此刻在不在线。话题里 @ 就是「把人拉进来」的动作,看不见状态就是盲拉。 */
  agentStatuses?: AgentStatusById
  /**
   * 来源群的运行 token(手机专用)。手机上话题整页盖住了群,群里那条运行条就看不见了 ——
   * 在话题输入框上面挂同一条:数据取来源群,短按 @ 进**话题**的输入框,长按看详情,同群里。
   * 桌面不传:分栏旁边群里那条一直看得见。
   */
  runningTokens?: RunningToken[]
  /** 运行条详情卡读哪条会话(来源群)。 */
  runningPreviewChatId?: string | null
  onClose: () => void
  /** 发言人的 id —— ChatMessageComposer 的 @ 候选与自指要用它。 */
  currentUserId: string | null
  /** 移动壳:整页盖住来源线、出口是左上返回,且不抢焦点(不弹软键盘)。 */
  mobile?: boolean
  /**
   * gugu-dev#181 画在会话页一块里:话题是块页签条上的一枚页签(和群那一枚并排,× = 收起),这一栏就是那一枚的内容,
   * 宽窄由并排的分界管 —— 没有自己的拖拽边、也没有自己的收起钮。不给 = 对话页(自带拖拽边)、手机(整页)。
   */
  embedded?: boolean
  /**
   * 手机对话页那排页签里的一枚(owner 10-25「和桌面类似分 tab」,OpenDCAI/gugu#446):这一栏就盖在群的消息区上,
   * 页头和页签条是群的,所以它自己没有页头,顶上只留一行「从哪一条开出来」;不滑进来。返回 = 回「群聊」那一枚。
   */
  inTab?: boolean
  // ⚠️ 下面几个是 MessageBubble 的**必填** props,而这一栏自己拿不到它们的实现
  // (表情/转发/删除都要 ChatAreaPanel 那层的 handler)。做成可选透传而不是在内部写死
  // no-op:不接时这几个动作在分栏里点了没反应 = 静默失败,接上就跟主线同口径。
  //
  // ❌ 引用**故意不透传主线的 handler**:主线那个把引用条塞进主 composer,于是用户在话题里点
  // 「引用」、发出去的却是源群 —— 正是话题要隔离掉的那个方向。这一栏自己接(见下面的 quoted)。
  /**
   * 点头像开成员卡片。不接 = 分栏里点头像**什么都不发生**,而主线点了会开卡片 ——
   * 同一个气泡组件在两栏里行为不一样,用户只会觉得「这边坏了」。
   * 弹层本身由 ChatAreaPanel 那一份统一渲染(分栏就长在它的树里),所以这里只透传 handler。
   */
  onOpenMemberProfile?: (member: MemberProfileCardModel, anchor: HTMLElement, preferredSide: MemberProfileSide) => void
  /** 气泡里的文件卡点开 —— 与主线同一个处理器。不接 = 分栏里的文件卡点了什么都不发生(#6375)。 */
  onOpenAttachment?: (meta: ParsedAttachment, message?: MessageItem) => void
  onReaction?: (messageId: string, emoji: string) => void
  onForward?: (msg: MessageItem) => void
  onDelete?: (messageId: string) => void
}

const noop = () => {}
// 分栏没有多选 —— 常量空值,免得每次渲染换引用把行的 memo 打破。
const EMPTY_SELECTION: Set<string> = new Set()
const MESSAGE_LIST_STYLE: React.CSSProperties = { flex: 1, minHeight: 0 }

// @@@ui-ruler 结构性 style 提到模块作用域(同 ChatListPanel 的 *_STYLE 常量):
// 既避免每次渲染重建对象,也让 JSX 里不再残留内联几何块这条债务痕迹。
// 依赖 props 的那一档提成纯函数,保持同一条纪律。
const TOPIC_SPLIT_SHELL_STYLE: React.CSSProperties = {
  width: '100%',
  height: '100%',
  overflow: 'hidden',
}
const TOPIC_SPLIT_PANE_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  position: 'relative',
  background: 'var(--bg-primary)',
  borderLeft: '1px solid var(--border-subtle)',
}
// 手机上放不下两栏 ⇒ 整页盖住来源线(同 ChatSettingsPanel 的手机页)。来源线在下面不被挤窄,返回后停在原处。
const TOPIC_PAGE_MOBILE_STYLE: React.CSSProperties = { position: 'fixed', inset: 'env(safe-area-inset-top) 0 0 0', zIndex: 'var(--z-modal)', background: 'var(--bg-primary)' }
const TOPIC_PAGE_PANE_MOBILE_STYLE: React.CSSProperties = { ...TOPIC_SPLIT_PANE_STYLE, borderLeft: 'none', background: 'transparent' }
const TOPIC_TAB_STYLE: React.CSSProperties = { position: 'absolute', inset: 0, zIndex: 1, background: 'transparent' }
const TOPIC_SPLIT_HEADER_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 8,
  padding: '12px 14px',
  borderBottom: '1px solid var(--border-subtle)',
  flexShrink: 0,
}
const TOPIC_SPLIT_HEADER_ACTIONS_STYLE: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0, marginTop: 'calc((var(--lh-title) - var(--control-h-sm)) / 2)' }
const TOPIC_SPLIT_MESSAGES_STYLE: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  padding: '14px 12px',
}
// Desktop framing is shared with the main composer through ChatBottomDock.
const TOPIC_SPLIT_COMPOSER_STYLE: React.CSSProperties = {
  padding: 0, flexShrink: 0,
}
const TOPIC_SPLIT_COMPOSER_MOBILE_STYLE: React.CSSProperties = {
  background: 'transparent', padding: '8px 8px max(8px, env(safe-area-inset-bottom))', flexShrink: 0,
}
const TOPIC_SPLIT_EMPTY_STYLE: React.CSSProperties = { textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 'var(--font-body)', padding: '24px 0' }

export function TopicSplitPane({ viewportKey = 'topic', navigationTarget = false,
  topic,
  messages,
  loading,
  memberProfiles,
  visibleChats,
  sourceMessagePreview,
  focusComposerToken,
  memberReadSeqs,
  onSend,
  onSendAttachments,
  mentionMembers,
  agentStatuses,
  runningTokens,
  runningPreviewChatId = null,
  history,
  onClose,
  currentUserId,
  mobile = false,
  onOpenMemberProfile,
  onOpenAttachment,
  onReaction,
  onForward, visible,
  onDelete,
  embedded = false,
  inTab = false,
}: TopicSplitPaneProps) {
  const { t } = useTranslation('messaging')
  // #6004: the projection owns membership and chat_members_changed refreshes. Read this topic's
  // IDs on every projection update; do not cache a second roster or infer participation from messages.
  const participantIds = visibleChats.find((chat) => chat.id === topic.chatId)?.member_user_ids
  const rankedMentionMembers = useMemo(
    () => prioritizeTopicParticipants(mentionMembers, participantIds),
    [mentionMembers, participantIds],
  )
  const [mentionToInsert, setMentionToInsert] = useState<{ id: string; name: string } | null>(null)
  const { readReceiptPanel, onShowReadReceipt, onCloseReadReceipt } = useReadReceiptPanel({
    chatId: topic.chatId, messages, memberReadSeqs, memberProfiles,
  })
  // 宽度记在本机:拖过一次之后下次打开还是那个宽度(与会话列表同口径)。
  const [width, setWidth] = useState(() => readStoredTopicSplitWidth())
  const commitWidth = useCallback((next: number) => {
    setWidth(next)
    writeStoredTopicSplitWidth(next)
  }, [])
  // 引用条留在**这一栏**:引用的是话题里的一句话,发出去也该落在话题里。
  // @@@3922 换话题时这个组件实例**不重挂**(key 在下面那个 motion.div 上,不在组件本身),
  // 所以引用条得自己认主体 —— 否则在话题 A 里点的引用会跟着漂到 B,一按回车就发错线。
  // 焦点:点话题进来时要落在**这一栏**的输入框上,❌ 不留在左边来源线那一个。
  // 移动壳不抢 —— 抢了就立刻弹软键盘,把本来就窄的消息区再挤掉一半(同 lib/focusComposer 的那条惯例)。
  const paneRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!focusComposerToken || mobile) return
    const frame = requestAnimationFrame(() => {
      paneRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [focusComposerToken, mobile])
  const [quoted, setQuoted] = useState<{ forChatId: string; messageId: string; senderName: string; content: string; source: MessageItem } | null>(null)
  const activeQuote = quoted?.forChatId === topic.chatId ? quoted : null
  // @@@5856 「自己贴底」那一整段已删 —— 滚动归 MessageList(lib/flowList.ts 的贴底 +
  // totalListHeightChanged)。手写的那份在 markdown/代码块异步撑高之后就钳不住,症状是新消息不滚。

  // 列表行与主线共用历史窗口和分页;分栏没有多选。
  // 已读环有 —— 水位由 useChatConversation 按**这条话题**自己拉,拉不到时是空表(空表就不出环)。
  const rows = useMemo<ChatListRowItem[]>(
    () => visibleDeliveryMessages(messages, messages).map((message) => ({ type: 'message' as const, message })),
    [messages],
  )
  const listRef = useRef<FlowListHandle | null>(null)
  const isAtBottomRef = useRef(true)
  const { messageWindow, setFollowingTail, loadMessageAnchor } = history
  const [flashMessageId, setFlashMessageId] = useState<string | null>(null)
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { toast } = useToast()
  const chatResetKey = `${topic.chatId}#${messageWindow.viewVersion}`
  const { scrollerEl, scrollerRef, setScrollerRef, isPreservingPosition, prepareForSavedPosition, forgetSavedPosition, openLocation, revealMessage } = useConversationScrollMemory({
    chatId: topic.chatId, viewportKey, activationKey: topic.chatId, enabled: visible !== false, discardSaved: !!history.unreadEntry,
    messageIds: rows.map((row) => row.message.id), isAtBottomRef, setFollowingTail, loadMessageAnchor,
  })
  const onHistoryError = useCallback((error: unknown) => toast(error instanceof Error ? error.message : String(error), 'error'), [toast])
  const unreadNavigationPending = useUnreadLocatorNavigation({ revealMessage, activeChatId: topic.chatId, enabled: visible !== false,
    scrollerRef, setFlashMessageId, flashTimerRef })
  const { viewportAtBottom, onAtBottomChange } = useFollowingTail({ resetKey: chatResetKey, unreadNavigationPending: !!unreadNavigationPending,
    hasNewer: messageWindow.hasNewer, loading: !!messageWindow.loading, isPreservingPosition, isAtBottomRef, setFollowingTail })
  useChatHistoryPagination({ resetKey: chatResetKey, messages, enabled: visible !== false && !unreadNavigationPending,
    scroller: scrollerEl, atBottom: viewportAtBottom, loadOlder: history.loadOlderMessages, loadNewer: history.loadNewerMessages, window: messageWindow, onError: onHistoryError })
  const { pinToBottom, onTotalListHeightChanged } = useTailPinning({ resetKey: chatResetKey, messages,
    enabled: visible !== false && !unreadNavigationPending, messageWindow, scrollerEl, scrollerRef, listRef, isAtBottomRef,
    isPreservingPosition, prepareForSavedPosition, forgetSavedPosition, returnToLatest: history.returnToLatestMessages, onError: onHistoryError })
  const showMessage = useSourceMessageReveal({
    viewportKey, navigationTarget, enabled: visible !== false,
    activeChatId: topic.chatId, 
    rows, listRef, isAtBottomRef, setFollowingTail, setFlashMessageId, flashTimerRef, revealMessage,
    onMissing: () => toast(t('chatArea.source.notVisible'), 'error'),
  })

  const rowProps = useMemo<MessageListRowProps>(() => ({
    rows,
    messages,
    isFiltering: false,
    mobile,
    memberReadSeqs,
    isAgentChat: false,
    // 话题是多人线 ⇒ 与群同口径,收到的气泡上方显发送者名。
    isGroupChat: true,
    memberProfiles,
    onOpenMemberProfile,
    onOpenFile: onOpenAttachment,
    onShowReadReceipt,
    onReaction: onReaction ?? noop,
    onShowMessage: showMessage,
    onQuote: (msg) => setQuoted({
      forChatId: topic.chatId,
      messageId: msg.id, source: msg,
      senderName: memberProfiles[msg.sender_user_id ?? '']?.displayName ?? '',
      content: quotePrefixOf(msg),
    }),
    onForward: onForward ?? noop,
    onDelete: onDelete ?? noop,
    onVisible: (message) => { if (visible !== false) history.markMessageVisible(message) },
    // 右键发送者头像 → @ 他:插进**这一栏**的输入框,与上面运行中头像条同一个 setMentionToInsert。
    onMentionMember: setMentionToInsert,
    // 单层不嵌套:onOpenTopic 给 undefined —— 话题里的消息不给「开话题」入口,也就没有锚点卡
    // (spec「必须有来源」:话题上不再开话题)。MessageBubble 的菜单项只在收到这个 handler 时才画。
    onOpenTopic: undefined, topicAnchors: undefined, onOpenTopicAnchor: undefined,
    // 本地文件链接只有 agent 私聊映射得到(useAgentSessionpagePresentation);搜索、三方、自动调档提示是主线的面。
    onOpenLocalFileLink: undefined, highlight: undefined, threeParty: undefined, agentFloodNoticeMessageId: undefined, onAgentFloodUndone: undefined,
    // 分栏没有多选态 ⇒ 不给「多选」菜单项(给 noop 就是一个点了没反应的死项)。
    selectMode: false,
    selectedIds: EMPTY_SELECTION,
    onToggleSelect: noop,
    onEnterSelectMode: undefined,
    flashMessageId,
  }), [showMessage, rows, messages, mobile, memberReadSeqs, memberProfiles, onOpenMemberProfile, onOpenAttachment, onShowReadReceipt, onReaction, onForward, onDelete, topic.chatId, flashMessageId, history, visible])

  useBackLayer(onClose, mobile && !inTab)
  const headerTitle = <TopicBreadcrumb topicName={topic.name} sourceMessagePreview={sourceMessagePreview} />
  const page = (
    // @@@2234 同 history/workspace/群 thread 面板:进场保留、**退场不保留占位**。
    // ⇒ ❌ 不要给它套 AnimatePresence / 加 exit。
    <motion.div
      key={`topic-split-${topic.chatId}`}
      initial={inTab ? false : mobile ? { x: '100%' } : { x: 340, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={tween(DUR_SLOW_MS, EASE_SPRING)}
      style={inTab ? TOPIC_TAB_STYLE : mobile ? TOPIC_PAGE_MOBILE_STYLE : TOPIC_SPLIT_SHELL_STYLE}
    >
      <div
        ref={paneRef}
        data-testid="topic-split-pane"
        data-topic-id={topic.chatId}
        data-chat-surface={topic.chatId}
        style={mobile ? TOPIC_PAGE_PANE_MOBILE_STYLE : TOPIC_SPLIT_PANE_STYLE}
      >
        {/* 这一条**常驻**:面板开着时它也在。曾经开面板就把它收起来,代价是
            ①「收起分栏」与另一颗切换键一起消失,②这一栏里再没有一个字说明你在哪条话题上
            (找茬第十轮)。嵌进来的那两个面板自带的头由 tokens.css 收掉,所以不会两条头叠着摆。 */}
        {inTab ? <TopicTabSource preview={sourceMessagePreview} /> : mobile ? (
          <PaneHeader mobile divider title={headerTitle} leading={(
            <IconButton size="lg" data-testid="topic-split-back" aria-label={t('common.back')} title={t('common.back')} onClick={onClose}><ChevronLeft /></IconButton>
          )} />
        ) : (
        <div style={TOPIC_SPLIT_HEADER_STYLE}>
          {headerTitle}
          <div style={TOPIC_SPLIT_HEADER_ACTIONS_STYLE}>
            {embedded ? null : (
              <IconButton
                size="sm"
                data-testid="topic-split-close"
                aria-label={t('topic.pane.collapseSplit')}
                // 「收起分栏」是界面动作、不是话题状态 ⇒ title 里点明「话题不会关闭」。
                title={t('topic.pane.collapseSplitHint')}
                onClick={onClose}
              >
                <X size={16} />
              </IconButton>
            )}
          </div>
        </div>
        )}

        <div
          data-testid="topic-split-messages"
          style={TOPIC_SPLIT_MESSAGES_STYLE}
        >
          {loading && messages.length === 0 && <MessageListSkeleton />}
          {history.messagesError && !(loading && messages.length === 0) && <MessageLoadFailure error={history.messagesError}
            inline={messages.length > 0} onRetry={() => history.refreshMessages()} />}
          {!loading && !history.messagesError && rows.length === 0 && <div data-testid="topic-split-empty" style={TOPIC_SPLIT_EMPTY_STYLE}>
            {t('topic.pane.empty')}
          </div>}
          {rows.length > 0 && (
            // @@@5856 用主线那一份消息列表,❌ 不再自己 map + 手写贴底。
            // owner 2026-09-19 实测:「发的新消息和收到的新消息,消息列表居然不会滚动」——
            // 自己撸的那份滚不动不是少写了一行 scrollTop,是主线列表的贴底与
            // totalListHeightChanged 那一套(markdown 异步撑高之后再钳底)根本不在。
            <MessageList
              resetKey={chatResetKey}
              scrollerRef={setScrollerRef}
              rows={rows}
              rowProps={rowProps}
              listRef={listRef}
              initialTopMostItemIndex={openLocation()}
              followTail={!unreadNavigationPending && !messageWindow.hasNewer && messageWindow.change !== 'newer'}
              unreadAbove={history.unreadEntry ? { messageId: history.unreadEntry.locator.message_id, messageSeq: history.unreadEntry.locator.message_seq,
                label: t('chatArea.unreadAbove', { count: history.unreadEntry.locator.unread_count }), onSeen: history.unreadEntry.onSeen, onJump: () => void history.jumpToUnreadEntry(scrollerRef.current).catch(onHistoryError) } : null}
              onAtBottomChange={onAtBottomChange}
              onTotalListHeightChanged={onTotalListHeightChanged}
              style={MESSAGE_LIST_STYLE}
              surface="aside"
            />
          )}
        </div>
        <ChatTailNotice window={messageWindow} hidden={false} onClick={pinToBottom} />

        {/* @@@5856 用主线那一份 ChatMessageComposer,❌ 不再自造一个轻量输入框。
            自造的那份缺发送键、缺 @ 候选弹窗、缺草稿与附件 —— 这些原件早就解决过,
            重写一份等于把它们统统退回未解决态,而且不报任何错(owner 2026-09-19 实测点破)。
            话题是一间屋子 ⇒ isGroupChat,寻址规则与群一致。 */}
        {/* 话题里运行条那一行同样是固定高的一行;只在传了 runningTokens 时才有(手机整页话题),桌面分栏旁边群里那一条一直看得见。 */}
        <ChatBottomDock reserve={messages.length === 0} above={runningTokens &&
        <RunningBarSlot>
        {runningTokens.length > 0 ? (
          <RunningTokenBar
            testId="topic-agent-running-status"
            previewChatId={runningPreviewChatId}
            tokens={runningTokens}
            onTokenClick={(id) => {
              const token = runningTokens.find((candidate) => candidate.id === id)
              if (token) setMentionToInsert({ id: token.id, name: token.name })
            }}
          />
        ) : null}
        </RunningBarSlot>
        }>
        <div data-topic-split-composer="" style={mobile ? TOPIC_SPLIT_COMPOSER_MOBILE_STYLE : TOPIC_SPLIT_COMPOSER_STYLE}>
        <ChatMessageComposer
          mentionToInsert={mentionToInsert}
          onMentionInserted={() => setMentionToInsert(null)}
          onSend={async (content, opts) => {
            await onSend(content, opts?.toUserIds ?? null, opts?.replyToMessageId ?? null, opts?.isWhisper)
          }}
          onSendAttachments={async (files, opts) => {
            await onSendAttachments(files, opts)
          }}
          placeholder={t('topic.pane.composerPlaceholder')}
          quoteContent={activeQuote}
          onQuoteConsumed={() => setQuoted(null)}
          chatId={topic.chatId} hidden={visible === false}
          isGroupChat
          groupMembers={rankedMentionMembers} messages={messages} participantIds={participantIds}
          currentUserId={currentUserId}
          agentStatuses={agentStatuses}
          surface="aside"
          // ❌ 故意不接的几个,逐条说清楚为什么这一栏不需要(❌ 不是“忘了”):
          //   · beforeSend / disabled / disabledReason —— agent 私聊专用(会话页会话恢复前置与禁用态),
          //     话题是场所型会话,这三个在主线也只在 isAgentChat 时才有值。
          //   · whisperTarget / onExitWhisper —— 成员卡片的主动入口在主线;
          //     回复的私密性与显式退出由共用 composer 自己处理。
        />
        </div>
        </ChatBottomDock>
        {readReceiptPanel ? (
          <ReadReceiptPopover
            {...readReceiptPanel}
            testId="message-read-receipt-panel"
            onClose={onCloseReadReceipt}
          />
        ) : null}
      </div>
    </motion.div>
  )
  if (mobile || embedded) return page
  return (
    <>
    {/* @@@5856 宽度归 ResizablePane —— owner 拿掉了「全宽打开」那颗键之后,
        「想看大一点」这件事只剩这条分割线,所以它必须真能拖(拖拽那一套复用会话列表那一份,
        见 ResizablePane 的注释:边界情形全在那儿踩过了)。 */}
    <ResizablePane
      edge="left"
      hidden={false}
      mobile={false}
      width={width}
      minWidth={TOPIC_SPLIT_MIN_WIDTH}
      initialMaxWidth={TOPIC_SPLIT_MAX_WIDTH}
      clampWidth={clampTopicSplitWidth}
      maxWidthForAvailable={maxTopicSplitWidthForAvailableWidth}
      onWidthChange={setWidth}
      onWidthCommit={commitWidth}
      resizeLabel={t('topic.pane.resize')}
      paneTestId="topic-split-resizable"
      handleTestId="topic-split-resize-handle"
    >
      {page}
    </ResizablePane>
    </>
  )
}

/**
 * 页签里那一枚的顶上:它从哪一条开出来(原型 v7.12 TopicPane)。任务的话题开在任务卡上,就写任务那句话;
 * 来源还没读到 / 读不到 = 不画;来源被删了要说出来(同 TopicBreadcrumb 的四种值)。
 */
function TopicTabSource({ preview }: { preview: string | null | 'pending' | 'unreadable' }) {
  const { t } = useTranslation('messaging')
  if (preview === 'pending' || preview === 'unreadable') return null
  const text = preview === null ? t('topic.breadcrumb.sourceDeleted') : composerCardPreview(preview)?.text ?? preview
  return <div className="gg-topic-tab-src" data-testid="topic-tab-source" data-gone={preview === null || undefined}>{text}</div>
}
