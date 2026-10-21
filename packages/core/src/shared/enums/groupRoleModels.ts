import type { GroupMemberRole, GroupMemberRoleInput } from '../types/chat'


export const GROUP_ROLE_OPTIONS: Array<{ value: GroupMemberRole; label: string }> = [
  { value: 'owner', label: '群主' },
  { value: 'admin', label: '管理员' },
  { value: 'member', label: '成员' },
]
export function normalizeGroupRole(role: GroupMemberRoleInput | string | null | undefined): GroupMemberRole {
  const normalized = typeof role === 'string' ? role.toLowerCase() : ''
  if (normalized === 'owner') return 'owner'
  if (normalized === 'admin') return 'admin'
  return 'member'
}

export function getGroupRoleLabel(role: GroupMemberRole | string | null | undefined): string {
  const normalized = normalizeGroupRole(role)
  return GROUP_ROLE_OPTIONS.find((item) => item.value === normalized)?.label ?? '成员'
}
