import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rendererLogger } from '@/lib/log'
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from '@assistant-ui/react'
import type { Device } from '@gugu/core/shared/types/chat'
import type {
  SessionpageSessionCreateModels,
  SessionpageSessionCreateOptions,
  SessionpageSessionSummary,
} from '@gugu/session-core/session-record/contract'
import { Thread } from '@/components/assistant-ui/thread.aui'
import { ComposerExtrasProvider } from '@/components/assistant-ui/composer-extras'
import { Button } from '@/components/ui/Button'
import { AgentWatchNote, AgentWatchScreen } from './AgentWatchChrome'
import { LiveGlyph } from './StatusGlyph'
import { CreateOptionsPill } from './CreateOptionsPill'
import { OfflineNote } from './OfflineNote'
import { CloudComputerNote } from './CloudComputerNote'
import { useCloudComputerWake } from '../../hooks/useWakeCloudComputer'
import { guguReasonInText, remoteFailureKind } from '@gugu/session-core/session-record/contract'
import { guguReasonText } from '@renderer/features/sessions/gugu-reason'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import { SessionpageRpcError, createSession, fetchCreateModels, fetchCreateOptions } from './sessionpage-rpc'
import {
  createBlocker,
  initialSelection,
  lastUsedDropped,
  reconcileModel,
  toSessionSummary,
  type CreateSelection,
  type LastUsedItem,
} from './create-session-form'

const createLog = rendererLogger('mobile/agent-watch')

/** 「没沿用上」那句话里每一格叫什么 —— 与选项胶囊上的行名同一套词。 */
const LAST_USED_ITEM_LABEL_KEYS: Record<LastUsedItem, string> = {
  project: 'agentWatch.create.project',
  harness: 'agentWatch.create.harness',
  sessionView: 'agentWatch.create.view',
  permissionMode: 'agentWatch.create.permissionLabel',
  model: 'agentWatch.create.model',
  effort: 'agentWatch.create.effort',
}

/**
 * 第四张页:在**这台机器上**开一条新会话。
 *
 * owner 2026-09-06:「新建任务应该是先选择设备再新建任务」「手机端的话,我建议是和你手机端会话
 * 一个输入框,然后是也 assistant 的组件」。所以:
 *   · 进这一页之前设备已经选定(从机器页的 + 走一遍选机器,或在某台机器的会话页直接 +);
 *   · 界面就是会话页那一套 —— 同一个官方 `Thread`、同一个输入框、同一颗选项胶囊(这里选的是
 *     项目 · harness),只是线程是空的。❌ 不再渲桌面会话页那张 composer:它是给 IDE 面画的。
 *   · 发送 = 建会话。建成直接跳进新会话的时间线,第一句话就在那儿。
 *
 * 发送失败**把那句话还给输入框**:assistant-ui 在发送时就清空了输入框,不还回去的话
 * 一次网络抖动就吞掉人打了半天的开场白 —— 那正是本仓禁止的「不持久化的输入」。
 */
function describe(err: unknown): string {
  if (err instanceof SessionpageRpcError) return `${err.message} (${err.code})`
  return err instanceof Error ? err.message : String(err)
}

export function CreateSessionPage({
  device,
  birthGroup = null,
  onClearBirthGroup,
  onBack,
  onCreated,
}: {
  device: Device
  /** 群成员里点的「新建 Agent」:建出来的 agent 一出生就进这个群(请求的 chatId)。null = 不进群。 */
  birthGroup?: { chatId: string; name: string } | null
  onClearBirthGroup?: () => void
  onBack: () => void
  /** 建成了:带着攒好的摘要与那句话跳进时间线(那句由时间线页接着画)。 */
  onCreated: (session: SessionpageSessionSummary, firstPrompt: string) => void
}) {
  const { t } = useTranslation('main')
  const online = device.is_online
  // #7199 在睡着的云电脑上新建 = 叫醒它;醒了(在线)选项照常读出来。
  const { issue: wakeIssue, dropped: wakeDropped, retry: retryWake } = useCloudComputerWake(device)
  const [options, setOptions] = useState<SessionpageSessionCreateOptions | null>(null)
  const [optionsError, setOptionsError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [selection, setSelection] = useState<CreateSelection>({ projectId: null, harness: null, model: null, sessionView: null, permissionMode: null, effort: null })
  /** 人动过选择没有 —— 动过之后「上次那一套没沿用上」就不再说(那是人自己的改动)。 */
  const [touched, setTouched] = useState(false)
  /** 选定 harness 的模型目录 —— 按 harness 现探,换家就重读;探不到不拦发送(默认档照建)。 */
  const [models, setModels] = useState<SessionpageSessionCreateModels | null>(null)
  const [modelsState, setModelsState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  /** 正在建的那句话;建成或失败后清空。它同时也是线程里唯一那条(乐观显示的)用户消息。 */
  const [pendingText, setPendingText] = useState<string | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)

  // 机器离线时**不发 RPC**(与会话页同一条):发过去只会等到超时,而超时长得像「机器没响应」。
  useEffect(() => {
    if (!online) return
    let cancelled = false
    setOptions(null)
    setOptionsError(null)
    setTouched(false)
    fetchCreateOptions(device.device_id)
      .then((next) => {
        if (cancelled) return
        setOptions(next)
        setSelection(initialSelection(next))
      })
      .catch((err) => { if (!cancelled) setOptionsError(describe(err)) })
    return () => { cancelled = true }
  }, [device.device_id, online, reloadKey])

  // 目录跟着 harness 走。⚠️ 目录要在那台机器上起一次 harness 进程探,几秒是常态 —— 所以它**不**挡发送:
  // 人不选模型就按默认建,目录只是「想换的话有哪些」。
  const harness = selection.harness
  const sessionView = selection.sessionView
  const model = selection.model
  useEffect(() => {
    if (!online || !harness) { setModels(null); setModelsState('idle'); return }
    let cancelled = false
    // 推理档跟着模型走(桌面同一条),所以换模型也重读;但同一家同一腿只是换模型时**不清空**清单 ——
    // 清了列表会在人刚点完那一下闪没,而且 reconcile 会把刚选的模型判成「不在目录里」清掉。
    setModels((prev) => (prev && prev.harness === harness ? prev : null))
    setModelsState('loading')
    fetchCreateModels(device.device_id, harness, sessionView, model)
      .then((next) => {
        if (cancelled) return
        setModels(next)
        setModelsState('ready')
        setSelection((current) => reconcileModel(current, next))
      })
      .catch(() => { if (!cancelled) setModelsState('failed') })
    return () => { cancelled = true }
  }, [device.device_id, online, harness, sessionView, model, reloadKey])

  const blocker = options ? createBlocker(options, selection) : null
  const creating = pendingText !== null

  const messages = useMemo<ThreadMessageLike[]>(
    () => (pendingText ? [{ role: 'user', content: [{ type: 'text', text: pendingText }] }] : []),
    [pendingText],
  )

  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    isRunning: creating,
    messages,
    convertMessage: (message) => message,
    onNew: async (message: AppendMessage) => {
      const first = message.content[0]
      if (!first || first.type !== 'text') throw new Error(t('agentWatch.composer.textOnly'))
      const text = first.text.trim()
      // 还没读到选项 / 还有拦着的原因 → 如实报,❌ 不带着空 projectId 发过去让机器来拒。
      if (!options || blocker) {
        setCreateError(t(`agentWatch.create.blocked.${blocker ?? 'loading'}`))
        runtime.thread.composer.setText(first.text)
        return
      }
      setCreateError(null)
      setPendingText(text)
      try {
        const result = await createSession(device.device_id, {
          projectId: selection.projectId!,
          harness: selection.harness!,
          prompt: text,
          ...(selection.model ? { model: selection.model } : {}),
          ...(selection.sessionView ? { sessionView: selection.sessionView } : {}),
          ...(selection.permissionMode ? { permissionMode: selection.permissionMode } : {}),
          ...(selection.effort ? { effort: selection.effort } : {}),
          ...(birthGroup ? { chatId: birthGroup.chatId } : {}),
        })
        onCreated(result.session ?? toSessionSummary(result, selection.harness!, new Date().toISOString()), text)
      } catch (err) {
        setPendingText(null)
        // 机器那边装 agent 没装成:原因进日志,人看到的是能照做的下一步(按本端语言,❌ 机器那边拼的双语原文)。
        // 其余原因同理:按原因码归类说人话(remoteFailureKind),原文只进日志。
        createLog.warn({ error: String(err) }, 'create session failed')
        const code = err instanceof SessionpageRpcError ? err.code : null
        // 签咕咕额度被拒:那台机器报的是原因码(#7103),按原因说(与新建框咕咕那一组同一份文案)。
        const gugu = guguReasonInText(code)
        setCreateError(code === 'harness_install_failed'
          ? t('agentWatch.create.agentInstallFailed')
          : code === 'harness_runtime_missing'
            ? t('agentWatch.create.agentRuntimeMissing')
            : gugu
              ? guguReasonText(gugu, translateSessionMessage)
              : t(`agentWatch.create.failure.${remoteFailureKind(code)}`))
        // 把那句话还回去。assistant-ui 发送时已经清空了输入框,这一步不做就等于吞掉用户输入。
        runtime.thread.composer.setText(first.text)
      }
    },
  })

  // 空线程的欢迎语(官方那句是「这条会话还没有内容」,对新建页口气不对)。所有 hook 都在这条早返回之前。
  const Welcome = useMemo(
    () =>
      function CreateWelcome() {
        return (
          <div className="aui-thread-welcome-root mb-6 flex flex-col items-center px-4 text-center">
            <h1 className="aui-thread-welcome-message-inner text-lg font-medium tracking-tight">
              {t('agentWatch.create.welcome', { machine: device.label })}
            </h1>
            <p className="aui-thread-welcome-hint text-muted-foreground mt-1 text-sm">
              {t('agentWatch.create.welcomeHint')}
            </p>
          </div>
        )
      },
    [t, device.label],
  )

  if (!online) {
    return (
      <AgentWatchScreen
        title={t('agentWatch.create.title')}
        subtitle={<span>{device.label}</span>}
        onBack={onBack}
        testId="agent-watch-create-page"
      >
        {device.cloud_computer === 'asleep' || device.cloud_computer === 'waking'
          ? <CloudComputerNote device={device} issue={wakeIssue} dropped={wakeDropped} onRetry={retryWake} />
          : <OfflineNote lastSeenAt={device.last_seen_at} />}
      </AgentWatchScreen>
    )
  }

  const errorNotice = createError ? (
    <div
      className="gg-aw-action-error"
      data-testid="agent-watch-create-error"
      role="alert"
      aria-live="assertive"
    >
      <span className="gg-aw-action-error-title">{t('agentWatch.create.failed')}</span>
      <span className="gg-aw-action-error-detail">{createError}</span>
      <Button
        variant="ghost"
        size="sm"
        data-testid="agent-watch-create-error-dismiss"
        onClick={() => setCreateError(null)}
      >
        {t('agentWatch.composer.dismiss')}
      </Button>
    </div>
  ) : null

  // 「为什么还不能发」钉在输入框上方,与失败横幅同一位置 —— 人看输入框时它就在眼前。
  // ⚠️ 这是**说明**,不是错误:机器上没项目是常态,❌ 不用报错的红。
  const blockerNotice = options && blocker ? (
    <div className="gg-aw-create-blocker" data-testid="agent-watch-create-blocker" data-blocker={blocker}>
      {t(`agentWatch.create.blocked.${blocker}`)}
    </div>
  ) : null

  // 生在哪个群里:与上面同一种说明口气,带一个「不加入」。
  const birthGroupNotice = birthGroup ? (
    <div className="gg-aw-create-blocker gg-aw-create-birth-group" data-testid="agent-watch-create-birth-group">
      <span>{t('agentWatch.create.birthGroup', { name: birthGroup.name })}</span>
      {onClearBirthGroup ? (
        <Button variant="ghost" size="sm" onClick={onClearBirthGroup} disabled={creating}>
          {t('agentWatch.create.birthGroupSkip')}
        </Button>
      ) : null}
    </div>
  ) : null

  // 上次那一套有几格这次没沿用上:说一句为什么变了(behavior mobile-session-view),与上面那句同一种说明口气。
  const dropped = options && !touched ? lastUsedDropped(options, selection) : []
  const lastUsedNotice = dropped.length > 0 ? (
    <div className="gg-aw-create-blocker" data-testid="agent-watch-create-last-used" data-dropped={dropped.join(' ')}>
      {t('agentWatch.create.lastUsedDropped', {
        items: dropped.map((item) => t(LAST_USED_ITEM_LABEL_KEYS[item])).join(t('agentWatch.create.lastUsedJoiner')),
      })}
    </div>
  ) : null

  /*
   * 「正在开会话 / 正在读选项」摆在页头状态位(与会话页页头的状态词同一个位置),
   * ❌ 不再在输入框上方另起一条带子 —— 那一行把输入框往上顶、和页头各说一半(owner 2026-09-24 真机)。
   * 选项还没读回来时仍要说一句:机器端刚重启要做全机依赖探测,可能几十秒,
   * 不说「在读」,页面与「什么都选不了」长得一模一样(owner 2026-09-15 真机)。
   */
  const busyLabel = creating
    ? t('agentWatch.create.creating')
    : !options && !optionsError
      ? t('agentWatch.create.loadingOptions')
      : null
  const subtitle = busyLabel ? (
    <span className="gg-aw-head-status" role="status" data-testid="agent-watch-create-status">
      <LiveGlyph state="busy" />
      <span>{busyLabel}</span>
    </span>
  ) : (
    <span>{device.label}</span>
  )

  return (
    <AgentWatchScreen
      title={t('agentWatch.create.title')}
      subtitle={subtitle}
      onBack={onBack}
      testId="agent-watch-create-page"
      bodyFill={!optionsError}
    >
      {optionsError ? (
        <AgentWatchNote
          title={t('agentWatch.create.optionsFailed')}
          detail={optionsError}
          tone="danger"
          testId="agent-watch-create-options-error"
        >
          <Button variant="secondary" size="lg" onClick={() => setReloadKey((k) => k + 1)}>
            {t('agentWatch.timeline.reload')}
          </Button>
        </AgentWatchNote>
      ) : (
        <AssistantRuntimeProvider runtime={runtime}>
          <div className="gg-aw-thread-host" data-testid="agent-watch-create-thread">
            <ComposerExtrasProvider
              placeholder={t('agentWatch.create.placeholder')}
              extras={
                options ? (
                  <CreateOptionsPill
                    options={options}
                    selection={selection}
                    onChange={(next) => { setTouched(true); setSelection(next) }}
                    busy={creating}
                    models={models}
                    modelsState={modelsState}
                  />
                ) : null
              }
              above={
                errorNotice || blockerNotice || lastUsedNotice || birthGroupNotice ? (
                  <div className="gg-aw-thread-extras">
                    {errorNotice}
                    {blockerNotice}
                    {lastUsedNotice}
                    {birthGroupNotice}
                  </div>
                ) : null
              }
            >
              <Thread components={{ Welcome }} autoFocus={false} />
            </ComposerExtrasProvider>
          </div>
        </AssistantRuntimeProvider>
      )}
    </AgentWatchScreen>
  )
}
