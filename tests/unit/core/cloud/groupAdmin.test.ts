import { describe, expect, it, vi } from 'vitest'
import { createGroupAdmin } from '../../../../packages/core/src/cloud/groupAdmin'
import { createGroupWithInvitations } from '../../../../packages/core/src/cloud/groupChat'

describe('the common group transport', () => {
  it('binds the trusted actor on both human and agent calls', async () => {
    for (const actor of ['human', 'agent']) {
      const rpc = vi.fn(async () => ({ data: { chat_id: 'group', user_id: 'target', status: 'removed' }, error: null }))
      await createGroupAdmin({ rpc }, actor).remove('group', 'target')
      expect(rpc).toHaveBeenCalledWith('remove_group_member_as', { p_chat_id: 'group', p_member_user_id: 'target', p_as_user_id: actor })
    }
  })
  it.each([null, [], { chat_id: 'other', user_id: 'target', status: 'removed' }, { chat_id: 'group', user_id: 'target', status: 'pending' }])('rejects non-authoritative removal receipts %j', async (data) => {
    await expect(createGroupAdmin({ rpc: async () => ({ data, error: null }) }, 'actor').remove('group', 'target')).rejects.toThrow()
  })
  // gugu-dev#181 任务座位不发入群提示。参数表每次都一样(发布闸要能静态读出它):任务座位 p_as_task true,其余 false。
  it('asks for a task seat only when told to, with the same argument shape every time', async () => {
    const rpc = vi.fn(async () => ({ data: { chat_id: 'group', status: 'joined' }, error: null }))
    const admin = createGroupAdmin({ rpc }, 'owner')
    await admin.addAgent('group', 'agent-1', { asTask: true })
    await admin.addAgent('group', 'agent-2')
    expect(rpc).toHaveBeenNthCalledWith(1, 'add_group_agent', { p_chat_id: 'group', p_agent_user_id: 'agent-1', p_message: null, p_as_user_id: 'owner', p_as_task: true })
    expect(rpc).toHaveBeenNthCalledWith(2, 'add_group_agent', { p_chat_id: 'group', p_agent_user_id: 'agent-2', p_message: null, p_as_user_id: 'owner', p_as_task: false })
  })
  it('propagates the database permission error without inventing success', async () => {
    await expect(createGroupAdmin({ rpc: async () => ({ data: null, error: { message: 'group_manager_required' } }) }, 'agent')
      .setRole('group', 'human', 'admin')).rejects.toThrow('group_manager_required')
  })
  it('does not confuse pending invitations or pending approval with joined membership', async () => {
    for (const status of ['pending', 'pending_approval']) {
      const admin = createGroupAdmin({ rpc: async () => ({ data: { chat_id: 'group', status }, error: null }) }, 'actor')
      expect((await admin.invite('group', 'target', '请加入')).status).toBe(status)
    }
  })
  it('keeps the committed group ID and per-target errors after a partial creation', async () => {
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'create_gugu_group') return { data: { id: 'created' }, error: null }
      if (args.p_invitee_user_id === 'human') return { data: null, error: { message: 'member_invite_disabled' } }
      return { data: { chat_id: 'created', status: 'pending' }, error: null }
    })
    const result = await createGroupWithInvitations({ rpc }, '协作', 'owner', 'owner', [
      { id: 'own-agent', type: 'agent', owner_user_id: 'owner' },
      { id: 'human', type: 'human', owner_user_id: null },
      { id: 'external-agent', type: 'agent', owner_user_id: 'other' },
    ])
    expect(result).toMatchObject({ chat_id: 'created', member_user_ids: ['owner', 'own-agent'], invitations: [{ status: 'pending' }],
      invitation_errors: [{ invitee_user_id: 'human', error: 'member_invite_disabled' }] })
    expect(rpc.mock.calls[0][1].p_initial_members).toEqual([{ user_id: 'own-agent', role: 'member' }])
    expect(rpc.mock.calls.filter(([name]) => name === 'create_gugu_group')).toHaveLength(1)
  })
})
