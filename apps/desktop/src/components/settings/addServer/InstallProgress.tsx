import { rendererLogger } from '@/lib/log';
import { toast } from '@renderer/lib/hooks/use-toast';
import { messageForUser } from '@/lib/userFacingError';
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, ChevronRight, Circle, X } from '@/lib/icons'
import type { ServerSshInstallFailureReason, ServerSshInstallState, ServerSshInstallStep } from '../../../lib/serverSshInstall'
import { cn } from '../../../lib/cn'
import { platform } from '../../../platform'
import { Button } from '../../ui/Button'
import { Collapse } from '../../ui/Collapse'
import { CommandBlock } from './CommandBlock'
import { InlineAction } from './InlineAction'
import { MachineLimitNotice } from './MachineLimitNotice'
import { SshHostKeyChanged } from './SshHostKeyChanged'
import { SshPromptCard } from './SshPromptCard'
import { calloutClassName } from './callout'
import { lingerCommand, machineSummary, progressText } from './addServerFormat'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'

// #6264 SSH 一步装好的进度:五步各自亮起(照 Zed 的「Connecting → Downloading … → …」与 JetBrains 的逐步检查),
// 每一步下面一行写清此刻在做什么(系统、版本、真实字节);SSH 的提问就地问;失败说清卡在哪、为什么、下一步做什么;
// 旁边一个「查看详情」展开原始日志(照 VS Code 的 Remote-SSH 输出面板)。

const text = 'text-[length:var(--font-body)] leading-[1.5]'
const caption = 'text-[length:var(--font-caption)] leading-[1.5]'
const muted = 'text-[var(--muted-fg)]'
const faint = 'text-[var(--faint-fg)]'

// 色只说状态(design.md):正在跑的那一步是 live 蓝,做完的是墨色勾,失败是 destructive 红;
// ❌ 做完再上一层绿 —— chrome is ink,一列绿勾是装饰色。
function StepIcon({ status }: { status: ServerSshInstallStep['status'] }) {
  if (status === 'running') return <LoadingIndicator size="inline" className="text-live" />
  if (status === 'done') return <Check aria-hidden className="size-4 text-[var(--fg)]" />
  if (status === 'skipped') return <Check aria-hidden className={cn('size-4', faint)} />
  if (status === 'failed') return <X aria-hidden className="size-4 text-[var(--danger)]" />
  return <Circle aria-hidden className={cn('size-4', faint)} />
}

/**
 * 装好之后那台机器有没有出现在设备列表里(#6264):登录成功到第一下心跳之间有几秒,这几秒如实说在等。
 * waiting = 在等;slow = 等了挺久还没来(说怎么查);online = 已出现并在线。
 */
export type InstallLanding = 'waiting' | 'slow' | 'online'

/**
 * 网络到不了那台机器(❌ 不含认证失败):这类机器多半只能从它那边往外连,正好是远程隧道的用处,
 * 所以在原因那句话后面直接给「改用远程隧道」。
 */
const TUNNEL_FALLBACK_REASONS: ReadonlySet<ServerSshInstallFailureReason> = new Set([
  'hostUnresolved',
  'connectionRefused',
  'unreachable',
  'timeout',
  'connectTimeout',
])

export function InstallProgress({
  state,
  landing = null,
  canOpenNewSession,
  onAnswer,
  onCancel,
  onRetry,
  onBack,
  onDone,
  onNewSession,
  onSwitchToTunnel,
  onUpgrade,
  onRemoveMachine,
}: {
  state: ServerSshInstallState
  /** 装好之后它出现没有;还没装好时为 null。 */
  landing?: InstallLanding | null
  canOpenNewSession: boolean
  onAnswer: (value: string | null, extra?: { installKey?: boolean }) => void
  onCancel: () => void
  onRetry: () => void
  onBack: () => void
  onDone: () => void
  onNewSession: () => void
  /** 连不上时改用远程隧道;不给就不出。 */
  onSwitchToTunnel?: () => void
  /** 机器数到上限时句尾的「升级会员」(去「设置 → 会员与额度」)。 */
  onUpgrade?: () => void
  /** 机器数到上限时句尾的「移除一台机器」(收起这块、回到设备列表)。 */
  onRemoveMachine?: () => void
}) {
  const { t } = useTranslation('settings')
  const { prompt, failure, result, warnings, finished, machine } = state
  const [showLog, setShowLog] = useState(false)

  const stepLabel = (step: ServerSshInstallStep) =>
    step.id === 'connect'
      ? `${t('devices.addServer.steps.connect')} ${state.target}`
      : t(`devices.addServer.steps.${step.id}`)

  const stepDetail = (step: ServerSshInstallStep): string | null => {
    // 「登录」那一步还没轮到时也先说清会发生什么(加一个账号、不顶掉别人),其余步骤轮到了才写。
    if (step.status === 'pending' && step.id !== 'login') return null
    switch (step.id) {
      case 'connect':
        return step.status === 'running' && !prompt ? t('devices.addServer.stepDetail.connecting') : null
      case 'detect':
        if (machine) return machineSummary(machine)
        return step.status === 'running' ? t('devices.addServer.stepDetail.detecting') : null
      case 'download': {
        const parts: string[] = []
        if (step.status === 'skipped') {
          parts.push(t('devices.addServer.skipped.alreadyInstalled'))
          if (step.version) parts.push(t('devices.addServer.stepDetail.version', { version: step.version }))
          return parts.join(' · ')
        }
        if (step.upgradeFrom) {
          // 装着的太旧、连不上:说「升级到 x」,❌ 只写版本号 —— 人要知道这一步不是「已经装过」。
          parts.push(
            step.version
              ? t('devices.addServer.stepDetail.upgradeTo', { version: step.version })
              : t('devices.addServer.stepDetail.upgradeFrom', { version: step.upgradeFrom }),
          )
        } else if (step.version) parts.push(t('devices.addServer.stepDetail.version', { version: step.version }))
        const transferred = step.progress && step.progress.total !== null && step.progress.done >= step.progress.total
        // 传完之后还有校验、解包:这时换成那台机器上安装脚本此刻打的那一行,❌ 停在「100%」不动。
        if (step.status === 'running' && transferred && step.live) {
          parts.push(step.live)
        } else if (step.status === 'running' && step.progress) {
          parts.push(
            `${step.progress.phase === 'upload' ? t('devices.addServer.stepDetail.uploading') : t('devices.addServer.stepDetail.downloading')} ${progressText(step.progress)}`,
          )
        } else if (step.status === 'running' && step.live) {
          parts.push(step.live)
        }
        return parts.join(' · ') || null
      }
      case 'service':
        if (step.status === 'skipped') return t('devices.addServer.skipped.alreadyRunning')
        return step.replaces && step.status !== 'failed' ? t('devices.addServer.stepDetail.replaces', { version: step.replaces }) : null
      case 'login':
        if (machine?.alreadySignedIn) return t('devices.addServer.stepDetail.alreadySignedIn')
        if (machine && machine.others.length > 0) return t('devices.addServer.stepDetail.addAccount', { names: machine.others.join('、') })
        return null
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="add-server-progress">
      <div className={cn(text, muted)}>{t('devices.addServer.installingOn', { target: state.target })}</div>

      <ol className="m-0 flex list-none flex-col gap-2 p-0" aria-live="polite">
        {state.steps.map((step) => {
          const detail = stepDetail(step)
          const download = step.id === 'download' && step.status === 'running' ? step : null
          return (
            <li key={step.id} className="flex items-start gap-2" data-step={step.id} data-status={step.status}>
              <span className="flex h-[21px] shrink-0 items-center"><StepIcon status={step.status} /></span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className={cn(text, step.status === 'pending' ? faint : 'text-[var(--fg)]', step.status === 'failed' && 'font-semibold')}>
                  {stepLabel(step)}
                </div>
                {download?.via === 'desktop' && (
                  <div className={cn(caption, muted)}>{t('devices.addServer.stepDetail.viaDesktop')}</div>
                )}
                {detail && <div className={cn(caption, faint, 'break-words')}>{detail}</div>}
                {download?.progress && (
                  <progress
                    className={cn(
                      // 胶囊是闭集(switch / 头像 / 状态点 / 未读计数),进度条落 --radius-sm;h-1 上两者同形。
                      // 在传的那一截是 live:此刻正在发生的事只有它。
                      'h-1 w-full appearance-none overflow-hidden rounded-[var(--radius-sm)] bg-[var(--muted)]',
                      '[&::-webkit-progress-bar]:bg-[var(--muted)] [&::-webkit-progress-value]:bg-live',
                      '[&::-moz-progress-bar]:bg-live',
                    )}
                    {...(download.progress.total ? { value: download.progress.done, max: download.progress.total } : {})}
                  />
                )}
              </div>
            </li>
          )
        })}
      </ol>

      {prompt && <SshPromptCard key={prompt.id} prompt={prompt} onAnswer={onAnswer} />}

      {warnings.map((warning) => (
        <div key={warning.kind} className={calloutClassName('warn')}>
          <div className={cn(text, 'text-[var(--fg)]')}>
            {warning.kind === 'lingerMissing'
              ? t('devices.addServer.warnings.lingerMissing')
              : warning.kind === 'runsAsRoot'
                ? t('devices.addServer.warnings.runsAsRoot')
                : t('devices.addServer.warnings.noReboot')}
          </div>
          {warning.kind === 'lingerMissing' && <CommandBlock command={lingerCommand(warning.user)} />}
        </div>
      ))}

      {failure && (
        <div className={calloutClassName('danger')} role="alert" data-testid="add-server-failure">
          <div className={cn(text, 'font-semibold text-[var(--danger)]')}>
            {failure.reason === 'cancelled'
              ? t('devices.addServer.reasons.cancelled')
              : t('devices.addServer.failedAt', { step: t(`devices.addServer.steps.${failure.step}`) })}
          </div>
          {failure.reason !== 'cancelled' && (
            <div className={cn(text, 'text-[var(--fg)]')}>
              {failure.reason === 'machineLimit' ? (
                <MachineLimitNotice refusal={failure.machineLimit ?? null} onUpgrade={onUpgrade} onRemoveMachine={onRemoveMachine} />
              ) : (
                t(`devices.addServer.reasons.${failure.reason}`)
              )}
              {onSwitchToTunnel && TUNNEL_FALLBACK_REASONS.has(failure.reason) && (
                <>
                  {' '}
                  <InlineAction onClick={onSwitchToTunnel} testId="add-server-switch-to-tunnel">
                    {t('devices.addServer.switchToTunnel')}
                  </InlineAction>
                </>
              )}
            </div>
          )}
          {failure.reason === 'hostKeyChanged' && failure.hostKey && <SshHostKeyChanged hostKey={failure.hostKey} />}
          {failure.leftover && <div className={cn(caption, muted)}>{t(`devices.addServer.leftover.${failure.leftover}`)}</div>}
        </div>
      )}

      {result && (
        <div className={cn(calloutClassName('ok'), 'gap-1')} data-testid="add-server-success">
          <div className={cn(text, 'font-semibold text-[var(--fg)]')}>
            {t('devices.addServer.doneTitle')}
          </div>
          <div className={cn(text, 'text-[var(--fg)]')}>
            {result.alreadySignedIn
              ? t('devices.addServer.doneAgain', { email: result.email ?? '', hostname: result.hostname })
              : t('devices.addServer.done', { email: result.email ?? '', hostname: result.hostname })}
          </div>
          {result.others.length > 0 && <div className={cn(text, muted)}>{t('devices.addServer.others', { names: result.others.join('、') })}</div>}
          {landing && (
            <div className={cn(text, 'flex items-start gap-2', landing === 'online' ? 'text-[var(--fg)]' : muted)} aria-live="polite" data-testid="add-server-landing" data-landing={landing}>
              {landing === 'waiting' && <LoadingIndicator size="inline" className="mt-[3px] text-live" />}
              <span>{t(`devices.addServer.landing.${landing}`)}</span>
            </div>
          )}
          {/* #6264「下次免密」:答密码时勾了「以后不用再输密码」—— 正在装 / 装好了写在这里;没做成另起一块黄条。 */}
          {state.keyInstall?.status === 'working' && (
            <div className={cn(text, 'flex items-start gap-2', muted)} aria-live="polite" data-testid="add-server-key-install" data-status="working">
              <LoadingIndicator size="inline" className="mt-[3px]" />
              <span>{t('devices.addServer.keyInstall.working')}</span>
            </div>
          )}
          {state.keyInstall?.status === 'installed' && (
            <div className={cn(text, 'text-[var(--fg)]')} aria-live="polite" data-testid="add-server-key-install" data-status="installed">
              {t('devices.addServer.keyInstall.installed')}
            </div>
          )}
        </div>
      )}

      {state.keyInstall?.status === 'failed' && (
        <div className={calloutClassName('warn')} role="status" data-testid="add-server-key-install" data-status="failed">
          <div className={cn(text, 'text-[var(--fg)]')}>
            {t('devices.addServer.keyInstall.failed', { why: t(`devices.addServer.keyInstall.reasons.${state.keyInstall.reason}`) })}
          </div>
        </div>
      )}

      <LogDisclosure lines={state.log} open={showLog} onToggle={() => setShowLog((v) => !v)} />

      <div className="flex justify-end gap-2">
        {!finished && <Button size="sm" onClick={onCancel}>{t('devices.cancel')}</Button>}
        {finished && failure && <Button size="sm" onClick={onBack}>{t('devices.addServer.back')}</Button>}
        {finished && failure && (
          <Button size="sm" variant="primary" onClick={onRetry}>{t('devices.retry')}</Button>
        )}
        {finished && !failure && (
          <>
            <Button size="sm" variant={canOpenNewSession ? 'secondary' : 'primary'} onClick={onDone}>{t('devices.addServer.close')}</Button>
            {canOpenNewSession && (
              <Button size="sm" variant="primary" onClick={onNewSession} data-testid="add-server-new-session">
                {t('devices.addServer.newTask')}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/** 「查看详情」:原始日志,展开时跟着滚到最新一行;可整份复制,方便贴给别人看。 */
function LogDisclosure({ lines, open, onToggle }: { lines: string[]; open: boolean; onToggle: () => void }) {
  const { t } = useTranslation('settings')
  const pre = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (open && pre.current) pre.current.scrollTop = pre.current.scrollHeight
  }, [open, lines])
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <Button size="sm" variant="ghost" className="-ml-2" aria-expanded={open} aria-controls="add-server-log" onClick={onToggle}>
          {open ? <ChevronDown aria-hidden className="size-4" /> : <ChevronRight aria-hidden className="size-4" />}
          {open ? t('devices.addServer.hideDetails') : t('devices.addServer.details')}
        </Button>
        {open && lines.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => void platform.writeClipboardText(lines.join('\n')).catch((error) => { rendererLogger('actions/InstallProgress').error({ error: error }, 'action failed'); toast({ title: messageForUser(error), tier: 'error' }); })}>
            {t('devices.addServer.copyLog')}
          </Button>
        )}
      </div>
      <Collapse open={open} id="add-server-log">
        <pre
          ref={pre}
          data-testid="add-server-log"
          className={cn(
            caption,
            // 机器吐出来的原文 = 印在页上的东西:密度面板 + --radius-document,❌ muted 实底当盒子。
            'm-0 max-h-[200px] overflow-auto whitespace-pre-wrap break-all rounded-[var(--radius-document)] bg-foreground/[0.025] px-2 py-2 font-mono dark:bg-foreground/[0.04]',
            muted,
          )}
        >
          {lines.length ? lines.join('\n') : t('devices.addServer.logEmpty')}
        </pre>
      </Collapse>
    </div>
  )
}
