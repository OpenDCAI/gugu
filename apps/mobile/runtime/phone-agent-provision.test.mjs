import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPhoneProvisioner } from './phone-agent-provision.mjs'

const ownerId = '8aa10e91-2d5f-4b8a-bf46-70154795a118'
const agentId = '59c63835-7f9b-463b-9576-7b54ee14f031'
const callerId = 'ec6d81f5-d25f-4414-8a0a-017b4979e186'
const groupId = '830db16e-b2d5-4272-b363-b6600596a3ec'

function fixture(status) {
  const calls = []
  const agent = { agentUserId: agentId, sessionId: 'child-session', chatId: 'child-dm' }
  const store = { state: { requests: {}, agents: { [agentId]: agent } }, save: async () => {} }
  const provisionRow = { agent_user_id: agentId, create_command_id: 'create-command', phase: 'ready' }
  const cloud = {
    chat: { from: () => ({ select: () => ({ eq: () => ({ single: async () => ({
      data: { id: groupId, kind: 'group', status: 'active' }, error: null,
    }) }) }) }) },
    identity: { from: (table) => ({ select: () => ({ eq: () => ({ single: async () => ({
      data: table === 'agent_provisions' ? provisionRow : { status: 'done' }, error: null,
    }) }) }) }) },
    rpc: async (schema, name, args) => {
      calls.push([schema, name, args])
      if (name === 'start_agent_provision_operation' || name === 'complete_agent_provision') return {}
      if (name === 'settle_agent_provision_terminal') return provisionRow
      if (name === 'add_group_agent') {
        // Model the installed backend's required actor and task-aware signature.
        if (!args.p_as_user_id || !Object.hasOwn(args, 'p_as_task')) throw new Error('RPC signature mismatch')
        if (status === 'denied') throw new Error('member_limit_reached')
        return { chat_id: groupId, status }
      }
      throw new Error(`Unexpected RPC ${schema}.${name}`)
    },
  }
  const provision = createPhoneProvisioner({ ownerId, cloud, store, deviceId: 'phone-device',
    projectId: 'phone-project', root: '/phone-private', models: { resolve: async () => 'free' },
    tick: async () => {}, admit: async () => {}, publish: () => {},
    snapshot: (entry) => ({ agent_user_id: entry.agentUserId, birth_group: entry.birthGroup }),
  })
  return { provision, calls, agent }
}

for (const status of ['joined', 'pending_approval']) {
  for (const caller of [null, { agentUserId: callerId, sessionId: 'parent-session', deviceId: 'phone-device', name: 'Parent' }]) {
    test(`birth-group ${status} uses the ${caller ? 'calling agent' : 'authenticated owner'} as actor`, async () => {
      const fx = fixture(status)
      const action = { harness: 'pi', prompt: 'Create one phone task', chatId: groupId }
      const first = await fx.provision('request-1043', action, caller)
      assert.deepEqual(fx.calls.filter(([, name]) => name === 'add_group_agent'), [[
        'chat', 'add_group_agent', {
          p_chat_id: groupId, p_agent_user_id: agentId, p_message: null,
          p_as_user_id: caller?.agentUserId ?? ownerId, p_as_task: true,
        },
      ]])
      assert.deepEqual(first.birth_group, { chatId: groupId, status })
      assert.deepEqual(await fx.provision('request-1043', action, caller), first)
      assert.equal(fx.calls.filter(([, name]) => name === 'add_group_agent').length, 1)
    })
  }
}

test('a denied birth-group request remains failed rather than claiming membership', async () => {
  const fx = fixture('denied')
  await fx.provision('denied-1043', { prompt: 'Create task', chatId: groupId })
  assert.deepEqual(fx.agent.birthGroup, { chatId: groupId, status: 'failed', error: 'member_limit_reached' })
})

test('creation outside a group does not request membership', async () => {
  const fx = fixture('joined')
  await fx.provision('no-group-1043', { prompt: 'Create task' })
  assert.equal(fx.calls.some(([, name]) => name === 'add_group_agent'), false)
  assert.equal(fx.agent.birthGroup, undefined)
})
