import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cloudComputerFailureKind, type CloudComputerFailureKind, type CloudComputerSnapshot } from '@gugu/core/cloud/cloudComputer'
import type { Device } from '@gugu/core/shared/types/chat'
import { Check, Circle, Plus, X } from '@/lib/icons'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { cn } from '../../lib/cn'
import { rendererLogger } from '../../lib/log'
import {
  destroyCloudComputer,
  provisionCloudComputer,
  refreshCloudComputer,
  wakeCloudComputer,
} from '../../lib/cloudComputerStore'
import type { BoundAgentsState } from '../../lib/deviceRowModel'
import { cloudComputerProvisionSteps, type CloudComputerStepStatus } from '../../lib/cloudComputerStore'
import { Button } from '../ui/Button'
import { Sheet } from '../ui/Sheet'
import { InlineAction } from './addServer/InlineAction'
import { calloutClassName } from './addServer/callout'

// #7199 个人助理的家(实现上叫云电脑,一人一台)的开通、状态、关闭:只用在「助理」App 里(开通引导、齿轮)。
// owner 10-15「云电脑对用户完全不可见」:设置 → 设备不再列它,这里的话说的一律是它本人 ——
//  · 还没有:「开通个人助理」;免费档点了就地说「个人助理是 Plus 及以上的权益」;
//  · 正在准备:就地一块进度(❌ 叠弹窗),三步按看得到的事实打勾;失败当场说原因;
//  · 开好之后:只说真实读数 —— 在线 / 连不上(带原因与重试);收回着、正在起来 ❌ 说(owner 10-17:Agent 没有休息这回事,
//    那是后台资源的事);关闭要再确认、写清一起删掉什么。

const log = rendererLogger('cloud-computer')
const text = 'text-[length:var(--font-body)] leading-[1.5]'
const caption = 'text-[length:var(--font-caption)] leading-[1.5]'

/** 给人看的只有那几类原因(common 词条 `cloudComputer.reason.*`);管家原话、异常原文进日志。 */
export type CloudComputerActionFailure = { kind: CloudComputerFailureKind }
type ActionFailure = CloudComputerActionFailure

function failureOf(error: unknown, action: string): ActionFailure {
  log.warn({ err: String((error as Error)?.message ?? error), action }, 'cloud computer action failed')
  return { kind: cloudComputerFailureKind(error) }
}

/** 没成的原因 → 一句话 + 句尾动作。免费档 / 积分用完各有自己的去处,别的是「没开成：」「没能唤醒：」+ 那一类原因。 */
export function CloudComputerRefusal({
  failure,
  prefixKey,
  onUpgrade,
  onRetry,
  onCancel,
}: {
  failure: ActionFailure
  /** 原因前面那半句(「没开成：」「没能唤醒：」)。 */
  prefixKey: 'devices.cloud.provisionFailed' | 'devices.cloud.wakeFailed'
  onUpgrade?: () => void
  onRetry?: () => void
  onCancel?: () => void
}) {
  const { t } = useTranslation('settings')
  const { t: tc } = useTranslation('common')
  const tone =
    failure.kind === 'plan_required' || failure.kind === 'credits_exhausted' || failure.kind === 'membership_expired'
      ? 'warn'
      : 'danger'
  return (
    <div className={calloutClassName(tone)} role="alert" data-testid="cloud-computer-refusal" data-kind={failure.kind}>
      <div className={cn(text, 'text-[var(--fg)]')}>
        {failure.kind === 'plan_required' ? (
          <>
            {t('devices.cloud.planRequired')}
            {onUpgrade && <>{' '}<InlineAction onClick={onUpgrade} testId="cloud-computer-upgrade">{t('devices.cloud.upgrade')}</InlineAction></>}
          </>
        ) : failure.kind === 'credits_exhausted' ? (
          <>
            {t('devices.cloud.creditsExhausted')}
            {onUpgrade && <>{' '}<InlineAction onClick={onUpgrade} testId="cloud-computer-top-up">{t('devices.cloud.topUp')}</InlineAction></>}
          </>
        ) : (
          <>
            {t(prefixKey)}{tc(`cloudComputer.reason.${failure.kind}`)}
            {onRetry && <>{' '}<InlineAction onClick={onRetry} testId="cloud-computer-retry">{t('devices.retry')}</InlineAction></>}
            {onCancel && <>{t('devices.cloud.or')}<InlineAction onClick={onCancel} testId="cloud-computer-cancel-provision">{t('devices.cloud.cancelProvision')}</InlineAction></>}
          </>
        )}
      </div>
    </div>
  )
}

/** 页头那颗「开一台云电脑」:只在问到「还没有」时出现(一人一台,没问到就不知道能不能开)。 */
export function OpenCloudComputerButton({
  primary,
  onFailure,
}: {
  primary?: boolean
  onFailure: (failure: ActionFailure | null) => void
}) {
  const { t } = useTranslation('settings')
  const [opening, setOpening] = useState(false)
  const open = useCallback(async () => {
    setOpening(true)
    onFailure(null)
    try {
      await provisionCloudComputer()
    } catch (error) {
      onFailure(failureOf(error, 'provision'))
    } finally {
      setOpening(false)
    }
  }, [onFailure])
  return (
    <Button
      size="sm"
      variant={primary ? 'primary' : 'secondary'}
      className="shrink-0"
      disabled={opening}
      onClick={() => void open()}
      data-testid="settings-open-cloud-computer"
    >
      {opening ? <LoadingIndicator size="inline" /> : <Plus aria-hidden className="size-4" />}
      {opening ? t('devices.cloud.opening') : t('devices.cloud.open')}
    </Button>
  )
}


function StepIcon({ status }: { status: CloudComputerStepStatus }) {
  if (status === 'running') return <LoadingIndicator size="inline" className="text-live" />
  if (status === 'done') return <Check aria-hidden className="size-4 text-[var(--fg)]" />
  return <Circle aria-hidden className="size-4 text-[var(--faint-fg)]" />
}

function elapsedText(since: string | null, now: number): string | null {
  const start = since ? Date.parse(since) : NaN
  if (!Number.isFinite(start)) return null
  const seconds = Math.max(0, Math.floor((now - start) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** 开通进度那一块:就地展开在设备列表上方。出错时原因 + 「重试」「取消开通」。 */
export function CloudComputerProvisionPanel({
  snapshot,
  device,
  onUpgrade,
  retryProvision,
}: {
  snapshot: CloudComputerSnapshot
  device: Device | null
  onUpgrade?: () => void
  /** 开通就出错(还没有设备)时「重试」怎么再开通一次;不给 = 照默认(不带助理的名字与形象)。 */
  retryProvision?: () => Promise<void>
}) {
  const { t } = useTranslation('settings')
  const [now, setNow] = useState(() => Date.now())
  const [failure, setFailure] = useState<ActionFailure | null>(null)
  const failed = snapshot.state === 'error'
  useEffect(() => {
    if (failed) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [failed])
  const steps = cloudComputerProvisionSteps(snapshot, device)
  const elapsed = elapsedText(snapshot.since, now)

  // 开通就出错(还没有 deviceId):重来一次 = 再开通;有了 deviceId(建助理没成)= /wake,管家会补建。
  const retry = useCallback(async () => {
    setFailure(null)
    try {
      if (snapshot.deviceId) await wakeCloudComputer()
      else if (retryProvision) await retryProvision()
      else await provisionCloudComputer()
    } catch (error) {
      setFailure(failureOf(error, 'retry provision'))
    }
  }, [snapshot.deviceId, retryProvision])
  const cancel = useCallback(async () => {
    setFailure(null)
    try {
      await destroyCloudComputer()
    } catch (error) {
      setFailure(failureOf(error, 'cancel provision'))
    }
  }, [])

  return (
    <div
      className="flex flex-col gap-3 rounded-[var(--radius-document)] bg-foreground/[0.025] p-[13px] dark:bg-foreground/[0.04]"
      role="region"
      aria-label={t('devices.cloud.title')}
      data-testid="settings-cloud-computer-provision"
      data-state={snapshot.state}
    >
      <div className={cn(text, 'font-semibold text-[var(--fg)]')}>{t('devices.cloud.provisioningTitle')}</div>
      <ol className="m-0 flex list-none flex-col gap-2 p-0" aria-live="polite">
        {steps.map((step) => {
          const stuck = failed && step.status === 'running'
          return (
            <li key={step.id} className="flex items-start gap-2" data-step={step.id} data-status={stuck ? 'failed' : step.status}>
              <span className="flex h-[21px] shrink-0 items-center">
                {stuck ? <X aria-hidden className="size-4 text-[var(--danger)]" /> : <StepIcon status={step.status} />}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className={cn(text, step.status === 'pending' ? 'text-[var(--faint-fg)]' : 'text-[var(--fg)]', stuck && 'font-semibold')}>
                  {t(`devices.cloud.steps.${step.id}`)}
                </div>
                {step.id === 'machine' && step.status === 'running' && !failed && (
                  <div className={cn(caption, 'text-[var(--faint-fg)]')}>
                    {elapsed ? t('devices.cloud.stepDetail.minutesElapsed', { elapsed }) : t('devices.cloud.stepDetail.minutes')}
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ol>
      {failed && (
        <CloudComputerRefusal
          failure={failure ?? { kind: 'failed' }}
          prefixKey="devices.cloud.provisionFailed"
          onUpgrade={onUpgrade}
          onRetry={() => void retry()}
          onCancel={() => void cancel()}
        />
      )}
      {!failed && failure && <CloudComputerRefusal failure={failure} prefixKey="devices.cloud.provisionFailed" onUpgrade={onUpgrade} />}
    </div>
  )
}

/**
 * 设备行上云电脑那一格状态(替掉「在线 / 上次在线」):在线;开通中;收回着 / 正在起来 = 不说(owner 10-17 ❌「休息中 / 正在醒来」);
 * 出错(连不上、建助理没成)时是「连不上：云电脑那边出了问题。」+ 「重试」(/wake);管家那句原因进日志(store)。
 */
export function CloudComputerRowStatus({
  device,
  snapshot,
  onUpgrade,
  provisionShown = false,
}: {
  device: Device
  snapshot: CloudComputerSnapshot
  onUpgrade?: () => void
  /** 开通进度那一块正摆着:出错的原因与「重试」在那一块里说,行上只说「没开成」(❌ 说两遍)。 */
  provisionShown?: boolean
}) {
  const { t } = useTranslation('settings')
  const { t: tc } = useTranslation('common')
  const [failure, setFailure] = useState<ActionFailure | null>(null)
  const wake = useCallback(async () => {
    setFailure(null)
    try {
      await wakeCloudComputer()
    } catch (error) {
      setFailure(failureOf(error, 'wake'))
    }
  }, [])
  if (failure) {
    return (
      <span className="text-[var(--danger)]" data-testid="settings-cloud-computer-status" data-status="wake-failed">
        {failure.kind === 'credits_exhausted'
          ? <>{t('devices.cloud.creditsExhausted')}{onUpgrade && <>{' '}<InlineAction onClick={onUpgrade}>{t('devices.cloud.topUp')}</InlineAction></>}</>
          : <>{t('devices.cloud.wakeFailed')}{tc(`cloudComputer.reason.${failure.kind}`)}{' '}<InlineAction onClick={() => void wake()}>{t('devices.retry')}</InlineAction></>}
      </span>
    )
  }
  if (snapshot.state === 'error' && provisionShown) {
    return <span className="text-[var(--danger)]" data-testid="settings-cloud-computer-status" data-status="error">{t('devices.cloud.provisionFailedShort')}</span>
  }
  if (snapshot.state === 'error') {
    return (
      <span className="text-[var(--danger)]" data-testid="settings-cloud-computer-status" data-status="error">
        {t('devices.cloud.wakeFailed')}{tc('cloudComputer.reason.failed')}{' '}
        <InlineAction onClick={() => void wake()} testId="settings-cloud-computer-wake-retry">{t('devices.retry')}</InlineAction>
      </span>
    )
  }
  const presence = device.cloud_computer
  if (presence === 'asleep' || presence === 'waking') return null
  if (presence || snapshot.state === 'provisioning') {
    const key = presence ?? 'provisioning'
    return <span data-testid="settings-cloud-computer-status" data-status={key}>{t(`devices.cloud.presence.${key}`)}</span>
  }
  // 管家那边已经没有它(刚关掉、列表还没刷新):照这一行本来的在线与否说。
  return <span data-testid="settings-cloud-computer-status" data-status="plain">{t(device.is_online ? 'devices.online' : 'devices.offline')}</span>
}

/**
 * 状态点:运行中 = live 实心;离线 = 墨色。收回着 / 正在起来 = 不画(#7199 owner 10-17:那是后台资源的事,
 * ❌ 说「休眠中 / 正在醒来」—— 旁边那句已经不说了,点也 ❌ 用空心圈、呼吸去说同一件事)。
 */
export function CloudComputerDot({ device }: { device: Device }) {
  const presence = device.cloud_computer
  if (presence === 'asleep' || presence === 'waking') return null
  return (
    <span
      aria-hidden
      data-presence={presence ?? 'none'}
      className={cn(
        'size-[7px] shrink-0 rounded-[var(--radius-circle)]',
        presence === 'awake' || device.is_online ? 'bg-live' : 'bg-[var(--faint-fg)]',
      )}
    />
  )
}

/**
 * 「关掉云电脑」的确认页:写清上面的会话、文件、智能体一起删掉、不能恢复,列出上面的智能体。
 * 管家删干净(设备行、智能体、沙盒、存的数据)才回成功;回来后刷新列表,那一行要是还在,照「移除这台机器(连同智能体)」补删一遍。
 */
export function CloudComputerCloseDialog({
  device,
  agents,
  onClose,
  onClosed,
}: {
  device: Device
  agents: BoundAgentsState
  onClose: () => void
  /** 管家删完之后:刷新列表、行还在就补删。 */
  onClosed: () => Promise<void>
}) {
  const { t } = useTranslation('settings')
  const { t: tc } = useTranslation('common')
  const [closing, setClosing] = useState(false)
  /** 没关掉(那一类原因)/ 关掉了但行没删掉。 */
  const [failure, setFailure] = useState<ActionFailure | 'listed' | null>(null)
  const confirm = useCallback(async () => {
    setClosing(true)
    setFailure(null)
    try {
      // DELETE / 删的是管家此刻那一台:先核对还是这一行(❌ 别处关掉又开了一台新的,这里一点就把新的删了)。
      const current = await refreshCloudComputer()
      if (current?.deviceId !== device.device_id) {
        log.warn({ deviceId: device.device_id, current: current?.deviceId ?? null }, 'close dialog is stale; not destroying')
        setFailure({ kind: 'gone' })
        setClosing(false)
        return
      }
      await destroyCloudComputer()
    } catch (error) {
      setFailure(failureOf(error, 'destroy'))
      setClosing(false)
      return
    }
    try {
      await onClosed()
      onClose()
    } catch (error) {
      log.error({ err: String((error as Error)?.message ?? error), deviceId: device.device_id }, 'remove closed cloud computer row failed')
      setFailure('listed')
      setClosing(false)
    }
  }, [device.device_id, onClose, onClosed])

  return (
    <Sheet
      onClose={closing ? () => undefined : onClose}
      desktopWidth="400px"
      desktopMaxHeight="80vh"
      mobileFitContent
      ariaLabel={t('devices.cloud.close.label', { name: device.label })}
      testId="settings-cloud-computer-close-dialog"
      zIndex="var(--z-settings-modal)"
    >
      <div className="flex flex-col gap-3 overflow-y-auto p-[18px]">
        <div className="text-[length:var(--font-title)] font-semibold text-[var(--fg)]">{t('devices.cloud.close.title', { name: device.label })}</div>
        <div className={cn(text, 'text-[var(--muted-fg)]')}>{t('devices.cloud.close.body')}</div>
        {agents.loading && <div className={cn(text, 'text-[var(--muted-fg)]')}>{t('devices.checkingAgents')}</div>}
        {!agents.loading && agents.agents.length > 0 && (
          <div className="flex flex-col gap-2">
            <div className={cn(text, 'text-[var(--muted-fg)]')}>{t('devices.cloud.close.agents', { count: agents.agents.length })}</div>
            <div className="flex max-h-40 flex-col gap-[5px] overflow-y-auto rounded-[var(--radius-document)] bg-foreground/[0.025] px-[10px] py-2 dark:bg-foreground/[0.04]">
              {agents.agents.map((agent) => (
                <div key={agent.id} className={cn(text, 'truncate text-[var(--fg)]')}>{agent.display_name}</div>
              ))}
            </div>
          </div>
        )}
        {failure && (
          <div className={cn(text, 'text-[var(--danger)]')} role="alert">
            {failure === 'listed' ? t('devices.cloud.close.closedButListed') : <>{t('devices.cloud.close.failed')}{tc(`cloudComputer.reason.${failure.kind}`)}</>}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button size="sm" onClick={onClose} disabled={closing}>{t('devices.cancel')}</Button>
          <Button size="sm" variant="danger" disabled={closing || agents.loading} onClick={() => void confirm()} data-testid="settings-cloud-computer-close-confirm">
            {closing ? t('devices.cloud.close.closing') : t('devices.cloud.close.confirm')}
          </Button>
        </div>
      </div>
    </Sheet>
  )
}

/** 读不到管家时页头下面那一句 + 「重试」(❌ 当成没有云电脑、把「开一台」摆出来)。 */
export function CloudComputerLoadError({ kind }: { kind: CloudComputerFailureKind }) {
  const { t } = useTranslation('settings')
  const { t: tc } = useTranslation('common')
  return (
    <div className={cn(caption, 'text-[var(--danger)]')} data-testid="settings-cloud-computer-load-error" data-kind={kind}>
      {t('devices.cloud.stateFailed')}{tc(`cloudComputer.reason.${kind}`)}{' '}
      <InlineAction onClick={() => void refreshCloudComputer().catch(() => undefined)}>{t('devices.retry')}</InlineAction>
    </div>
  )
}
