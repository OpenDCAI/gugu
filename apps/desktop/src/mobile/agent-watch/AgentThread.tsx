import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AssistantRuntimeProvider,
  ExportedMessageRepository,
  MessageNotSentError,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessage,
  type ToolCallMessagePartComponent,
  useAuiState
} from '@assistant-ui/react'
import { MAX_ATTACHMENT_BYTES, TOOL_IMAGE_FETCH_LIMIT } from '@gugu/session-core/session-record/contract'
import { composePromptText } from '@renderer/features/sessions/acp/composer-file-paths'
import { formatBytes } from '@renderer/utils/formatBytes'
import { DEFAULT_GROUP_BY, Thread, type ThreadComponents } from '@/components/assistant-ui/thread.aui'
import { tallyToolRun, toolRunLabel, toolRunNow, toolRunNowLabel } from '@gugu/session-chat-ui/tool-run'
import { translateSessionMessage } from '@/session/renderer/localization/locale-store'
import { ToolGroupContent, ToolGroupRoot, ToolGroupTrigger } from '@/components/assistant-ui/tool-group.aui'
import { DeliveryMessage } from '@/components/assistant-ui/delivery-message.aui'
import { ComposerExtrasProvider } from '@/components/assistant-ui/composer-extras'
import { preloadSharedChatRuntime } from '@/components/assistant-ui/shared-transcript.aui'
import { ToolFallback } from '@/components/assistant-ui/tool-fallback.aui'
import { MediaGrid } from '@/components/media/MediaGrid'
import { toolImageUrl, type ToolCallItem, type ToolImage, type TranscriptItem, type TranscriptThinking } from '@gugu/session-core/acp/client'
import { pinnedSettlements, type AgentWatchTimeline } from './agent-watch-store'
import type { SettlementResponse, SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import type { PendingSend } from './pending-sends'
import { QuestionDataUI, SettlementCard, SettlementSlotProvider } from './TimelineView'
import { SessionOptionsPill } from './SessionOptionsPill'
import { QUESTION_DATA_PART, runningToolIds, THINKING_DATA_PART, TOOL_RUNNING, toolImagesById, toolItemsById, toThreadMessages, unsettledLastTurnId, userMessage, type ToolImageTile, type ToolPartArtifact } from './thread-messages'
import { useLoadOlderOnTop } from './load-older-on-top'
import { ThinkingDataUI } from './thinking-part'
import { OpenedOutputsDataUI } from './opened-outputs-part'
import { AgentSendDataUI } from './agent-send-part'
import { OpenedOutputHandlersContext } from './opened-output-handlers'
import { useOpenedOutputOpener } from './opened-output-opener'
import { LiveTail } from './live-tail'
import { TurnProcessMessage, TurnProcessToggleProvider } from './turn-process-message'
import { attachmentMentions, sessionAttachmentAdapter } from './composer-attachments'
import { sessionAttachmentRpc } from './sessionpage-rpc'
import { PhoneTaskDraftRecovery } from '../local-agent/PhoneTaskDraftRecovery'
import { appendToDraft } from '@/store/chatContext'
import { notify } from '@/lib/notices'
import { messageForUser } from '@/lib/userFacingError'
import { dismissSubagent } from '@renderer/features/sessions/view/subagent-dismissals'
import { usePhoneBackgroundTasks } from './background-tasks'
import { PhoneBackgroundTasks } from './PhoneBackgroundTasks'
import { stopBackgroundTask } from './sessionpage-rpc'

/**
 * 手机任务时间线复用 assistant-ui Thread 的消息仓库、滚动、附件和发送行为。
 * 手机阅读面和输入框在 phone-conversation.css 消费产品视觉规范的 token；触摸键盘的 Enter 保留换行。
 *
 * 这一层只剩两件咕咕特有的事：
 *   ① 数据：`useExternalStoreRuntime` 直接读现成的时间线（读侧只读，发送走已有的 send）。
 *   ② 审批/提问卡：画在问出它的那次工具调用的位置(thread-messages 的 `question` part),
 *      流里没有那一行的待答项钉在末尾 —— 一个看不见的待审批 = 卡死的会话。
 */

/**
 * 还在跑的工具(thread-messages runningToolIds):官方只给整条消息一个状态,一条消息里跑完的和在跑的分不开,
 * 运行态按卡交。走 context 而不进工具卡组件的闭包:闭包一变,组件就是新的,每张卡重挂、摊开的又收起来。
 */
const RunningTools = createContext<ReadonlySet<string>>(new Set())

/** 线程空着时那一句(读取中 / 等它开口),画在官方的空态位上;同 RunningTools 走 context,组件本身不换。 */
const EmptyNote = createContext<ReactNode>(null)
const EmptyNoteWelcome = () => <>{useContext(EmptyNote)}</>

/** 去机器上取一张工具图、写回条目(use-timeline-session `loadToolImage`)。 */
const ToolImageLoader = createContext<((itemId: string, index: number) => Promise<void>) | null>(null)

/**
 * 时间线手里的工具图(thread-messages toolImagesById),按条目 id。同 RunningTools 走 context:图格读**时间线这一份**,
 * 和它同一次提交。❌ 读工具卡 artifact 里的:那是 assistant-ui 的一份,它在 effect 里才换上新消息,晚一两次提交 ——
 * 图格读它,就会对着一张早已取到的图再要一遍(2026-10-16 mac1 实测往上翻 64 张问了 74 次)。
 */
const ToolImagesInHand = createContext<ReadonlyMap<string, readonly (ToolImage | null | undefined)[]>>(new Map())
/** 一张图的 data: 地址按图记一份:时间线每变一次图格都重画,❌ 每次把几百 K 的 base64 再拼一遍。 */
const imageUrls = new WeakMap<ToolImage, string>()
function urlOf(image: ToolImage): string {
  let url = imageUrls.get(image)
  if (!url) imageUrls.set(image, (url = toolImageUrl(image)))
  return url
}

/**
 * 工具卡下的那组图:app 自己那套图格(MediaGrid,点开进看图器),收在缩略图那么宽(agent-watch.css)。
 * 时间线里只有每张的字数(transport-trim),图要去机器上取:这组图滚进视口才取(工具卡在折着的那一轮里本来就不渲染,
 * 所以也只在展开时取),取到的写回条目、跟时间线一起存在手机上;超过上限的不取,写「在桌面上看」;取不到写出来,
 * 点一下再取。
 * 取不取只看数据(`ToolImagesInHand`):条目在时间线里、这一张还没有、没超上限、没取失败 ⇒ 要。条目已经不在时间线里
 * (换代快照没带那一轮、换了会话),它的卡还会在屏上多留一两次提交:❌ 替它要(复核 10-16:一组早已画上的 6 张又问了
 * 6 次)。条目被宿主重发、图没带过来时(agent-watch-store `keepFetchedImages` 只带同一组图)这一格又没了图,照样再要;
 * 同一张只发一问由 `loadToolImage` 管,这里不另记。
 * ❌ 一直转圈:那一问 12 秒没回就算取不到(sessionpage-rpc `fetchToolImage` 走 `once`)。
 */
function ToolImages({ images }: { images: readonly ToolImageTile[] }) {
  const { t } = useTranslation('main')
  const load = useContext(ToolImageLoader)
  const inHand = useContext(ToolImagesInHand)
  const box = useRef<HTMLDivElement>(null)
  const [inView, setInView] = useState(typeof IntersectionObserver === 'undefined')
  const [failed, setFailed] = useState<ReadonlySet<number>>(new Set())
  useEffect(() => {
    const element = box.current
    if (inView || !element) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setInView(true)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [inView])
  const fetchOne = useCallback((image: ToolImageTile) => {
    setFailed((now) => (now.has(image.index) ? new Set([...now].filter((i) => i !== image.index)) : now))
    const fail = () => setFailed((now) => new Set(now).add(image.index))
    if (!load) return fail()
    load(image.itemId, image.index).catch(fail)
  }, [load])
  useEffect(() => {
    if (!inView) return
    for (const image of images) {
      if (inHand.has(image.itemId) && !inHand.get(image.itemId)?.[image.index] && image.chars <= TOOL_IMAGE_FETCH_LIMIT && !failed.has(image.index)) fetchOne(image)
    }
  }, [inView, images, inHand, failed, fetchOne])
  // 还没到手的那一格:取的时候空着(一块底色),太大、取不到各写一句。
  const pendingOf = (image: ToolImageTile): string =>
    image.chars > TOOL_IMAGE_FETCH_LIMIT ? t('agentWatch.toolImages.tooLarge') : failed.has(image.index) ? t('agentWatch.toolImages.failed') : ''
  return (
    <div ref={box} className="gg-aw-tool-images" data-testid="tool-images">
      <MediaGrid
        images={images.map((image) => {
          const shot = inHand.get(image.itemId)?.[image.index]
          return shot ? { url: urlOf(shot), alt: image.alt } : { url: '', alt: image.alt, pending: pendingOf(image) }
        })}
        onPending={(at) => {
          const image = images[at]
          if (image && failed.has(image.index)) fetchOne(image)
        }}
      />
    </div>
  )
}

/** 官方工具卡,运行态按卡给。用 `components.ToolFallback` 这个官方留好的插槽，❌ 不去改 thread.aui.tsx。 */
const ToolWithStatus: ToolCallMessagePartComponent = (part) => {
  const toolRunning = useContext(RunningTools).has(part.toolCallId)
  const images = (part.artifact as ToolPartArtifact | undefined)?.images
  return (
    <>
      <ToolFallback {...part} status={toolRunning ? TOOL_RUNNING : part.status} />
      {images ? <ToolImages images={images} /> : null}
    </>
  )
}

/** 时间线里每一次工具调用,按 id(= 工具卡的 `toolCallId`)。一组头上那句话按它们原本是哪一类来数。同 RunningTools 走 context。 */
const ToolItems = createContext<ReadonlyMap<string, TranscriptItem>>(new Map())

/**
 * 分组:连着的思考(本页把思考画成 `thinking` data part)与工具调用归进同一组 —— 同桌面「思考也进这一句」
 * (owner 2026-10-16,#7316);其余照官方模板。模块级常量:同一个函数,GroupedParts 才认得出分组规则没变。
 */
const PROCESS_GROUP_BY: NonNullable<ThreadComponents['groupBy']> = (part, context) =>
  part.type === 'data' && part.name === THINKING_DATA_PART ? ['group-chainOfThought'] : DEFAULT_GROUP_BY(part, context)

/** 连着的工具调用:外面那一组(`ProcessRun`)已经收起来、数过了,这一层 ❌ 再套 —— 那要点两层才看得到一张卡。 */
const ToolGroupPassThrough: NonNullable<ThreadComponents['ToolGroup']> = ({ children }) => <>{children}</>

type RunMember = Parameters<typeof tallyToolRun>[0][number]

/**
 * 一轮里连着的思考 + 工具调用收成一组,头上写桌面同一句「思考了 2 次、跑了 3 条命令」(`tool-run`,同一份判断):
 * 时间头里外、跑着还是跑完点开,都一样(owner 2026-10-16,推翻 10-02「过程折叠里直接摆工具卡」—— 跑着时一直平铺)。
 * 一项就是一行(同桌面:「折一条等于把一行换成另一行」)—— ❌「1 次工具调用」再套一层。
 * 工具组的外壳(`tool-group`)本身不是一次调用,不数,数的是它下面那几次(同桌面 `tallyToolRun`)。
 */
const ProcessRun: NonNullable<ThreadComponents['ChainOfThoughtGroup']> = ({ group, children }) => {
  const parts = useAuiState((s) => s.message.parts)
  const items = useContext(ToolItems)
  const running = useContext(RunningTools)
  const members: RunMember[] = []
  let live = false
  for (const index of group.indices) {
    const part = parts[index]
    if (part?.type === 'data' && part.name === THINKING_DATA_PART) {
      const thinking = part.data as TranscriptThinking
      members.push(thinking as unknown as RunMember)
      if (thinking.status === 'thinking') live = true
    } else if (part?.type === 'tool-call') {
      const item = items.get(part.toolCallId)
      if (item && item.kind !== 'tool-group') members.push(item as unknown as RunMember)
      if (running.has(part.toolCallId)) live = true
    }
  }
  if (members.length < 2) return <>{children}</>
  // 跑着时这一句后面接此刻在做什么(在跑的命令 / 在想),与桌面 tool-run 同一份判断;跑完恢复原样。
  const now = live ? toolRunNow(members as Parameters<typeof toolRunNow>[0]) : null
  const label = toolRunLabel(tallyToolRun(members), translateSessionMessage)
  return (
    <ToolGroupRoot variant="ghost">
      <ToolGroupTrigger
        count={members.length}
        label={now ? `${label} · ${toolRunNowLabel(now, translateSessionMessage)}` : label}
        {...(now?.kind === 'command' ? { detail: now.command } : {})}
        active={live}
      />
      <ToolGroupContent>{children}</ToolGroupContent>
    </ToolGroupRoot>
  )
}

export function AgentThread({
  timeline,
  deviceId,
  sessionId,
  draft,
  onDraftApplied,
  phoneHost = false,
  machineLabel,
  sessionRuntime,
  respondingItemId,
  onRespond,
  onSend,
  pendingSends,
  sending,
  agentWorking,
  headerRunning,
  onStop,
  stopping,
  footerNotice,
  onLoadOlder,
  onLoadToolImage,
  emptyNote
}: {
  timeline: AgentWatchTimeline
  deviceId: string
  sessionId: string
  draft?: { text: string }
  onDraftApplied?: () => void
  phoneHost?: boolean
  /** That machine's name, for an App install asked there (D-31). */
  machineLabel?: string
  /** 这条会话的腿(协议 / 终端),决定审批/提问卡能不能在手机上答。 */
  sessionRuntime: SessionpageSessionSummary['runtime']
  respondingItemId: string | null
  onRespond: (input: SettlementResponse) => void
  onSend: (text: string) => Promise<void>
  /** 已发出、那台机器还没报出来(记录里没有、队列里也没有)的那几句 —— 接在时间线末尾照常画成用户消息(pending-sends.ts)。 */
  pendingSends: readonly PendingSend[]
  sending: boolean
  /**
   * **远端那条会话正在跑**(最后一轮还没结算),不是「这台手机正在发」。
   * 两者都要锁输入与选项:一轮跑到一半插话或换模型,会和它自己的输出交错。
   */
  agentWorking: boolean
  /**
   * 页头那颗状态点说「运行中」。最后一条回复下面换成「正在回」的点只看它:记录里一轮已经结算了,agent 往往还要忙
   * 二三十秒(收尾、hook),这段时间页头写着运行中而动作栏已经出来,读起来就是「还在跑却能复制了」(owner 10-09 真机)。
   */
  headerRunning?: boolean
  /** 停掉正在飞的一轮。照桌面端:在跑时发送键位置变停止键;打了字又变回发送键(在跑时发送是排队)。 */
  onStop: () => void
  stopping: boolean
  footerNotice?: ReactNode
  /** 滚到顶时往前翻一页(没有更早的就不会被调)。 */
  onLoadOlder: () => Promise<void>
  /** 去机器上取一张工具交回来的图、写回条目;不给就一张都不取(图格写着取不到)。 */
  onLoadToolImage?: (itemId: string, index: number) => Promise<void>
  /** 时间线还没到手时空着的线程说的那一句;不给就是官方空态。 */
  emptyNote?: ReactNode
}) {
  const { t } = useTranslation('main')
  // 输入框的附件:字节送到会话所在的那台机器(composer-attachments.ts)。
  const attachments = useMemo(
    () =>
      sessionAttachmentAdapter({
        rpc: sessionAttachmentRpc(deviceId, phoneHost),
        sessionId,
        describe: (reason) =>
          reason === 'too-large'
            ? t('agentWatch.composer.attachTooLarge', { limit: formatBytes(MAX_ATTACHMENT_BYTES) })
            : t(reason === 'server-too-old' ? 'agentWatch.composer.attachServerTooOld' : 'agentWatch.composer.attachFailed'),
      }),
    [deviceId, sessionId, phoneHost, t],
  )
  const messages = useMemo(
    () => [
      ...toThreadMessages(timeline.turns, {
        // 发给手机的那一份裁过长输出(transport-trim);裁了就要说,❌ 不让人以为输出到此为止。
        trimmedNote: (chars) => t('agentWatch.timeline.outputTrimmed', { count: chars }),
        // 最后一轮还没结算 = 在跑(等审批 / 提问也算):它的过程头在数秒、默认摊开,不挂附件卡(同桌面的活动层)。
        liveTurnId: unsettledLastTurnId(timeline.turns),
        settlements: timeline.settlements,
        terminals: timeline.terminals,
      }),
      // 那台机器上还排着的(与桌面「Queued prompts」同一份),接着是手机刚发、那台机器还没报出来的。
      ...[
        ...timeline.queuedPrompts.map((prompt) => ({ id: `queued:${prompt.id}`, text: prompt.text })),
        ...pendingSends,
      ].map((send) => userMessage(send.id, send.text)),
    ],
    [timeline.turns, timeline.settlements, timeline.terminals, timeline.queuedPrompts, pendingSends, t],
  )
  /*
   * 整条线由我们交成一份线性仓库(父 = 上一条),❌ 交 `messages`:那个模式下库自己攒一份**只加不删**的仓库,
   * 乐观行(手机刚发的、那台机器还排着的)被记录行(另一个 id)顶掉、从中间撤掉、或记录换了世代,旧那一行都留在里面成了兄弟;
   * 它的驱逐只沿上一个 head 走,「A 的记录先回来、B 还在路上」就漏(#6901)。
   * 交整份时,不在里面的行库会真删 —— 仓库永远就是这一条线,一条消息一行。
   */
  const messageRepository = useMemo(() => ExportedMessageRepository.fromArray(messages), [messages])
  // 后台命令与子智能体(#638):对话末尾、输入框上面那一句。手机自己当主机时没有这条路(那是手机上的 agent)。
  const [dismissals, setDismissals] = useState(0)
  const backgroundTasks = usePhoneBackgroundTasks(deviceId, sessionId, timeline.turns, dismissals, !phoneHost)
  const background = backgroundTasks.commands.length + backgroundTasks.subagents.length > 0 ? (
    <PhoneBackgroundTasks
      tasks={backgroundTasks}
      onStop={(stopId) => {
        stopBackgroundTask(deviceId, sessionId, stopId).catch((error: unknown) =>
          notify({ tier: 'error', title: translateSessionMessage('acpFailure.stop'), description: messageForUser(error) }))
      }}
      onDismiss={(entryId) => { dismissSubagent(sessionId, entryId); setDismissals((value) => value + 1) }}
    />
  ) : null

  const runtime = useExternalStoreRuntime<ThreadMessage>({
    /*
     * ⚠️ 这里曾经只写 `sending` —— 那只是「**这台手机**正在发」的那几百毫秒。
     * 远端 agent 自己在干活时(你打开页面时它已经在跑、或别人给它发了消息)它是 false,
     * 于是输入框照常可发、动作栏照常出现,屏幕看着像「它已经停了」。
     * 权威判据是时间线自己:最后一轮还没结算 = 还在跑(deriveAttention 的 'running');
     * 页头那颗状态点用的是同一份 —— ❌ 不让两处对同一件事各说各话。
     */
    /*
     * #3566 审计后改口:**不把「远端在跑」当 isRunning 交给官方线程**。
     * 官方模板对 isRunning 做三件事:锁输入框、在最后一条下面画一个闪烁的占位圆点、把发送键换成
     * 停止键 —— 三样在这里都不对:机器端 `send` 在跑的时候是**排队**(accepted:'queued'),锁着
     * 输入框只是让人以为不能说话;那个圆点和页头转圈、输入框上方那一行是同一件事的第三处闪烁;
     * 停止键没有对应的能力。isRunning 只留「这台手机正在发」那几百毫秒,免得同一句发两遍。
     * 「远端在跑」由页头状态词表达,停止键在输入框的发送键位置(ComposerExtrasProvider 的 stop)。
     * ❌ 输入框上方不再另起「Agent 在干活」一行:和页头说的是同一件事(owner 2026-09-24 真机)。
     */
    isRunning: sending,
    messageRepository,
    onNew: async (message: AppendMessage) => {
      const typed = message.content.find((part) => part.type === 'text')
      // 附件以那台机器上的路径拼进正文(与桌面同一种表示);可以只发附件。
      const text = composePromptText(typed?.type === 'text' ? typed.text : '', attachmentMentions(message.attachments))
      if (!text) return
      try {
        await onSend(text)
      } catch (error) {
        /*
         * 发不出去:乐观那一行已经撤了(use-timeline-session),输入框在按下发送时也清空了 ——
         * 两头都不还的话,打的字和附件在屏上和输入框里同时消失。交回 assistant-ui 的输入框:它把字和附件
         * 一起放回去,只在输入框空着时放,❌ 盖掉这期间新打的字(与桌面会话页 `_rollbackUnsentPrompt` 同一条规矩)。
         * 原因已经在输入框上方那条横幅里(use-timeline-session 的 actionError)。
         */
        throw new MessageNotSentError(error instanceof Error ? error.message : String(error))
      }
    },
    adapters: { attachments },
  })
  // Each App handoff is applied once, including a second draft into the task already open.
  const appliedDraft = useRef<typeof draft>(undefined)
  useEffect(() => {
    if (!draft || appliedDraft.current === draft) return
    appliedDraft.current = draft
    const composer = runtime.thread.composer
    const text = composer.getState().text
    composer.setText(appendToDraft(text, draft.text))
    onDraftApplied?.()
  }, [draft, runtime, onDraftApplied])
  const hostRef = useRef<HTMLDivElement | null>(null)
  useLoadOlderOnTop(hostRef, timeline.hasOlder, onLoadOlder)
  useEffect(preloadSharedChatRuntime, [])

  // 附件卡(#7193)点开:网页交给浏览器,文件从那台电脑现读、在一整页预览里看。
  const quoteOutput = useCallback((text: string) => {
    const composer = runtime.thread.composer
    composer.setText(appendToDraft(composer.getState().text, text))
  }, [runtime])
  const outputs = useOpenedOutputOpener({ deviceId, sessionId, onQuote: quoteOutput })
  const running = useMemo(() => runningToolIds(timeline.turns), [timeline.turns])
  const imagesInHand = useMemo(() => toolImagesById(timeline.turns), [timeline.turns])
  const toolItems = useMemo(() => toolItemsById(timeline.turns), [timeline.turns])
  const slot = useMemo(
    () => ({ settlements: timeline.settlements, runtime: sessionRuntime, machine: machineLabel, respondingItemId, onRespond }),
    [timeline.settlements, sessionRuntime, machineLabel, respondingItemId, onRespond],
  )
  // 已经画在流里的卡(thread-messages 交成 `question` part 的那些);判据本身在 store 里(`pinnedSettlements`)。
  const inlineIds = new Set<string>()
  for (const message of messages) {
    for (const part of message.content) {
      if (typeof part === 'object' && part.type === 'data' && part.name === QUESTION_DATA_PART) {
        inlineIds.add((part.data as ToolCallItem).toolCallId)
      }
    }
  }
  const pinned = pinnedSettlements(timeline.settlements, inlineIds)

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThinkingDataUI />
      <QuestionDataUI />
      <OpenedOutputsDataUI />
      <AgentSendDataUI />
      <div ref={hostRef} className="gg-aw-thread-host" data-testid="agent-watch-timeline">
        {/* 选项摆在输入框那一行(orca 同款位置),❌ 不在页头右上角:
            改模型/权限档是「说这句话之前先定个调」,和输入框是一件事。 */}
        <ComposerExtrasProvider
          extras={
            <SessionOptionsPill
              deviceId={deviceId}
              sessionId={sessionId}
              phoneHost={phoneHost}
              // 改模型/权限档在跑的时候仍然锁:一轮跑到一半换模型,会和它自己的输出交错。
              busy={sending || agentWorking}
            />
          }
          stop={agentWorking ? { onStop, stopping } : null}
          above={footerNotice || phoneHost || background ? <div className="gg-aw-thread-extras">{background}{footerNotice}{phoneHost && <PhoneTaskDraftRecovery deviceId={deviceId} sessionId={sessionId} composer={runtime.thread.composer} sending={sending} />}</div> : null}
          tail={
            pinned.length > 0 ? (
              <div className="gg-aw-thread-extras" data-testid="agent-watch-pinned-settlements">
                {pinned.map((settlement) => (
                  <SettlementCard
                    key={settlement.itemId}
                    settlement={settlement}
                    runtime={sessionRuntime}
                    machine={machineLabel}
                    busy={respondingItemId === settlement.itemId}
                    onRespond={onRespond}
                  />
                ))}
              </div>
            ) : null
          }
        >
          <TurnProcessToggleProvider>
            <OpenedOutputHandlersContext.Provider value={outputs.handlers}>
            <SettlementSlotProvider value={slot}>
            <EmptyNote.Provider value={emptyNote}>
            <RunningTools.Provider value={running}>
            <ToolImageLoader.Provider value={onLoadToolImage ?? null}>
            <ToolImagesInHand.Provider value={imagesInHand}>
            <ToolItems.Provider value={toolItems}>
              <LiveTail.Provider value={headerRunning ? (messages.at(-1)?.id ?? null) : null}>
              <Thread
                components={{
                  ToolFallback: ToolWithStatus, ToolGroup: ToolGroupPassThrough, ChainOfThoughtGroup: ProcessRun, groupBy: PROCESS_GROUP_BY,
                  UserMessage: DeliveryMessage, AssistantMessage: TurnProcessMessage,
                  ...(emptyNote ? { Welcome: EmptyNoteWelcome } : {}),
                }}
                autoFocus={false}
                submitOnEnter={false}
              />
              </LiveTail.Provider>
            </ToolItems.Provider>
            </ToolImagesInHand.Provider>
            </ToolImageLoader.Provider>
            </RunningTools.Provider>
            </EmptyNote.Provider>
            </SettlementSlotProvider>
            </OpenedOutputHandlersContext.Provider>
          </TurnProcessToggleProvider>
        </ComposerExtrasProvider>
      </div>
      {outputs.panel}
    </AssistantRuntimeProvider>
  )
}
