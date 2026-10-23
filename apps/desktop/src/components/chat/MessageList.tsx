import { memo, useCallback, useEffect, useMemo, useRef } from 'react'
import type { CSSProperties, MouseEvent, ReactNode, Ref } from 'react'
import type { MessageItem, MessageSendState, TopicSummary } from '@gugu/core/shared/types/chat'
import type { ParsedAttachment } from '@gugu/core/shared/ui/attachmentModels'
import { computeGroupedWithPrev } from '@gugu/core/shared/ui/messageListModels'
import { deriveMessageSendState, deriveReadReceipt } from '@gugu/core/shared/ui/messageState'
import { AUTOMATION_TEST_IDS } from '@/lib/automationDom'
import { OPEN_AT_LATEST, useRowAboveViewport } from '@/lib/listLanding'
import { useFlowList, type FlowListHandle, type ListLanding } from '@/lib/flowList'
import { formatCalendarDayTime } from '@/lib/calendarTime'
import type { MemberProfileCardModel } from '../MemberProfileCard'
import type { MemberProfileSide } from '../memberProfileModels'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { MessageRow } from './MessageRow'
import { MessageBubble } from './MessageBubble'
import { AgentFloodSystemNotice } from './AgentFloodSystemNotice'
import { MemberJoinNotice, type MentionTarget } from '../groups/MemberJoinNotice'
import { parseSystemNotice } from '@gugu/core/shared/ui/systemNotice'
import { TopicAnchorCard } from './TopicAnchorCard'
import { shouldShowTimeDivider } from './messageRowTime'
import { TaskExchangeBubble } from '../assistant/TaskExchangeBubble'

// #1163 perf — 在父层为单条消息预算「发送/已读态」(primitive 字符串)，下传给 memo 化的 MessageBubble，
// 取代旧的「整个 memberReadSeqs map 下传、气泡自己 derive」。任一成员已读回执会换 map 引用、破气泡浅比较
// memo → 全群可视气泡重渲；改传 primitive 后，只有本消息状态真翻转时气泡才重渲。仅 is_mine 非撤回消息需要。
function computeSendState(msg: MessageItem, memberReadSeqs: Record<string, number>): MessageSendState | undefined {
  if (!msg.is_mine || msg.retracted_at) return undefined
  return deriveMessageSendState(msg, memberReadSeqs, {
    // @@@per-message-read (#598) - precise directed read receipts, decoupled from the watermark.
    // memberIds = current OTHER members (so a recipient who left drops out of the denominator).
    memberIds: Object.keys(memberReadSeqs),
    messageReaders: msg.readers && msg.readers.length ? { [msg.id]: new Set(msg.readers) } : {},
  })
}

// @@@1313 逐成员读回执（水位派生）：父层预算「已读 N · 未读 M」/ 私聊「已读」「未读」primitive 字符串
// 下传气泡（同 computeSendState 的 memo 策略——别传整个 memberReadSeqs map）。仅本人已发(非撤回/非发送中)。
// @@@1345 已读回执进度圆环：父层预算「已读数 / 收件总数」两个 primitive 下传(memo 安全)，气泡渲染环；
// 标签(已读/未读 文案)与环填充都由 read/total 在气泡侧派生(total===1 私聊 / total>1 群聊)。
function computeReadReceipt(
  msg: MessageItem,
  memberReadSeqs: Record<string, number>,
): { read: number; total: number } | undefined {
  if (!msg.is_mine || msg.retracted_at || msg.seq < 0 || msg.local_send_state === 'sending' || msg.local_send_state === 'failed') {
    return undefined
  }
  const receipt = deriveReadReceipt(msg, memberReadSeqs, {
    messageReaders: msg.readers && msg.readers.length ? { [msg.id]: new Set(msg.readers) } : {},
  })
  if (receipt.totalRecipients === 0) return undefined // 无其他收件方（自言自语/空群）→ 不显
  return { read: receipt.readCount, total: receipt.totalRecipients }
}

// @@@multi-select (#988) — 多选行首勾选框，沿用 ForwardMessageDialog 的圆形勾选样式（--accent / --accent-tint-row）。


/**
 * 主时间线的消息列表。@@@5856 从 ChatAreaPanel 里**抽出来**的,不是新写的一份:
 * 话题分栏原先自己撸了一个 map + 手写贴底,owner 2026-09-19 实测的原话是
 * 「发的新消息和收到的新消息,消息列表居然不会滚动,我怀疑消息列表你也是自己 vibe 没有复用.应该复用」。
 *
 * 他说对了。这个列表难的不是把消息画出来,是滚动:首屏钉底要等 markdown/代码块异步撑高、
 * 快速上滚时 atBottom 的 ref 会 stale、prepend 旧页不许把视口拽回底、Virtuoso 自己的
 * autoscroll 在某些平台还会差一截。这些 #461 / #667 / #780 / #781 / #1315 一路踩过来的东西,
 * 自己撸一个 map 全都没有 —— 症状就是「不会滚」。
 */
// ── MessageListRow ────────────────────────────────────────────────────────────
// Module-level so row rendering stays stable across ChatAreaPanel re-renders;
// unrelated header/input state changes should not remount visible message rows.

export interface MessageListRowProps {
  rows: ChatListRowItem[]
  messages: MessageItem[]
  isFiltering: boolean
  mobile: boolean
  highlight: string | undefined
  /** #1708 命中「来源消息跳转」时高亮闪烁的消息 id。 */
  flashMessageId: string | null | undefined
  memberReadSeqs: Record<string, number>
  isAgentChat: boolean
  // 私聊/AI 没有 thread surface；群聊 thread 由右侧 panel 承载。
  isGroupChat: boolean
  threeParty: boolean | undefined
  memberProfiles: Record<string, MemberProfileCardModel>
  onReaction: (messageId: string, emoji: string) => void
  // @@@1345 点击已读圆环 → 父层弹「谁已读/谁未读」名单(稳定回调，避免 reader 列表作对象 prop 破 memo)。
  onShowReadReceipt: ((messageId: string, anchor: HTMLElement) => void) | undefined
  onQuote: (msg: MessageItem) => void
  onForward: (msg: MessageItem) => void
  onDelete: (messageId: string) => void
  onVisible: (msg: MessageItem) => void
  onOpenMemberProfile: ((
    member: MemberProfileCardModel,
    anchor: HTMLElement,
    preferredSide: MemberProfileSide,
  ) => void) | undefined
  // @@@5856 开话题(从本消息长出一条线)+ 本消息底下已有的话题锚点卡。锚点是溯源不是父容器:
  // 卡片只是双向连接的一端,话题本身在会话列表里缩进挂在来源那条线底下。
  onOpenTopic: ((messageId: string) => void) | undefined
  topicAnchors: ReadonlyMap<string, TopicSummary[]> | undefined
  onOpenTopicAnchor: ((topicChatId: string) => void) | undefined
  /** 这条线上「agent 超过 5 个已自动转 passive」的那条系统消息(每条线至多一条)。 */
  agentFloodNoticeMessageId: string | null | undefined
  onAgentFloodUndone: (() => void) | undefined
  onOpenFile: ((meta: ParsedAttachment, message?: MessageItem) => void) | undefined; onOpenLocalFileLink: ((path: string) => void) | undefined
  onMentionMember: ((target: MentionTarget) => void) | undefined // @@@6386 入群灰字里点名字 → 输入框插 @
  // @@@multi-select (#988) — 多选态：行首勾选框 + 整行点击切换选中；onEnterSelectMode 透传给气泡「多选」菜单项。
  selectMode: boolean
  selectedIds: Set<string>
  onToggleSelect: (messageId: string) => void
  onEnterSelectMode: ((msg: MessageItem) => void) | undefined
}

// @@@2186 — 主时间线 rows 只有消息行。#1671 后 in-list 运行态改由 composer 上方浮动条统一显示，曾经的
// agentActivity 行渲染恒为 null——一个零高的 virtuoso 行，agent 运行期间每次行测量都对它报一条
// "react-virtuoso: Zero-sized element" console error（#2186），故该行类型随 #1671 的契约一并移除。
export type ChatListRowItem = { type: 'message'; message: MessageItem } | { type: 'task-exchange'; message: MessageItem; recipientUserId: string }

const SelectionCheckbox = ({ checked }: { checked: boolean }) => (
  <div
    aria-checked={checked}
    role="checkbox"
    style={{
      width: 18,
      height: 18,
      borderRadius: 'var(--radius-circle)',
      flexShrink: 0,
      border: checked ? '2px solid var(--accent)' : '2px solid var(--border-subtle)',
      background: checked ? 'var(--accent)' : 'var(--bg-transparent)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      transition: 'background var(--transition-fast), color var(--transition-fast)',
    }}
  >
    {checked && (
      <svg width="10" height="8" viewBox="0 0 10 8" fill="none" aria-hidden="true">
        <path d="M1 4l3 3 5-6" stroke="var(--surface-white)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )}
  </div>
)
// memo:面板因为与消息无关的状态重渲时(头栏、输入区、运行条),rowProps 不变 ⇒ 行连同气泡都不重算。
const MessageListRow = memo(function MessageListRow({
  index,
  rows,
  messages,
  isFiltering,
  mobile,
  highlight,
  flashMessageId,
  memberReadSeqs,
  isAgentChat,
  isGroupChat,
  threeParty,
  memberProfiles,
  onReaction,
  onShowReadReceipt,
  onQuote,
  onForward,
  onDelete,
  onVisible,
  onOpenMemberProfile,
  onOpenTopic, topicAnchors, onOpenTopicAnchor, agentFloodNoticeMessageId, onAgentFloodUndone,
  onOpenFile, onOpenLocalFileLink, onMentionMember,
  selectMode,
  selectedIds,
  onToggleSelect,
  onEnterSelectMode,
}: {
  index: number
} & MessageListRowProps) {
  const row = rows[index]
  const rowRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!row || row.type === 'task-exchange') return
    const msg = row.message
    const node = rowRef.current
    if (!node) return
    if (typeof IntersectionObserver === 'undefined') {
      onVisible(msg)
      return
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        onVisible(msg)
      }
    }, { threshold: 0.6 })
    observer.observe(node)
    return () => observer.disconnect()
  }, [row, onVisible])

  // @@@virtuoso-oob-guard (#461) - 行由 rows.slice 给出、不会越界;这一行只为收窄 rows[index] 的类型。
  if (!row) return null

  const msg = row.message
  const memberProfile = msg.sender_user_id === null ? null : (memberProfiles[msg.sender_user_id] ?? null) // @@@2051 null=注销,无档、非 agent
  const isAgentMessage = memberProfile?.type === 'agent'
  // #2086 owner 定:引用块对齐微信/主流 IM,所有回复(含回复正上方那条)都显示引用块。
  // 原 @@@adjacent-reply-quote(#453)对「紧邻回复」隐藏引用块的优化已按 owner 意愿撤销。
  const prevRow = index > 0 ? rows[index - 1] : undefined

  const isSelected = selectedIds.has(msg.id)
  const readReceipt = computeReadReceipt(msg, memberReadSeqs) // @@@1577 M5 A6 — 单次派生,原同行同参调两次
  const sendState = computeSendState(msg, memberReadSeqs)

  // 连续消息合组：同一发送者、无时间分隔线切断、双方都是普通消息时，后续消息隐藏头像+名字/时间行，
  // 只留气泡（间距也收紧）。搜索态(isFiltering)结果不连续，不合组。whisper 形态特殊，不参与合组。
  const showTimeDivider = !isFiltering && shouldShowTimeDivider(messages, index)
  const prevMsg = prevRow?.type === 'message' ? prevRow.message : null
  const groupedWithPrev = computeGroupedWithPrev({ isFiltering, showTimeDivider, prevMsg, msg, prevIsThreadRoot: false })
  const anchoredTopics = topicAnchors?.get(msg.id)
  // @@@5856 自动调档那条系统消息用专门的版式渲染:居中、说清改了哪几个、就地一键全撤。
  const isAgentFloodNotice = msg.id === agentFloodNoticeMessageId && msg.content_type === 'system'
  const notice = parseSystemNotice(msg) // @@@6386 服务端落的「X 加入了群聊」;回合失败那种由气泡里的 SystemMessageNotice 画
  // 右键群聊里的发送者头像 → 输入框 @ 他:与点运行中头像同一条插入链路;能 @ 谁同入群灰字(在群、不是自己)。
  const mentionFromAvatar = (event: MouseEvent<HTMLDivElement>) => {
    if (!isGroupChat || !onMentionMember || !memberProfile || msg.is_mine || memberProfile.membership === 'former') return
    if (!(event.target as Element).closest('[data-message-sender-id]')) return
    event.preventDefault()
    onMentionMember({ id: memberProfile.id, name: memberProfile.displayName })
  }
  const bubble = (
    <MessageBubble
      msg={msg}
      onReaction={onReaction}
      sendState={isAgentChat && sendState === 'read' ? 'sent' : sendState}
      readReceiptRead={readReceipt?.read}
      readReceiptTotal={readReceipt?.total}
      // #2098 owner 定:已读回执逐条显示(每条本人消息都挂环),非只末条。气泡内已按 is_mine + read>0 门控。
      showReadReceipt={msg.is_mine && !isAgentChat}
      groupedWithPrev={groupedWithPrev}
      // 这条消息上方刚渲染了时间分隔 pill → 气泡的名字/时间行不再把同一个时间重说一遍(截图里
      // 「03:10」上下各出现一次)。时间节点仍在 DOM 里(视觉隐藏),移动端无 hover、读屏与 e2e 照样取得到。
      // 手机上时间只由分隔 pill 说(间隔 ≥5 分钟才出一条,微信同款):窄屏上每换一个发送者就再印一遍
      // 「14:52」,同一分钟里的一串对话被切成一截一截的(手机端走查实拍)。桌面有宽度,照旧在组首写时间。
      hideTime={showTimeDivider || mobile}
      onShowReadReceipt={onShowReadReceipt}
      highlight={highlight}
      onQuote={onQuote}
      onForward={onForward}
      onDelete={onDelete}
      isAgent={isAgentMessage}
      isGroup={isGroupChat || threeParty}
      // 与 agent 的单聊:小鸟统一在头栏正中(AgentChatHero),这里不再每条各挂一个
      hideAvatar={isAgentChat}
      memberProfile={memberProfile}
      onOpenMemberProfile={onOpenMemberProfile}
      compactMobile={mobile}
      // 直接透传稳定 handler；话题里不传则不显示「开话题」菜单项(单层不嵌套)。
      onOpenTopic={onOpenTopic} onOpenFile={onOpenFile} onOpenLocalFileLink={onOpenLocalFileLink}
      memberProfiles={memberProfiles}
      // @@@multi-select (#988) — More 菜单「多选」入口;多选态的勾选/底色在外层 MessageListRow 处理。
      onEnterSelectMode={onEnterSelectMode}
    />
  )

  return (
    <MessageRow rowRef={rowRef} index={index} count={rows.length} messageId={msg.id} className={msg.id === flashMessageId ? 'msg-src-flash' : undefined} style={{ paddingBottom: 'var(--spacing-xs)' }} onContextMenu={mentionFromAvatar}>
      {showTimeDivider && (
        /* @@@ui-ruler 时间分隔 = Chip(小标签的唯一实现:18px 药丸、caption 字号、muted 底)。
           原来是这里自己拍的 10px 圆角 + 2/10 内距 + 裸 11px。 */
        <div style={{ textAlign: 'center', margin: 'var(--spacing-sm) 0 var(--spacing-xs)', userSelect: 'none' }}>
          <Chip>{formatCalendarDayTime(msg.created_at)}</Chip>
        </div>
      )}
      {/* @@@multi-select (#988) — 多选态：行首勾选框 + 整行点击切换选中；内层气泡 pointer-events:none
          全面禁交互（连带隐藏悬浮操作条/菜单/长按）。非多选态原样渲染。 */}
      {row.type === 'task-exchange' ? <TaskExchangeBubble message={msg} recipientUserId={row.recipientUserId} mobile={mobile} /> : selectMode ? (
        <div
          data-message-select-row={msg.id}
          onClick={() => onToggleSelect(msg.id)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '0 14px',
            cursor: 'pointer',
            background: isSelected ? 'var(--accent-tint-row)' : undefined,
          }}
        >
          <SelectionCheckbox checked={isSelected} />
          <div style={{ flex: 1, minWidth: 0, pointerEvents: 'none' }}>{bubble}</div>
        </div>
      ) : isAgentFloodNotice ? (
        <AgentFloodSystemNotice messageId={msg.id} content={msg.content ?? ''} onUndone={onAgentFloodUndone} />
      ) : notice?.kind === 'member-joined' ? (
        <MemberJoinNotice userIds={notice.userIds} content={msg.content ?? ''} memberProfiles={memberProfiles} onMention={onMentionMember} />
      ) : bubble}
      {/* @@@5856 锚点:这条消息长出来的话题挂在它底下(它是这条消息的附件,所以跟气泡同侧同缩进),
          双向连接的另一端是分栏标题块里那句「引自…」。正文要传进去:话题名默认就是从这条正文截的,
          没改过名时锚点不再把它念第二遍(owner:「你不感觉这个像是个文字重复吗」)。 */}
      {anchoredTopics && onOpenTopicAnchor && (
        <TopicAnchorCard topics={anchoredTopics} isMine={!!msg.is_mine} sourceContent={msg.content} onOpen={onOpenTopicAnchor} memberProfiles={memberProfiles} />
      )}
    </MessageRow>
  )
})
// 分页的起点下标(prepend 时往下减);列表本身已按文档流排,这个数只剩窗口记账用。
export const VIRTUOSO_START_INDEX = 100000
// @@@5856 两份表面各报各的:未读定位(useUnreadLocatorNavigation)用 querySelector 取**文档序第一个**主表面,副栏另报 aside。
const SCROLLER_TEST_ID = { main: AUTOMATION_TEST_IDS.chatMessageList, aside: AUTOMATION_TEST_IDS.chatMessageListAside } as const
const LIST_FRAME_STYLE: CSSProperties = { position: 'relative', display: 'flex', flexDirection: 'column' }
// 原生滚动锚定(overflow-anchor 缺省 auto):视口上方的行变高时浏览器在同一次排版里改位置,见 lib/flowList.ts。
const LIST_SCROLLER_STYLE: CSSProperties = { flex: 1, minHeight: 0, position: 'relative', overflowX: 'hidden', overflowY: 'auto', outline: 'none' }
// 与底部「N 条新消息 ↓」同一身份(强调色药丸 + 浮层阴影),位置照微信放右上角。
const UNREAD_ABOVE_STYLE: CSSProperties = { position: 'absolute', top: 'var(--spacing-md)', right: 'var(--spacing-md)', zIndex: 'var(--z-float)', borderRadius: 'var(--radius-xl)', fontSize: 'var(--font-caption)', boxShadow: 'var(--shadow-lift)' }
/**
 * 列表本体:整个消息窗口按文档流排(store 已把窗口限在 MAX_WINDOW 行内),滚动机制在 lib/flowList.ts。
 * 分页 / 未读定位这些只有主线才有的东西从外面传。
 *
 * ⚠️ @@@5856 但「滚动」不在这一类里 —— 它是消息列表的**缺省义务**,不是主线的特权:
 * 不传落点 = 停在最新一条;在底部时内容一变就贴底(新消息、markdown 异步撑高)。分栏用的就是这份缺省。
 */
export function MessageList({
  rows,
  rowProps,
  resetKey,
  listRef,
  scrollerRef,
  initialTopMostItemIndex = OPEN_AT_LATEST,
  onAtBottomChange,
  followTail = true,
  onStartReached,
  onTotalListHeightChanged,
  style,
  topInset = 0,
  surface = 'main',
  unreadAbove,
  footer,
}: {
  rows: ChatListRowItem[]
  rowProps: MessageListRowProps
  resetKey?: string | number
  listRef?: Ref<FlowListHandle>
  scrollerRef?: (element: HTMLElement | Window | null) => void
  initialTopMostItemIndex?: ListLanding | null // null = 落点还没定(恢复位置的锚点还在载入):先藏着,别露出最新处(#6595)
  onAtBottomChange?: (atBottom: boolean) => void
  followTail?: boolean
  onStartReached?: () => void
  onTotalListHeightChanged?: () => void
  style?: CSSProperties
  /** 顶部让出多少 px:头栏上的悬浮小鸟探出头栏时,滚到最上面的第一条 / 日期分隔落在它脚下面,不被盖住(agent 单聊的桌面形态传)。 */
  topInset?: number
  /** 这条消息流在哪一栏。副栏不当未读定位器的 main 表面(见 SCROLLER_TEST_ID)。 */
  surface?: 'main' | 'aside'
  /** @@@6530 这次打开时的第一条未读:在视口上方时右上角出「↑ N 条新消息」,点了跳过去。 */
  unreadAbove?: { messageId: string; messageSeq: number; label: string; onJump: () => void } | null
  /** 接在最后一条后面、随消息流一起滚的那一格(助理聊天里它在处理时的打字气泡);窗口没到最新处时不画。 */
  footer?: ReactNode
}): ReactNode {
  const ownScrollerRef = useRef<HTMLElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const handleScrollerRef = useCallback((element: HTMLDivElement | null) => {
    ownScrollerRef.current = element
    scrollerRef?.(element)
  }, [scrollerRef])
  const rowIds = useMemo(() => rows.map((row) => row.message.id), [rows])
  const { start, end } = useFlowList({ scrollerRef: ownScrollerRef, contentRef, resetKey, rowIds, landing: initialTopMostItemIndex, followTail, atBottomThreshold: 80, onAtBottomChange, onTotalHeightChanged: onTotalListHeightChanged, onStartReached, handleRef: listRef })
  // 未读行不在窗口里:比窗口最早一条还早 = 在上方(-1);否则是尾部对账还没回来,先不判(null)。
  const unreadIndex = unreadAbove ? rows.findIndex((row) => row.message.id === unreadAbove.messageId) : -1
  const unreadAt = !unreadAbove ? null : unreadIndex >= 0 ? unreadIndex : rows.length > 0 && rows[0].message.seq > unreadAbove.messageSeq ? -1 : null
  const showUnreadAbove = useRowAboveViewport(ownScrollerRef, unreadAbove?.messageId, unreadAt, true)
  const scrollerStyle = useMemo<CSSProperties>(() => (topInset ? { ...LIST_SCROLLER_STYLE, paddingTop: topInset } : LIST_SCROLLER_STYLE), [topInset])
  const frameStyle = useMemo<CSSProperties>(() => ({ minHeight: 0, ...(style ?? { flex: 1 }), ...LIST_FRAME_STYLE, visibility: initialTopMostItemIndex === null ? 'hidden' : undefined }), [style, initialTopMostItemIndex])
  return (
    <div style={frameStyle}>
      {/* 每换一条线(resetKey)换一个滚动容器:落点、贴底电平、锚定都从这条线自己的第一帧开始。 */}
      <div key={resetKey} ref={handleScrollerRef} data-testid={SCROLLER_TEST_ID[surface]} data-unread-stream-surface={surface} data-image-gallery="" style={scrollerStyle}>
        <div ref={contentRef}>
          {rows.slice(start, end).map((row, i) => <MessageListRow key={row.message.id} index={start + i} {...rowProps} />)}
          {end >= rows.length ? footer : null}
        </div>
      </div>
      {unreadAbove && showUnreadAbove && <Button variant="primary" size="sm" data-unread-above="" style={UNREAD_ABOVE_STYLE} onClick={unreadAbove.onJump}>{unreadAbove.label}</Button>}
    </div>
  )
}
