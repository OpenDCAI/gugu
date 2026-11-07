import { observer } from 'mobx-react-lite'
import { useShownAgentName } from '@/hooks/useShownAgentName'
import { useAvatarIdentity } from '@/lib/avatarIdentity'
import { useNativeSessionRecord } from './useNativeSessionRecord'
import { useSessionRestart } from './useSessionRestart'
import { useTimelineFailureNotice } from './useTimelineFailureNotice'
import { useEffect, useState, type CSSProperties } from 'react'
import { showPhoneAppView } from '@/components/appSlot/phoneAppState'
import { reaction } from 'mobx'
import { useTranslation } from 'react-i18next'
import { PhoneTaskSkills } from '../local-agent/PhoneTaskSkillsButton'
import type { Device } from '@gugu/core/shared/types/chat'
import { isAgentHostDevice, isPhoneDevice } from '@gugu/core/cloud/devices'
import { remoteFailureKind, type SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { AgentFailureSlot } from '@/components/AgentFailureSlot'
import { Button } from '@/components/ui/Button'
import { useBackLayer } from '@/components/ui/sheetStack'
import { IconButton } from '@/components/ui/IconButton'
import { MoreHorizontal } from '@/lib/icons'
import { AgentWatchNote, AgentWatchScreen } from './AgentWatchChrome'
import { SessionConversation } from './SessionConversation'
import { enqueueSessionInput, releaseQueuedSessionInput, queuedSessionInputs, useQueuedSessionInputs } from '@/lib/sessionInputOutboxBridge'
import { sessionInputBaseline } from '@/lib/pendingSessionInput'
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
import { useMobileShell } from '@/hooks/useMobileShell'
import { hostedInputIds } from './local-queued-inputs'
import { canResumePhoneInput, phoneInputQueueIntent } from './phone-input-queue'
import { messageForUser } from '@/lib/userFacingError'

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
  firstPrompt,
  draft,
  initialAppKind,
  local = false,
  onBack,
}: {
  device: Device
  session: SessionpageSessionSummary
  /** 刚从新建页建成:建它时带的那句(新建页上已经画着),这一页接着画,❌ 换页时让它消失。 */
  firstPrompt?: string
  draft?: { text: string }
  initialAppKind?: string
  /** The session is on this computer (desktop assistant task pane): read it over IPC, also without a network. */
  local?: boolean
  onBack: () => void
}) {
  const { t } = useTranslation('main')
  const mobile = useMobileShell()
  const { label: machineLabel } = useMachineLabel()
  const phoneHost = isPhoneDevice(device)
  const networkOnline = useNetworkOnline()
  const queuedInputs = useQueuedSessionInputs(session.conversationId)
  // The session menu's actions travel by device RPC, so it follows the network; the timeline itself is local over IPC.
  const reachable = networkOnline && device.is_online && (!phoneHost || isAgentHostDevice(device))
  const online = local || reachable
  // #7199 打开睡着的云电脑上的会话 = 叫醒它的三件事之一;醒了时间线照常连上。
  const { issue: wakeIssue, dropped: wakeDropped, retry: retryWake } = useCloudComputerWake(device)
  const cloudAsleep = device.cloud_computer === 'asleep' || device.cloud_computer === 'waking'
  const [appliedDraft, setAppliedDraft] = useState<typeof draft>(undefined)
  const [menuAnchor, setMenuAnchor] = useState<Element | null>(null)
  const [inputQueueError, setInputQueueError] = useState<string | null>(null)
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
    useAgentWatchSession(device.device_id, session.conversationId, online, firstPrompt, phoneHost, local)

  const native = !phoneHost && session.runtime === 'acp' && (session.nativeInputVersion === 1 || session.nativeInputVersion === 2)
  const nativeRecord = useNativeSessionRecord(device.device_id, session.conversationId, native, online, local)
  const recovery = useSessionRestart({ deviceId: device.device_id, projectId: session.projectId, sessionId: session.conversationId,
    missing: native && nativeRecord.errorCode === 'record_not_found', online, local,
    onReady: () => { reload(); return nativeRecord.reload() } })
  useTimelineFailureNotice(`${device.device_id}/${session.conversationId}`, error ?? nativeRecord.error, recovery)
  // The directory says a crashed / unplugged machine is online until its lease runs out (about two minutes): its not
  // answering is the earlier fact. Same note as offline; the reads keep trying and the page comes back by itself.
  const hostSilent = !local && online && ((link === 'lost' && (!error || remoteFailureKind(errorCode) === 'machine-unreachable')) || (native && nativeRecord.unreachable))
  const answering = online && !hostSilent
  const conversation = native ? { ...timeline, turns: [...(nativeRecord.record?.turns ?? []), ...(nativeRecord.record?.activeTurn ? [nativeRecord.record.activeTurn] : [])], hasOlder: nativeRecord.record ? nativeRecord.record.nextCursor !== null : false } : timeline
  const drawnInputIds = mobile ? [...hostedInputIds(conversation.queuedPrompts, conversation.turns)] : undefined

  // 提醒**不在这一页**发:它挂在看管入口的根上(useAgentWatchAlerts),这样在机器列表、
  // 会话列表、乃至刚切走时都叫得住人。这里再发一份的话,正开着这条会话时同一件事会响两次。
  const attention = deriveAttention(conversation)
  const foregroundWorking = attention === 'running' || attention === 'waiting' || recovery.pendingPrompt !== null
  const queueReady = answering && phase === 'ready' && link === 'ok' && (!native || Boolean(nativeRecord.ready && nativeRecord.record && !nativeRecord.record.hasNewer && !nativeRecord.record.activeTurn))
  const queuedInput = foregroundWorking || queuedInputs.length > 0
  const beforeSend = () => {
    if (mobile && native && queuedInput && session.nativeInputIdentity !== true) {
      throw new Error(t('settings:devices.notice.serverTooOldHint'))
    }
  }
  // Identified agents share the group/avatar reading; transport only governs timeline access.
  const shownStatus = useShownAgentStatus()
  const agentUserId = session.agent?.userId
  const identity = useAvatarIdentity(agentUserId ?? '')
  const shownName = useShownAgentName({ name: session.title, createdAt: identity?.created_at ?? undefined })
  // A machine that does not answer: offline — ❌ the agent's presence, which outlives it as long as its lease.
  const presentation = !answering ? (agentUserId ? presentAgentStatus({ reading: null, reachability: 'offline' }) : null)
    : shownStatus.presentation(agentUserId, sessionPresentation(session, true, agentUserId))
  const statusColor = presentation ? agentStatusColorVar(presentation.tone) : null
  const statusStyle: CSSProperties | undefined = statusColor ? { color: statusColor } : undefined
  // The task's one name is its agent's name: the header says it once.
  const taskHeader = {
    title: shownName,
    titleLeading: (
      <span className="gg-aw-title-avatar">
        <SessionAvatar agentId={agentUserId} sessionId={session.conversationId} presentation={presentation} />
      </span>
    ),
    subtitle: presentation ? (
      <span className="gg-aw-head-status">
        <span className="gg-aw-head-state" data-testid="agent-watch-session-status" data-tone={presentation.tone} data-emphasis={presentation.emphasis ? 'true' : undefined} style={statusStyle}>
          {agentStatusText(presentation.label)}
        </span>
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
  const sendError = actionError ?? inputQueueError
  const actionErrorNotice = sendError ? (
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
      <span className="gg-aw-action-error-detail">{sendError}</span>
      <Button
        variant="ghost"
        size="sm"
        data-testid="agent-watch-action-error-dismiss"
        onClick={() => { dismissActionError(); setInputQueueError(null) }}
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
      {reachable && !hostSilent ? (
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
      {!answering && queuedInputs.length === 0 ? (
        /* 待发消息只带正常发送中状态;没有待发内容时才显示机器连接状态。 */
        offlineNotice
      ) : null}

      {recovery.canStartFresh ? <Button variant="secondary" onClick={() => { void recovery.startFresh() }} disabled={recovery.busy}>
        {translateSessionMessage('transcript.condition.startFresh')}
      </Button> : null}

      {/* ⚠️ 此前是 `phase !== 'error'`:首次拉取失败就把时间线**和输入框**一起藏掉。
          缓存里有东西时那是白藏；重试耗尽走统一出口，内容照常给。 */}
      {(
        <SessionConversation
          agentName={shownName}
          agentUserId={agentUserId}
          harness={session.harness}
          timeline={conversation}
          deviceId={device.device_id}
          sessionId={session.conversationId}
          draft={draft === appliedDraft ? undefined : draft}
          onDraftApplied={() => setAppliedDraft(draft)}
          phoneHost={phoneHost} local={local} nativeRecord={native} hostReachable={answering}
          unseen={session.unseen === true}
          queueReady={queueReady}
          machineLabel={machineLabel(device)}
          sessionRuntime={session.runtime}
          respondingItemId={respondingItemId}
          onRespond={respond}
          onBeforeSend={beforeSend}
          onSend={async (text, files) => {
            beforeSend()
            setInputQueueError(null)
            const request = { deviceId: device.device_id, sessionId: session.conversationId, text, composer: true as const,
              ...phoneInputQueueIntent(foregroundWorking, queuedInputs), ...sessionInputBaseline(conversation.turns), ...(files?.length ? { files } : {}) }
            await enqueueSessionInput(request)
            if (canResumePhoneInput(queueReady, foregroundWorking, conversation.turns)) {
              const head = [...queuedSessionInputs(session.conversationId)].filter(input => input.sendQueue).sort((a, b) => a.sendQueue!.order - b.sendQueue!.order)[0]
              if (head) {
                try { await releaseQueuedSessionInput(session.conversationId, conversation.turns, head.id) }
                catch (error) { setInputQueueError(messageForUser(error)) }
              }
            }
            if (native) nativeRecord.followTail()
          }}
          pendingSends={pendingSends}
          startupPrompt={recovery.pendingPrompt}
          sending={sending}
          agentWorking={foregroundWorking}
          headerRunning={presentation?.tone === 'running'}
          onStop={cancel}
          stopping={cancelling}
          footerNotice={<>{agentUserId ? <AgentFailureSlot agentUserId={agentUserId} /> : null}<SessionInputQueue sessionId={session.conversationId} waitingForConnection={!answering} inTranscript={drawnInputIds} />{actionErrorNotice}</>}
          onAtBottom={native ? nativeRecord.loadNewer : undefined}
          historyReady={!native || nativeRecord.record !== null} historyCursor={native ? nativeRecord.record?.nextCursor : undefined}
          onLoadOlder={native ? nativeRecord.loadOlder : loadOlder}
          onLoadToolImage={loadToolImage}
          emptyNote={answering && (phase === 'loading' || timeline.turns.length > 0) ? (
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
