import { observer } from 'mobx-react-lite'
import { useEffect, useState, type CSSProperties } from 'react'
import { showPhoneAppView } from '@/components/appSlot/phoneAppState'
import { reaction } from 'mobx'
import { useTranslation } from 'react-i18next'
import { PhoneTaskSkills } from '../local-agent/PhoneTaskSkillsButton'
import type { Device } from '@gugu/core/shared/types/chat'
import { isAgentHostDevice, isPhoneDevice } from '@gugu/core/cloud/devices'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import type { SessionShellAgentName } from '@/session/shared/lib/ipc/shell-port'
import { Button } from '@/components/ui/Button'
import { useBackLayer } from '@/components/ui/sheetStack'
import { IconButton } from '@/components/ui/IconButton'
import { MoreHorizontal } from '@/lib/icons'
import { AgentWatchNote, AgentWatchScreen } from './AgentWatchChrome'
import { AgentThread } from './AgentThread'
import { SessionAvatar } from './StatusGlyph'
import { OfflineNote } from './OfflineNote'
import { CloudComputerNote } from './CloudComputerNote'
import { useCloudComputerWake } from '../../hooks/useWakeCloudComputer'
import { deriveAttention } from './agent-watch-store'
import { useShownAgentStatus } from '@/components/chat/useAgentsOnCloudComputer'
import { sessionPresentation } from './watch-status'
import { agentStatusText } from '@/lib/agentStatusText'
import { agentStatusColorVar } from '@gugu/core/shared/agentStatusPresentation'
import { useAgentWatchSession } from './useAgentWatchSession'
import { SessionActions } from './SessionsPage'
import { MobileModeMenu } from './MobileModeMenu'
import { useMachineLabel } from './useMachineLabel'
import { SessionAppFrame } from '@/components/appSlot/SessionAppFrame'
import { installedExtensionsStore } from '@/session/renderer/features/extensions/installed-extensions-store'

/**
 * owner 10-16 The App tabs a session offers on the phone: installed, switched on, opening no file — the session page's 「+」
 * on a computer. Their page draws here; their program runs on the session's computer.
 */
function useSessionApps(): Array<{ kind: string; name: string }> {
  const read = () => installedExtensionsStore.enabledTabContributions.map((entry) => ({ kind: entry.kind, name: entry.title || entry.extensionName }))
  const [apps, setApps] = useState(read)
  useEffect(() => reaction(read, setApps, { equals: (a, b) => a.length === b.length && a.every((one, i) => one.kind === b[i]?.kind && one.name === b[i]?.name) }), [])
  return apps
}

/**
 * 第三张页:一条会话的时间线 + 回复 + 审批/提问。
 *
 * 页头状态是宿主写下的那份读数(`session` 是机器推来的最新一份,见 AgentWatchPage),与列表、提醒、桌面同一句话;
 * 时间线自己的推导(deriveAttention)只管这一页内部:最后一轮还没结算时线尾画「在干活」。
 */
export const SessionTimelinePage = observer(function SessionTimelinePage({
  device,
  session,
  agent,
  firstPrompt,
  draft,
  initialAppKind,
  onBack,
  onOpenChat,
}: {
  device: Device
  session: SessionpageSessionSummary
  /** 这条会话背后的 agent;还没有身份就不给。 */
  agent?: SessionShellAgentName | undefined
  /** 刚从新建页建成:建它时带的那句(新建页上已经画着),这一页接着画,❌ 换页时让它消失。 */
  firstPrompt?: string
  draft?: { text: string }
  initialAppKind?: string
  onBack: () => void
  /** 去这个 agent 的私聊(模式按钮的「聊天」,#7197)。 */
  onOpenChat?: (agentUserId: string) => void
}) {
  const { t } = useTranslation('main')
  const { label: machineLabel } = useMachineLabel()
  const phoneHost = isPhoneDevice(device)
  const online = device.is_online && (!phoneHost || isAgentHostDevice(device))
  // #7199 打开睡着的云电脑上的会话 = 叫醒它的三件事之一;醒了时间线照常连上。
  const { issue: wakeIssue, dropped: wakeDropped, retry: retryWake } = useCloudComputerWake(device)
  const cloudAsleep = device.cloud_computer === 'asleep' || device.cloud_computer === 'waking'
  const [appliedDraft, setAppliedDraft] = useState<typeof draft>(undefined)
  const [menuAnchor, setMenuAnchor] = useState<Element | null>(null)
  // owner 10-16 The App this page shows instead of the timeline, picked from the mode button; null = the timeline.
  const [appKind, setAppKind] = useState<string | null>(initialAppKind ?? null)
  useEffect(() => showPhoneAppView({
    activeSessionId: session.conversationId,
    activeProjectId: session.projectId ?? null,
    panes: [{ paneId: 'workspace', focused: true, activeTab: { tabId: appKind ?? session.conversationId, kind: appKind ?? 'session', ...(!appKind ? { agentId: session.conversationId } : {}) } }],
  }), [session.conversationId, session.projectId, appKind])
  // Its back key goes back to the timeline, as its header's back does — not past it to the list (the App is a layer here).
  useBackLayer(() => setAppKind(null), appKind !== null)
  const apps = useSessionApps()
  const {
    timeline, phase, error, actionError, dismissActionError, waitingForRecord,
    reload, loadOlder, loadToolImage, send, pendingSends, respond, sending, respondingItemId, cancel, cancelling,
  } =
    useAgentWatchSession(device.device_id, session.conversationId, online, firstPrompt, phoneHost)

  // 提醒**不在这一页**发:它挂在看管入口的根上(useAgentWatchAlerts),这样在机器列表、
  // 会话列表、乃至刚切走时都叫得住人。这里再发一份的话,正开着这条会话时同一件事会响两次。
  const attention = deriveAttention(timeline)
  // Identified agents share the group/avatar reading; transport only governs timeline access.
  const shownStatus = useShownAgentStatus()
  const agentUserId = agent?.agentUserId ?? session.agent?.userId
  const presentation = shownStatus.presentation(agentUserId, sessionPresentation(session, online, agentUserId))
  const statusColor = presentation ? agentStatusColorVar(presentation.tone) : null
  const statusStyle: CSSProperties | undefined = statusColor ? { color: statusColor } : undefined
  const distinctAgentName = agent && agent.displayName !== session.title ? agent.displayName : null
  const taskHeader = {
    title: agent && !distinctAgentName ? <span data-testid="agent-watch-agent-name">{session.title}</span> : session.title,
    titleLeading: (
      <span className="gg-aw-title-avatar">
        <SessionAvatar agentId={agent?.agentUserId ?? session.agent?.userId} sessionId={session.conversationId} presentation={presentation} />
      </span>
    ),
    subtitle: distinctAgentName || presentation ? (
      <span className="gg-aw-head-status">
        {distinctAgentName ? <span className="gg-aw-head-agent" data-testid="agent-watch-agent-name">{distinctAgentName}</span> : null}
        {distinctAgentName && presentation ? <span aria-hidden="true">·</span> : null}
        {presentation ? (
          <span className="gg-aw-head-state" data-testid="agent-watch-session-status" data-tone={presentation.tone} data-emphasis={presentation.emphasis ? 'true' : undefined} style={statusStyle}>
            {agentStatusText(presentation.label)}
          </span>
        ) : null}
      </span>
    ) : undefined,
    headerTestId: 'agent-watch-hero',
  }

  /**
   * 机器离线 —— ⚠️ 这里此前是一句早返回,把本地缓存的那份时间线一起挡掉了
   * (`useAgentWatchSession` 的 `readCachedTimeline` 明明读得出来)。
   * 结果是「机器不在线 = 我连自己说过什么都看不到」,而那份内容就躺在这台手机上
   * (spec `session-always-openable`:「打不开」不是一种可接受的降级形态)。
   *
   * ⇒ 离线只说明**发不出去**,不说明**看不了**:缓存里有东西就照常画,离线这件事作为
   *   时间线顶上的一条说明出现;缓存里确实空的时候,它才是这一屏的全部内容。
   */
  if (!online && timeline.turns.length === 0) {
    return (
      <AgentWatchScreen {...taskHeader} onBack={onBack} testId="agent-watch-timeline-page">
        {cloudAsleep ? <CloudComputerNote device={device} issue={wakeIssue} dropped={wakeDropped} onRetry={retryWake} /> : <OfflineNote lastSeenAt={device.last_seen_at} phone={phoneHost} />}
      </AgentWatchScreen>
    )
  }

  // 动作失败贴着**动作发生的地方**显示(输入框正上方),❌ 不跑到页顶去冒充「打不开时间线」——
  // 发送失败时时间线好端端在那儿,页顶那个红框还配一个「重新读取」,对发送毫无意义。
  const actionErrorNotice = actionError ? (
    <div
      className="gg-aw-action-error"
      data-testid="agent-watch-action-error"
      /*
       * 这条横幅是发送失败的**唯一**去处 —— 没有 toast 兜底。它一出现,屏幕上其余部分
       * 一切照旧(时间线还在、输入框还在),看不见的人不会察觉自己刚才那句话没发出去。
       * 所以要报出来:role=alert + assertive,让读屏当场打断念出来(orca 同款)。
       */
      role="alert"
      aria-live="assertive"
    >
      <span className="gg-aw-action-error-title">{t('agentWatch.composer.sendFailed')}</span>
      <span className="gg-aw-action-error-detail">{actionError}</span>
      <Button
        variant="ghost"
        size="sm"
        data-testid="agent-watch-action-error-dismiss"
        onClick={dismissActionError}
      >
        {t('agentWatch.composer.dismiss')}
      </Button>
    </div>
  ) : null

  // 模式按钮(#7197)在「…」左边:去对话不要那台机器,离线也去得了,所以它一直在。
  // 有没有咕咕身份看会话自己带不带 agent id,❌ 看通讯录里有没有它的名字(通讯录还没到时会把有身份的说成没有);
  // 通讯录里真找不到,由去对话那头(MainLayout handleOpenAgentChat)响亮地说。
  // 会话的管理动作与列表行尾「…」同一个面板;都要那台机器执行,离线不给。
  const headerActions = (
    <>
      {phoneHost ? <PhoneTaskSkills deviceId={device.device_id} sessionId={session.conversationId} online={online} busy={attention === 'running' || attention === 'waiting' || sending || pendingSends.length > 0 || cancelling} /> : null}
      {!phoneHost ? <MobileModeMenu
        at={appKind ? `app:${appKind}` : 'task'}
        onOpenChat={agentUserId && onOpenChat ? () => onOpenChat(agentUserId) : null}
        onOpenTask={() => setAppKind(null)}
        apps={apps}
        onOpenApp={setAppKind}
      /> : null}
      {online ? (
        <IconButton size="md" aria-label={t('agentWatch.sessions.menu')} data-testid="agent-watch-session-page-menu" onClick={(event) => setMenuAnchor(event.currentTarget)}>
          <MoreHorizontal />
        </IconButton>
      ) : null}
    </>
  )

  if (appKind) {
    return (
      <AgentWatchScreen {...taskHeader} onBack={() => setAppKind(null)} testId="agent-watch-session-app" actions={headerActions} bodyFill>
        <SessionAppFrame kind={appKind} device={device} session={{ id: session.conversationId, ...(session.projectId ? { projectId: session.projectId } : {}) }} />
      </AgentWatchScreen>
    )
  }

  return (
    <AgentWatchScreen
      {...taskHeader}
      onBack={onBack}
      testId="agent-watch-timeline-page"
      actions={headerActions}
      bodyFill={phase !== 'error'}
    >
      {timeline.lastReset ? (
        <AgentWatchNote
          // 一档一条整句,❌ 不用「模板 + 片段」拼:各语言语序不同,拼出来的句子没法翻。
          title={t(`agentWatch.timeline.reloaded.${timeline.lastReset}`)}
          testId="agent-watch-reset-note"
        />
      ) : null}

      {!online ? (
        /* 离线但本地还有缓存:内容照常看,只说清「现在发不出去」。云电脑没醒着:说正在叫醒它。 */
        cloudAsleep ? <CloudComputerNote device={device} issue={wakeIssue} dropped={wakeDropped} onRetry={retryWake} /> : <OfflineNote lastSeenAt={device.last_seen_at} phone={phoneHost} />
      ) : null}

      {error ? (
        <AgentWatchNote
          title={t('agentWatch.timeline.loadFailed')}
          detail={error}
          tone="danger"
          testId="agent-watch-timeline-error"
        >
          <Button variant="secondary" size="lg" onClick={reload}>
            {t('agentWatch.timeline.reload')}
          </Button>
        </AgentWatchNote>
      ) : null}

      {/* ⚠️ 此前是 `phase !== 'error'`:首次拉取失败就把时间线**和输入框**一起藏掉。
          缓存里有东西时那是白藏 —— 错误已经在上面那条说明里说清楚了,内容照常给。 */}
      {phase !== 'error' || timeline.turns.length > 0 ? (
        <AgentThread
          timeline={timeline}
          deviceId={device.device_id}
          sessionId={session.conversationId}
          draft={draft === appliedDraft ? undefined : draft}
          onDraftApplied={() => setAppliedDraft(draft)}
          phoneHost={phoneHost}
          machineLabel={machineLabel(device)}
          sessionRuntime={session.runtime}
          respondingItemId={respondingItemId}
          onRespond={(input) => { void respond(input).catch(() => undefined) }}
          onSend={send}
          pendingSends={pendingSends}
          sending={sending}
          agentWorking={attention === 'running'}
          headerRunning={presentation?.tone === 'running'}
          onStop={cancel}
          stopping={cancelling}
          footerNotice={actionErrorNotice}
          onLoadOlder={loadOlder}
          onLoadToolImage={loadToolImage}
          emptyNote={phase === 'loading' || timeline.turns.length > 0 ? (
            /* 刚建的会话:记录要等 agent 写下第一行才有。那时说「正在等它开口」,❌ 不说「正在读取」——
               读取早就成功了,是对面还没写。线上已画着刚发的那句时不说(线程有内容就不画空态):那句本身就是「发出去了」。
               画在线程自己的空态位上,❌ 在线程上方另起一行:那样空着的线程还会再说一句「Nothing in this task yet」
               (对一条有历史的任务是错话),撤掉上方那一行时整条线程跟着上移(owner 10-12「进去就颤两下」)。
               时间线已经到手、线程还没画出来的那一两帧(运行时下一拍才收到)也是这一句,❌ 退回官方空态闪一下。 */
            <div className="gg-aw-placeholder" data-testid={waitingForRecord ? 'agent-watch-waiting-record' : undefined}>
              {t(waitingForRecord ? 'agentWatch.timeline.waitingRecord' : 'agentWatch.timeline.loading')}
            </div>
          ) : null}
        />
      ) : null}

      <SessionActions
          anchor={menuAnchor}
          session={session}
          deviceId={device.device_id}
          phoneHost={phoneHost}
          onClose={() => setMenuAnchor(null)}
          onArchived={onBack}
        />
    </AgentWatchScreen>
  )
})
