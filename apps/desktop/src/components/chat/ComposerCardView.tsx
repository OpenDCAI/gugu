import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { labelOfDisplayStatus } from '@gugu/core/shared/ui/agentConversationStatusModels'
import type { ComposerCard, TaskCard } from '@gugu/core/shared/ui/taskCardModels'
import type { AgentDisplayStatus } from '@gugu/core/shared/types/chat'
import { Check, Clock, Sparkles } from '@/lib/icons'
import { useAgentDisplayStatuses } from '../../hooks/useAgentDisplayStatus'
import { listMyAgentJoinRequests } from '../../lib/groupAgentJoinService'
import type { AgentJoinRequestStatus } from '../../lib/groupAgentJoin'
import { platform } from '../../platform'
import { showSessionBeside } from '../../session/renderer/app/screen-layout-actions'
import { getProjectStore, projectDisplayName } from '../../session/renderer/features/projects/stores/project-selectors'
import { openSessionInSessionWhenReady } from '../../session/renderer/features/sessions/open-session-in-session'
import { appState } from '../../session/renderer/lib/stores/app-state'
import { isImplicitSessionHomeProjectId } from '../../session/shared/core/projects/session-home-project'
import { AgentNeedsUserGlyph } from '../AgentNeedsUserGlyph'
import { openSessionInFull } from '../appSlot/peekFullSession'

/**
 * gugu-dev#181 任务卡 / 已安排卡:一个面、三行 —— 是什么、原话、交给谁(行尾一个状态标记,与侧栏同一套读数)。
 * 量值照聊天里的兄弟卡(App 安装包卡:12px 圆角、1px 边、12px 内边距、行距 8px);❌ 上下两截、❌ 另起状态条。
 */
export function ComposerCardView({ card, isMine, isGroup, chatId, senderName }: {
  card: ComposerCard
  isMine: boolean
  isGroup: boolean
  chatId: string
  senderName: string
}) {
  const { t } = useTranslation('messaging')
  const task = card.type === 'task' ? card : null
  const place = useTaskCardPlace(task, isMine, senderName)
  const join = useMyAgentJoin(isMine && isGroup ? chatId : null, task?.agentUserId ?? null)
  const status = useAgentDisplayStatuses(task ? [task.agentUserId] : [])[task?.agentUserId ?? '']
  const openable = task && place.local
  const Root = openable ? 'button' : 'div'
  return (
    <Root
      type={openable ? 'button' : undefined}
      data-testid="composer-card"
      data-card-type={card.type}
      title={openable ? t('message.taskCard.open') : undefined}
      onClick={openable ? () => openTaskCardSession(task) : undefined}
      className="box-border flex w-[300px] max-w-full flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] p-3 text-left enabled:cursor-pointer enabled:hover:border-[var(--border-strong)]"
    >
      <span className="flex h-6 items-center gap-2">
        <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-[var(--radius-document)] border border-[var(--border)]">
          {task ? <Sparkles size={13} /> : <Clock size={13} />}
        </span>
        <span className="text-[var(--font-body)] font-semibold">
          {task ? t('message.taskCard.task') : `${t('message.taskCard.schedule')} · ${card.type === 'schedule' ? card.scheduleLabel : ''}`}
        </span>
      </span>
      <span className="line-clamp-4 whitespace-pre-wrap break-words text-[var(--font-prose)] leading-[var(--lh-prose)]">{card.text}</span>
      {task && (
        <span className="flex h-5 min-w-0 items-center gap-2 text-[var(--font-caption)] text-[var(--muted-fg)]">
          <span className="shrink-0">{t('message.taskCard.handedTo')}</span>
          <b className="shrink-0 font-medium text-[var(--text-secondary)]">{task.agentName}</b>
          <span className="min-w-0 truncate">
            {join === 'pending' ? `· ${t('message.taskCard.awaitingApproval')}` : join === 'rejected' ? `· ${t('message.taskCard.rejected')}` : place.label ? `· ${place.label}` : ''}
          </span>
          <span className="ml-auto flex shrink-0 items-center">{join ? null : <TaskStatusMark status={status} />}</span>
        </span>
      )}
    </Root>
  )
}

/** 行尾那一格:在跑 = 跳动的点、需要你 = 叹号、出错 = 红点、做完(空闲 / 后台静止)= 勾;归档 / 离线不画。 */
function TaskStatusMark({ status }: { status: AgentDisplayStatus | undefined }) {
  const { t } = useTranslation('common')
  if (!status || status === 'pending' || status === 'removed' || status === 'offline') return null
  const label = t(`agentStatus.${labelOfDisplayStatus(status)}`)
  if (status === 'needs_user') return <span role="img" aria-label={label} title={label}><AgentNeedsUserGlyph size={12} /></span>
  if (status === 'idle' || status === 'parked') return <Check role="img" aria-label={label} size={14} className="text-[var(--muted-fg)]" />
  const tone = status === 'working' ? 'bg-[var(--agent-tone-running)] animate-pulse motion-reduce:animate-none' : 'bg-[var(--agent-tone-error)]'
  return <span role="img" aria-label={label} title={label} className={`mx-[3px] size-2 rounded-full ${tone}`} />
}

let localDeviceIdOnce: Promise<string | null> | null = null
function localDeviceId(): Promise<string | null> {
  localDeviceIdOnce ??= Promise.resolve(platform.getLocalDeviceSelfSnapshot?.()).then((self) => self?.device_id ?? null, () => null)
  return localDeviceIdOnce
}

/**
 * 卡上「在哪」:我的卡、会话就在这台电脑上 = 它的项目(点卡打开);我在别的电脑上派的 = 那台电脑;
 * 同事的卡 = 在他的电脑上(过程看不到,结果看群里)。
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
  // 没选项目的任务跑在隐式的工作目录里:那不是一个用户认得的项目,❌ 写出它的内部名字。
  const project = isImplicitSessionHomeProjectId(task.projectId) ? undefined : projectDisplayName(getProjectStore(task.projectId))
  return { local: true, label: project ? t('message.taskCard.inProject', { project }) : null }
}

/** 一个群里我名下 agent 的入群请求,同一个群的几张卡共用一次读。 */
const joinReads = new Map<string, { at: number; read: Promise<Map<string, AgentJoinRequestStatus>> }>()
const JOIN_READ_TTL_MS = 15_000

function useMyAgentJoin(chatId: string | null, agentUserId: string | null): 'pending' | 'rejected' | null {
  const [state, setState] = useState<'pending' | 'rejected' | null>(null)
  useEffect(() => {
    if (!chatId || !agentUserId) return
    let live = true
    let entry = joinReads.get(chatId)
    if (!entry || Date.now() - entry.at > JOIN_READ_TTL_MS) {
      entry = { at: Date.now(), read: listMyAgentJoinRequests(chatId) }
      joinReads.set(chatId, entry)
    }
    void entry.read.then(
      (byAgent) => {
        const status = byAgent.get(agentUserId)
        if (live) setState(status === 'pending' || status === 'rejected' ? status : null)
      },
      () => { joinReads.delete(chatId) },
    )
    return () => { live = false }
  }, [chatId, agentUserId])
  return state
}

/** 点卡 = 屏上(会话 / 项目块)就拼在正看着那块右边(与侧栏 ⌘ 点同一条);在聊天页就整页打开它。 */
function openTaskCardSession(task: TaskCard): void {
  const target = { projectId: task.projectId, sessionId: task.sessionId }
  const view = appState.navigation.currentViewId
  if (view === 'session' || view === 'project') {
    showSessionBeside(target)
    openSessionInSessionWhenReady(target)
    return
  }
  openSessionInFull(target)
}
