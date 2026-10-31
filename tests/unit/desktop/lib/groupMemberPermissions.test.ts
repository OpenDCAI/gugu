import { describe, expect, it } from 'vitest'
import { canInviteHumansToGroup, isGroupManagerRole } from '../../../../apps/desktop/src/lib/groupMemberPermissions'

// 界面判定与库里 chat.group_add_denial 同一口径:服务端判定的管理者豁免「允许成员邀请」,普通成员不豁免。
describe('canInviteHumansToGroup', () => {
  it('管理者在关了「允许成员邀请」的群里照样能拉人(以前只豁免创建者)', () => {
    expect(canInviteHumansToGroup({ my_role: 'admin', can_manage: true, allow_member_invite: false })).toBe(true)
    expect(canInviteHumansToGroup({ my_role: 'owner', can_manage: true, allow_member_invite: false })).toBe(true)
  })
  it('普通成员只在开关打开时能拉人(正对照)', () => {
    expect(canInviteHumansToGroup({ my_role: 'member', can_manage: false, allow_member_invite: false })).toBe(false)
    expect(canInviteHumansToGroup({ my_role: 'member', can_manage: false, allow_member_invite: true })).toBe(true)
  })
  it('不在群里(没有角色)的人永远不能拉人;设置没读到也不能', () => {
    expect(canInviteHumansToGroup({ my_role: null, can_manage: false, allow_member_invite: true })).toBe(false)
    expect(canInviteHumansToGroup(null)).toBe(false)
  })
  it('isGroupManagerRole 只认 owner / admin', () => {
    expect(['owner', 'admin', 'member', null, undefined, 'Owner'].map(isGroupManagerRole)).toEqual([true, true, false, false, false, false])
  })
})
