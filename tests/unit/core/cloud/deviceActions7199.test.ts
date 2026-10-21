// #7199 第二步:设备动作的收发规矩。被调用方:收到 / 每 15 秒还在跑 / 结果 / 没收到「结果收到」重推 /
// 按 call_id 去重 / 授权三处各查一次;调用方:不在线不发、10 秒没收到重发一次、30 秒没进度当失联、拿到结果回「结果收到」。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDeviceActionHost, type DeviceActionOutcome, type DeviceActionProvider } from '@gugu/core/cloud/deviceActionHost'
import { createDeviceActionCaller, type DeviceActionCaller, type DeviceActionTarget } from '@gugu/core/cloud/deviceActionCaller'
import { DeviceRpcTimeoutError } from '@gugu/core/cloud/deviceRpcRequester'
import {
  DEVICE_ACTION_PROGRESS_EVENT,
  DEVICE_ACTION_RESULT_ACK_RPC_TYPE,
  DEVICE_ACTION_RESULT_EVENT,
  DEVICE_ACTION_RPC_TYPE,
  normalizeDeviceActionsCapability,
  readDeviceActionResult,
  type DeviceActionsCapability,
} from '@gugu/core/shared/deviceActions'

afterEach(() => {
  vi.useRealTimers()
})

function call(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    call_id: 'c1',
    action: 'calendar.events.create',
    args: { title: '会' },
    timeout_ms: 30_000,
    deadline_at: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  }
}

function provider(over: Partial<DeviceActionProvider> & { granted?: () => boolean } = {}): DeviceActionProvider & { runs: number } {
  const p = {
    runs: 0,
    manifest: () => [],
    permit: () => ((over.granted ?? (() => true))() ? { ok: true as const } : { ok: false as const, code: 'not_granted' as const, message: '没开' }),
    run: async (): Promise<DeviceActionOutcome> => {
      p.runs += 1
      return { ok: true, data: { created: true } }
    },
    ...over,
  }
  return p
}

describe('被调用方(DeviceActionHost)', () => {
  it('exposes the remaining execution budget independently of the ACK deadline', async () => {
    vi.useFakeTimers()
    let remaining: (() => number) | undefined
    const host = createDeviceActionHost({
      provider: provider({ run: async (_action, _args, ctx) => {
        remaining = ctx.remainingMs
        return new Promise<DeviceActionOutcome>(() => undefined)
      } }),
      publishEvent: () => undefined,
    })
    try {
      await host.handleCall(call({ timeout_ms: 60_000, deadline_at: new Date(Date.now() + 25_000).toISOString() }))
      expect(remaining?.()).toBe(60_000)
      await vi.advanceTimersByTimeAsync(26_000)
      expect(remaining?.()).toBe(34_000)
      await vi.advanceTimersByTimeAsync(34_000)
      expect(remaining?.()).toBe(0)
    } finally { host.dispose() }
  })

  it('收到 → 结果事件;同一个 call_id 再来回存着的结果,❌ 再做一次;结果收到后停止重推', async () => {
    vi.useFakeTimers()
    const events: Array<Record<string, unknown>> = []
    const p = provider()
    const host = createDeviceActionHost({ provider: p, publishEvent: (e) => { events.push(e as Record<string, unknown>) } })
    const reply = await host.handleCall(call())
    expect(reply.result).toMatchObject({ state: 'accepted', call_id: 'c1' })
    await vi.advanceTimersByTimeAsync(0)
    const results = () => events.filter((e) => e.type === DEVICE_ACTION_RESULT_EVENT)
    expect(results()).toHaveLength(1)
    expect(readDeviceActionResult(results()[0].result)).toMatchObject({ ok: true, call_id: 'c1', data: { created: true } })
    // 没收到「结果收到」:5 秒后重推。
    await vi.advanceTimersByTimeAsync(5_000)
    expect(results()).toHaveLength(2)
    // 重发的请求(调用方没收到「收到」):回那份结果,不再执行。
    const again = await host.handleCall(call())
    expect(readDeviceActionResult(again.result)).toMatchObject({ ok: true, call_id: 'c1' })
    expect(p.runs).toBe(1)
    host.handleResultAck({ call_id: 'c1' })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(results()).toHaveLength(2)
    host.dispose()
  })

  it('开始前就没授权:直接在应答里回 not_granted,❌ 执行', async () => {
    const p = provider({ granted: () => false })
    const host = createDeviceActionHost({ provider: p, publishEvent: () => undefined })
    const reply = await host.handleCall(call())
    expect(readDeviceActionResult(reply.result)).toMatchObject({ ok: false, code: 'not_granted' })
    expect(p.runs).toBe(0)
  })

  it('执行中撤销授权:下一次报进度时拦下,回 revoked', async () => {
    vi.useFakeTimers()
    let granted = true
    const events: Array<Record<string, unknown>> = []
    const p = provider({
      granted: () => granted,
      run: () => new Promise<DeviceActionOutcome>(() => undefined),
    })
    const host = createDeviceActionHost({ provider: p, publishEvent: (e) => { events.push(e as Record<string, unknown>) } })
    await host.handleCall(call({ timeout_ms: 120_000 }))
    await vi.advanceTimersByTimeAsync(15_000)
    expect(events.filter((e) => e.type === DEVICE_ACTION_PROGRESS_EVENT)).toHaveLength(1)
    granted = false
    await vi.advanceTimersByTimeAsync(15_000)
    const result = events.find((e) => e.type === DEVICE_ACTION_RESULT_EVENT)
    expect(readDeviceActionResult(result?.result)).toMatchObject({ ok: false, code: 'revoked' })
    host.dispose()
  })

  it('交结果前授权已撤:结果不交出,回 revoked(如实说动作可能已经做了)', async () => {
    let granted = true
    const events: Array<Record<string, unknown>> = []
    const p = provider({
      granted: () => granted,
      run: async () => {
        granted = false
        return { ok: true, data: { secret: 1 } }
      },
    })
    const host = createDeviceActionHost({ provider: p, publishEvent: (e) => { events.push(e as Record<string, unknown>) } })
    await host.handleCall(call())
    await new Promise((r) => setTimeout(r, 0))
    const result = readDeviceActionResult(events.find((e) => e.type === DEVICE_ACTION_RESULT_EVENT)?.result)
    expect(result).toMatchObject({ ok: false, code: 'revoked' })
    expect(JSON.stringify(result)).not.toContain('secret')
    host.dispose()
  })

  it('到点没做完:回 timeout', async () => {
    vi.useFakeTimers()
    const events: Array<Record<string, unknown>> = []
    const host = createDeviceActionHost({
      provider: provider({ run: () => new Promise<DeviceActionOutcome>(() => undefined) }),
      publishEvent: (e) => { events.push(e as Record<string, unknown>) },
    })
    await host.handleCall(call({ timeout_ms: 5_000 }))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(readDeviceActionResult(events.find((e) => e.type === DEVICE_ACTION_RESULT_EVENT)?.result)).toMatchObject({ ok: false, code: 'timeout' })
    const result = readDeviceActionResult(events.find((e) => e.type === DEVICE_ACTION_RESULT_EVENT)?.result)
    expect(result?.ok === false && result.message).toMatch(/已请求取消.*可能部分执行.*结果未确认/)
    expect(result?.ok === false && result.message).not.toContain('已停止')
    host.dispose()
  })

  it('过了最晚开始时刻才收到:回 expired,❌ 执行;要确认的在应答里回 needs_confirmation', async () => {
    const p = provider({
      preflight: (_action, args) => (args.confirmed === true ? null : { ok: false, code: 'needs_confirmation', message: '要确认', confirm: { question: '建吗?' } }),
    })
    const host = createDeviceActionHost({ provider: p, publishEvent: () => undefined })
    const late = await host.handleCall(call({ call_id: 'late', deadline_at: new Date(Date.now() - 1).toISOString() }))
    expect(readDeviceActionResult(late.result)).toMatchObject({ ok: false, code: 'expired' })
    const ask = await host.handleCall(call({ call_id: 'ask' }))
    expect(readDeviceActionResult(ask.result)).toMatchObject({ ok: false, code: 'needs_confirmation', confirm: { question: '建吗?' } })
    expect(p.runs).toBe(0)
  })

  it('开工前就回绝的(没授权 / 过期 / 要确认)也记进「最近调用」,带调用者与原因', async () => {
    const records: Array<Record<string, unknown>> = []
    let granted = false
    const p = provider({
      granted: () => granted,
      preflight: () => ({ ok: false, code: 'needs_confirmation', message: '要确认', confirm: { question: '建吗?' } }),
      record: (entry) => { records.push({ ...entry }) },
    })
    const host = createDeviceActionHost({ provider: p, publishEvent: () => undefined })
    const caller = { agent_user_id: 'a1', name: '助理' }
    await host.handleCall(call({ call_id: 'denied', caller }))
    await host.handleCall(call({ call_id: 'late', caller, deadline_at: new Date(Date.now() - 1).toISOString() }))
    granted = true
    await host.handleCall(call({ call_id: 'ask', caller }))
    expect(records.map((r) => [r.callId, r.ok, r.code])).toEqual([
      ['denied', false, 'not_granted'],
      ['late', false, 'expired'],
      ['ask', false, 'needs_confirmation'],
    ])
    expect(records.every((r) => (r.caller as { name?: string })?.name === '助理' && typeof r.finishedAt === 'string')).toBe(true)
  })
})

const manifest: DeviceActionsCapability = {
  v: 1,
  updated_at: new Date().toISOString(),
  timezone: 'Asia/Shanghai',
  actions: [{
    name: 'calendar.events.create', group: 'calendar', title: '建日程', description: '', risk: 'medium', confirm: 'on_conflict',
    input_schema: { type: 'object' }, available: true,
  }],
}

function target(over: Partial<DeviceActionTarget> = {}): DeviceActionTarget {
  return { device_id: 'mac', label: 'MacBook', online: true, last_seen_at: new Date().toISOString(), actions: manifest, ...over }
}

describe('调用方(DeviceActionCaller)', () => {
  it('device_actions 三层:不带设备 = 按分组汇总;带设备 = 每个动作一行(无说明 / 参数);再带 group / name = 那几个全量', async () => {
    const big: DeviceActionsCapability = {
      ...manifest,
      actions: [
        ...manifest.actions,
        { name: 'calendar.events.list', group: 'calendar', title: '查日程', description: 'list events', risk: 'medium', confirm: 'never', input_schema: { type: 'object', properties: { start: {} } }, available: true },
        { name: 'mail.send', group: 'mail', title: '发邮件', description: 'send', risk: 'high', confirm: 'always', input_schema: { type: 'object' }, available: false, unavailable_reason: 'not_granted', unavailable_detail: '去连上邮件' },
      ],
    }
    const caller = createDeviceActionCaller({ listDevices: async () => [target({ actions: big }), target({ device_id: 'old', actions: undefined })], rpc: async () => ({ result: null }) })
    const all = await caller.describe()
    expect(all[0]).toMatchObject({ timezone: 'Asia/Shanghai', groups: [
      { group: 'calendar', available: true, actions: ['calendar.events.create', 'calendar.events.list'] },
      { group: 'mail', available: false, actions: ['mail.send'], unavailable_reason: 'not_granted', unavailable_detail: '去连上邮件' },
    ] })
    expect(all[0]).not.toHaveProperty('actions')
    expect(all[1]).toMatchObject({ device_id: 'old', groups: null })
    const one = await caller.describe('mac')
    expect(one[0].actions).toHaveLength(3)
    expect(one[0].actions![2]).toEqual({ name: 'mail.send', title: '发邮件', available: false, risk: 'high', confirm: 'always', unavailable_reason: 'not_granted', unavailable_detail: '去连上邮件' })
    expect(JSON.stringify(one)).not.toContain('input_schema')
    expect((await caller.describe('mac', { group: 'calendar' }))[0].actions!.map((a) => a.name)).toEqual(['calendar.events.create', 'calendar.events.list'])
    expect((await caller.describe('mac', { name: 'calendar.events.list' }))[0].actions).toEqual([big.actions[1]])
    await expect(caller.describe('mac', { name: 'nope' })).rejects.toThrow('没有动作 nope')
  })

  it('设备离线:当场说清是哪台,❌ 发出去', async () => {
    const rpc = vi.fn()
    const caller = createDeviceActionCaller({ listDevices: async () => [target({ online: false })], rpc })
    const result = await caller.call({ deviceId: 'mac', action: 'calendar.events.create' })
    expect(result).toMatchObject({ ok: false, code: 'device_offline' })
    expect(!result.ok && result.message).toContain('MacBook')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('不在账号下 / 没登记这个动作 / 老版本不登记:各自一个码,都 ❌ 发出去', async () => {
    const rpc = vi.fn()
    const caller = createDeviceActionCaller({ listDevices: async () => [target(), target({ device_id: 'old', actions: undefined })], rpc })
    expect(await caller.call({ deviceId: 'nope', action: 'x' })).toMatchObject({ code: 'unknown_device' })
    expect(await caller.call({ deviceId: 'mac', action: 'shell.run' })).toMatchObject({ code: 'unknown_action' })
    expect(await caller.call({ deviceId: 'old', action: 'calendar.events.create' })).toMatchObject({ code: 'unsupported' })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('收到 → 结果事件 → 回「结果收到」;第一次没收到就用同一个 call_id 重发', async () => {
    const sent: Array<{ type: string; payload: Record<string, unknown> }> = []
    let attempts = 0
    const caller: DeviceActionCaller = createDeviceActionCaller({
      listDevices: async () => [target()],
      newCallId: () => 'c9',
      rpc: async (_device, type, payload) => {
        sent.push({ type, payload: payload as Record<string, unknown> })
        if (type === DEVICE_ACTION_RESULT_ACK_RPC_TYPE) return { result: {} }
        attempts += 1
        if (attempts === 1) throw new DeviceRpcTimeoutError('no reply')
        setTimeout(() => caller.onEvent('mac', { payload: { type: DEVICE_ACTION_RESULT_EVENT, call_id: 'c9', result: { v: 1, ok: true, call_id: 'c9', data: { uid: 'E1' } } } }), 10)
        return { result: { v: 1, call_id: 'c9', state: 'accepted' } }
      },
    })
    const result = await caller.call({ deviceId: 'mac', action: 'calendar.events.create', args: { title: '会' } })
    expect(result).toMatchObject({ ok: true, data: { uid: 'E1' } })
    const calls = sent.filter((s) => s.type === DEVICE_ACTION_RPC_TYPE)
    expect(calls).toHaveLength(2)
    expect(calls[0].payload.call_id).toBe('c9')
    expect(calls[1].payload.call_id).toBe('c9')
    await new Promise((r) => setTimeout(r, 0))
    expect(sent.some((s) => s.type === DEVICE_ACTION_RESULT_ACK_RPC_TYPE && s.payload.call_id === 'c9')).toBe(true)
  })

  it('两次都没收到:no_answer(可能是刚关掉 / 断网)', async () => {
    const caller = createDeviceActionCaller({
      listDevices: async () => [target()],
      rpc: async () => { throw new DeviceRpcTimeoutError('no reply') },
    })
    expect(await caller.call({ deviceId: 'mac', action: 'calendar.events.create' })).toMatchObject({ ok: false, code: 'no_answer' })
  })

  it('收到之后 30 秒没有进度:no_answer;有进度就接着等', async () => {
    vi.useFakeTimers()
    const caller: DeviceActionCaller = createDeviceActionCaller({
      listDevices: async () => [target()],
      newCallId: () => 'c7',
      rpc: async () => ({ result: { v: 1, call_id: 'c7', state: 'accepted' } }),
    })
    const pending = caller.call({ deviceId: 'mac', action: 'calendar.events.create', timeoutMs: 120_000 })
    await vi.advanceTimersByTimeAsync(20_000)
    caller.onEvent('mac', { type: DEVICE_ACTION_PROGRESS_EVENT, call_id: 'c7', state: 'running', progress_at: new Date().toISOString() })
    await vi.advanceTimersByTimeAsync(25_000)
    let settled = false
    void pending.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await pending).toMatchObject({ ok: false, code: 'no_answer' })
  })

  it('别的调用(另一台设备 / 别人发的)的事件不串到这一次', async () => {
    const caller: DeviceActionCaller = createDeviceActionCaller({
      listDevices: async () => [target()],
      newCallId: () => 'mine',
      rpc: async (_d, type) => {
        if (type !== DEVICE_ACTION_RPC_TYPE) return { result: {} }
        setTimeout(() => {
          caller.onEvent('mac', { type: DEVICE_ACTION_RESULT_EVENT, call_id: 'other', result: { v: 1, ok: false, call_id: 'other', code: 'timeout', message: 'x' } })
          caller.onEvent('phone', { type: DEVICE_ACTION_RESULT_EVENT, call_id: 'mine', result: { v: 1, ok: false, call_id: 'mine', code: 'timeout', message: 'x' } })
          caller.onEvent('mac', { type: DEVICE_ACTION_RESULT_EVENT, call_id: 'mine', result: { v: 1, ok: true, call_id: 'mine', data: 1 } })
        }, 5)
        return { result: { v: 1, call_id: 'mine', state: 'accepted' } }
      },
    })
    expect(await caller.call({ deviceId: 'mac', action: 'calendar.events.create' })).toMatchObject({ ok: true, data: 1 })
  })
})

describe('登记清单的解析', () => {
  it('没授权的也登记、带原因;时区原样;不像清单的回 null', () => {
    const parsed = normalizeDeviceActionsCapability({
      v: 1, updated_at: 't', timezone: 'Asia/Shanghai',
      actions: [{ name: 'fs.read', group: 'files', title: '读文件', risk: 'medium', confirm: 'never', input_schema: {}, available: false, unavailable_reason: 'not_granted', unavailable_detail: '去设置里打开' }],
    })
    expect(parsed?.timezone).toBe('Asia/Shanghai')
    expect(parsed?.actions[0]).toMatchObject({ available: false, unavailable_reason: 'not_granted', unavailable_detail: '去设置里打开' })
    expect(normalizeDeviceActionsCapability({ nope: true })).toBeNull()
  })
})
