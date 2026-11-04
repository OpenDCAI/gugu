// #7199 日历动作族:13 个动作;建日程用三端合同的 title / start / end;撞时间先问;删除先读出真名再问;
// 原生助手报的系统权限错误变成 os_permission 并把这一组标成不可用。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FamilyDeps } from '../../../../apps/desktop/electron/device-actions/catalog'
import { createCalendarFamily } from '../../../../apps/desktop/electron/device-actions/families/calendar'
import { createDeviceActionGrantsStore } from '../../../../apps/desktop/electron/device-actions/grants-store'
import { NativeCallError, type MacHelperClient } from '../../../../apps/desktop/electron/device-actions/native/mac-helper-client'
import { createDeviceActionsProvider } from '../../../../apps/desktop/electron/device-actions/provider'

type Answer = (method: string, params: Record<string, unknown>) => unknown

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-cal-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function setup(answer: Answer, connected = true) {
  const call = vi.fn(async (method: string, params?: unknown) => answer(method, (params ?? {}) as Record<string, unknown>))
  const helper: MacHelperClient = { available: () => ({ ok: true }), call: call as unknown as MacHelperClient['call'], dispose: () => undefined }
  const deps: FamilyDeps = {
    platform: 'darwin',
    nativeDir: dir,
    now: () => new Date(2026, 9, 15, 10, 0),
    homedir: () => dir,
    clipboardRead: () => '',
    clipboardWrite: () => undefined,
    notify: async () => ({ shown: true }),
    openExternal: async () => undefined,
    trashItem: async () => undefined,
    jxa: vi.fn() as unknown as FamilyDeps['jxa'],
    exec: vi.fn(),
    macHelper: () => helper,
    cua: () => ({ available: () => ({ ok: false, message: 'no cua-driver' }), callTool: vi.fn(), stop: () => undefined, dispose: () => undefined }),
  }
  const store = createDeviceActionGrantsStore(path.join(fs.mkdtempSync(path.join(dir, 'grants-')), 'grants.json'))
  if (connected) store.setGroup('calendar', true)
  const da = createDeviceActionsProvider({ store, families: [createCalendarFamily()], deps })
  /** 照 deviceActionHost 的顺序:先 preflight,过了再 run。 */
  const invoke = async (action: string, args: Record<string, unknown>) => {
    const pre = await da.provider.preflight?.(action, args)
    if (pre) return pre
    return da.provider.run(action, args, { callId: 'c1', signal: new AbortController().signal, note: () => undefined })
  }
  return { call, store, da, invoke }
}

const methods = (call: ReturnType<typeof setup>['call']) => call.mock.calls.map((c) => c[0])

const event = (over: Record<string, unknown> = {}) => ({
  event_id: 'E1',
  title: '周会',
  start: '2026-10-16T15:30:00',
  end: '2026-10-16T16:30:00',
  all_day: false,
  calendar: '工作',
  calendar_id: 'C-work',
  recurring: false,
  ...over,
})

describe('日历动作族', () => {
  it('13 个动作同名,都在「日历」组;没连上时全部不可用', () => {
    const { da } = setup(() => null, false)
    const actions = da.capability()!.actions
    expect(actions.map((a) => a.name).sort()).toEqual([
      'calendar.calendars.create', 'calendar.calendars.delete', 'calendar.calendars.get', 'calendar.calendars.update',
      'calendar.events.create', 'calendar.events.delete', 'calendar.events.export', 'calendar.events.get', 'calendar.events.list', 'calendar.events.update',
      'calendar.list', 'calendar.sources.list', 'calendar.status',
    ])
    expect(actions.every((a) => a.group === 'calendar' && a.input_schema.additionalProperties === false)).toBe(true)
    expect(actions.every((a) => !a.available && a.unavailable_reason === 'not_granted')).toBe(true)
    const confirm = Object.fromEntries(actions.map((a) => [a.name, a.confirm]))
    expect(confirm['calendar.events.create']).toBe('on_conflict')
    expect(confirm['calendar.events.delete']).toBe('always')
    expect(confirm['calendar.calendars.delete']).toBe('always')
    expect(confirm['calendar.events.list']).toBe('never')
    expect(da.provider.permit('calendar.events.create')).toMatchObject({ ok: false, code: 'not_granted' })
  })

  it('连接:请原生助手要日历授权,给了才记成连上;没给回 os_permission 和系统设置入口', async () => {
    const granted = setup((m) => (m === 'permissions.request' ? { status: 'granted' } : null), false)
    expect(await granted.da.connect('calendar')).toEqual({ ok: true })
    expect(granted.call).toHaveBeenCalledWith('permissions.request', { kind: 'calendar' }, expect.anything())
    expect(granted.store.read().groups.calendar).toBe(true)

    const denied = setup((m) => (m === 'permissions.request' ? { status: 'denied' } : null), false)
    const r = await denied.da.connect('calendar')
    expect(r).toMatchObject({ ok: false, code: 'os_permission' })
    expect(!r.ok && r.settingsUrl).toContain('Privacy_Calendars')
    expect(denied.store.read().groups.calendar).toBeUndefined()
  })

  it('「明天下午 3 点建个会」:title / start / end 本地时间,先看那段时间,没撞就建进默认日历(不传 calendar)', async () => {
    const created = event({ event_id: 'NEW', title: '项目会', start: '2026-10-16T15:00:00+08:00', end: '2026-10-16T16:00:00+08:00', calendar: '个人' })
    const { call, invoke } = setup((m) => (m === 'calendar.events.list' ? { events: [] } : m === 'calendar.events.create' ? created : null))
    const r = await invoke('calendar.events.create', { title: '项目会', start: '2026-10-16T15:00:00', end: '2026-10-16T16:00:00' })
    expect(r).toEqual({ ok: true, data: created })
    expect(methods(call)).toEqual(['calendar.events.list', 'calendar.events.create'])
    expect(call.mock.calls[0]![1]).toEqual({ start: '2026-10-16T15:00:00', end: '2026-10-16T16:00:00', include_declined: true, limit: 500 })
    expect(call.mock.calls[1]![1]).toEqual({ title: '项目会', start: '2026-10-16T15:00:00', end: '2026-10-16T16:00:00' })
  })

  it('没给 end:按 1 小时看冲突,end 交给原生助手补', async () => {
    const { call, invoke } = setup((m) => (m === 'calendar.events.list' ? { events: [] } : event()))
    await invoke('calendar.events.create', { title: '项目会', start: '2026-10-16T15:00:00', calendar: '工作', alarms_minutes_before: [15] })
    expect(call.mock.calls[0]![1]).toMatchObject({ start: '2026-10-16T15:00:00', end: new Date(2026, 9, 16, 16, 0).toISOString() })
    expect(call.mock.calls[1]![1]).toEqual({ title: '项目会', start: '2026-10-16T15:00:00', calendar: '工作', alarms_minutes_before: [15] })
  })

  it('撞了时间:回 needs_confirmation 点名撞上的那条,❌ 建;全天 / 空闲 / 已谢绝 / 已取消 / 首尾相接的不算;带 confirmed 才建', async () => {
    const existing = [
      event(),
      event({ event_id: 'A', title: '国庆', all_day: true, start: '2026-10-16', end: '2026-10-16' }),
      event({ event_id: 'F', title: '午休', availability: 'free' }),
      event({ event_id: 'D', title: '别人的会', my_status: 'declined' }),
      event({ event_id: 'X', title: '取消的会', status: 'canceled' }),
      event({ event_id: 'B', title: '前一个会', start: '2026-10-16T14:00:00', end: '2026-10-16T15:00:00' }),
    ]
    const { call, invoke } = setup((m) => (m === 'calendar.events.list' ? { events: existing } : event({ event_id: 'NEW' })))
    const args = { title: '项目会', start: '2026-10-16T15:00:00', end: '2026-10-16T16:00:00' }
    const first = await invoke('calendar.events.create', args)
    expect(first).toMatchObject({ ok: false, code: 'needs_confirmation' })
    if (first.ok || !first.confirm) throw new Error('expected a confirmation')
    expect(first.confirm.question).toBe('这段时间已经有「周会」（10月16日 15:30–16:30），还要建「项目会」吗？')
    expect((first.confirm.details as { clashes: Array<{ event_id: string }> }).clashes.map((c) => c.event_id)).toEqual(['E1'])
    expect(methods(call)).toEqual(['calendar.events.list'])

    call.mockClear()
    const second = await invoke('calendar.events.create', { ...args, confirmed: true })
    expect(second.ok).toBe(true)
    expect(methods(call)).toEqual(['calendar.events.create'])
    expect(call.mock.calls[0]![1]).not.toHaveProperty('confirmed')
  })

  it('全天日程:只看同一天同名的全天日程', async () => {
    const { call, invoke } = setup((m) => (m === 'calendar.events.list'
      ? { events: [event({ title: '团建', all_day: true, start: '2026-10-17', end: '2026-10-17' }), event({ title: '团建' })] }
      : event()))
    const r = await invoke('calendar.events.create', { title: '团建', start: '2026-10-17', end: '2026-10-17', all_day: true })
    expect(call.mock.calls[0]![1]).toEqual({ start: '2026-10-17', end: '2026-10-17', include_declined: true, limit: 500 })
    expect(r).toMatchObject({ ok: false, code: 'needs_confirmation', confirm: { question: '这段时间已经有「团建」（10月17日 全天），还要建「团建」吗？' } })
  })

  it('参数不对:开工前就回 invalid_args,❌ 碰原生助手', async () => {
    const { call, invoke } = setup(() => null)
    const cases: Array<[string, Record<string, unknown>]> = [
      ['calendar.events.create', { start: '2026-10-16T15:00:00' }],
      ['calendar.events.create', { title: '会', start: '明天三点' }],
      ['calendar.events.create', { title: '会', start: '2026-10-16T15:00:00', end: '2026-10-16T14:00:00' }],
      ['calendar.events.create', { title: '会', start: '2026-10-17', end: '2026-10-16', all_day: true }],
      ['calendar.events.create', { title: '会', start: '2026-10-16T15:00:00', alarms_minutes_before: ['15'] }],
      ['calendar.events.create', { title: '会', start: '2026-10-16T15:00:00', recurrence: { frequency: 'hourly' } }],
      ['calendar.events.create', { title: '会', start: '2026-10-16T15:00:00', url: 'example.com' }],
      ['calendar.events.update', { event_id: 'E1' }],
      ['calendar.events.update', { event_id: 'E1', title: '' }],
      ['calendar.events.delete', { event_id: 'E1', span: 'all' }],
      ['calendar.events.list', { cursor: 'abc' }],
      ['calendar.events.list', { start: '2026-10-16', end: '2026-10-15' }],
      ['calendar.events.export', {}],
      ['calendar.calendars.update', { calendar_id: 'C1' }],
      ['calendar.calendars.create', { name: '工作', color: 'red' }],
    ]
    for (const [action, args] of cases) {
      expect(await invoke(action, args), `${action} ${JSON.stringify(args)}`).toMatchObject({ ok: false, code: 'invalid_args' })
    }
    expect(call).not.toHaveBeenCalled()
    // 全天日程同一天是一天;只有日期的 end 含那一整天。
    expect(await createCalendarFamilyValidate('calendar.events.create', { title: '会', start: '2026-10-16', end: '2026-10-16', all_day: true })).toBeNull()
    expect(await createCalendarFamilyValidate('calendar.events.list', { start: '2026-10-16', end: '2026-10-16' })).toBeNull()
  })

  it('删日程:没带 confirmed 先读出那一条,问句说出名字和时间,❌ 删;带 confirmed 才删(并把 confirmed 交给原生助手兜底)', async () => {
    const { call, invoke } = setup((m) => (m === 'calendar.events.get' ? event({ start: '2026-10-16T15:00:00', end: '2026-10-16T16:00:00' }) : { deleted: true }))
    const first = await invoke('calendar.events.delete', { event_id: 'E1' })
    expect(first).toMatchObject({ ok: false, code: 'needs_confirmation', confirm: { question: '要删除日程「周会」（10月16日 15:00–16:00）吗？' } })
    expect(call.mock.calls).toEqual([['calendar.events.get', { event_id: 'E1' }, expect.anything()]])

    call.mockClear()
    expect((await invoke('calendar.events.delete', { event_id: 'E1', confirmed: true })).ok).toBe(true)
    expect(call.mock.calls).toEqual([['calendar.events.delete', { event_id: 'E1', confirmed: true }, expect.anything()]])
  })

  it('删重复日程:没给 span 先要 span(❌ 问人);给了 future 的问句写清「这一次及以后」', async () => {
    const recurring = event({ event_id: 'S1@2026-10-16T15:00:00+08:00', start: '2026-10-16T15:00:00', recurring: true, attendee_count: 3 })
    const { invoke } = setup((m) => (m === 'calendar.events.get' ? recurring : { deleted: true }))
    expect(await invoke('calendar.events.delete', { event_id: recurring.event_id })).toMatchObject({ ok: false, code: 'invalid_args' })
    expect(await invoke('calendar.events.delete', { event_id: recurring.event_id, span: 'future' })).toMatchObject({
      ok: false,
      code: 'needs_confirmation',
      confirm: { question: '要删除重复日程「周会」从 10月16日 15:00 起的这一次及以后各次吗？它有 3 位参与者，删除可能会通知到他们。' },
    })
  })

  it('改日程:只发给了的字段;空串 = 清空;span 原样带过去', async () => {
    const { call, invoke } = setup(() => event())
    await invoke('calendar.events.update', { event_id: 'E1', span: 'this', start: '2026-10-16T16:00:00', location: '', alarms_minutes_before: [] })
    expect(call.mock.calls[0]!.slice(0, 2)).toEqual(['calendar.events.update', { event_id: 'E1', span: 'this', start: '2026-10-16T16:00:00', location: '', alarms_minutes_before: [] }])
  })

  it('查日程:cursor 变成 offset,过滤条件原样带过去', async () => {
    const { call, invoke } = setup(() => ({ events: [], total: 0, has_more: false }))
    await invoke('calendar.events.list', { start: '2026-10-16', end: '2026-10-16', calendar_ids: ['C1', 'C2'], query: '周会', limit: 20, cursor: '40' })
    expect(call.mock.calls[0]!.slice(0, 2)).toEqual(['calendar.events.list', { start: '2026-10-16', end: '2026-10-16', calendar_ids: ['C1', 'C2'], query: '周会', limit: 20, offset: 40 }])
  })

  it('删日历:问句说出日历名、账户、默认日历;系统日历直接拒;带 confirmed 才删', async () => {
    const cal = { id: 'C1', name: '工作', writable: true, is_default: true, immutable: false, source: { id: 'S1', name: 'iCloud', type: 'caldav' } }
    const { call, invoke } = setup((m) => (m === 'calendar.calendars.get' ? cal : { deleted: true }))
    expect(await invoke('calendar.calendars.delete', { calendar_id: 'C1' })).toMatchObject({
      ok: false,
      code: 'needs_confirmation',
      confirm: { question: '要删除日历「工作」（iCloud）和里面的全部日程吗？删了不能撤销。它是新日程默认放进去的日历。' },
    })
    expect(methods(call)).toEqual(['calendar.calendars.get'])
    call.mockClear()
    await invoke('calendar.calendars.delete', { calendar_id: 'C1', confirmed: true })
    expect(call.mock.calls[0]!.slice(0, 2)).toEqual(['calendar.calendars.delete', { calendar_id: 'C1', confirmed: true }])

    const system = setup(() => ({ ...cal, immutable: true }))
    expect(await system.invoke('calendar.calendars.delete', { calendar_id: 'C1' })).toMatchObject({ ok: false, code: 'invalid_args' })
  })

  it('新建日历:同名先问;没同名直接建', async () => {
    const lists = { calendars: [{ id: 'C1', name: '工作', writable: true, is_default: false, immutable: false, source: { id: 'S1', name: 'iCloud', type: 'caldav' } }] }
    const { call, invoke } = setup((m) => (m === 'calendar.calendars.list' ? lists : { id: 'C2', name: '健身' }))
    expect(await invoke('calendar.calendars.create', { name: ' 工作 ' })).toMatchObject({ ok: false, code: 'needs_confirmation', confirm: { question: '已经有叫「工作」的日历（iCloud），还要再建一个同名的吗？' } })
    call.mockClear()
    expect(await invoke('calendar.calendars.create', { name: '健身', color: '#FF9500' })).toEqual({ ok: true, data: { id: 'C2', name: '健身' } })
    expect(call.mock.calls.map((c) => c.slice(0, 2))).toEqual([['calendar.calendars.list', {}], ['calendar.calendars.create', { name: '健身', color: '#FF9500' }]])
  })

  it('系统权限没给:原生助手的 os_permission 原样回给 agent,这一组标成不可用;再做成一次就恢复', async () => {
    let denied = true
    const { invoke, da } = setup((m) => {
      if (denied) throw new NativeCallError('os_permission', 'macOS has not allowed 咕咕 to access Calendar')
      return m === 'calendar.events.list' ? { events: [] } : null
    })
    expect(await invoke('calendar.events.list', {})).toEqual({ ok: false, code: 'os_permission', message: 'macOS has not allowed 咕咕 to access Calendar' })
    const entry = da.capability()!.actions.find((a) => a.name === 'calendar.events.create')!
    expect(entry).toMatchObject({ available: false, unavailable_reason: 'os_permission' })
    expect(da.blocked('calendar')).toMatchObject({ reason: 'os_permission' })
    denied = false
    expect((await invoke('calendar.events.list', {})).ok).toBe(true)
    expect(da.blocked('calendar')).toBeNull()
  })

  it('导出:按 event_id 或时间窗,参数原样带过去', async () => {
    const { call, invoke } = setup(() => ({ ics: 'BEGIN:VCALENDAR', count: 1, truncated: false }))
    await invoke('calendar.events.export', { event_id: 'E1', occurrence_only: true })
    await invoke('calendar.events.export', { start: '2026-10-01', end: '2026-10-31', calendar: '工作' })
    expect(call.mock.calls.map((c) => c.slice(0, 2))).toEqual([
      ['calendar.events.export', { event_id: 'E1', occurrence_only: true }],
      ['calendar.events.export', { start: '2026-10-01', end: '2026-10-31', calendar: '工作' }],
    ])
  })
})

/** 只跑某个动作的 validate(不经 provider)。 */
async function createCalendarFamilyValidate(name: string, args: Record<string, unknown>) {
  const def = createCalendarFamily().actions.find((a) => a.name === name)!
  return def.validate?.(args) ?? null
}
