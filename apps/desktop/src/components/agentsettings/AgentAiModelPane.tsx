import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  isModelAccessProtocol,
  engineIdForAgentType,
  type AgentModelSelection,
  type ModelAccessProtocol,
} from '@gugu/core/shared/agentModelSelection'
import type { AgentSettingsPaneProps } from './types'
import { rendererLogger } from '../../lib/log'
import { agentSettingsPaneClass, asClass } from './agentSettingsStyles'
import {
  fetchPlatformModelCatalog,
  platformProtocolForAgentType,
  readAgentModelSelection,
  setAgentModelSelection,
  type AgentModelSelectionOutcome,
  type AgentModelSelectionState,
  type PlatformCatalogModel,
} from '../../lib/agentModelSelection'
import { GUGU_BILLING_URL } from '../../lib/appLinks'
import { AgentModelPicker } from './AgentModelPicker'
import { Button } from '../ui/Button'
import { fetchAgentHarnessModels } from '../../lib/agentModelSelection'
import { useDevicesStore } from '../../store/devicesContext'
import { platform } from '../../platform'
import type { SessionpageSessionCreateModels } from '@gugu/session-core/session-record/contract'
import { assembleComposerModelOptions, composerModelSelection } from '@/session/renderer/features/sessions/session-config/use-composer-model-options'
import { platformOptionId } from '@/session/shared/platform-model-id'
import type { ComposerModelOption } from '@gugu/session-ui/react/components'
import { offeredInModelPicker } from '@/session/shared/core/agents/platform-model'
import { useMyAssistant } from '@/lib/myAssistant'

function selectionValue(selection: AgentModelSelection): string {
  if (selection.source === 'default') return 'default'
  if (selection.source === 'byok') return `byok:${selection.modelId}`
  return `platform:${selection.protocol}:${selection.modelId}`
}

function parseSelection(value: string): AgentModelSelection {
  if (value === 'default') return { source: 'default' }
  if (value.startsWith('byok:')) return { source: 'byok', modelId: value.slice(5) }
  const match = /^platform:([a-z-]+):(.+)$/.exec(value)
  if (match && isModelAccessProtocol(match[1])) {
    return { source: 'platform', protocol: match[1], modelId: match[2] }
  }
  return { source: 'default' }
}

function sameSelection(a: AgentModelSelection, b: AgentModelSelection | null): boolean {
  return b !== null && selectionValue(a) === selectionValue(b)
}

/**
 * 与会话输入框同一张模型菜单；harness保留，只改模型与额度来源。
 * 原有配置保留开通时的选择；自有订阅目录从助理所在设备读取，平台模型另成一组。
 * 所在设备与harness是两个维度，不能把控制端本机订阅当作远端凭据。
 *
 * #5276 这一页在桌面与手机上是**同一条路**:目录问服务端、当前值读云端 `agent_model_selections`、
 * 写走 RPC 投设备命令,再等设备把它落下。❌ 不再经 Electron IPC —— 那条路只有跑 Agent 的那台机器
 * 自己走得通,手机上恒禁用。desired 与 applied 分开显示:设备还没落下就说「待设备生效」,
 * 设备拒了就把原话摆出来,❌ 不把「写进云里了」说成「已生效」。
 */
const paneLog = rendererLogger('agents/model-pane')

export function AgentAiModelPane({ agent }: AgentSettingsPaneProps) {
  const { t } = useTranslation('agents')
  const { devices, cloudComputer } = useDevicesStore()
  const mine = useMyAssistant(agent.owner_user_id, agent.id)
  const cloudOnly = (mine.agentId === agent.id || mine.loading) && Boolean(agent.device_id
    && (devices.some(device => device.device_id === agent.device_id && device.cloud_computer !== undefined)
      || cloudComputer?.snapshot?.deviceId === agent.device_id))
  const isLocal = platform.capabilities.agentRuntime && devices.some((device) => device.device_id === agent.device_id && device.is_current_device)
  const engine = agent.agent_type ? engineIdForAgentType(agent.agent_type) : null
  const [harness, setHarness] = useState<SessionpageSessionCreateModels | null>(null)
  const [harnessFailed, setHarnessFailed] = useState(false)
  const [harnessAttempt, setHarnessAttempt] = useState(0)
  const protocol: ModelAccessProtocol | null = platformProtocolForAgentType(agent.agent_type)
  const [catalog, setCatalog] = useState<PlatformCatalogModel[] | null>(null)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [state, setState] = useState<AgentModelSelectionState | null>(null)
  const [value, setValue] = useState('default')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<AgentModelSelectionOutcome | null>(null)
  const requestEpoch = useRef(0)
  const applying = useRef(false)

  useEffect(() => {
    let live = true
    requestEpoch.current += 1
    applying.current = false
    setSaving(false)
    setState(null)
    setCatalog(null)
    setCatalogError(null)
    setError(null)
    setOutcome(null)
    readAgentModelSelection(agent.id)
      .then((next) => {
        if (!live) return
        setState(next)
        setValue(selectionValue(next.desired))
      })
      .catch((cause: unknown) => { if (live) setError((cause as Error).message) })
    // 引擎说不了平台协议就不问目录:问回来也一条都列不出,还会把「目录拉不到」误报成这个 Agent 的问题。
    if (protocol) {
      fetchPlatformModelCatalog()
        .then((models) => { if (live) setCatalog(models) })
        // 服务端原文(测试库没配网关时是 `model access server is not configured`)只进日志,界面说一句人话。
        .catch((cause: unknown) => {
          paneLog.warn({ agentId: agent.id, error: String(cause) }, 'platform model catalog unavailable')
          if (live) setCatalogError(t('settings.model.catalogUnavailable'))
        })
    } else {
      setCatalog([])
    }
    return () => { live = false; requestEpoch.current += 1 }
  }, [agent.id, protocol, t])

  useEffect(() => {
    let live = true
    setHarness(null)
    setHarnessFailed(false)
    if (agent.device_id && engine && !cloudOnly) {
      fetchAgentHarnessModels(agent.device_id, engine, isLocal)
        .then((models) => { if (live) setHarness(models) })
        .catch((cause: unknown) => {
          paneLog.warn({ agentId: agent.id, error: String(cause) }, 'agent device model catalog unavailable')
          if (live) setHarnessFailed(true)
        })
    }
    return () => { live = false }
  }, [agent.id, agent.device_id, engine, isLocal, harnessAttempt, cloudOnly])

  // 存着的那一项:它要会员了(会员到期)、或被他在设置「模型」页关掉了,也照列 —— 下拉显示的就是它。
  const savedValue = state ? selectionValue(state.desired) : null
  const platformOptions = useMemo(() => (catalog ?? [])
    .filter((model) => model.enabled && protocol !== null && model.protocols.includes(protocol))
    // 与模型下拉同一个判据(#7056):只列点得中、跑得起来的,❌ 列一条选了就被拒的。
    .filter((model) => offeredInModelPicker(model) || `platform:${protocol}:${model.id}` === savedValue)
    .map((model) => ({
      value: `platform:${protocol}:${model.id}`,
      label: model.displayName,
      membersOnly: model.requiresMembership,
    })),
  [catalog, protocol, savedValue])
  // 选着的这一项要会员(会员到期):说清楚,给一条去网页续费的路。
  const lockedSelection = platformOptions.find((option) => option.value === value && option.membersOnly) ?? null

  const originalOption = '__assistant_original_config__'
  const ownOptions: Record<string, ComposerModelOption> = {}
  if (!cloudOnly && harness?.harnessState === 'ready') {
    for (const model of harness.models) {
      if (model.source === 'harness') ownOptions[model.id] = { name: model.name, description: model.description }
    }
  }
  const options = assembleComposerModelOptions(ownOptions, (catalog ?? []).filter((model) =>
    model.enabled && protocol !== null && model.protocols.includes(protocol)).map((model) => ({
      ...model, creditMultiplier: model.creditMultiplier ?? null, contextWindow: model.contextWindow ?? null,
    })), engine ?? '', undefined, state?.desired.source === 'platform' ? state.desired.modelId : null) ?? ownOptions
  const current = parseSelection(value)
  const selectedOption = current.source === 'default' ? originalOption
    : current.source === 'byok' ? current.modelId : platformOptionId(current.modelId)
  if (current.source !== 'default' && !options[selectedOption]) options[selectedOption] = { name: current.modelId }
  const items = [...(!cloudOnly || current.source === 'default' ? [{ id: originalOption, name: t('settings.model.original'), description: t('settings.model.originalSourceNote') }] : []),
    ...Object.entries(options).filter(([id]) => !cloudOnly || id.startsWith('platform:')).map(([id, option]) => ({ id, ...option }))]

  // 能改的前提:Agent 绑了设备(没有谁能把选择变成事实,RPC 会拒)且当前值已读到。
  const canEdit = Boolean(agent.device_id) && state !== null && !saving
  const usingPlatform = value.startsWith('platform:')
  const pendingOnDevice = state !== null
    && state.applyError === null
    && !sameSelection(state.desired, state.applied)
    && !(state.applied === null && state.desired.source === 'default')

  const save = async (nextValue: string) => {
    if (!canEdit || applying.current) return
    const epoch = requestEpoch.current
    applying.current = true
    setValue(nextValue)
    setSaving(true)
    setError(null)
    setOutcome(null)
    try {
      const selection = parseSelection(nextValue)
      const result = await setAgentModelSelection(agent.id, selection)
      if (epoch !== requestEpoch.current) return
      setOutcome(result)
      // 写完重读:desired / applied / apply_error 都以云端为准,❌ 不用本地猜一份「应该已经变成这样」。
      const next = await readAgentModelSelection(agent.id)
      if (epoch !== requestEpoch.current) return
      setState(next)
      if (result.ok) setValue(selectionValue(next.desired))
    } catch (cause) {
      if (epoch === requestEpoch.current) setError((cause as Error).message)
    } finally {
      if (epoch === requestEpoch.current) {
        applying.current = false
        setSaving(false)
      }
    }
  }

  // 设备拒了 ⇒ 原话原样摆出来(behavior:「设备拒了就把原话摆出来」),但原话是**设备说的**,不是文案:
  // 它单独成一段,❌ 不插进翻译词条里(user-copy-leak-check 把「文案里拼 {{error}}」当泄漏;这里两件事分开)。
  const deviceError = outcome !== null && !outcome.ok
    ? outcome.error
    : state?.applyError ?? null
  const outcomeText = outcome === null
    ? null
    : outcome.ok
      ? `${t(
        outcome.applied === 'hot'
          ? 'settings.model.appliedHot'
          : outcome.applied === 'reload'
            // #6247 重开后原生会话接没接回来由设备读实际 session id 说;旧设备不带这一格 ⇒ 中性,❌ 猜「续上历史」。
            ? outcome.nativeSession === 'preserved'
              ? 'settings.model.appliedReloadPreserved'
              : outcome.nativeSession === 'replaced'
                ? 'settings.model.appliedReloadReplaced'
                : 'settings.model.appliedReload'
            : 'settings.model.appliedNextSession',
      )}${outcome.warning ? ` ${outcome.warning}` : ''}`
      : t('settings.model.applyFailed')

  return (
    <div className={agentSettingsPaneClass(true)}>
      <div className={asClass.aiModelLabel}>{t('settings.model.label')}</div>
      <AgentModelPicker items={items} value={selectedOption} disabled={!canEdit} onChange={(optionId) => {
        const chosen = composerModelSelection(optionId)
        if (cloudOnly && (optionId === originalOption || chosen.source === 'own')) return
        const next = optionId === originalOption ? 'default' : selectionValue(chosen.source === 'own'
          ? { source: 'byok', modelId: chosen.modelId }
          : { source: 'platform', protocol: protocol!, modelId: chosen.modelId })
        if (next !== value) void save(next)
      }} />
      {!usingPlatform && (harnessFailed ? <div className={asClass.aiModelArd} role="status">{t('settings.model.deviceCatalogUnavailable')} <Button variant="ghost" size="sm" onClick={() => setHarnessAttempt((attempt) => attempt + 1)}>{t('settings.model.retryCatalog')}</Button></div>
        : harness?.harnessState === 'auth-required' ? <div className={asClass.aiModelArd}>{t('settings.model.deviceSubscriptionMissing')}</div> : null)}
      <div className={asClass.aiModelArd} role="status">
        {saving ? t('settings.model.applying') : error
          || outcomeText
          || catalogError
          || (!agent.device_id && t('settings.model.noDevice'))
          || (state?.applyError && t('settings.model.applyFailed'))
          || (pendingOnDevice && t('settings.model.pendingOnDevice'))
          || (!protocol && t('settings.model.noPlatformForEngine'))
          || (value === 'default' ? t('settings.model.originalSourceNote') : usingPlatform
            // 窗口长度是运营可改的配置,这里拿不到 —— 写死「5 小时」会在改配置后变成假话。
            // 具体数字归积分面板讲,它手上有服务端返回值。
            ? t('settings.model.billed')
            : t('settings.model.own'))}
      </div>
      {deviceError && (
        <div className={asClass.aiModelArd} data-testid="agent-model-device-error">{deviceError}</div>
      )}
      {/* 买会员只在网页面板(GUGU_BILLING_URL 抬头写了为什么);<a target="_blank"> 交给系统浏览器,与积分面板同一条路。 */}
      {lockedSelection && (
        <div className={asClass.aiModelArd} data-testid="agent-model-members-only">
          {t('settings.model.membersOnlyHint', { model: lockedSelection.label })}{' '}
          <a href={GUGU_BILLING_URL} target="_blank" rel="noreferrer" className="underline">
            {t('settings.model.membersOnlyAction')}
          </a>
        </div>
      )}
      {/* 手机上拿不到活会话的清单,判不出热切还是重开 —— 如实说两种可能,而不是假装知道。 */}
      <div className={asClass.aiModelArd}>{t('settings.model.liveSessionHint')}</div>
      {(error || deviceError) && <Button variant="ghost" size="sm" disabled={!canEdit} onClick={() => void save(value)}>{t('settings.model.retryApply')}</Button>}
    </div>
  )
}
