import { AgentAvatar } from '@/components/agentAvatar/AgentAvatar'
import { DEFAULT_ASSISTANT_LOOK } from '@/components/agentAvatar/look'

/**
 * 底栏「咕咕」那一格在还没有它时的图标(owner 10-16:桌面最左栏顶上换成咕咕,「得考虑最开始没有创建咕咕的新用户」):
 * 手机统一使用默认咕咕，不叠加号；读不到身份时不冒充尚未开通。
 * 未选择形象时统一用素色、不戴装扮的默认形象。现在挂在「消息」首行咕咕那一行,和别的会话头像一样 48。
 */
export function PhoneGuguTabIcon({ name, fresh }: { name: string; fresh: boolean }) {
  return (
    <span className="ta-phone-bar-gugu" data-testid="mobile-assistant-nav-default" data-fresh={fresh ? '' : undefined}>
      <AgentAvatar id="assistant-intro" name={name} look={DEFAULT_ASSISTANT_LOOK} size={48} />
    </span>
  )
}
