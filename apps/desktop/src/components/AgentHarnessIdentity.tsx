import { useTranslation } from 'react-i18next'
import type { CSSProperties } from 'react'
import { agentIcons } from '@gugu/session-plugins/agent-icons'
import { pluginIdForAgentType } from '@gugu/core/agentTypes'
import { engineLabel } from '../lib/usage/engineLabel'
import { CircleAlert, Cloud, Clock, UserMinus, type IconComponent } from '@/lib/icons'
import { useAgentHarnessIdentity } from '../hooks/useAgentHarnessIdentity'
import { useKnownPhoneAgent } from '../hooks/useKnownPhoneAgent'
import { htmlProp } from '../lib/innerHtml'
import { useTheme } from '../store/theme'
import { pickIconVariant } from '../session/renderer/lib/components/agent-icon-variant'
import './AgentHarnessIdentity.css'

/**
 * @@@6009 —— 没有品牌字形的那几档各有各的形状。
 *
 * `agentIcons` 覆盖 `VALID_AGENT_TYPES` 里除 `gugu-cloud` 外的全部类型 ⇒ 落到兜底分支的
 * 实际有四种语义:`pending`(presence 还没到、类型未确认)、`removed`(墓碑)、`unavailable`
 * (权威 payload 说不出类型)、以及 `gugu-cloud`(产品自己的云 agent,`agentTypes.ts` 的
 * `CLOUD_AGENT_TYPE`,UI 叫 Gagent)。从前四者共用一个通用字形,只有 `aria-label`/`title` 不同
 * —— 读屏分得出,眼睛分不出,而 #6002 要的是「首次尚未取得类型时**明确显示**确认中」。
 * ⇒ 一档一个字形;着色见 `AgentHarnessIdentity.css`。
 * ❌ 别把 `gugu-cloud` 加进 `agentIcons`:那张表是 agent **插件**的品牌资产,云 agent 不是插件。
 */
const FALLBACK_GLYPHS: Readonly<Record<string, IconComponent>> = {
  pending: Clock,
  removed: UserMinus,
  unavailable: CircleAlert,
  'gugu-cloud': Cloud,
}

function sizeStyle(size: number): CSSProperties {
  return { '--agent-harness-size': `${size}px` } as CSSProperties
}

function useHarness(agentId: string | undefined) {
  const type = useAgentHarnessIdentity(agentId)
  const phone = useKnownPhoneAgent(agentId) && type !== 'removed'
  const { t } = useTranslation('messaging')
  const icon = phone ? undefined : agentIcons[pluginIdForAgentType(type)]
  const label = phone ? t('agent.identity.phone') : icon?.alt ?? t(`agent.identity.${type === 'gugu-cloud' ? 'cloud' : type === 'removed' ? 'removed' : type === 'pending' ? 'pending' : 'unavailable'}`)
  return { type, icon, label }
}

export function AgentHarnessBadge({ agentId, avatarSize }: { agentId: string | undefined; avatarSize: number }) {
  const identity = useHarness(agentId)
  const size = Math.max(10, Math.min(24, Math.round(avatarSize * 0.44)))
  if (!identity.icon && !FALLBACK_GLYPHS[identity.type]) return null
  return <span className="agent-harness-badge" style={sizeStyle(size)}><HarnessGlyph {...identity} size={size - 4} /></span>
}

/** An inline harness glyph for status rows and other surfaces without an avatar. */
export function AgentHarnessIcon({ agentId, size = 14 }: { agentId: string | undefined; size?: number }) {
  const { type, icon, label } = useHarness(agentId)
  return <HarnessGlyph type={type} icon={icon} label={label} size={size} />
}

/**
 * 按引擎类型(`conversations.provider` 那个 id)画同一套品牌字形 —— 用量页的「按引擎」没有 agent id,
 * 只有类型。与 {@link AgentHarnessIcon} 共用下面这一个渲染体,❌ 别另抄一份。
 */
export function EngineIcon({ engine, size = 14 }: { engine: string; size?: number }) {
  const icon = agentIcons[pluginIdForAgentType(engine)]
  return <HarnessGlyph type={engine} icon={icon} label={engineLabel(engine)} size={size} />
}


function HarnessGlyph({ type, icon, label, size }: { type: string; icon: (typeof agentIcons)[string] | undefined; label: string; size: number }) {
  const { theme } = useTheme()
  const variant = icon ? pickIconVariant(icon.variants, size) : null
  const content = theme === 'dark' && variant?.dark ? variant.dark : variant?.light
  const Glyph = FALLBACK_GLYPHS[type]
  if (!icon && !Glyph) return <span className="sr-only" data-agent-harness={type} role="img" aria-label={label} />
  // ❌ 原生 title:这枚字形多半画在头像角标上,被放进别人的悬停浮层(运行中 agent 的预览卡),
  // 两个浮层会叠在一起。引擎名给读屏走 aria-label,给眼睛由外层自己说。
  return (
    <span className="agent-harness-icon" data-agent-harness={type} role="img" aria-label={label}
      style={sizeStyle(size)}>
      {icon && content ? (
        <span aria-hidden="true" className={theme === 'dark' && icon.invertInDark ? 'agent-harness-artwork--inverted' : undefined}>
          {icon.kind === 'image' ? <img src={content} alt="" /> : <span dangerouslySetInnerHTML={htmlProp(content)} />}
        </span>
      ) : Glyph ? <Glyph size={size} /> : null}
    </span>
  )
}
