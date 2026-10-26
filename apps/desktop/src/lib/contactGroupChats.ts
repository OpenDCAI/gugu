// 通讯录「群聊」那一格的读法:从会话投影派生(纯函数,零 IO)。
import type { ChatItem } from '@gugu/core/shared/types/chat'
import type { ContactGroupChat, ContactUser } from '@gugu/core/shared/types/contacts'
import type { DisplayIdentity } from './displayIdentity'

// @@@1752 — display_name 排序改客户端后必须全端确定：localeCompare 依赖运行时 ICU/系统语言
// （Electron/web/Capacitor 可各不同）→ 用码点比较（与 DB collation 不逐字相同，但单一确定）。
function compareByDisplayName(a: ContactUser, b: ContactUser): number {
  const an = a.display_name ?? ''
  const bn = b.display_name ?? ''
  return an < bn ? -1 : an > bn ? 1 : 0
}

/**
 * 会话投影里我所在的活跃群 → 通讯录的「群聊」行。「我在哪些群」只有投影这一份(按键增量,#5394),
 * ❌ 另拉一张整表。成员数 = 投影里这条群带着的成员(身份还没到的那一位要等下一条 agent_changed 补上)。
 */
export function contactGroupChatsOf(chats: readonly ChatItem[]): ContactGroupChat[] {
  return chats
    .filter((chat) => chat.kind === 'group' && chat.status === 'active')
    .map((chat) => ({
      id: chat.id,
      public_id: chat.public_id ?? null,
      kind: 'group',
      name: chat.name,
      alias: chat.alias ?? null,
      avatar_url: chat.avatar ?? null,
      member_count: chat.member_user_ids?.length ?? 0,
      is_muted: chat.is_muted === true,
      // @@@1694 当前用户在该群的角色——群行右键菜单角色化（owner→解散群聊 / member→退出群聊）。
      my_role: chat.my_role ?? null,
      member_user_ids: chat.member_user_ids ?? [],
    }))
}

/** 群里别人的 agent(不是我的):身份就在投影带回来的那份里。按显示名码点排(compareByDisplayName)。 */
export function sharedGroupAgentsOf(
  groups: readonly ContactGroupChat[],
  identitiesById: Readonly<Record<string, DisplayIdentity>>,
  userId: string | null,
): ContactUser[] {
  if (!userId) return []
  const ids = new Set(groups.flatMap((group) => group.member_user_ids ?? []))
  return [...ids]
    .flatMap((id) => {
      const identity = identitiesById[id]
      return id !== userId && identity?.type === 'agent' && identity.owner_user_id && identity.owner_user_id !== userId ? [identity] : []
    })
    .sort(compareByDisplayName)
}
