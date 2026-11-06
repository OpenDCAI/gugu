import type { AgentDisplayStatus } from '@gugu/core/shared/types/chat'
import { useTranslation } from 'react-i18next'
import { agentDisplayStatusText } from '@/lib/agentStatusText'
import type { MentionCandidate } from '@/lib/mention'
import { Hint } from '../ui/Tooltip'
import { useShownAgentStatus } from './useAgentsOnCloudComputer'

/** Presentation only: delivery and the editor's serialized mention stay unchanged. */
export function AgentMentionInlineStatus({ member, status }: { member: MentionCandidate; status?: AgentDisplayStatus }) {
  const { t } = useTranslation(['messaging', 'common'])
  const shown = useShownAgentStatus().status(member.id, status)
  if (member.type !== 'agent' || (shown !== 'offline' && shown !== 'archived')) return null
  const label = agentDisplayStatusText(shown)
  const description = t(shown === 'archived' ? 'agent.archivedMentionHint' : 'agent.offlineMentionHint', { ns: 'messaging' })
  return <Hint label={`${member.name} · ${label} · ${description}`} side="top">
    <span tabIndex={0} title="" data-agent-status-surface="mention-inline" data-agent-id={member.id}
      data-agent-display-status={shown} aria-label={`${label} · ${description}`}
      className="ms-1.5 text-[length:var(--font-body)] text-[var(--text-secondary)]">{label}</span>
  </Hint>
}
