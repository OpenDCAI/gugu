import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { SettingsNote } from '@/components/settings/SettingsPrimitives'
import { PhoneAgentHostControl } from './PhoneAgentHostControl'
import { PhoneAgentSetupBackground, PhoneAgentSetupTools } from './PhoneAgentSetupPermissions'
import type { PhoneAgentSetupStep } from './PhoneAgentSetupState'
import { PhoneSheetHandle } from '../PhoneSheetHandle'
import '../phone-device/phone-device.css'

const STEPS: readonly PhoneAgentSetupStep[] = ['host', 'background', 'tools']
const TITLES: Record<PhoneAgentSetupStep, string> = { host: '让 Agent 在手机上做事', background: '切走后也能收到消息', tools: '选择它能用的手机能力' }
const STEP_LABELS: Record<PhoneAgentSetupStep, string> = { host: '手机 Agent', background: '消息与后台', tools: '手机能力' }

export function PhoneAgentSetup({ ownerId, initialStep, onStep, onFinish, onLater, saveError }: {
  ownerId: string
  initialStep: PhoneAgentSetupStep
  onStep: (step: PhoneAgentSetupStep) => void
  onFinish: () => void
  onLater: () => void
  saveError: string | null
}) {
  const [step, setStep] = useState(initialStep)
  const index = STEPS.indexOf(step)
  const move = (next: PhoneAgentSetupStep) => { setStep(next); onStep(next) }
  return (
    <div className="gg-phone-setup" data-testid={`phone-agent-setup-${step}`}>
      <PhoneSheetHandle onDismiss={onLater} />
      <div className="gg-phone-setup-header">
        <p className="gg-phone-setup-eyebrow">这台手机 · 可选设置</p>
        <h2 className="gg-phone-setup-heading">{TITLES[step]}</h2>
        <ol className="gg-phone-setup-steps" aria-label="设置步骤">
          {STEPS.map((item, position) => <li key={item} aria-current={item === step ? 'step' : undefined}>{position + 1} · {STEP_LABELS[item]}</li>)}
        </ol>
      </div>
      <div className="gg-phone-setup-body" key={step}>
        {step === 'host' ? (
          <>
            <p className="gg-phone-setup-intro">手机 Agent 已集成在咕咕里，无需另装 App。基础任务不需要日历、相册等权限。</p>
            <PhoneAgentHostControl ownerId={ownerId} />
          </>
        ) : step === 'background' ? <PhoneAgentSetupBackground /> : <PhoneAgentSetupTools ownerId={ownerId} />}
      </div>
      <div className="gg-phone-setup-footer">
        {saveError && <SettingsNote role="alert" tone="danger">{saveError}</SettingsNote>}
        <SettingsNote>都可稍后在「我的 → 这台手机」设置。</SettingsNote>
        <div className="gg-phone-setup-actions">
          {index > 0 && <Button onClick={() => move(STEPS[index - 1]!)}>上一步</Button>}
          <Button variant="ghost" data-testid="phone-agent-setup-later" onClick={onLater}>稍后设置</Button>
          <Button variant="primary" data-testid="phone-agent-setup-next" onClick={() => index === STEPS.length - 1 ? onFinish() : move(STEPS[index + 1]!)}>{index === STEPS.length - 1 ? '完成' : '继续'}</Button>
        </div>
      </div>
    </div>
  )
}
