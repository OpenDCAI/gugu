import { describe, expect, it } from 'vitest'
import { canInviteHumansToGroup, isGroupManagerRole } from '../../../../apps/desktop/src/lib/groupMemberPermissions'

// 界面判定与库里 chat.group_add_denial 同一口径:管理员豁免「允许成员邀请」,普通成员不豁免。
describe('canInviteHumansToGroup', () => {
  it('管理员在关了「允许成员邀请」的群里照样能拉人(以前只豁免创建者)', () => {
    expect(canInviteHumansToGroup({ viewerRole: 'admin', allowMemberInvite: false })).toBe(true)
    expect(canInviteHumansToGroup({ viewerRole: 'owner', allowMemberInvite: false })).toBe(true)
  })
  it('普通成员只在开关打开时能拉人(正对照)', () => {
    expect(canInviteHumansToGroup({ viewerRole: 'member', allowMemberInvite: false })).toBe(false)
    expect(canInviteHumansToGroup({ viewerRole: 'member', allowMemberInvite: true })).toBe(true)
  })
  it('不在群里(没有角色)的人永远不能拉人', () => {
    expect(canInviteHumansToGroup({ viewerRole: null, allowMemberInvite: true })).toBe(false)
  })
  it('isGroupManagerRole 只认 owner / admin', () => {
    expect(['owner', 'admin', 'member', null, undefined, 'Owner'].map(isGroupManagerRole)).toEqual([true, true, false, false, false, false])
  })
})
