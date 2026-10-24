/**
 * 生产 bug:一轮 agent.deliver 跑得比这一拍拿到的令牌剩下的寿命还长 ⇒ 结束时用 tick 开头那个 client 写 done,
 * 库回「JWT expired」;改写 error 用的是同一个 client,照样失败 ⇒ 命令永远停在 running,各端一直以为这台机器在忙。
 * 判据:落终态的写在**写的那一刻**现取 client(resolveSettleClient),抛错按退避重试;写不进去 ❌ 冒充回合失败。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { setCoreLoggerFactory } from '@gugu/core/log'
import {
  deferDeviceCommand,
  processPendingDeviceCommandsOnce,
  type DeviceCommandTableClient,
} from '@gugu/core/cloud/deviceCommands'
import { RuntimeAuthExpiredError } from '@gugu/core/cloud/runtimeAuthProvider'
import { deviceCommandRow, MemoryDeviceCommandClient } from '../../../support/deviceRuntimeHarness'
import { until } from '../../../support/awaitCondition'

const DEVICE = 'dev-1'
const NOW = '2026-10-15T12:24:32.000Z'
const JWT_EXPIRED = { data: null, error: { message: 'JWT expired' } }

/** 一枚令牌对应的 client 视图:令牌失效后,库对它的每个请求都回 PostgREST 的 401 体。 */
function tokenClient(db: MemoryDeviceCommandClient, valid: () => boolean): DeviceCommandTableClient {
  const rejected = {
    eq: () => rejected,
    select: () => Promise.resolve(JWT_EXPIRED),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(JWT_EXPIRED).then(resolve),
  }
  return {
    from: ((table: 'gugu_device_commands' | 'runtime_instances') => {
      if (valid()) return db.from(table as 'gugu_device_commands')
      return { select: () => rejected, update: () => rejected, delete: () => rejected, insert: () => ({ select: () => ({ single: () => Promise.resolve(JWT_EXPIRED) }) }) }
    }) as DeviceCommandTableClient['from'],
    rpc: (fn, args) => (valid() ? db.rpc(fn, args) : Promise.resolve(JWT_EXPIRED)),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function setup() {
  const db = new MemoryDeviceCommandClient([
    deviceCommandRow({ id: 'a8f47c6e', deviceId: DEVICE, type: 'agent.deliver', payload: { agent_user_id: 'agent-1', chat_id: 'c', message_id: 'm' }, createdAt: NOW }),
  ])
  let tickTokenValid = true
  const tickClient = tokenClient(db, () => tickTokenValid)
  const freshClient = tokenClient(db, () => true)
  return { db, tickClient, freshClient, expireTickToken: () => { tickTokenValid = false } }
}

const noSleep = async () => {}

/** 记下「终态写彻底放弃」的那一行 —— 拍外的重试链走到头时唯一的可观测出口。 */
function captureLostSettlements(): string[] {
  const lost: string[] = []
  const restore = setCoreLoggerFactory(() => ({
    debug: () => {}, info: () => {}, warn: () => {},
    error: (fields, msg) => { if (msg.includes('could not be written')) lost.push(String(fields.commandId)) },
  }))
  restoreLogger.push(restore)
  return lost
}
const restoreLogger: Array<() => void> = []
afterEach(() => { while (restoreLogger.length) restoreLogger.pop()!() })

describe('落终态用写那一刻有效的令牌', () => {
  it('其他类型命令失败不改变其result语义', async () => {
    const db = new MemoryDeviceCommandClient([deviceCommandRow({ id: 'other', deviceId: DEVICE, type: 'agent.create', payload: {}, createdAt: NOW })])
    const previousResult = db.row('other').result
    await processPendingDeviceCommandsOnce(db, DEVICE, { 'agent.create': async () => { throw new Error('create failed') } }, { nowIso: () => NOW, sleep: noSleep })
    expect(db.row('other').result).toBe(previousResult)
  })
  it.each([true, false])('落库保留是否已在聊天披露：%s，其他设备不再重复通知', async (disclosedInChat) => {
    const { db, tickClient } = setup()
    await processPendingDeviceCommandsOnce(tickClient, DEVICE, {
      'agent.deliver': async () => { throw Object.assign(new Error('weekly limit reached'), { disclosedInChat }) },
    }, { nowIso: () => NOW, sleep: noSleep })
    expect(db.row('a8f47c6e').result).toEqual({ reply_notice: disclosedInChat ? 'in-chat' : 'context' })
  })
  it('一轮跑到令牌过期之后才结束:done 照样写进去', async () => {
    const { db, tickClient, freshClient, expireTickToken } = setup()
    const turn = deferred<object>()
    const results = await processPendingDeviceCommandsOnce(tickClient, DEVICE, {
      'agent.deliver': () => deferDeviceCommand({ delivered: true }, turn.promise),
    }, { nowIso: () => NOW, resolveSettleClient: async () => freshClient, sleep: noSleep })
    expect(results).toEqual([expect.objectContaining({ status: 'deferred' })])
    expect(db.row('a8f47c6e').status).toBe('running')

    expireTickToken()
    turn.resolve({ delivered: true })
    await until('命令落成 done', () => db.row('a8f47c6e').status === 'done')
    expect(db.row('a8f47c6e')).toMatchObject({ status: 'done', claim_token: null, error: null })
  })

  it('同步 handler 跑到令牌过期:done 也写得进去', async () => {
    const { db, tickClient, freshClient, expireTickToken } = setup()
    const results = await processPendingDeviceCommandsOnce(tickClient, DEVICE, {
      'agent.deliver': async () => { expireTickToken(); return { delivered: true } },
    }, { nowIso: () => NOW, resolveSettleClient: async () => freshClient, sleep: noSleep })
    expect(results).toEqual([expect.objectContaining({ status: 'done' })])
    expect(db.row('a8f47c6e').status).toBe('done')
  })

  it('取新令牌一时失败(刷新抖动):退避后重试,写进去', async () => {
    const { db, tickClient, freshClient, expireTickToken } = setup()
    const turn = deferred<object>()
    const delays: number[] = []
    let asks = 0
    await processPendingDeviceCommandsOnce(tickClient, DEVICE, {
      'agent.deliver': () => deferDeviceCommand({ delivered: true }, turn.promise),
    }, {
      nowIso: () => NOW,
      resolveSettleClient: async () => {
        asks += 1
        // 第一次是 tick 之后那次 claim 后的落定;前两次刷新失败,第三次拿到。
        if (asks <= 2) throw new Error('Supabase token refresh failed: fetch failed')
        return freshClient
      },
      settleRetryDelaysMs: [10, 20, 30],
      sleep: async (ms) => { delays.push(ms) },
    })
    expireTickToken()
    turn.resolve({ delivered: true })
    await until('命令落成 done', () => db.row('a8f47c6e').status === 'done')
    expect(delays).toEqual([10, 20])
  })

  it('回合成功、但重试用尽仍写不进去:❌ 把它改写成 error,行留给服务端超时兜底', async () => {
    const { db, tickClient, expireTickToken } = setup()
    const turn = deferred<object>()
    const delays: number[] = []
    const failed: string[] = []
    await processPendingDeviceCommandsOnce(tickClient, DEVICE, {
      'agent.deliver': () => deferDeviceCommand({ delivered: true }, turn.promise),
    }, {
      nowIso: () => NOW,
      resolveSettleClient: async () => tickClient,
      settleRetryDelaysMs: [1, 2],
      sleep: async (ms) => { delays.push(ms) },
      onCommandFailed: (command) => { failed.push(command.id) },
    })
    expireTickToken()
    turn.resolve({ delivered: true })
    await until('两次重试都用掉', () => delays.length === 2)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(db.row('a8f47c6e').status).toBe('running')
    expect(failed).toEqual([])
  })

  it('回合真失败:error 用新令牌写进去', async () => {
    const { db, tickClient, freshClient, expireTickToken } = setup()
    const turn = deferred<object>()
    const failed: string[] = []
    await processPendingDeviceCommandsOnce(tickClient, DEVICE, {
      'agent.deliver': () => deferDeviceCommand({ delivered: true }, turn.promise),
    }, {
      nowIso: () => NOW,
      resolveSettleClient: async () => freshClient,
      sleep: noSleep,
      onCommandFailed: (command) => { failed.push(command.id) },
    })
    expireTickToken()
    turn.reject(new Error('provider turn failed'))
    await until('命令落成 error', () => db.row('a8f47c6e').status === 'error')
    expect(db.row('a8f47c6e').error).toBe('provider turn failed')
    expect(failed).toEqual(['a8f47c6e'])
  })
})

describe('同步 handler 的终态写不在拍里退避', () => {
  it('拍里写失败一次:这一条立刻报 deferred,重试挪到拍外,拿到新令牌后写进去', async () => {
    const { db, tickClient, freshClient, expireTickToken } = setup()
    let healthy = false
    const sleeps: number[] = []
    const results = await processPendingDeviceCommandsOnce(tickClient, DEVICE, {
      'agent.deliver': async () => { expireTickToken(); return { delivered: true } },
    }, {
      nowIso: () => NOW,
      // 刷新服务一时连不上:拍里那一次拿到的还是旧令牌。
      resolveSettleClient: async () => (healthy ? freshClient : tickClient),
      settleRetryDelaysMs: [60_000],
      sleep: async (ms) => { sleeps.push(ms); healthy = true },
    })
    expect(results).toEqual([expect.objectContaining({ status: 'deferred' })])
    await until('拍外重试把 done 写进去', () => db.row('a8f47c6e').status === 'done')
    expect(sleeps).toEqual([60_000])
  })

  it('宿主停了:拍外的退避立刻结束,行留给服务端兜底', async () => {
    const { db, tickClient, expireTickToken } = setup()
    const lost = captureLostSettlements()
    const controller = new AbortController()
    let sleeps = 0
    const results = await processPendingDeviceCommandsOnce(tickClient, DEVICE, {
      'agent.deliver': async () => { expireTickToken(); return { delivered: true } },
    }, {
      nowIso: () => NOW,
      signal: controller.signal,
      resolveSettleClient: async () => tickClient,
      settleRetryDelaysMs: [60_000, 60_000, 60_000],
      // 自己永远不醒的 sleep:重试链能走到头,只能是 abort 把它叫醒。
      sleep: () => { sleeps += 1; return new Promise<void>(() => {}) },
    })
    expect(results).toEqual([expect.objectContaining({ status: 'deferred' })])
    await until('拍外开始退避', () => sleeps === 1)
    controller.abort()
    await until('重试链放弃', () => lost.length === 1)
    expect(sleeps).toBe(1)
    expect(db.row('a8f47c6e').status).toBe('running')
  })
})

describe('令牌永久失效不重试', () => {
  it('回合结束时 refresh token 已被吊销:不退避,当场放弃', async () => {
    const { tickClient } = setup()
    const lost = captureLostSettlements()
    const turn = deferred<object>()
    let asks = 0
    await processPendingDeviceCommandsOnce(tickClient, DEVICE, {
      'agent.deliver': () => deferDeviceCommand({ delivered: true }, turn.promise),
    }, {
      nowIso: () => NOW,
      resolveSettleClient: async () => { asks += 1; throw new RuntimeAuthExpiredError('refresh token revoked') },
      settleRetryDelaysMs: [1, 1, 1],
      sleep: noSleep,
    })
    turn.resolve({ delivered: true })
    await until('放弃', () => lost.length === 1)
    expect(asks).toBe(1)
  })

  it('同步路径:RuntimeAuthExpiredError 原样逃出这一拍,交给宿主的「请重新登录」', async () => {
    const { tickClient, expireTickToken } = setup()
    const run = processPendingDeviceCommandsOnce(tickClient, DEVICE, {
      'agent.deliver': async () => { expireTickToken(); return { delivered: true } },
    }, {
      nowIso: () => NOW,
      resolveSettleClient: async () => { throw new RuntimeAuthExpiredError('refresh token revoked') },
      sleep: noSleep,
    })
    await expect(run).rejects.toBeInstanceOf(RuntimeAuthExpiredError)
  })
})
