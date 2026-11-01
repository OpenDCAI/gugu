import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { presentAgentStatus } from '@gugu/core/shared/agentStatusPresentation'
import type { ComposerCard, QuestionCard, TaskCard } from '@gugu/core/shared/ui/taskCardModels'
import { composerCardCopy } from '../../lib/composerCardCopy'
import type { AgentDisplayStatus } from '@gugu/core/shared/types/chat'
import { Check, Clock, Sparkles } from '@/lib/icons'
import { AgentHarnessIcon, EngineIcon } from '../AgentHarnessIdentity'
import { Avatar } from '../Avatar'
import { useAgentDisplayStatuses } from '../../hooks/useAgentDisplayStatus'
import { listMyAgentJoinRequests } from '../../lib/groupAgentJoinService'
import { rendererLogger } from '../../lib/log'
import { platform } from '../../platform'
import { useChatStore } from '../../store/chatContext'
import { useAuth } from '../../store/auth'
import type { MemberProfileCardModel } from '../MemberProfileCard'
import { openTaskCardSession } from './openTaskCardSession'
import { AgentStatusGlyph } from '../../session/renderer/lib/components/agent-status-indicator'

/**
 * 卡的记号:任务卡画接手那个 agent 的引擎字形(和侧栏会话行同一枚),已安排卡画一枚钟。
 * 不知道是哪个 agent(引用块里引卡的是人)时画一枚通用的星。
 */
function ComposerCardMark({ type, agentUserId, size }: { type: ComposerCard['type']; agentUserId: string | null; size: number }) {
  if (type === 'schedule') return <Clock size={size} />
  return agentUserId ? <AgentHarnessIcon agentId={agentUserId} size={size} /> : <Sparkles size={size} />
}

/** 引用块里的卡头「✳ 新任务」(agent 回群时引的是它那张卡):引的那一条是谁的不用说,卡上写着。 */
export function ComposerCardHead({ type, agentUserId }: { type: ComposerCard['type']; agentUserId: string | null }) {
  const { t } = useTranslation('messaging')
  return (
    <span className="inline-flex items-center gap-1 align-middle">
      <ComposerCardMark type={type} agentUserId={agentUserId} size={12} />
      {t(composerCardCopy[type].head)}
    </span>
  )
}

/**
 * gugu-dev#181 任务卡 / 已安排卡:是什么(右上时刻)、原话、文件名(有附件时)、交给谁(行尾状态与侧栏同一套读数)。
 * 量值照聊天里的兄弟卡(App 安装包卡:12px 圆角、1px 边、12px 内边距、行距 8px);❌ 上下两截、❌ 另起状态条。
 */
export function ComposerCardView({ card, isMine, isGroup, chatId, senderName, time, memberProfiles, onOpenTopic }: {
  card: Exclude<ComposerCard, QuestionCard>
  isMine: boolean
  isGroup: boolean
  chatId: string
  senderName: string
  /** 这个群现在的成员(随 chat_members_changed 更新):接手的 agent 坐进来了,卡上就没有「等待」。 */
  memberProfiles?: Record<string, MemberProfileCardModel>
  /** 发出的时刻(卡头右上;群里自己发的那条没有名字时刻那一行)。 */
  time: ReactNode
  /**
   * 手机:点任务卡 = 切到它那枚页签(它开在这张卡上的话题;owner 10-26「任务那枚页签 = 话题,从任务卡开」)。
   * 谁的卡都能点 —— 话题跟着群,群里的人都看得见;过程在派它的那台电脑上,话题里是它每一轮说的话。
   */
  onOpenTopic?: () => void
}) {
  const { t } = useTranslation('messaging')
  const { user } = useAuth()
  const task = card.type === 'task' ? card : null
  const agent = task && memberProfiles?.[task.agentUserId]
  const owned = agent?.ownerUserId ? agent.ownerUserId === user?.id : isMine
  const place = useTaskCardPlace(task, owned, agent?.ownerDisplayName || senderName)
  const seated = !!task && !!memberProfiles?.[task.agentUserId] && memberProfiles[task.agentUserId]!.membership !== 'former'
  const join = useMyAgentJoin(owned && isGroup && !seated ? chatId : null, task?.agentUserId ?? null)
  const status = useAgentDisplayStatuses(task ? [task.agentUserId] : [])[task?.agentUserId ?? '']
  const openable = task && (owned || onOpenTopic)
  return (
    <ComposerCardFrame
      cardType={card.type}
      // 卡上记着接手的是哪种 agent(贴卡时写下的),谁看都画这一枚;没记的老卡画通用的星 —— ❌ 去查这个 agent 现在看不看得到。
      mark={task ? (task.agentType ? <EngineIcon engine={task.agentType} size={13} /> : <Sparkles size={13} />) : <Clock size={13} />}
      title={task ? t('message.taskCard.task') : `${t('message.taskCard.schedule')} · ${card.type === 'schedule' ? card.scheduleLabel : ''}`}
      time={time}
      text={card.text}
      onOpen={openable ? () => (onOpenTopic ? onOpenTopic() : openTaskCardSession(task, place.local)) : undefined}
    >
      {task?.files?.length ? (
        <span className="whitespace-pre-wrap break-words text-[var(--font-caption)] text-[var(--muted-fg)]">{task.files.map(file => file.name).join('\n')}</span>
      ) : null}
      {task && !owned ? (
        <span className="break-words text-[var(--font-caption)] text-[var(--muted-fg)]">{place.label}</span>
      ) : task && (
        <TaskCardHandedTo
          agentName={task.agentName}
          agentAvatar={task.agentAvatar ?? null}
          agentUserId={task.agentUserId}
          note={join === 'pending' ? `· ${t('message.taskCard.awaitingApproval')}` : join === 'rejected' ? `· ${t('message.taskCard.rejected')}` : place.label ? `· ${place.label}` : ''}
          mark={join ? null : <TaskStatusMark status={status} />}
        />
      )}
    </ComposerCardFrame>
  )
}

/**
 * 任务卡 / 已安排卡的那一面:卡头(记号、是什么、时刻)、原话,底下一行由调用方给。只管长相,❌ 读任何数据 ——
 * 群里的卡(ComposerCardView)和示例项目(#709)里那张预先写好的卡画的是同一面。
 */
export function ComposerCardFrame({ cardType, mark, title, time, text, onOpen, tour, children }: {
  cardType: ComposerCard['type']
  mark: ReactNode
  title: string
  time: ReactNode
  text: string
  /** 给了 = 整张卡可点(打开它的会话、话题或详情)。 */
  onOpen?: () => void
  /** 分步引导定位这张卡用的锚点。 */
  tour?: string
  children?: ReactNode
}) {
  const { t } = useTranslation('messaging')
  const interactiveTime = typeof time !== 'string'
  const Root = onOpen && !interactiveTime ? 'button' : 'div'
  return (
    <Root
      type={onOpen ? 'button' : undefined}
      role={onOpen && interactiveTime ? 'button' : undefined}
      tabIndex={onOpen && interactiveTime ? 0 : undefined}
      onKeyDown={onOpen && interactiveTime ? event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onOpen() } } : undefined}
      data-openable={!!onOpen || undefined}
      data-testid="composer-card"
      data-card-type={cardType}
      data-tour={tour}
      title={onOpen ? t('message.taskCard.open') : undefined}
      onClick={onOpen}
      className="box-border flex w-[300px] max-w-full flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] p-3 text-left data-[openable]:cursor-pointer data-[openable]:hover:border-[var(--border-strong)]"
    >
      <span className="flex h-6 items-center gap-2">
        <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-[var(--radius-document)] border border-[var(--border)]">
          {mark}
        </span>
        <span className="min-w-0 truncate text-[var(--font-body)] font-semibold">{title}</span>
        <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[var(--font-caption)] text-[var(--muted-fg)]">{time}</span>
      </span>
      <span className="line-clamp-4 whitespace-pre-wrap break-words text-[var(--font-prose)] leading-[var(--lh-prose)]">{text}</span>
      {children}
    </Root>
  )
}

/** 任务卡最后一行「交给 谁 · 在哪 …… 状态」。 */
export function TaskCardHandedTo({ agentName, agentAvatar, agentUserId, note, mark }: {
  agentName: string
  agentAvatar: string | null
  agentUserId: string
  note: string
  mark: ReactNode
}) {
  const { t } = useTranslation('messaging')
  return (
    <span className="flex h-5 min-w-0 items-center gap-2 text-[var(--font-caption)] text-[var(--muted-fg)]">
      <span className="shrink-0">{t('message.taskCard.handedTo')}</span>
      <span className="flex min-w-0 items-center gap-1">
        <Avatar name={agentName} avatarUrl={agentAvatar} seed={agentUserId} isAgent harnessBadge={false} size={16} still />
        <b className="truncate font-medium text-[var(--text-secondary)]">{agentName}</b>
      </span>
      <span className="min-w-0 truncate">{note}</span>
      <span className="ml-auto flex shrink-0 items-center">{mark}</span>
    </span>
  )
}

/**
 * 行尾那一格,和侧栏会话行同一枚字形(AgentStatusGlyph,同一个 presentAgentStatus):在跑 = 四个点在转、后台在跑 = 同一枚静止、
 * 需要你 = 琥珀点、出错 = 红点;做完(空闲)= 勾;归档 / 离线不画。
 */
export function TaskStatusMark({ status }: { status: AgentDisplayStatus | undefined }) {
  const { t } = useTranslation('common')
  if (!status || status === 'pending' || status === 'starting' || status === 'removed' || status === 'archived' || status === 'offline') return null
  if (status === 'idle') return <Check role="img" aria-label={t('agentStatus.idle')} size={14} className="text-[var(--muted-fg)]" />
  const presentation = presentAgentStatus({
    reading: status === 'parked' ? { status: 'working', detail: 'parked' } : { status, detail: null },
  })
  return <AgentStatusGlyph presentation={presentation} label={t(`agentStatus.${presentation.label}`)} variant="2" />
}

function localDeviceId(): Promise<string | null> {
  return Promise.resolve(platform.getLocalDeviceSelfSnapshot?.()).then((self) => self?.device_id ?? null, () => null)
}

/**
 * 卡上「在哪」:我的卡、会话就在这台电脑上 = 不写(点卡打开;卡就在它的项目群或对话里,原型里卡上只有三行);
 * 我在别的电脑上派的 = 那台电脑;同事的卡 = 在他的电脑上(过程看不到,结果看群里)。
 */
function useTaskCardPlace(task: TaskCard | null, isMine: boolean, senderName: string): { local: boolean; label: string | null } {
  const { t } = useTranslation('messaging')
  const [here, setHere] = useState<string | null>(null)
  useEffect(() => {
    if (!task || !isMine) return
    let live = true
    void localDeviceId().then((id) => { if (live) setHere(id) })
    return () => { live = false }
  }, [task, isMine])
  if (!task) return { local: false, label: null }
  if (!isMine) return { local: false, label: t('message.taskCard.onColleagueComputer', { name: senderName }) }
  if (here !== task.deviceId) return { local: false, label: here ? t('message.taskCard.onMachine', { machine: task.machineLabel }) : null }
  return { local: true, label: null }
}

const joinLog = rendererLogger('chat/task-card-join')

/**
 * 我的卡、agent 还没坐进这个群时:它的入群请求是待审还是被拒。请求一变,库给发起人发 friend_requests_changed,
 * 卡就跟着重读 —— 同意(它也随之坐进来)、拒绝都不用刷新页面。坐进来了就不读。
 */
function useMyAgentJoin(chatId: string | null, agentUserId: string | null): 'pending' | 'rejected' | null {
  const { subscribeAccountRevision } = useChatStore('subscribeAccountRevision')
  const [state, setState] = useState<'pending' | 'rejected' | null>(null)
  useEffect(() => {
    if (!chatId || !agentUserId) return
    let live = true
    const read = () => listMyAgentJoinRequests(chatId).then(
      (byAgent) => {
        const status = byAgent.get(agentUserId)
        if (live) setState(status === 'pending' || status === 'rejected' ? status : null)
      },
      (error: unknown) => joinLog.error({ chatId, agentUserId, error: String(error) }, 'reading the agent join request for a task card failed'),
    )
    void read()
    const unsubscribe = subscribeAccountRevision('friend_requests_changed', read)
    return () => { live = false; unsubscribe() }
  }, [chatId, agentUserId, subscribeAccountRevision])
  return chatId && agentUserId ? state : null
}
