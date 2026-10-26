import assistantPortrait from '@/components/agentAvatar/assets/faces/agent-face-00.webp'
import type { PhoneAgentSetupStep } from './PhoneAgentSetupState'

/** The bundled Gugu portrait is an illustration, never a host or permission status. */
export function PhoneAgentSetupVisual({ step }: { step: PhoneAgentSetupStep }) {
  return (
    <div className="gg-phone-setup-visual" data-step={step} aria-hidden="true">
      <img className="gg-phone-setup-portrait" src={assistantPortrait} alt="" draggable={false} />
      {step === 'notifications' && (
        <div className="gg-phone-setup-notification">
          <div className="gg-phone-setup-notification-heading"><span>咕咕</span><span>提醒示意</span></div>
          <div className="gg-phone-setup-notification-title">任务有了新进展</div>
          <div className="gg-phone-setup-notification-copy">回来看看，继续下一步。</div>
        </div>
      )}
      {step === 'background' && <div className="gg-phone-setup-scene-label">切换 App，自由安排</div>}
      {step === 'tools' && <div className="gg-phone-setup-capability-preview"><span>日历</span><span>通讯录</span><span>相册</span></div>}
    </div>
  )
}
