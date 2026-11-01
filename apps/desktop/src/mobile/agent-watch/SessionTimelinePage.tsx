import { observer } from 'mobx-react-lite'
import { useNativeSessionRecord } from './useNativeSessionRecord'
import { useEffect, useState, type CSSProperties } from 'react'
import { showPhoneAppView } from '@/components/appSlot/phoneAppState'
import { reaction } from 'mobx'
import { useTranslation } from 'react-i18next'
import { PhoneTaskSkills } from '../local-agent/PhoneTaskSkillsButton'
import type { Device } from '@gugu/core/shared/types/chat'
import { isAgentHostDevice, isPhoneDevice } from '@gugu/core/cloud/devices'
import { remoteFailureKind, type SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import type { SessionShellAgentName } from '@/session/shared/lib/ipc/shell-port'
import { Button } from '@/components/ui/Button'
import { useBackLayer } from '@/components/ui/sheetStack'
import { IconButton } from '@/components/ui/IconButton'
import { MoreHorizontal } from '@/lib/icons'
import { AgentWatchNote, AgentWatchScreen } from './AgentWatchChrome'
import { SessionConversation } from './SessionConversation'
import { enqueueSessionInput, useQueuedSessionInputs } from '@/lib/sessionInputOutboxBridge'
import { SessionInputQueue } from '@/components/chat/SessionInputQueue'
import { SessionAvatar } from './StatusGlyph'
import { OfflineNote } from './OfflineNote'
import { CloudComputerNote } from './CloudComputerNote'
import { useCloudComputerWake } from '../../hooks/useWakeCloudComputer'
import { deriveAttention } from './agent-watch-store'
import { useShownAgentStatus } from '@/components/chat/useAgentsOnCloudComputer'
import { sessionPresentation } from './watch-status'
import { agentStatusText } from '@/lib/agentStatusText'
import { agentStatusColorVar, presentAgentStatus } from '@gugu/core/shared/agentStatusPresentation'
import { useAgentWatchSession } from './useAgentWatchSession'
import { SessionActions } from './SessionsPage'
import { SessionAppMenu } from './SessionAppMenu'
import { useMachineLabel } from './useMachineLabel'
import { SessionAppFrame } from '@/components/appSlot/SessionAppFrame'
import { installedExtensionsStore } from '@/session/renderer/features/extensions/installed-extensions-store'
import { useNetworkOnline } from '@/hooks/useNetworkOnline'
import { translateSessionMessage } from '@/session/renderer/localization/locale-store'

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
}) {
  const { t } = useTranslation('main')
  const { label: machineLabel } = useMachineLabel()
  const phoneHost = isPhoneDevice(device)
  const networkOnline = useNetworkOnline()
  const queuedInputs = useQueuedSessionInputs(session.conversationId)
  const online = networkOnline && device.is_online && (!phoneHost || isAgentHostDevice(device))
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
    reload, loadOlder, loadToolImage, pendingSends, respond, sending, respondingItemId, cancel, cancelling, link, errorCode,
  } =
    useAgentWatchSession(device.device_id, session.conversationId, online, firstPrompt, phoneHost)
  const native = !phoneHost && session.runtime === 'acp' && session.nativeInputVersion === 1
  const nativeRecord = useNativeSessionRecord(device.device_id, session.conversationId, native, online)
  // The directory says a crashed / unplugged machine is online until its lease runs out (about two minutes): its not
  // answering is the earlier fact. Same note as offline; the reads keep trying and the page comes back by itself.
  const hostSilent = online && ((link === 'lost' && (!error || remoteFailureKind(errorCode) === 'machine-unreachable')) || (native && nativeRecord.unreachable))
  const reachable = online && !hostSilent
  const conversation = native ? { ...timeline, turns: [...(nativeRecord.record?.turns ?? []), ...(nativeRecord.record?.activeTurn ? [nativeRecord.record.activeTurn] : [])], hasOlder: nativeRecord.record ? nativeRecord.record.nextCursor !== null : false } : timeline

  // 提醒**不在这一页**发:它挂在看管入口的根上(useAgentWatchAlerts),这样在机器列表、
  // 会话列表、乃至刚切走时都叫得住人。这里再发一份的话,正开着这条会话时同一件事会响两次。
  const attention = deriveAttention(timeline)
  // Identified agents share the group/avatar reading; transport only governs timeline access.
  const shownStatus = useShownAgentStatus()
  const agentUserId = agent?.agentUserId ?? session.agent?.userId
  // A machine that does not answer: its own reading, offline — ❌ the agent's presence, which outlives it as long as its lease.
  const presentation = !reachable ? (agentUserId ? presentAgentStatus({ reading: null, reachability: 'offline' }) : null)
    : shownStatus.presentation(agentUserId, sessionPresentation(session, true, agentUserId))
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
  const offlineNotice = !networkOnline
    ? <AgentWatchNote title={translateSessionMessage('conversation.connectionUnavailable')} testId="agent-watch-local-offline" />
    : cloudAsleep ? <CloudComputerNote device={device} issue={wakeIssue} dropped={wakeDropped} onRetry={retryWake} /> : <OfflineNote device={device} sendLater />

  // Keep the same task composer even before a cold offline phone has any timeline.
  // Its durable input queue waits for the host's stable acknowledgement contract.
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

  // 会话的管理动作与列表行尾「…」同一个面板;都要那台机器执行,离线不给。
  const headerActions = (
    <>
      {phoneHost ? <PhoneTaskSkills deviceId={device.device_id} sessionId={session.conversationId} online={online} busy={attention === 'running' || attention === 'waiting' || sending || pendingSends.length > 0 || cancelling} /> : null}
      {!phoneHost ? <SessionAppMenu
        appKind={appKind}
        onConversation={() => setAppKind(null)}
        apps={apps}
        onOpenApp={setAppKind}
      /> : null}
      {reachable ? (
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
      bodyFill
    >
      {timeline.lastReset ? (
        <AgentWatchNote
          // 一档一条整句,❌ 不用「模板 + 片段」拼:各语言语序不同,拼出来的句子没法翻。
          title={t(`agentWatch.timeline.reloaded.${timeline.lastReset}`)}
          testId="agent-watch-reset-note"
        />
      ) : null}

      {!reachable && queuedInputs.length === 0 ? (
        /* 待发消息只带正常发送中状态;没有待发内容时才显示机器连接状态。 */
        offlineNotice
      ) : null}

      {reachable && (error || nativeRecord.error) ? (
        <AgentWatchNote
          title={t('agentWatch.timeline.loadFailed')}
          detail={nativeRecord.error ?? error ?? undefined}
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
      {(
        <SessionConversation
          agentName={agent?.displayName ?? session.title}
          agentUserId={agent?.agentUserId ?? session.agent?.userId}
          timeline={conversation}
          deviceId={device.device_id}
          sessionId={session.conversationId}
          draft={draft === appliedDraft ? undefined : draft}
          onDraftApplied={() => setAppliedDraft(draft)}
          phoneHost={phoneHost} nativeRecord={native} hostReachable={reachable}
          machineLabel={machineLabel(device)}
          sessionRuntime={session.runtime}
          respondingItemId={respondingItemId}
          onRespond={respond}
          onSend={async (text, attachments) => { await enqueueSessionInput({ deviceId: device.device_id, sessionId: session.conversationId, text, ...(attachments?.length ? { attachments } : {}) }); if (native) nativeRecord.followTail() }}
          pendingSends={pendingSends}
          sending={sending}
          agentWorking={attention === 'running'}
          headerRunning={presentation?.tone === 'running'}
          onStop={cancel}
          stopping={cancelling}
          footerNotice={<><SessionInputQueue sessionId={session.conversationId} waitingForConnection={!reachable} />{actionErrorNotice}</>}
          onAtBottom={native ? nativeRecord.loadNewer : undefined}
          onLoadOlder={native ? nativeRecord.loadOlder : loadOlder}
          onLoadToolImage={loadToolImage}
          emptyNote={reachable && (phase === 'loading' || timeline.turns.length > 0) ? (
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
      )}

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
