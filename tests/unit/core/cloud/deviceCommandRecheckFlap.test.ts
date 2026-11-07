/**
 * 生产(11-05):断网抖动时 claim 成功,紧接着的 lease recheck RPC 回 supabase-js 的 `TypeError: fetch failed`,
 * 被当成命令失败落了终态 ⇒ handler 没跑、reader 没拉、消息停在未读,失败卡还说「连不上模型服务」。
 * 判据:recheck 没有回答 ≠ 拒绝执行 —— 命令回 pending,下一拍照常执行;只有 recheck 回 false 才不执行。
 */
import { describe, expect, it } from 'vitest'
import { processPendingDeviceCommandsOnce, type DeviceCommandTableClient } from '@gugu/core/cloud/deviceCommands'
import { deviceCommandRow, MemoryDeviceCommandClient } from '../../../support/deviceRuntimeHarness'

const DEVICE = 'dev-1'
const NOW = '2026-11-05T01:24:19.000Z'
const FETCH_FAILED = { data: null, error: { message: 'TypeError: fetch failed', details: '', hint: '', code: '' } }

/** The command channel during a flap: the lease recheck of the first `failures` attempts gets no answer. */
function flappingRecheck(db: MemoryDeviceCommandClient, failures: number): DeviceCommandTableClient {
  let left = failures
  return {
    from: db.from.bind(db) as DeviceCommandTableClient['from'],
    rpc: (fn, args) => {
      if (fn === 'recheck_device_command_execution' && left > 0) { left -= 1; return Promise.resolve(FETCH_FAILED) }
      return db.rpc(fn, args)
    },
  }
}

describe('lease recheck 没有回答时,投递不落终态', () => {
  it('fetch failed 的 recheck 让命令回 pending,下一拍投递成功', async () => {
    const db = new MemoryDeviceCommandClient([
      deviceCommandRow({ id: 'eff4a05b', deviceId: DEVICE, type: 'agent.deliver', payload: { agent_user_id: 'agent-1', chat_id: 'c', message_id: 'm' }, createdAt: NOW }),
    ])
    const client = flappingRecheck(db, 1)
    let delivered = 0
    const handlers = { 'agent.deliver': async () => { delivered += 1; return { delivered: true } } }

    const first = await processPendingDeviceCommandsOnce(client, DEVICE, handlers, { nowIso: () => NOW, sleep: async () => {} })
    expect(first).toMatchObject([{ commandId: 'eff4a05b', status: 'held' }])
    expect(db.row('eff4a05b')).toMatchObject({ status: 'pending' })
    expect(delivered).toBe(0)

    const second = await processPendingDeviceCommandsOnce(client, DEVICE, handlers, { nowIso: () => NOW, sleep: async () => {} })
    expect(second).toMatchObject([{ commandId: 'eff4a05b', status: 'done' }])
    expect(db.row('eff4a05b').status).toBe('done')
    expect(delivered).toBe(1)
  })

  it('recheck 回 false 是终态:handler 不跑,行落 error,记「未送达」', async () => {
    const db = new MemoryDeviceCommandClient([
      deviceCommandRow({ id: 'c3c34409', deviceId: DEVICE, type: 'agent.deliver', payload: { agent_user_id: 'agent-1', chat_id: 'c', message_id: 'm' }, createdAt: NOW }),
    ])
    const refusing: DeviceCommandTableClient = {
      from: db.from.bind(db) as DeviceCommandTableClient['from'],
      rpc: (fn, args) => fn === 'recheck_device_command_execution' ? Promise.resolve({ data: false, error: null }) : db.rpc(fn, args),
    }
    let delivered = 0
    const handlers = { 'agent.deliver': async () => { delivered += 1; return { delivered: true } } }

    const results = await processPendingDeviceCommandsOnce(refusing, DEVICE, handlers, { nowIso: () => NOW, sleep: async () => {} })
    expect(results).toMatchObject([{ commandId: 'c3c34409', status: 'error' }])
    expect(db.row('c3c34409')).toMatchObject({ status: 'error', result: { reply_notice: 'context', reason: 'deliveryRejected' } })
    expect(delivered).toBe(0)
  })

  it('a raise in the recheck is a refusal too: the row ends, and the next delivery of the agent gets its turn', async () => {
    const db = new MemoryDeviceCommandClient([
      deviceCommandRow({ id: 'gone-post', deviceId: DEVICE, type: 'agent.deliver', createdAt: '2026-11-05T01:00:00.000Z', payload: { agent_user_id: 'agent-1', source: 'forum' } }),
      deviceCommandRow({ id: 'live-post', deviceId: DEVICE, type: 'agent.deliver', createdAt: '2026-11-05T01:10:00.000Z', payload: { agent_user_id: 'agent-1', source: 'forum' } }),
    ])
    const raising: DeviceCommandTableClient = {
      from: db.from.bind(db) as DeviceCommandTableClient['from'],
      rpc: (fn, args) => fn === 'recheck_device_command_execution' && args.p_id === 'gone-post'
        ? Promise.resolve({ data: null, error: { message: 'delivery is not live', details: null, hint: null, code: 'P0001' } })
        : db.rpc(fn, args),
    }
    const delivered: string[] = []
    const handlers = { 'agent.deliver': async (command: { id: string }) => { delivered.push(command.id); return { delivered: true } } }

    const first = await processPendingDeviceCommandsOnce(raising, DEVICE, handlers, { nowIso: () => NOW, sleep: async () => {} })
    expect(first).toMatchObject([{ commandId: 'gone-post', status: 'error' }])
    expect(db.row('gone-post')).toMatchObject({ status: 'error', result: { reason: 'deliveryRejected' } })

    const second = await processPendingDeviceCommandsOnce(raising, DEVICE, handlers, { nowIso: () => NOW, sleep: async () => {} })
    expect(second).toMatchObject([{ commandId: 'live-post', status: 'done' }])
    expect(delivered).toEqual(['live-post'])
  })
})
