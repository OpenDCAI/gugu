import type { GroupJoinRequest } from '@gugu/core/shared/types/chat'
import type { ContactGroupChat } from '@gugu/core/shared/types/contacts'
import { chatService } from './chat'
import { isGroupManagerRole } from './groupMemberPermissions'
import { pendingFirst } from './requestHistory'

/**
 * @@@6418 入群申请(#858)是冲着「人」来的请求 —— 和好友申请一样归通讯录「新的请求」,❌ 折叠在群里。
 * 一条申请带上它要进的那个群,卡片上才说得清「谁想进哪个群」。
 */
export type ManagedGroupJoinRequest = GroupJoinRequest & {
  group: Pick<ContactGroupChat, 'id' | 'name' | 'avatar_url'>
}

/** 我能审的群 = 我是群主或管理员、且群还在(解散的群没有人会再去审)。 */
export function managedGroupChats(groupChats: readonly ContactGroupChat[]): ContactGroupChat[] {
  return groupChats.filter((group) => isGroupManagerRole(group.my_role) && group.status !== 'archived')
}

/**
 * 读我管理的每个群的入群申请(含已处理的),等我处理的在前。
 * 库里只有「按单个群列」的 RPC(list_group_join_requests,内部再校验管理权限),所以这里逐群并发读;
 * 任何一个群读失败整体 fail-loud —— 少读一个群 = 让管理员以为「没人申请」而漏审(#1125)。
 * 管理的群很多时这是 N 次往返;真到那一步应在 gugu-supabase 补一个跨群一次读的 RPC。
 */
export async function listManagedGroupJoinRequests(groups: readonly ContactGroupChat[]): Promise<ManagedGroupJoinRequest[]> {
  const perGroup = await Promise.all(groups.map(async (group) => {
    const rows = await chatService.listGroupJoinRequests(group.id)
    return rows.map((row) => ({ ...row, group: { id: group.id, name: group.name, avatar_url: group.avatar_url } }))
  }))
  return perGroup.flat().sort(pendingFirst)
}
