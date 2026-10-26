import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { SettingsNote } from '@/components/settings/SettingsPrimitives'
import { platform } from '@/platform'
import { PhoneAgentHostControl } from './PhoneAgentHostControl'
import { PhoneAgentSetupPermission, PhoneAgentSetupTools } from './PhoneAgentSetupPermissions'
import type { PhoneAgentSetupStep } from './PhoneAgentSetupState'
import { PhoneSheetHandle } from '../PhoneSheetHandle'
import '../phone-device/phone-device.css'

const STEPS: readonly PhoneAgentSetupStep[] = ['host', 'notifications', 'background', 'tools']
const ACTIONS: Record<PhoneAgentSetupStep, string> = { host: '设置手机 Agent', notifications: '设置消息通知', background: '设置后台运行', tools: '选择手机能力' }
const TITLES: Record<PhoneAgentSetupStep, string> = {
  host: '让 Agent 在这台手机上处理任务',
  notifications: '任务有进展时，收到消息提醒',
  background: '切走后，允许咕咕在后台运行',
  tools: '按需连接日历、相册等手机能力',
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
  const steps: PhoneAgentSetupStep[] = ['host',
    ...(platform.systemPermissions.includes('notifications') ? ['notifications' as const] : []),
    ...(platform.systemPermissions.includes('batteryOptimization') ? ['background' as const] : []), 'tools']
  const following = STEPS.slice(STEPS.indexOf(step) + 1).find((item) => steps.includes(item)) ?? 'tools'
  const next = () => {
    if (step === 'tools') onFinish()
    else { setStep(following); onStep(following) }
  }
  return (
    <div className="gg-phone-setup" data-testid={`phone-agent-setup-${step}`}>
      <PhoneSheetHandle onDismiss={onLater} />
      <div className="gg-phone-setup-header">
        <h2 className="gg-phone-setup-heading">{TITLES[step]}</h2>
      </div>
      <div className="gg-phone-setup-body" key={step}>
        {step === 'host' ? <PhoneAgentHostControl ownerId={ownerId} setup={{ onContinue: next, continueLabel: ACTIONS[following] }} />
          : step === 'notifications' || step === 'background'
            ? <PhoneAgentSetupPermission permission={step === 'notifications' ? 'notifications' : 'batteryOptimization'} onContinue={next} continueLabel={ACTIONS[following]} />
            : <PhoneAgentSetupTools ownerId={ownerId} />}
        {saveError && <SettingsNote role="alert" tone="danger">{saveError}</SettingsNote>}
      </div>
      <div className="gg-phone-setup-footer">
        <Button variant="ghost" data-testid="phone-agent-setup-next" onClick={next}>{step === 'tools' ? '完成设置' : '稍后'}</Button>
      </div>
    </div>
  )
}
