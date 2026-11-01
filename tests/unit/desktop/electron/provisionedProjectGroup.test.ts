import { describe, expect, it } from 'vitest'
import { resolveProvisionedProjectGroup } from '../../../../apps/desktop/electron/sessionpage/emdash-agent-provisioning'

describe('resolveProvisionedProjectGroup', () => {
  const job = { groupName: 'Project', groupChatId: 'g-mapped' }
  it('does not retain the mapped group when enrollment failed', () => {
    expect(resolveProvisionedProjectGroup(job, { groupChatId: '', priorGroupState: 'join_failed:member_limit_reached' }))
      .toEqual({ kind: 'not-joined', groupChatId: '' })
  })
  it('需审批 ⇒ 这次不在群里(名册不记群),映射不动', () => {
    expect(resolveProvisionedProjectGroup(job, { groupChatId: '', priorGroupState: 'pending_approval' }))
      .toEqual({ kind: 'pending-approval', groupChatId: '' })
  })
  it('服务端另建了群(归档 / foreign)⇒ 改指新群', () => {
    expect(resolveProvisionedProjectGroup(job, { groupChatId: 'g-new', priorGroupState: 'foreign' }))
      .toEqual({ kind: 'remapped', groupChatId: 'g-new' })
  })
  it('正对照:就在映射的群里 ⇒ 不变', () => {
    expect(resolveProvisionedProjectGroup(job, { groupChatId: 'g-mapped', priorGroupState: 'active' }))
      .toEqual({ kind: 'unchanged', groupChatId: 'g-mapped' })
  })
})
