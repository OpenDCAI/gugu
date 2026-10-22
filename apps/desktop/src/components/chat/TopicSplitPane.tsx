import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { useTranslation } from 'react-i18next'
import { DUR_SLOW_MS, EASE_SPRING, tween } from '@/styles/motion'
import { ChevronLeft, LayoutGrid, Paperclip, Users, X } from '@/lib/icons'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { GroupRosterCandidate } from '@/lib/mention'
import type { AgentStatusById } from './agentMentionStatusModels'
import type { MemberProfileCardModel } from '../MemberProfileCard'
import type { ParsedAttachment } from '@gugu/core/shared/ui/attachmentModels'
import type { MemberProfileSide } from '../memberProfileModels'
import { IconButton } from '../ui/IconButton'
import { MenuItem } from '../ui/Menu'
import { PaneHeader } from '../ui/Pane'
import { useTopicWorkspace } from '../appSlot/useTopicWorkspace'
import { useBackLayer } from '../ui/sheetStack'
import { InputArea } from './InputArea'
import { RunningTokenBar, type RunningToken } from '../RunningTokenBar'
import { GROUP_AGENT_BAR_MAX } from '@/lib/groupRunningTokenModels'
import { TopicBreadcrumb } from './TopicBreadcrumb'
import { TopicMoreMenu } from './TopicMoreMenu'
import { HistoryPanel, type HistoryFileItem } from '../HistoryPanel'
import { chatService } from '@/lib/chat'
import { rendererLogger } from '@/lib/log'
import { MemberListPanel } from './MemberListPanel'
import { RightPanel, RightPanelBackButton } from './RightPanel'
import { MessageList, type ChatListRowItem, type MessageListRowProps } from './MessageList'
import { useToast } from '../toastContext'
import { askReveal, useSourceMessageReveal } from '@/hooks/useSourceMessageReveal'
import type { FlowListHandle, ListLanding } from '@/lib/flowList'
import { APP_SHOW_MESSAGE_EVENT, type AppShowMessageDetail } from '@/session/shared/extensions/app-runtime-protocol'
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
  topic: { chatId: string; name: string }
  messages: MessageItem[]
  loading: boolean
  memberProfiles: Record<string, MemberProfileCardModel>
  /**
   * @@@5856 话题的成员名册也只能从这里进。owner 拿掉了「从会话列表全宽打开话题」那条路之后,
   * 原来挂在头栏 👥 上的那份面板对话题**一个入口都不剩** —— 改名、成员档位、agent 数量线
   * 全都点不到了。所以这一栏自带一颗 👥,按下去这栏换成名册。
   */
  visibleChats: readonly { id: string; name: string; member_user_ids?: string[] }[]
  /**
   * 这条话题引自哪一句。四种值分开(见 TopicBreadcrumb):'pending' 还没读到 / 'unreadable' 读到了
   * 但这个人看不到 / null 来源消息确实被删了 / 有字 = 预览。从会话列表点进来的人,
   * 光看话题名说不出它从哪条消息长出来的 —— 这是「双向连接」上行的那一半。
   */
  sourceMessagePreview: string | null | 'pending' | 'unreadable'
  /** 话题里的附件点开/下载 —— 与主线共用同一对处理器,❌ 不在这里另写一份预览/下载。 */
  onOpenFile: (file: HistoryFileItem) => void
  onDownloadFile: (file: HistoryFileItem) => void
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
  onSend: (text: string, toUserIds: readonly string[] | null, replyToMessageId: string | null) => Promise<void>
  /** 发附件。回形针在 InputArea 里是无条件画的,不接这一口 = 挂得上发不出去。 */
  onSendAttachments: (files: File[], opts?: { toUserIds?: string[] | null; caption?: string; onSent?: (file: File, index: number) => void }) => Promise<void>
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
  /**
   * 往上翻一页。不接它 = 分栏永远只有最新一页,滚到顶是一堵墙且不报错 ——
   * owner 报的「消息列表不会滚动」里的另一半。
   */
  onRevealOlder: () => void
  onClose: () => void
  /** 发言人的 id —— InputArea 的 @ 候选与自指要用它。 */
  currentUserId: string | null
  /** 移动壳:整页盖住来源线、出口是左上返回,且不抢焦点(不弹软键盘)。 */
  mobile?: boolean
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
  background: 'var(--bg-primary)',
  borderLeft: '1px solid var(--border-subtle)',
}
// 手机上放不下两栏 ⇒ 整页盖住来源线(同 ChatSettingsPanel 的手机页)。来源线在下面不被挤窄,返回后停在原处。
const TOPIC_PAGE_MOBILE_STYLE: React.CSSProperties = { position: 'fixed', inset: 'env(safe-area-inset-top) 0 0 0', zIndex: 'var(--z-modal)', background: 'var(--bg-primary)' }
const TOPIC_PAGE_PANE_MOBILE_STYLE: React.CSSProperties = { ...TOPIC_SPLIT_PANE_STYLE, borderLeft: 'none' }
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
const topicSplitLog = rendererLogger('chat/topic-split')
const TOPIC_SPLIT_MEMBERS_STYLE: React.CSSProperties = { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }
const TOPIC_SPLIT_MEMBERS_HEAD_STYLE: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
  padding: '12px 14px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0,
}
const TOPIC_SPLIT_HEADER_SPACER_STYLE: React.CSSProperties = { flex: '1 1 auto' }
const TOPIC_SPLIT_MESSAGES_STYLE: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  padding: '14px 12px',
}
// @@@5856 输入框的外边距与主线那一份对齐(ChatAreaPanel 的 `12px 22px 18px`)。
// **垂直方向必须一模一样**:主线那份上 12 下 18,而这一栏原先什么都没有 ⇒ 输入框直接贴着窗底,
// 同屏并排看就是两个高度(owner 2026-09-19 实测:「这个高度怎么不一致」)。
// 水平方向用 14 与这一栏自己的头对齐 —— 它比主栏窄,照抄 22 会把输入框挤细。
const TOPIC_SPLIT_COMPOSER_STYLE: React.CSSProperties = {
  background: 'var(--bg-primary)', padding: '12px 14px 18px', flexShrink: 0,
}
const TOPIC_SPLIT_COMPOSER_MOBILE_STYLE: React.CSSProperties = {
  background: 'var(--bg-primary)', padding: '8px 10px max(10px, env(safe-area-inset-bottom))', flexShrink: 0,
}
const TOPIC_SPLIT_LOADING_STYLE: React.CSSProperties = { textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-body)', padding: '24px 0' }
const TOPIC_SPLIT_EMPTY_STYLE: React.CSSProperties = { textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 'var(--font-body)', padding: '24px 0' }

export function TopicSplitPane({
  topic,
  messages,
  loading,
  memberProfiles,
  visibleChats,
  sourceMessagePreview,
  onOpenFile,
  onDownloadFile,
  focusComposerToken,
  memberReadSeqs,
  onSend,
  onSendAttachments,
  mentionMembers,
  agentStatuses,
  runningTokens,
  runningPreviewChatId = null,
  onRevealOlder,
  onClose,
  currentUserId,
  mobile = false,
  onOpenMemberProfile,
  onOpenAttachment,
  onReaction,
  onForward, visible,
  onDelete,
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
  const [quoted, setQuoted] = useState<{ forChatId: string; messageId: string; senderName: string; content: string } | null>(null)
  const activeQuote = quoted?.forChatId === topic.chatId ? quoted : null
  // @@@5856 话题的附件列表。全宽形态拿掉之后头栏那颗 🕐 只对来源线生效 ⇒ 话题自己的附件
  // 一个入口都不剩。这一栏自带一颗 🕐,与 👥 同一个槽位(互斥),开的是同一份 HistoryPanel 的话题支。
  const [filesForChatId, setFilesForChatId] = useState<string | null>(null)
  const filesOpen = filesForChatId === topic.chatId
  const [files, setFiles] = useState<HistoryFileItem[]>([])
  const [filesLoading, setFilesLoading] = useState(false)
  useEffect(() => {
    if (!filesOpen || !currentUserId) return
    let cancelled = false
    setFilesLoading(true)
    void chatService.getChatFiles(topic.chatId, currentUserId)
      .then((rows) => { if (!cancelled) setFiles(rows) })
      .catch((error: unknown) => {
        // 读不到就是空列表 + 一条日志。❌ 不把内部失败描述摆到界面上(用户拿它做不了任何事)。
        topicSplitLog.error({ error, chatId: topic.chatId }, 'topic files load failed')
        if (!cancelled) setFiles([])
      })
      .finally(() => { if (!cancelled) setFilesLoading(false) })
    return () => { cancelled = true }
  }, [filesOpen, topic.chatId, currentUserId])
  // 名册开着时换的是**这一栏的内容**,不是右边再开一栏 —— 分栏最宽 720,再挤一栏进去谁都读不了。
  // 换话题就收回去:名册是「关于哪条话题」的读数,跟着主体走(同 activeQuote 的 subject-scope)。
  const [membersForChatId, setMembersForChatId] = useState<string | null>(null)
  const workspace = useTopicWorkspace(topic.chatId, mobile, () => { setFilesForChatId(null); setMembersForChatId(null) }, { visible, onForward }) // 摩擦单 F23
  const closeWorkspace = workspace.close
  const membersOpen = membersForChatId === topic.chatId
  const setMembersOpen = useCallback(
    (next: boolean | ((open: boolean) => boolean)) => {
      setMembersForChatId((current) => {
        const open = typeof next === 'function' ? next(current === topic.chatId) : next
        if (open) { setFilesForChatId(null); closeWorkspace() }
        return open ? topic.chatId : null
      })
    },
    [topic.chatId, closeWorkspace],
  )
  const toggleFiles = useCallback(() => {
    setFilesForChatId((current) => {
      if (current === topic.chatId) return null
      setMembersForChatId(null); closeWorkspace()
      return topic.chatId
    })
  }, [topic.chatId, closeWorkspace])

  // @@@5856 「自己贴底」那一整段已删 —— 滚动归 MessageList(lib/flowList.ts 的贴底 +
  // totalListHeightChanged)。手写的那份在 markdown/代码块异步撑高之后就钳不住,症状是新消息不滚。

  // 列表要的两样:行数据,和每一行怎么画。分栏没有分页、没有多选,所以那几项是定值;
  // 已读环有 —— 水位由 useTopicLine 按**这条话题**自己拉,拉不到时是空表(空表就不出环)。
  const rows = useMemo<ChatListRowItem[]>(
    () => messages.map((message) => ({ type: 'message' as const, message })),
    [messages],
  )
  // gugu.showMessage of a message in this topic (R A/B 10-06: the topic's App asked, nothing moved): this list goes to
  // it and flashes it, as a group's does. The topic's App panel covers the list, so a reveal for this topic closes the
  // panel; the list comes back landed on that line (a list that mounts lands once, after any scroll asked before it) and
  // the hook takes the reveal.
  const listRef = useRef<FlowListHandle | null>(null)
  const isAtBottomRef = useRef(true)
  const [followingTail, setFollowingTail] = useState(true)
  const [flashMessageId, setFlashMessageId] = useState<string | null>(null)
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { toast } = useToast()
  const workspaceOpen = workspace.open
  const [revealLanding, setRevealLanding] = useState<ListLanding | null>(null)
  useEffect(() => { if (revealLanding) setRevealLanding(null) }, [revealLanding]) // read once, by the list that mounted
  useEffect(() => {
    const onShow = (event: Event) => {
      const detail = (event as CustomEvent<AppShowMessageDetail>).detail
      if (!workspaceOpen || detail?.chatId !== topic.chatId) return
      const index = rows.findIndex((row) => row.message.id === detail.messageId)
      if (index >= 0) setRevealLanding({ index, align: 'start', offset: -96 })
      askReveal(topic.chatId, detail.messageId)
      closeWorkspace()
    }
    window.addEventListener(APP_SHOW_MESSAGE_EVENT, onShow)
    return () => window.removeEventListener(APP_SHOW_MESSAGE_EVENT, onShow)
  }, [workspaceOpen, closeWorkspace, topic.chatId, rows])
  useSourceMessageReveal({
    activeChatId: workspaceOpen ? null : topic.chatId,
    rows, listRef, isAtBottomRef, setFollowingTail, setFlashMessageId, flashTimerRef,
    // Older lines of a topic load as its list reaches the top; one not loaded yet is said, as the group's.
    revealMessage: () => Promise.reject(new Error('not loaded in this topic')),
    onMissing: () => toast(t('chatArea.source.notVisible'), 'error'),
  })
  const rowProps = useMemo<MessageListRowProps>(() => ({
    rows,
    messages: [...messages],
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
    onQuote: (msg) => setQuoted({
      forChatId: topic.chatId,
      messageId: msg.id,
      senderName: memberProfiles[msg.sender_user_id ?? '']?.displayName ?? '',
      content: quotePrefixOf(msg),
    }),
    onForward: onForward ?? noop,
    onDelete: onDelete ?? noop,
    onVisible: noop,
    // 单层不嵌套:❌ 不传 onOpenTopic —— 话题里的消息不给「开话题」入口
    // (spec「必须有来源」:话题上不再开话题)。MessageBubble 的菜单项只在收到这个 handler 时才画,
    // 所以「不传」本身就是那道守卫。
    selectMode: false,
    selectedIds: EMPTY_SELECTION,
    onToggleSelect: noop,
    onEnterSelectMode: noop,
    flashMessageId,
  }), [rows, messages, mobile, memberReadSeqs, memberProfiles, onOpenMemberProfile, onOpenAttachment, onShowReadReceipt, onReaction, onForward, onDelete, topic.chatId, flashMessageId])

  // 手机页只有左上返回一个出口:子视图(附件/成员)开着先退回话题,否则收起话题回来源线。
  const goBack = filesOpen ? () => setFilesForChatId(null) : membersOpen ? () => setMembersOpen(false) : workspace.open ? workspace.close : onClose
  // 手机整页:安卓返回键 = 左上返回(先退附件/成员子视图,再回群),❌ 越过群退到会话列表。
  useBackLayer(goBack, mobile)
  // 名册那条头自带「话题成员 + 改名框」,名字在那儿写着了 ⇒ 这里就不再写一遍。
  // 附件面板没有标题(它自己那条头被收掉了),所以那时这里要写。
  const headerTitle = membersOpen
    ? <span style={TOPIC_SPLIT_HEADER_SPACER_STYLE} />
    : <TopicBreadcrumb topicName={topic.name} sourceMessagePreview={sourceMessagePreview} />
  const membersToggle = (
    <IconButton
      size={mobile ? 'md' : 'sm'}
      data-testid="topic-split-members-toggle"
      on={membersOpen || undefined}
      aria-pressed={membersOpen}
      aria-label={t('topic.pane.members')}
      title={t('topic.pane.members')}
      onClick={() => setMembersOpen((open) => !open)}
    >
      <Users size={16} />
    </IconButton>
  )
  // 手机页头右边最多两颗(与群聊页 compactRoom 一致):成员 + ⋯,附件和文件夹收进 ⋯,排在 App 前面。
  const headerToggles = mobile ? (
    <>
      {membersToggle}
      <TopicMoreMenu chatId={topic.chatId} mobile items={(
        <>
          <MenuItem data-testid="topic-split-files-toggle" onClick={toggleFiles} icon={<Paperclip size={16} />}>{t('topic.pane.attachments')}</MenuItem>
          <MenuItem data-testid="topic-split-workspace-toggle" onClick={workspace.show} icon={<LayoutGrid size={16} />}>{workspace.folderName}</MenuItem>
        </>
      )} />
    </>
  ) : (
    <>
      <IconButton
        size="sm"
        data-testid="topic-split-files-toggle"
        on={filesOpen || undefined}
        aria-pressed={filesOpen}
        aria-label={t('topic.pane.attachments')}
        title={t('topic.pane.attachments')}
        onClick={toggleFiles}
      >
        <Paperclip size={16} />
      </IconButton>
      {membersToggle}
      {workspace.toggle}
      <TopicMoreMenu chatId={topic.chatId} mobile={false} />
    </>
  )
  const page = (
    // @@@2234 同 history/workspace/群 thread 面板:进场保留、**退场不保留占位**。
    // ⇒ ❌ 不要给它套 AnimatePresence / 加 exit。
    <motion.div
      key={`topic-split-${topic.chatId}`}
      initial={mobile ? { x: '100%' } : { x: 340, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={tween(DUR_SLOW_MS, EASE_SPRING)}
      style={mobile ? TOPIC_PAGE_MOBILE_STYLE : TOPIC_SPLIT_SHELL_STYLE}
    >
      <div
        ref={paneRef}
        data-testid="topic-split-pane"
        data-topic-id={topic.chatId}
        style={mobile ? TOPIC_PAGE_PANE_MOBILE_STYLE : TOPIC_SPLIT_PANE_STYLE}
      >
        {/* 这一条**常驻**:面板开着时它也在。曾经开面板就把它收起来,代价是
            ①「收起分栏」与另一颗切换键一起消失,②这一栏里再没有一个字说明你在哪条话题上
            (找茬第十轮)。嵌进来的那两个面板自带的头由 tokens.css 收掉,所以不会两条头叠着摆。 */}
        {mobile ? (
          <PaneHeader mobile divider title={headerTitle} actions={headerToggles} leading={(
            <IconButton size="lg" data-testid="topic-split-back" aria-label={t('common.back')} title={t('common.back')} onClick={goBack}><ChevronLeft /></IconButton>
          )} />
        ) : (
        <div style={TOPIC_SPLIT_HEADER_STYLE}>
          {headerTitle}
          <div style={TOPIC_SPLIT_HEADER_ACTIONS_STYLE}>
            {headerToggles}
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
          </div>
        </div>
        )}

        {filesOpen ? (
          // 这份面板自带的头嵌进来时由 .gg-topic-split-members 收掉;它不定宽,撑满这一栏。
          <div className="gg-topic-split-members" style={TOPIC_SPLIT_MEMBERS_STYLE}>
            <HistoryPanel
              mode="topic"
              mobile={mobile}
              attachments={files}
              loading={filesLoading}
              onOpenFile={onOpenFile}
              onDownloadFile={onDownloadFile}
              onClose={() => setFilesForChatId(null)}
            />
          </div>
        ) : membersOpen ? (
          // 名册的外壳归这一栏:桌面上撑满分栏、边线归分栏(width="fill");手机上 RightPanel 照旧是整页。
          <div className="gg-topic-split-members" style={TOPIC_SPLIT_MEMBERS_STYLE}>
            <RightPanel width="fill" onClose={() => setMembersOpen(false)}>
              <MemberListPanel
                key={topic.chatId}
                chatId={topic.chatId}
                chatKind="topic"
                head={(title, actions) => (
                  // 桌面上收起名册归上面那条常驻分栏头的 👥,这里不再画关闭;手机整页的出口是左上返回。
                  <div style={TOPIC_SPLIT_MEMBERS_HEAD_STYLE}>
                    {mobile ? <RightPanelBackButton onBack={() => setMembersOpen(false)} /> : null}
                    {title}
                    {actions}
                  </div>
                )}
                chatName={topic.name}
                topicInvitation={{ candidates: mentionMembers, send: onSend }}
              />
            </RightPanel>
          </div>
        ) : workspace.open ? workspace.view : (
        <>
        <div
          data-testid="topic-split-messages"
          style={TOPIC_SPLIT_MESSAGES_STYLE}
        >
          {loading && messages.length === 0 ? (
            <div style={TOPIC_SPLIT_LOADING_STYLE}>
              {t('common.loading')}
            </div>
          ) : messages.length === 0 ? (
            <div
              data-testid="topic-split-empty"
              style={TOPIC_SPLIT_EMPTY_STYLE}
            >
              {t('topic.pane.empty')}
            </div>
          ) : (
            // @@@5856 用主线那一份消息列表,❌ 不再自己 map + 手写贴底。
            // owner 2026-09-19 实测:「发的新消息和收到的新消息,消息列表居然不会滚动」——
            // 自己撸的那份滚不动不是少写了一行 scrollTop,是主线列表的贴底与
            // totalListHeightChanged 那一套(markdown 异步撑高之后再钳底)根本不在。
            <MessageList
              resetKey={topic.chatId}
              rows={rows}
              rowProps={rowProps}
              listRef={listRef}
              initialTopMostItemIndex={revealLanding ?? undefined}
              followTail={followingTail}
              onAtBottomChange={(atBottom) => { isAtBottomRef.current = atBottom; if (atBottom) setFollowingTail(true) }}
              style={MESSAGE_LIST_STYLE}
              surface="aside"
              onStartReached={onRevealOlder}
            />
          )}
        </div>

        {/* @@@5856 用主线那一份 InputArea,❌ 不再自造一个轻量输入框。
            自造的那份缺发送键、缺 @ 候选弹窗、缺草稿与附件 —— 这些原件早就解决过,
            重写一份等于把它们统统退回未解决态,而且不报任何错(owner 2026-09-19 实测点破)。
            话题是一间屋子 ⇒ isGroupChat,寻址规则与群一致。 */}
        {runningTokens && runningTokens.length > 0 ? (
          <RunningTokenBar
            testId="topic-agent-running-status"
            cap={GROUP_AGENT_BAR_MAX}
            previewChatId={runningPreviewChatId}
            tokens={runningTokens}
            onTokenClick={(id) => {
              const token = runningTokens.find((candidate) => candidate.id === id)
              if (token) setMentionToInsert({ id: token.id, name: token.name })
            }}
          />
        ) : null}
        <div data-topic-split-composer="" style={mobile ? TOPIC_SPLIT_COMPOSER_MOBILE_STYLE : TOPIC_SPLIT_COMPOSER_STYLE}>
        <InputArea
          mentionToInsert={mentionToInsert}
          onMentionInserted={() => setMentionToInsert(null)}
          onSend={async (content, opts) => {
            await onSend(content, opts?.toUserIds ?? null, opts?.replyToMessageId ?? null)
          }}
          onSendAttachments={async (files, opts) => {
            await onSendAttachments(files, { toUserIds: opts?.toUserIds ?? null, caption: opts?.caption, onSent: opts?.onSent })
          }}
          placeholder={t('topic.pane.composerPlaceholder')}
          quoteContent={activeQuote}
          onQuoteConsumed={() => setQuoted(null)}
          chatId={topic.chatId} hidden={visible === false}
          isGroupChat
          groupMembers={rankedMentionMembers}
          currentUserId={currentUserId}
          agentStatuses={agentStatuses}
          surface="aside"
          // ❌ 故意不接的几个,逐条说清楚为什么这一栏不需要(❌ 不是“忘了”):
          //   · beforeSend / disabled / disabledReason —— agent 私聊专用(会话页会话恢复前置与禁用态),
          //     话题是场所型会话,这三个在主线也只在 isAgentChat 时才有值。
          //   · whisperTarget / onExitWhisper —— 悋悋话的入口在成员卡片上;话题里能不能悋悋话
          //     spec 没说,❌ 不在这里自己拍板。
        />
        </div>
        </>
        )}
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
  if (mobile) return page
  return (
    // @@@5856 宽度归 ResizablePane —— owner 拿掉了「全宽打开」那颗键之后,
    // 「想看大一点」这件事只剩这条分割线,所以它必须真能拖(拖拽那一套复用会话列表那一份,
    // 见 ResizablePane 的注释:边界情形全在那儿踩过了)。
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
  )
}
