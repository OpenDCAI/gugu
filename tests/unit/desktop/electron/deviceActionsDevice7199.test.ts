// #7199 位置与设备状态(location.get / location.geocode / battery.get):连接「位置」时如实判授权 ——
// macOS 可能根本不给命令行助手弹授权框,状态停在「没决定」就不算连上;坐标开工前就判范围;电池把原生助手的 IOKit 读数
// 变成一眼看懂的状态,台式机说清「没有电池」。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FamilyDeps } from '../../../../apps/desktop/electron/device-actions/catalog'
import { createDeviceFamily } from '../../../../apps/desktop/electron/device-actions/families/device'
import { createDeviceActionGrantsStore } from '../../../../apps/desktop/electron/device-actions/grants-store'
import { NativeCallError } from '../../../../apps/desktop/electron/device-actions/native/mac-helper-client'
import { createDeviceActionsProvider } from '../../../../apps/desktop/electron/device-actions/provider'

let dir: string
let stores = 0

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-dad-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

type Call = (method: string, params?: unknown, options?: { signal?: AbortSignal; timeoutMs?: number }) => Promise<unknown>

function setup(call: Call) {
  const helperCall = vi.fn(call)
  const deps: FamilyDeps = {
    platform: 'darwin',
    nativeDir: '/x',
    now: () => new Date('2026-10-15T08:00:00Z'),
    homedir: () => dir,
    clipboardRead: () => '',
    clipboardWrite: vi.fn(),
    notify: vi.fn(),
    openExternal: vi.fn(async () => undefined),
    trashItem: vi.fn(async () => undefined),
    jxa: vi.fn(async () => ({})),
    exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
    macHelper: () => ({ available: () => ({ ok: true as const }), call: helperCall as never, dispose: () => undefined }),
    cua: () => ({ available: () => ({ ok: true as const }), callTool: vi.fn(async () => ({ content: [] })), stop: () => undefined, dispose: () => undefined }),
  }
  const store = createDeviceActionGrantsStore(path.join(dir, `grants-${++stores}.json`))
  const p = createDeviceActionsProvider({ store, families: [createDeviceFamily()], deps })
  const notes: string[] = []
  const invoke = async (action: string, args: Record<string, unknown>) => {
    const permit = await p.provider.permit(action)
    if (!permit.ok) return permit
    const pre = await p.provider.preflight?.(action, args)
    if (pre) return pre
    return p.provider.run(action, args, { callId: 'c', signal: new AbortController().signal, note: (t) => notes.push(t) })
  }
  return { p, store, helperCall, invoke, notes }
}

const status = (value: string): Call => async (method) => (method === 'permissions.request' ? { status: value } : {})

describe('位置', () => {
  it('登记 location.get / location.geocode(组 location)与 battery.get(组 device)', () => {
    const { p } = setup(status('granted'))
    expect(p.capability()!.actions.map((a) => [a.name, a.group])).toEqual([
      ['location.get', 'location'],
      ['location.geocode', 'location'],
      ['battery.get', 'device'],
    ])
  })

  it('连接「位置」:授权了才连上;状态停在「没决定」(没弹框)/ 拒绝 / 定位服务关了 → os_permission,各说清去哪,❌ 记成连上', async () => {
    const granted = setup(status('granted'))
    expect(await granted.p.connect('location')).toEqual({ ok: true })
    expect(granted.helperCall).toHaveBeenCalledWith('permissions.request', { kind: 'location' }, expect.anything())

    const cases: Array<[string, string]> = [
      ['not_determined', '可能根本没弹出'],
      ['denied', '定位服务 里打开咕咕'],
      ['restricted', '定位服务 里打开咕咕'],
      ['services_off', '总开关'],
    ]
    for (const [value, words] of cases) {
      const s = setup(status(value))
      const r = await s.p.connect('location')
      expect(r).toMatchObject({ ok: false, code: 'os_permission', settingsUrl: expect.stringContaining('Privacy_LocationServices') })
      expect(!r.ok && r.message).toContain(words)
      expect(s.store.read().groups.location).toBeUndefined()
    }
  })

  it('location.get:交给助手定位(给够时间、报一句「正在定位」),坐标与地址原样回', async () => {
    const fix = { latitude: 39.9, longitude: 116.4, accuracy_m: 65, timestamp: '2026-10-15T16:00:00+08:00', address: { found: true, locality: '北京市' } }
    const s = setup(async (method) => (method === 'permissions.request' ? { status: 'granted' } : fix))
    await s.p.connect('location')
    expect(await s.invoke('location.get', {})).toEqual({ ok: true, data: fix })
    expect(s.helperCall).toHaveBeenLastCalledWith('location.get', {}, expect.objectContaining({ timeoutMs: 45_000 }))
    expect(s.notes).toEqual(['正在定位…'])
  })

  it('location.get 时授权被收回:os_permission,并把「位置」标成不可用', async () => {
    const s = setup(async (method) => {
      if (method === 'permissions.request') return { status: 'granted' }
      throw new NativeCallError('os_permission', "macOS has not allowed 咕咕 to use this Mac's location: System Settings → Privacy & Security → Location Services → turn on 咕咕.")
    })
    await s.p.connect('location')
    expect(await s.invoke('location.get', {})).toMatchObject({ ok: false, code: 'os_permission', message: expect.stringContaining('Location Services') })
    expect(s.p.blocked('location')).toMatchObject({ reason: 'os_permission' })
  })

  it('location.geocode:坐标缺 / 越界开工前就挡;合法的按数字交给助手', async () => {
    const s = setup(async (method) => (method === 'permissions.request' ? { status: 'granted' } : { found: true, country: '中国' }))
    await s.p.connect('location')
    s.helperCall.mockClear()
    for (const args of [{}, { latitude: 30 }, { latitude: '30', longitude: 120 }, { latitude: 91, longitude: 0 }, { latitude: 0, longitude: -180.5 }]) {
      expect(await s.invoke('location.geocode', args)).toMatchObject({ ok: false, code: 'invalid_args' })
    }
    expect(s.helperCall).not.toHaveBeenCalled()
    expect(await s.invoke('location.geocode', { latitude: -90, longitude: 180 })).toEqual({ ok: true, data: { found: true, country: '中国' } })
    expect(s.helperCall).toHaveBeenLastCalledWith('location.geocode', { latitude: -90, longitude: 180 }, expect.anything())
  })
})

describe('电池', () => {
  const laptop = (over: Record<string, unknown> = {}, source = 'AC Power') => ({
    has_battery: true,
    batteries: [{ name: 'InternalBattery-0', percent: 82, charging: false, charged: false, power_source: source, health: 'Good', ...over }],
    providing_power_source: source,
    low_power_mode: false,
    thermal_state: 'nominal',
  })

  async function battery(reading: unknown) {
    const s = setup(async () => reading)
    expect(await s.p.connect('device')).toEqual({ ok: true })
    expect(s.helperCall).not.toHaveBeenCalled() // 「设备」不要系统授权:一点就连上
    const r = await s.invoke('battery.get', {})
    expect(s.helperCall).toHaveBeenLastCalledWith('battery.status', {}, expect.anything())
    return r
  }

  it('笔记本:电量、充电状态、电源、剩余时间都翻成一眼看懂的', async () => {
    expect(await battery(laptop({ charging: true, minutes_to_full: 40 }))).toEqual({
      ok: true,
      data: { has_battery: true, percent: 82, state: 'charging', charging: true, minutes_to_empty: null, minutes_to_full: 40, health: 'Good', power_source: 'ac', low_power_mode: false, thermal_state: 'nominal' },
    })
    expect(await battery(laptop({ minutes_to_empty: 300 }, 'Battery Power'))).toMatchObject({ ok: true, data: { state: 'on_battery', power_source: 'battery', minutes_to_empty: 300 } })
    expect(await battery(laptop({ percent: 100, charged: true }))).toMatchObject({ ok: true, data: { state: 'charged', power_source: 'ac' } })
    expect(await battery(laptop())).toMatchObject({ ok: true, data: { state: 'plugged_in' } })
  })

  it('台式机:has_battery false,并说清是没有电池(❌ 报成 0%)', async () => {
    const r = await battery({ has_battery: false, batteries: [], providing_power_source: 'AC Power', low_power_mode: false, thermal_state: 'fair' })
    expect(r).toEqual({ ok: true, data: { has_battery: false, power_source: 'ac', low_power_mode: false, thermal_state: 'fair', note: expect.stringContaining('no battery') } })
  })
})
