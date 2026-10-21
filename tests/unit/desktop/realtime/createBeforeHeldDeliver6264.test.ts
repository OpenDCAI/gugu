/**
 * #6264 实机(d22)复现:同一事务写入的建单与首条投递 created_at 相同,公平取数按 id 定序 —— 投递排在建单前面时,
 * 投递因「还没有谁持有这个 agent」被按住,建单又取不到(每个 agent 一次一条),两条一起等满 150 秒持有预算,
 * 然后投递先落空。修法:投递因此被按住时,当场把同 agent 的那条建单找出来先办,再回头办投递。
 */
import { describe, expect, it } from 'vitest'
import { processPendingDeviceCommandsOnce } from '@gugu/core/cloud/deviceCommands'
import { deviceCommandRow, MemoryDeviceCommandClient } from '../../../support/deviceRuntimeHarness'

const DEVICE = 'dev-1'
const AGENT = 'agent-9'
const AT = '2026-09-25T02:09:39.827Z'

function rows() {
  return [
    // id 较小的是投递(真机上正是这样:3719… < 8ce4…)。
    deviceCommandRow({ id: 'a-deliver', deviceId: DEVICE, type: 'agent.deliver', payload: { agent_user_id: AGENT, chat_id: 'c', message_id: 'm' }, createdAt: AT }),
    deviceCommandRow({ id: 'b-create', deviceId: DEVICE, type: 'agent.create', payload: { agent_user_id: AGENT }, createdAt: AT }),
  ]
}

describe('建单排在被按住的投递后面', () => {
  it('同一轮里先办建单、再办投递;投递送到', async () => {
    const client = new MemoryDeviceCommandClient(rows())
    const order: string[] = []
    let created = false
    const results = await processPendingDeviceCommandsOnce(client as never, DEVICE, {
      'agent.create': async () => { order.push('create'); created = true; return {} },
      'agent.deliver': async () => { order.push('deliver'); return {} },
    }, {
      nowIso: () => '2026-09-25T02:09:40.000Z',
      resolveHolding: (command) => (command.type === 'agent.create' || created ? 'held' : 'unheld'),
    })
    expect(order).toEqual(['create', 'deliver'])
    expect(results.filter((r) => r.status === 'done').map((r) => r.commandId)).toEqual(['b-create', 'a-deliver'])
  })

  it('没有同 agent 的建单时照旧按住(只多查这一次)', async () => {
    const client = new MemoryDeviceCommandClient([rows()[0]!])
    const results = await processPendingDeviceCommandsOnce(client as never, DEVICE, {
      'agent.deliver': async () => { throw new Error('must not run') },
    }, {
      nowIso: () => '2026-09-25T02:09:40.000Z',
      resolveHolding: () => 'unheld',
    })
    expect(results).toEqual([expect.objectContaining({ commandId: 'a-deliver', status: 'skipped', reason: 'unheld' })])
  })
})
