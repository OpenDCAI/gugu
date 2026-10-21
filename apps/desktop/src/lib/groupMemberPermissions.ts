/**
 * 群里「谁能拉人」的界面判定 —— 与库里 chat.group_add_denial 同一口径(gugu-supabase 迁移 20260923170000):
 * 群主 / 管理员随时能拉人;普通成员只在群开了「允许成员邀请」时能拉人类。
 * 以前界面只豁免创建者、没豁免管理员(库里的插入规则也是),于是管理员在关了邀请的群里拉不了人。
 */
export function isGroupManagerRole(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin'
}

export function canInviteHumansToGroup(input: {
  viewerRole: string | null | undefined
  allowMemberInvite: boolean
}): boolean {
  if (!input.viewerRole) return false
  return isGroupManagerRole(input.viewerRole) || input.allowMemberInvite
}
