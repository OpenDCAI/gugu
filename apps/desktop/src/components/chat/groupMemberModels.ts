// @@@2178 — 群成员模型助手,从冻结的 GroupMembersSection.tsx 抽出,供该组件与 GroupMemberAvatarRow 共用
// (抽出同时抵消 god 文件增行)。纯数据/排序,无 React。
import type {
  GroupAgentItem,
  GroupCollabSnapshot,
  GroupMemberItem,
  GroupMemberRole,
} from '@gugu/core/shared/types/chat'

export interface UnifiedMember {
  id: string
  type: 'human' | 'agent'
  raw: GroupMemberItem | GroupAgentItem
  role: GroupMemberRole
}

// @@@unified-member-sort - owner first, then admin, then member; humans before agents within role.
function sortRoleWeight(role: GroupMemberRole): number {
  if (role === 'owner') return 0
  if (role === 'admin') return 1
  return 2
}

export function buildUnifiedMembers(snapshot: GroupCollabSnapshot): UnifiedMember[] {
  const all: UnifiedMember[] = [
    ...snapshot.humans.map((h) => ({ id: h.id, type: 'human' as const, raw: h, role: h.role })),
    ...snapshot.agents.map((a) => ({ id: a.id, type: 'agent' as const, raw: a, role: a.role })),
  ]
  all.sort((a, b) => {
    const dr = sortRoleWeight(a.role) - sortRoleWeight(b.role)
    if (dr !== 0) return dr
    if (a.type !== b.type) return a.type === 'human' ? -1 : 1
    return a.id.localeCompare(b.id)
  })
  return all
}
