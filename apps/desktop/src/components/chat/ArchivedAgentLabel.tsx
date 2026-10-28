import { useAgentContactStatusLabel } from '../contactAgentTone'
import type { AgentDisplayStatus } from '@gugu/core/shared/types/chat'

/** A retained member needs a visible archival label, beyond the avatar tooltip. */
export function ArchivedAgentLabel({ status }: { status?: AgentDisplayStatus }) {
  const label = useAgentContactStatusLabel(status)
  if (status !== 'archived') return null
  return <span data-agent-archive-label className="text-[length:var(--font-caption)] text-[var(--text-tertiary)]">{label}</span>
}
