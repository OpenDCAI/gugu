import { describe, expect, it } from 'vitest'
import type { GroupCollabSnapshot } from '../../../../packages/core/src/shared/types/chat'
import { buildGroupRosterCandidates } from '../../../../apps/desktop/src/lib/mention'
import { topicMentionCandidates } from '../../../../apps/desktop/src/components/chat/topicMentionModels'
import { filterMentionCandidates, mentionMatchScore } from '../../../../apps/desktop/src/lib/mentionMatch'
import { rankMentionCandidates } from '../../../../apps/desktop/src/lib/mentionRanking'

const archivedAt = '2026-10-29T00:00:00Z'
const snapshot: Pick<GroupCollabSnapshot, 'humans' | 'agents'> = {
  humans: [{ id: 'human', role: 'member', type: 'human', account_status: null }],
  agents: ['active', 'archived', 'offline'].map((id): GroupCollabSnapshot['agents'][number] => ({
    id, role: 'member', type: 'agent', account_status: 'active',
    client: null, model_source: null, tools: [], permission_scope: null,
    current_task_id: null, current_task_title: null, last_action: null, last_active_at: null,
    listen_mode: 'passive',
  })),
}
const identities = {
  human: { display_name: 'Human', type: 'human' as const },
  active: { display_name: 'Active Agent', type: 'agent' as const, session_archived_at: null },
  archived: { display_name: 'Archived Agent', type: 'agent' as const, session_archived_at: archivedAt, gugu_number: 87113 },
  offline: { display_name: 'Offline Agent', type: 'agent' as const, desired_status: 'offline' },
}
const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id)
const context = { chatId: 'group', currentUserId: 'me', messages: [], now: 0 }

describe('archived Agent mention candidates #871', () => {
  it('excludes archived group/project-group Agents from both shared matching paths while retaining people and offline Agents', () => {
    const roster = buildGroupRosterCandidates(snapshot, identities)
    expect(ids(filterMentionCandidates(roster, ''))).toEqual(['human', 'active', 'offline'])
    expect(ids(rankMentionCandidates(roster, '', { ...context, projectMemberIds: ['archived'] })))
      .toEqual(['human', 'active', 'offline'])
    expect(filterMentionCandidates(roster, 'Archived Agent')).toEqual([])
    expect(filterMentionCandidates(roster, '87113')).toEqual([])
  })

  it('retains the archive fact when topic/source-line members are unioned into desktop or mobile suggestions', () => {
    const roster = topicMentionCandidates([], ['human', 'active'], ['archived', 'offline'], identities)
    expect(ids(filterMentionCandidates(roster, ''))).toEqual(['human', 'active', 'offline'])
    expect(ids(rankMentionCandidates(roster, '', { ...context, participantIds: ['archived'] })))
      .toEqual(['human', 'active', 'offline'])
  })

  it('restores an unarchived Agent without changing its identity or membership', () => {
    const restored = { ...identities, archived: { ...identities.archived, session_archived_at: null } }
    expect(ids(filterMentionCandidates(buildGroupRosterCandidates(snapshot, identities), ''))).not.toContain('archived')
    expect(ids(filterMentionCandidates(buildGroupRosterCandidates(snapshot, restored), '')))
      .toEqual(['human', 'active', 'archived', 'offline'])
    expect(snapshot.agents.map((agent) => agent.id)).toEqual(['active', 'archived', 'offline'])
  })

  it('applies archival only to Agents, preserving people, broadcasts and existing matching', () => {
    expect(mentionMatchScore({ name: 'Human', type: 'human', session_archived_at: archivedAt }, '')).toBeGreaterThan(0)
    expect(mentionMatchScore({ name: 'All', type: 'all' }, '')).toBeGreaterThan(0)
    expect(mentionMatchScore({ name: 'Active Agent', type: 'agent', session_archived_at: null }, 'active')).toBeGreaterThan(0)
  })
})
