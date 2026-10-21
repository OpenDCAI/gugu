import { AgentNeedsUserGlyph } from './AgentNeedsUserGlyph'
import { agentContactRowDotClass, type AgentContactTone } from './contactAgentTone'

export function AgentContactStatusMark({ tone }: { tone: AgentContactTone | null }) {
  if (tone === null) return null // #7199 不画状态的那一格(宿主闲时收回着)
  return tone === 'needs_user'
    ? <AgentNeedsUserGlyph size={8} />
    : <span className={agentContactRowDotClass(tone)} aria-hidden="true" />
}
