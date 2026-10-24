import type { AgentStatusPresentation } from '@gugu/core/shared/agentStatusPresentation'
import { displayStatusOf } from '@gugu/core/shared/ui/agentConversationStatusModels'
import { agentStatusText } from '@/lib/agentStatusText'
import { Avatar } from '@/components/Avatar'
import { useAvatarIdentity } from '@/lib/avatarIdentity'

/**
 * 会话状态的那一小格。形制照抄 orca 手机端(`mobile/src/components/AgentSpinner.tsx`):
 * **12×12 的外壳里放一个 8×8 的字形**,在跑时是缺口环、其余是实心圆点。
 *
 * 为什么是外壳套内胆:状态在几种字形之间切换时,行高与基线不能跳。外壳定死 12×12,
 * 内胆怎么换都不影响排版。
 *
 * 画什么由 presentation 决定(与会话页、聊天同一张表):`data-tone` 选颜色与字形,`data-animate` 决定转不转
 * (后台在跑是同一个环、静止)。`null` = 这一格不说状态(离线机器上的「在跑」快照),画一个灰点。
 */
export function StatusGlyph({ presentation }: { presentation: AgentStatusPresentation | null }) {
  return (
    <span
      className="gg-aw-glyph"
      data-tone={presentation?.tone ?? 'none'}
      data-animate={presentation?.animate ? 'true' : undefined}
      role={presentation ? 'img' : undefined}
      aria-label={presentation ? agentStatusText(presentation.label) : undefined}
      aria-hidden={presentation ? undefined : true}
      data-testid="agent-watch-status-glyph"
    >
      <span className="gg-aw-glyph-inner" />
    </span>
  )
}

/** Session rows share the canonical agent avatar; sessions without an identity use their stable session id. */
export function SessionAvatar({
  agentId,
  sessionId,
  presentation,
  size = 32
}: {
  agentId?: string | null
  sessionId: string
  presentation: AgentStatusPresentation | null
  size?: number
}) {
  const identity = useAvatarIdentity(agentId ?? '')
  return (
    <Avatar seed={agentId || sessionId} avatarUrl={identity?.avatar} isAgent harnessBadge={false} size={size}
        name={identity?.display_name ?? (presentation ? agentStatusText(presentation.label) : agentStatusText('none'))}
        statusLabel={presentation?.label ?? 'none'} agentStatus={presentation ? displayStatusOf(presentation.tone) : undefined} />
  )
}

/**
 * 同一个外壳画的另一根轴:机器连没连上(live 蓝点)、页头「正在开 / 正在读」的转圈。它们不是 agent 状态,
 * ❌ 不借 agent 状态的颜色。文字由调用方写在旁边,这里只画形。
 */
/** asleep = #7199 休眠中的云电脑:live 空心圈(❌ 退成离线那一档)。 */
export function LiveGlyph({ state }: { state: 'online' | 'offline' | 'busy' | 'asleep' }) {
  return (
    <span className="gg-aw-glyph" data-live={state} aria-hidden="true" data-testid="agent-watch-live-glyph">
      <span className="gg-aw-glyph-inner" />
    </span>
  )
}
