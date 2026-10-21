import type { AgentStatusPresentation } from '@gugu/core/shared/agentStatusPresentation'
import { agentStatusText } from '@/lib/agentStatusText'
import { AgentAvatar } from '@/components/agentAvatar/AgentAvatar'
import { agentIdentity } from '@/components/agentAvatar/engine/identity'

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

/**
 * 会话那一格的**小鸟**:状态靠身体自己变形说(缩成三颗点、拉成「!」、塌成一滩……),不再是 8px 的点。
 * 画什么由 presentation 决定(与会话页、聊天同一张表);`null` = 这一格不说状态(离线机器上的「在跑」快照),
 * 画「状态不可用」那一格的样子 —— ❌ 不替联系不上的机器说「在跑」,也不说「空闲」。
 * `agentId` = 这条会话背后 agent 的 user id:小鸟按它的形象画(与聊天、会话页同一只);还没有咕咕身份的会话
 * 不给,按 `sessionId` 推一个样子 —— 不同会话各不相同,❌ 全长成同一只。
 */
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
  return (
    <AgentAvatar
      id={agentId || sessionId}
      look={agentId ? undefined : agentIdentity(sessionId)}
      name={presentation ? agentStatusText(presentation.label) : agentStatusText('none')}
      size={size}
      state={presentation?.label ?? 'none'}
    />
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
