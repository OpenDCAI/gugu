import { projectGroupsStore } from '../session/renderer/features/projects/stores/project-groups-store'

/**
 * 群里「谁能拉人」的界面判定 —— 与库里 chat.group_add_denial 同一口径(gugu-supabase 迁移 20260923170000):
 * 群主 / 管理员随时能拉人;普通成员只在群开了「允许成员邀请」时能拉人类。
 * 以前界面只豁免创建者、没豁免管理员(库里的插入规则也是),于是管理员在关了邀请的群里拉不了人。
 */
export function isGroupManagerRole(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin'
}

/** Agent ownership and current source-group authority are independent listen-mode rights. */
export function canEditAgentListenMode(
  profile: { type: 'human' | 'agent'; ownerUserId?: string | null },
  currentUserId: string | null,
  settings: { my_role: string | null; can_manage: boolean } | null,
): boolean {
  return !!currentUserId && profile.type === 'agent' && (
    profile.ownerUserId === currentUserId ||
    (settings?.can_manage === true && isGroupManagerRole(settings.my_role))
  )
}

/** Reads the server's projection of the viewer (group_info_as), never a locally held roster role. */
export function canInviteHumansToGroup(settings: {
  my_role: string | null
  can_manage: boolean
  allow_member_invite: boolean
} | null): boolean {
  if (!settings?.my_role) return false
  return settings.can_manage || settings.allow_member_invite
}

/**
 * 项目群(gugu-dev#181,yangchichi 10-23「项目群是我的 agent 和我交流的地方,没有第三者」):项目就是群,群里只有你和你的
 * agent,不拉别的人进来;和别人一起在「对话」里建群。所有往群里拉人的入口都问这一处,❌ 各自判断;拦人的那一刀在库里
 * (insert_group_member),界面上这些入口只是不提供、并说出原因。
 */
export function isProjectGroupChat(chatId: string): boolean {
  return projectGroupsStore.projectOfChat(chatId) !== undefined
}
