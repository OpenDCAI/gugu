import assert from 'node:assert/strict'
import test from 'node:test'
import { phoneChatReadTools } from './phone-agent-chat.mjs'

const self = '10000000-0000-4000-8000-000000000001'
const other = '10000000-0000-4000-8000-000000000002'
const chat = '10000000-0000-4000-8000-000000000003'

function memberTool(presence) {
  const users = [{ id: self, display_name: '手机 Agent', type: 'agent' }, { id: other, display_name: '远端 Agent', type: 'agent' }]
  const cloud = {
    identity: { from: () => ({ select: () => ({ in: async (_column, ids) => ({ data: users.filter((user) => ids.includes(user.id)) }) }) }) },
    rpc: async (schema, method, args) => {
      if (schema === 'chat' && method === 'list_member_ids') {
        assert.equal(args.p_as_user_id, self)
        return users.map((user) => ({ user_id: user.id }))
      }
      assert.equal(schema, 'identity')
      assert.equal(method, 'get_agent_presence_batch')
      assert.deepEqual(args.p_agent_user_ids, [other])
      return presence()
    },
  }
  return phoneChatReadTools({ agent: { agentUserId: self }, cloud, store: { state: { agents: { [self]: { status: 'idle' } } } }, env: { GUGU_HOME: '/tmp/gugu-phone-chat-unit' } }).find((tool) => tool.name === 'message_members')
}

test('member discovery survives presence failure and retains typed addressing plus local status', async () => {
  const tool = memberTool(() => { throw new Error('presence unavailable') })
  const { details } = await tool.execute('read-members', { chat_id: chat })
  assert.equal(details.total, 2)
  assert.match(details.status_unavailable, /presence unavailable/)
  assert.equal(details.items.find((item) => item.is_self).status_from, 'this_machine')
  assert.equal(details.items.find((item) => !item.is_self).user_id, `user:${other}`)
})

test('unknown remote device state stays unknown in member directory', async () => {
  const tool = memberTool(() => ({ results: { [other]: { status: 'presence', presence: { agent_status: 'idle', device_status: null } } } }))
  const { details } = await tool.execute('read-members', { chat_id: chat })
  assert.equal(details.items.find((item) => !item.is_self).host_online, null)
})
