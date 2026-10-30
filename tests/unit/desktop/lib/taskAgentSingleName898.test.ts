import { describe, expect, it } from 'vitest'
import { taskAgentName, taskAgentNameLength } from '../../../../packages/core/src/shared/taskAgentName'
import { displayIdentityFromRow, identityDisplayName } from '../../../../apps/desktop/src/lib/displayIdentity'
import { buildGroupRosterCandidates, resolveMentionUserIds } from '../../../../apps/desktop/src/lib/mention'
import { filterMentionCandidates } from '../../../../apps/desktop/src/lib/mentionMatch'
import { buildMemberProfileMap } from '../../../../apps/desktop/src/components/memberProfileModels'
import { buildMentionRender } from '../../../../apps/desktop/src/lib/mentionRenderModel'
import type { GroupCollabSnapshot } from '../../../../packages/core/src/shared/types/chat'
import { sessionConfigSchema } from '../../../../apps/desktop/src/session/shared/core/sessions/new-session-config'

const identity = (id: string, serial: number, name = 'Review') => displayIdentityFromRow({
  id, name_serial: serial, display_name: name, type: 'agent', avatar: null, gugu_number: null,
  bio: null, owner_user_id: 'owner', agent_public: true, desired_status: 'online',
  device_id: 'device', category: null, is_official: false, local_path: null, created_at: null, updated_at: null,
})
const group: GroupCollabSnapshot = {
  scheduler: { chat_id: 'room', paused: false, queue_count: 0, blocked_count: 0, summary: null, updated_at: '2026-10-30T00:00:00Z' },
  humans: [], tasks: [], outputs: [],
  agents: ['claude', 'codex'].map((id) => ({
    id, type: 'agent', role: 'member', account_status: 'active', client: null, model_source: null, tools: [],
    permission_scope: null, current_task_id: null, current_task_title: null, last_action: null, last_active_at: null,
    listen_mode: 'passive',
  })),
}

describe('one task-agent display name', () => {
  it('measures manual and automatic limits in graphemes without cutting a name', () => {
    const cluster = '👨‍👩‍👧‍👦'
    expect(taskAgentNameLength(cluster.repeat(40))).toBe(40)
    expect(taskAgentName(` ${cluster.repeat(40)} `)).toBe(cluster.repeat(40))
    expect(taskAgentName('e\u0301'.repeat(20), true)).toBe('e\u0301'.repeat(20))
    expect(() => taskAgentName(cluster.repeat(41))).toThrow('1–40')
    expect(() => taskAgentName(cluster.repeat(21), true)).toThrow('1–20')
    expect(() => taskAgentName('  ')).toThrow()
  })

  it('adds serials only within this chat and lets aliases win', () => {
    const a = identity('claude', 2)
    const b = identity('codex', 7)
    expect(identityDisplayName(a)).toBe('Review')
    expect(identityDisplayName(a, [a])).toBe('Review')
    expect(identityDisplayName(a, [a, b])).toBe('Review · 2')
    expect(identityDisplayName(a, [a, b], 'My reviewer')).toBe('My reviewer')
    expect(buildMemberProfileMap(group, { claude: a, codex: b }, {}, [], { claude: 'My reviewer' }).claude.displayName).toBe('My reviewer')
  })

  it('rejects a long explicit creation name at the typed entry while preserving derived prompt titles', () => {
    const input = { version: '1', name: 'Task', initialSession: { id: 's1', provider: 'codex', title: '👨‍👩‍👧‍👦'.repeat(40), titleSource: 'manual' } }
    expect(sessionConfigSchema.safeParse(input).success).toBe(true)
    expect(sessionConfigSchema.safeParse({ ...input, initialSession: { ...input.initialSession, title: `${input.initialSession.title}x` } }).success).toBe(false)
    expect(sessionConfigSchema.safeParse({ ...input, initialSession: { ...input.initialSession, titleSource: undefined, title: 'x'.repeat(100) } }).success).toBe(true)
  })

  it('keeps same-name, same-serial selections ID based, including old mention labels', () => {
    const identities = { claude: identity('claude', 1), codex: identity('codex', 1) }
    const members = buildGroupRosterCandidates(group, identities)
    expect(members.map((member) => member.name)).toEqual(['Review · 1', 'Review · 1'])
    expect(resolveMentionUserIds('@Review · 1', ['codex'], members, true)).toEqual(['codex'])
    expect(resolveMentionUserIds('@[Old task name](aid:codex)', [], members, true)).toEqual(['codex'])
    expect(resolveMentionUserIds('@[Old task name](aid:claude)', [], members, true)).toEqual(['claude'])
  })

  it('uses current identities for historical sender headers and removes a resolved collision', () => {
    const identities = { claude: identity('claude', 2), codex: identity('codex', 7) }
    expect(buildMemberProfileMap(group, identities).claude.displayName).toBe('Review · 2')
    identities.claude = identity('claude', 2, 'New name')
    const profiles = buildMemberProfileMap(group, identities, {}, ['claude'])
    expect(profiles.claude.displayName).toBe('New name')
    expect(profiles.codex.displayName).toBe('Review')
    expect(buildGroupRosterCandidates(group, identities).map((member) => member.name)).toEqual(['New name', 'Review'])
    const mention = buildMentionRender('@[Review · 2](aid:claude)', ['claude'], { nameOf: (id) => profiles[id]?.displayName, marker: '#current-name' })
    expect(mention.content).toContain('@New name')
    expect(mention.content).not.toContain('Review')
    expect(mention.fallbackLabels).toEqual([])
  })

  it('searches harness metadata without putting it in the displayed name', () => {
    const member = { id: 'codex', type: 'agent' as const, name: 'Review', harness: 'Codex' }
    expect(filterMentionCandidates([member], 'codex')).toEqual([member])
    expect(member.name).toBe('Review')
  })
})
