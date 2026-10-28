import { messageForUser } from '@/lib/userFacingError';
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentDisplayStatus, ChatItem } from '@gugu/core/shared/types/chat'
import type { AgentStatusPresentation } from '@gugu/core/shared/agentStatusPresentation'
import { ExternalLink } from '@/lib/icons'
import type { AgentRunningStatus } from '../../hooks/useAgentRunningStatus'
import { resolveAgentRunningDisplayName } from '../../lib/agentRunningStatusModels'
import { useSessionpageAgentProjection } from '../../hooks/useSessionpageAgentProjection'
import { useSessionpageSessionTimeline, type SessionpageRecentActions } from '../../hooks/useSessionpageSessionTimeline'
import { useSessionpageSessionStartupFailure } from '../../hooks/useSessionpageSessionStartupFailure'
import { readSessionpageSessionStartupFailureBridge } from '../../lib/sessionpageSessionStartupFailureBridge'
import { rendererLogger } from '../../lib/log'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import { NoticeButton, SessionpageNoticeBar } from './SessionpageNoticeBar'
import { MobileAgentOpenTask } from '@/mobile/agent-watch/MobileAgentOpenTask'
import { useAgentSessionRow } from '@/mobile/agent-watch/useAgentSessionRow'
import { AgentPermissionBand } from './AgentPermissionBand'
import { AgentQuestionCard } from './AgentQuestionCard'
import { useRemoteAgentQuestion } from '../../hooks/useRemoteAgentQuestion'
import { useAuth } from '../../store/auth'
import { agentQuestionDraftKey } from '../../lib/agentQuestion'
import { useToast } from '../toastContext'
import { useShownAgentStatus } from './useAgentsOnCloudComputer'

const sessionpageLog = rendererLogger('chat/sessionpage-presentation')

type DirectRunningToken = {
  agentId: string
  displayName: string
  avatar: string | null
}

type AgentSessionpagePresentation = {
  status: AgentDisplayStatus | null
  /** 头部那一句与颜色;与 `status` 同时为 null(不是 agent 会话)。 */
  presentation: AgentStatusPresentation | null
  runningToken: DirectRunningToken | null
  openFileLink: ((path: string) => void) | undefined
  openAction: ReactNode
  /** Recent actions from the shared local session timeline, when it is readable. */
  recentActions: SessionpageRecentActions | null
  /** 会话页 conversation 的会话事实在当前 DM 的显形:启动失败条、review 门提示。挂在 composer 上方的通知槽。 */
  sessionpageNotices: ReactNode
  /** 起任务 / 恢复失败的横幅在说这次失败:同槽位的「本次回复出错」就不再说一遍(#7103 同一次失败只说一次)。 */
  failureExplained: boolean
}

export function useAgentSessionpagePresentation(
  agentChat: ChatItem | null,
  identity: { display_name: string; avatar: string | null } | null,
  legacy: Pick<AgentRunningStatus, 'status' | 'presentation' | 'runningActivity' | 'local'>,
  mobile: boolean,
  /** 打开这个 Agent 的任务。 */
  onOpen: ((agentUserId: string) => Promise<void>) | undefined,
  onOpenFile?: (agentUserId: string, path: string) => Promise<void>,
): AgentSessionpagePresentation {
  const projection = useSessionpageAgentProjection(agentChat?.peer_user_id ?? null)
  // 手机上这个 agent 的会话在哪台机器上(#7197):找得到才放模式按钮,页头据 openAction 决定要不要给它腾地方。
  const mobileSessionRow = useAgentSessionRow(agentChat?.peer_user_id ?? null)
  const timeline = useSessionpageSessionTimeline(projection.context?.sessionId ?? null)
  const remoteQuestion = useRemoteAgentQuestion(mobileSessionRow, projection.context?.sessionId ?? null)
  const { user } = useAuth()
  // #4602 —— hydrate 以具名错误停住时,任务 renderer 的账本里有这条会话;这里是它在聊天面的出口。
  const startupFailure = useSessionpageSessionStartupFailure(projection.context?.sessionId ?? null)
  const [opening, setOpening] = useState(false)
  const [recoveryRetrying, setRecoveryRetrying] = useState(false)
  const shown = useShownAgentStatus()
  const { toast } = useToast()
  const { t } = useTranslation('messaging')

  useEffect(() => {
    if (projection.kind === 'error' && projection.context === null) {
      toast(t('agent.taskpage.statusReadFailed', { reason: projection.error }), 'error')
    }
  }, [projection, t, toast])

  useEffect(() => setOpening(false), [agentChat?.peer_user_id])

  // @@@5426 这里**不**写任何状态。写入者挂在会话面上,就等于「谁在看决定谁被记录」:用户切走之后那条
  // running 没有人来收尾。状态、审阅门、阻塞都是宿主按 agent 的流里的那一条(agentStatusFeedBridge →
  // presence 表的 `local`),本 hook 只把它们在会话面显形:会话入口、review 门、阻塞条、启动失败条。

  const handleOpen = useCallback(async () => {
    const agentUserId = agentChat?.peer_user_id
    if (!agentUserId || !onOpen || opening) return
    setOpening(true)
    try {
      await onOpen(agentUserId)
    } catch (error) {
      toast(t('agent.taskpage.openFailed', { reason: error instanceof Error ? error.message : String(error) }), 'error')
    } finally {
      setOpening(false)
    }
  }, [agentChat?.peer_user_id, onOpen, opening, t, toast])

  const handleOpenFileLink = useCallback((path: string) => {
    const agentUserId = agentChat?.peer_user_id
    if (!agentUserId || projection.kind !== 'mapped' || !projection.context || !onOpenFile) return
    void onOpenFile(agentUserId, path).catch((error) => {
      toast(t('agent.taskpage.openFailed', { reason: error instanceof Error ? error.message : String(error) }), 'error')
    })
  }, [agentChat?.peer_user_id, onOpenFile, projection.context, projection.kind, t, toast])

  const handleRecoveryRetry = useCallback(async () => {
    const sessionId = projection.context?.sessionId
    const api = (window as unknown as {
      electronAPI?: { invoke?: (channel: string, ...args: unknown[]) => Promise<unknown> }
    }).electronAPI
    if (!sessionId || !api?.invoke || recoveryRetrying) return
    setRecoveryRetrying(true)
    try {
      const raw = await api.invoke('sessionpage:retry-platform-recovery', sessionId)
      if (raw && typeof raw === 'object' && (raw as { status?: unknown }).status === 'failed') {
        throw new Error(String((raw as { error?: unknown }).error ?? 'platform credential recovery failed'))
      }
    } catch (error) {
      sessionpageLog.error(
        { error: error instanceof Error ? error.message : String(error) },
        'platform credential recovery retry failed',
      )
      toast(t('agent.taskpage.recoveryFailed.retryError'), 'error', messageForUser(error))
    } finally {
      setRecoveryRetrying(false)
    }
  }, [projection.context?.sessionId, recoveryRetrying, toast, t])

  // 状态就是那张 agent 状态表给的那一个(宿主写下的读数 × 可达),与头像、列表、通讯录同一个词。审阅门与
  // provider 阻塞只有宿主知道,也在本机那一条里;它们对状态的影响(等你 / 出错)宿主写读数时已经算过,
  // ❌ 在这里再覆盖一次状态。
  const mapped = projection.kind === 'mapped' || projection.kind === 'error'
  const local = legacy.local && projection.context && legacy.local.sessionId === projection.context.sessionId
    ? legacy.local
    : null
  const waitingForReview = mapped && local?.reviewGate === 'mcp'
  const providerBlocker = mapped ? local?.providerBlocker ?? null : null
  const statusSourceFault = mapped ? local?.statusSourceFault ?? null : null
  const platformRecovery = mapped ? projection.context?.platformRecovery ?? null : null
  const blockedByProvider = providerBlocker !== null
  const status = agentChat ? legacy.status : null
  // 头像与头栏那一句画的那一格(#7199 宿主闲时收回着 ≠ 不在线:不画状态);`status` 照旧是读数,给输入框等逻辑用。
  const presentation = agentChat ? shown.presentation(agentChat.peer_user_id, legacy.presentation) : null
  const runningToken = !agentChat || blockedByProvider || status === 'needs_user' || !legacy.runningActivity
    ? null
    : {
        agentId: legacy.runningActivity.agentId,
        displayName: resolveAgentRunningDisplayName(identity?.display_name, legacy.runningActivity.displayName),
        avatar: identity?.avatar ?? legacy.runningActivity.avatar,
      }

  // 电脑上私聊页头不再放「在任务中打开」(owner 10-28):私聊统一以后,私聊、任务页、项目页进去是同一个界面。
  // 手机上那一颗由手机线自己删(#7197 的会话目录入口)。
  const openAction = mobile && mobileSessionRow ? <MobileAgentOpenTask row={mobileSessionRow} /> : null

  // 会话页会话事实在当前 DM 的两种显形共用一条通知条(composer 上方的槽位):review 门(status)与启动失败(alert)。
  // 移动壳里触控目标 ≥44px、正文 ≥14px、按压反馈走 .gg-pressable —— 规范在 CLAUDE.md「移动端」,两条一起遵守。
  const openButton = (testId: string) => projection.context && onOpen ? (
    <NoticeButton
      testId={testId}
      busy={opening}
      extra={{ 'data-sessionpage-open-target': projection.context.sessionId }}
      onClick={() => { void handleOpen() }}
    >
      <ExternalLink size={14} />
      {t('agent.taskpage.open')}
    </NoticeButton>
  ) : null
  const reviewNotice = waitingForReview && agentChat && projection.context && onOpen ? (
    <SessionpageNoticeBar
      testId="agent-sessionpage-review-notice"
      role="status"
      tone="neutral"
      mobile={mobile}
      title={t('agent.taskpage.review.title')}
      body={t('agent.taskpage.review.action')}
      action={openButton('agent-sessionpage-review-open')}
    />
  ) : null

  // 会话启动失败:与任务页内容区说同一句(账本的 describe,#7103 同一次失败只说一次;原文只进日志)。
  // 重试 = 让任务 renderer 对同一 conversation 再 hydrate 一次,不新建;重试改变不了的(换模型 / 开会员)给「打开任务」,
  // 去路在任务页上。只要账本里还有这条它就一直在:失败是终态,消失的途径只有重试成功或该会话的标签页全部关掉;
  // 重试飞行中条目仍在、按钮禁用并写「重试中」—— ❌ 不把那一段显示成「没事了」。
  const startupFailureNotice = startupFailure && agentChat ? (
    <SessionpageNoticeBar
      testId={AUTOMATION_TEST_IDS.agentSessionpageStartupFailure}
      role="alert"
      tone="danger"
      mobile={mobile}
      title={t('agent.taskpage.startupFailure.title')}
      body={startupFailure.text}
      action={(!startupFailure.retryable && openButton('agent-sessionpage-startup-failure-open')) || (
        <NoticeButton
          testId={AUTOMATION_TEST_IDS.agentSessionpageStartupFailureRetry}
          busy={startupFailure.retrying}
          onClick={startupFailure.retry}
        >
          {t(startupFailure.retrying ? 'agent.taskpage.startupFailure.retrying' : 'agent.taskpage.startupFailure.retry')}
        </NoticeButton>
      )}
    />
  ) : null

  const providerBlockerNotice = providerBlocker && agentChat && projection.context ? (
    <SessionpageNoticeBar
      testId="agent-sessionpage-provider-blocker"
      role="alert"
      tone="danger"
      mobile={mobile}
      title={t('agent.taskpage.providerBlocker.title')}
      body={`${providerBlocker.message}\n${t('agent.taskpage.providerBlocker.action')}`}
      action={openButton('agent-sessionpage-provider-blocker-open')}
    />
  ) : null

  // spec hook-status-derivation「打断边:会话在场文件」:状态来源读不出 —— 任务照常,按 Esc 打断后状态可能不更新。
  const statusSourceFaultNotice = statusSourceFault && agentChat && projection.context ? (
    <SessionpageNoticeBar
      testId="agent-sessionpage-status-source-fault"
      role="status"
      tone="neutral"
      mobile={mobile}
      title={t('agent.taskpage.statusSourceFault.title')}
      body={statusSourceFault}
      action={null}
    />
  ) : null

  // 头像上的感叹号(needs_user)在这里有地方按:同一条审批,会话页、手机、聊天页谁先答谁生效。
  const permissionNotice = timeline.pendingPermission && agentChat ? <AgentPermissionBand sessionId={projection.context?.sessionId ?? null} pending={timeline.pendingPermission} respond={timeline.respondPermission} /> : null
  const question = timeline.question ?? remoteQuestion.question
  const questionScope = `${user?.id}:${projection.context?.sessionId ?? remoteQuestion.key}`
  const questionNotice = question && agentChat ? <AgentQuestionCard key={agentQuestionDraftKey(questionScope, question)} scope={questionScope} settlement={question} mobile={mobile}
    unavailable={!timeline.question && !remoteQuestion.available}
    respond={(answers) => timeline.question ? timeline.respondQuestion(question.itemId, answers) : remoteQuestion.respond(answers, question.itemId)} /> : null

  // 恢复失败按构造全是咕咕这一侧的(恢复协调器):带码按原因表说,不带码说「咕咕这边出错了」,❌ 英文原文上屏。
  const recoveryError = platformRecovery?.error && readSessionpageSessionStartupFailureBridge()?.describe(platformRecovery.error, 'gugu').text
  const recoveryFailureNotice = platformRecovery?.status === 'failed' && agentChat ? (
    <SessionpageNoticeBar
      testId="agent-sessionpage-platform-recovery-failed"
      role="alert"
      tone="danger"
      mobile={mobile}
      title={t('agent.taskpage.recoveryFailed.title')}
      body={recoveryError || t('agent.taskpage.recoveryFailed.unknown')}
      action={
        <NoticeButton
          testId="agent-sessionpage-platform-recovery-retry"
          busy={recoveryRetrying}
          onClick={() => { void handleRecoveryRetry() }}
        >
          {t(recoveryRetrying ? 'agent.taskpage.recoveryFailed.retrying' : 'agent.taskpage.recoveryFailed.retry')}
        </NoticeButton>
      }
    />
  ) : null

  return {
    status,
    presentation,
    runningToken,
    openFileLink: projection.kind === 'mapped' && projection.context && onOpenFile ? handleOpenFileLink : undefined,
    recentActions: timeline.recentActions,
    openAction,
    failureExplained: Boolean(startupFailureNotice || recoveryFailureNotice),
    sessionpageNotices: questionNotice || permissionNotice || startupFailureNotice || recoveryFailureNotice || providerBlockerNotice || statusSourceFaultNotice || reviewNotice ? (
      <>
        {questionNotice}
        {permissionNotice}
        {startupFailureNotice}
        {recoveryFailureNotice}
        {providerBlockerNotice}
        {statusSourceFaultNotice}
        {reviewNotice}
      </>
    ) : null,
  }
}
