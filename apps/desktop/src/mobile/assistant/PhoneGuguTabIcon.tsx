import { AgentAvatar } from '@/components/agentAvatar/AgentAvatar'
import { DEFAULT_ASSISTANT_LOOK } from '@/components/agentAvatar/look'
import { Plus } from '@/lib/icons'

/**
 * 底栏「咕咕」那一格在还没有它时的图标(owner 10-16:桌面最左栏顶上换成咕咕,「得考虑最开始没有创建咕咕的新用户」):
 * 默认咕咕淡一点 + 角上一个小「+」(= 这里能给它安个家);还在读 / 读不到它是谁时只是淡一点的默认咕咕,❌ 提前说「去创建」。
 * 未选择形象时统一用素色、不戴装扮的默认形象。
 */
export function PhoneGuguTabIcon({ name, fresh }: { name: string; fresh: boolean }) {
  return (
    <span className="ta-phone-bar-gugu" data-testid="mobile-assistant-nav-default" data-fresh={fresh ? '' : undefined}>
      <AgentAvatar id="assistant-intro" name={name} look={DEFAULT_ASSISTANT_LOOK} size={23} />
      {fresh ? (
        <span className="ta-phone-bar-plus" aria-hidden>
          <Plus size={9} strokeWidth={3} />
        </span>
      ) : null}
    </span>
  )
}
