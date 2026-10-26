import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { SettingsNote } from '@/components/settings/SettingsPrimitives'
import { platform } from '@/platform'
import { useSystemPermissionStates } from '@/lib/systemPermissions'
import { PhoneAgentHostControl } from './PhoneAgentHostControl'
import { PhoneAgentSetupPermission, PhoneAgentSetupTools } from './PhoneAgentSetupPermissions'
import type { PhoneAgentSetupStep } from './PhoneAgentSetupState'
import { IconButton } from '@/components/ui/IconButton'
import { ArrowLeft, X } from '@/lib/icons'
import { PhoneAgentSetupVisual } from './PhoneAgentSetupVisual'
import '../phone-device/phone-device.css'

const STEPS: readonly PhoneAgentSetupStep[] = ['host', 'notifications', 'background', 'tools']
const STEP_LABELS: Record<PhoneAgentSetupStep, string> = { host: '手机运行', notifications: '消息通知', background: '后台运行', tools: '手机能力' }
const ACTIONS: Record<PhoneAgentSetupStep, string> = { host: '设置手机 Agent', notifications: '设置消息通知', background: '设置后台运行', tools: '选择手机能力' }
const TITLES: Record<PhoneAgentSetupStep, string> = {
  host: '让 Agent 在手机上做事',
  notifications: '接收任务进展提醒',
  background: '切走后，任务照常进行',
  tools: '按需连接手机能力',
}

export function PhoneAgentSetup({ ownerId, initialStep, onStep, onFinish, onLater, saveError }: {
  ownerId: string
  initialStep: PhoneAgentSetupStep
  onStep: (step: PhoneAgentSetupStep) => void
  onFinish: () => void
  onLater: () => void
  saveError: string | null
}) {
  const [step, setStep] = useState(initialStep)
  const { states, refresh } = useSystemPermissionStates(['notifications', 'batteryOptimization'])
  const steps: PhoneAgentSetupStep[] = ['host',
    ...(platform.systemPermissions.includes('notifications') ? ['notifications' as const] : []),
    ...(platform.systemPermissions.includes('batteryOptimization') ? ['background' as const] : []), 'tools']
  const granted = (item: PhoneAgentSetupStep) => item === 'notifications' ? states.notifications === 'granted'
    : item === 'background' && states.batteryOptimization === 'granted'
  const following = STEPS.slice(STEPS.indexOf(step) + 1).find((item) => steps.includes(item) && !granted(item)) ?? 'tools'
  // Native permission changes can arrive after opening or returning from system settings.
  useEffect(() => {
    if ((step === 'notifications' && states.notifications === 'granted') || (step === 'background' && states.batteryOptimization === 'granted')) {
      setStep(following)
      onStep(following)
    }
  }, [step, states.notifications, states.batteryOptimization, following, onStep])
  const previous = STEPS.slice(0, STEPS.indexOf(step)).reverse().find((item) => steps.includes(item) && !granted(item))
  const moveBack = () => { if (previous) { setStep(previous); onStep(previous) } else onLater() }
  const index = steps.indexOf(step)
  const next = () => {
    if (step === 'tools') onFinish()
    else { setStep(following); onStep(following) }
  }
  return (
    <div className="gg-phone-setup" data-testid={`phone-agent-setup-${step}`}>
      <div className="gg-phone-setup-topbar">
        <IconButton size="lg" className="gg-phone-setup-back" aria-label={previous ? '上一步' : '关闭设置'} onClick={moveBack}>
          {previous ? <ArrowLeft /> : <X />}
        </IconButton>
        <div className="gg-phone-setup-progress" role="progressbar" aria-label="设置步骤"
          aria-valuemin={1} aria-valuemax={steps.length} aria-valuenow={index + 1}
          aria-valuetext={`第 ${index + 1} 步，共 ${steps.length} 步：${STEP_LABELS[step]}`}>
          <span style={{ width: `${(index + 1) / steps.length * 100}%` }} />
        </div>
        <span className="gg-phone-setup-count" aria-hidden="true">{index + 1} / {steps.length}</span>
      </div>
      <div className="gg-phone-setup-body" key={step}>
        <h2 id="phone-agent-setup-heading" className="gg-phone-setup-heading">{TITLES[step]}</h2>
        <PhoneAgentSetupVisual step={step} />
      </div>
      <div className="gg-phone-setup-footer">
        {saveError && <SettingsNote role="alert" tone="danger">{saveError}</SettingsNote>}
        {step === 'host' ? <PhoneAgentHostControl ownerId={ownerId} setup={{ onContinue: next, continueLabel: ACTIONS[following] }} />
          : step === 'notifications' || step === 'background'
            ? <PhoneAgentSetupPermission permission={step === 'notifications' ? 'notifications' : 'batteryOptimization'} state={states[step === 'notifications' ? 'notifications' : 'batteryOptimization']} onRefresh={refresh} />
            : <PhoneAgentSetupTools ownerId={ownerId} />}
        <Button variant="ghost" data-testid="phone-agent-setup-next" onClick={next}>{step === 'tools' ? '完成设置' : '稍后'}</Button>
      </div>
    </div>
  )
}
