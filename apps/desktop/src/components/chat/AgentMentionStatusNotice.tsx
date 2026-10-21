import type { AgentDisplayStatus } from '@gugu/core/shared/types/chat'
import { useTranslation } from 'react-i18next'
import type { MentionCandidate } from '@/lib/mention'
import type { MentionTarget } from './useChatDraft'
import type { AgentStatusById } from './agentMentionStatusModels'
import { ComposerNotice } from './ComposerNotice'
import { useAgentsOnCloudComputer, useShownAgentStatus } from './useAgentsOnCloudComputer'

export function AgentMentionOptionLabel({
  member,
  status,
}: {
  member: MentionCandidate
  status?: AgentDisplayStatus
}) {
  const { t } = useTranslation('messaging')
  // #7199 住在收回着的云端宿主上的 agent 读数是离线,但消息照收、有事宿主自己醒 —— ❌ 说它不在线 / 在休息(owner 10-17)。
  const shownStatus = useShownAgentStatus().status(member.id, status)
  const offline = member.type === 'agent' && shownStatus === 'offline'
  return (
    <span style={{ minWidth: 0, display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
      <span>
        {member.name}
        {member.type === 'agent' && member.ownerDisplayName ? (
          <span className="text-[length:var(--font-caption)] text-[var(--text-secondary)]">
            {t('message.agentOwnerSuffix', { owner: member.ownerDisplayName })}
          </span>
        ) : null}
      </span>
      {offline ? (
        <span data-agent-status-warning="offline" style={{ fontSize: 'var(--font-caption)', color: 'var(--text-secondary)' }}>
          {t('agent.offlineWarning', { name: member.name })}
        </span>
      ) : null}
    </span>
  )
}

export function AgentMentionSelectionNotice({
  members,
  mentionTargets,
  agentStatuses,
}: {
  members: MentionCandidate[]
  mentionTargets: MentionTarget[]
  agentStatuses: AgentStatusById
}) {
  const { t } = useTranslation('messaging')
  const onCloud = useAgentsOnCloudComputer()
  const offlineMember = mentionTargets
    .map((target) => members.find((member) => member.id === target.userId && member.type === 'agent'))
    .find((member) => member && agentStatuses[member.id] === 'offline' && !onCloud.has(member.id))
  if (!offlineMember) return null

  return (
    <ComposerNotice
      data-agent-status-surface="mention-selection"
      data-agent-id={offlineMember.id}
      data-agent-display-status="offline"
      data-agent-status-warning="offline"
    >
      {t('agent.offlineWarning', { name: offlineMember.name })}
    </ComposerNotice>
  )
}
