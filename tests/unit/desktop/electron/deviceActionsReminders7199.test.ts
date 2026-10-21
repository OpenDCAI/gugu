// #7199 提醒事项动作族:13 个动作;建提醒先查同一列表里同名没完成的;删除先读出真名再问;
// 第一版的参数(title / due / list / notes / include_completed)照旧能用;系统权限错误变成 os_permission。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FamilyDeps } from '../../../../apps/desktop/electron/device-actions/catalog'
import { createRemindersFamily } from '../../../../apps/desktop/electron/device-actions/families/reminders'
import { createDeviceActionGrantsStore } from '../../../../apps/desktop/electron/device-actions/grants-store'
import { NativeCallError, type MacHelperClient } from '../../../../apps/desktop/electron/device-actions/native/mac-helper-client'
import { createDeviceActionsProvider } from '../../../../apps/desktop/electron/device-actions/provider'

type Answer = (method: string, params: Record<string, unknown>) => unknown

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-rem-'))
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
    notify: () => undefined,
    openExternal: async () => undefined,
    trashItem: async () => undefined,
    jxa: vi.fn() as unknown as FamilyDeps['jxa'],
    exec: vi.fn(),
    macHelper: () => helper,
    cua: () => ({ available: () => ({ ok: false, message: 'no cua-driver' }), callTool: vi.fn(), stop: () => undefined, dispose: () => undefined }),
  }
  const store = createDeviceActionGrantsStore(path.join(fs.mkdtempSync(path.join(dir, 'grants-')), 'grants.json'))
  if (connected) store.setGroup('reminders', true)
  const da = createDeviceActionsProvider({ store, families: [createRemindersFamily()], deps })
  const invoke = async (action: string, args: Record<string, unknown>) => {
    const pre = await da.provider.preflight?.(action, args)
    if (pre) return pre
    return da.provider.run(action, args, { callId: 'c1', signal: new AbortController().signal, note: () => undefined })
  }
  return { call, store, da, invoke }
}

const sent = (call: ReturnType<typeof setup>['call']) => call.mock.calls.map((c) => c.slice(0, 2))

const reminder = (over: Record<string, unknown> = {}) => ({
  reminder_id: 'R1',
  title: '买牛奶',
  completed: false,
  list: '购物',
  list_id: 'L-shop',
  ...over,
})

describe('提醒事项动作族', () => {
  it('13 个动作同名,都在「提醒事项」组;删除与建提醒要先问', () => {
    const { da } = setup(() => null, false)
    const actions = da.capability()!.actions
    expect(actions.map((a) => a.name).sort()).toEqual([
      'reminders.complete', 'reminders.create', 'reminders.delete', 'reminders.get', 'reminders.list', 'reminders.lists',
      'reminders.lists.create', 'reminders.lists.delete', 'reminders.lists.get', 'reminders.lists.update',
      'reminders.sources.list', 'reminders.status', 'reminders.update',
    ])
    expect(actions.every((a) => a.group === 'reminders' && a.input_schema.additionalProperties === false && !a.available)).toBe(true)
    const confirm = Object.fromEntries(actions.map((a) => [a.name, a.confirm]))
    expect([confirm['reminders.create'], confirm['reminders.delete'], confirm['reminders.lists.delete'], confirm['reminders.lists.create']]).toEqual(['on_conflict', 'always', 'always', 'on_conflict'])
    expect(confirm['reminders.complete']).toBe('never')
  })

  it('连接:请原生助手要提醒事项授权', async () => {
    const { da, call, store } = setup((m) => (m === 'permissions.request' ? { status: 'granted' } : null), false)
    expect(await da.connect('reminders')).toEqual({ ok: true })
    expect(call).toHaveBeenCalledWith('permissions.request', { kind: 'reminders' }, expect.anything())
    expect(store.read().groups.reminders).toBe(true)
  })

  it('建提醒(第一版的参数照旧):先在默认列表里查同名没完成的,没有就建', async () => {
    const created = reminder({ reminder_id: 'NEW', title: '交房租', due: '2026-10-20T09:00:00+08:00', list: '提醒' })
    const { call, invoke } = setup((m) => (m === 'reminders.items.list' ? { reminders: [reminder()] } : created))
    const r = await invoke('reminders.create', { title: '交房租', due: '2026-10-20T09:00:00', notes: '转账' })
    expect(r).toEqual({ ok: true, data: created })
    expect(sent(call)).toEqual([
      ['reminders.items.list', { default_list: true, status: 'incomplete', query: '交房租', limit: 500 }],
      ['reminders.items.create', { title: '交房租', notes: '转账', due: '2026-10-20T09:00:00' }],
    ])
  })

  it('建提醒撞上同一列表里同名没完成的:回 needs_confirmation,❌ 建;带 confirmed 才建', async () => {
    const { call, invoke } = setup((m) => (m === 'reminders.items.list'
      ? { reminders: [reminder({ title: '买牛奶 ', due: '2026-10-16' }), reminder({ reminder_id: 'R2', title: '买牛奶和面包' })] }
      : reminder({ reminder_id: 'NEW' })))
    const first = await invoke('reminders.create', { title: '买牛奶', list: '购物' })
    expect(first).toMatchObject({ ok: false, code: 'needs_confirmation', confirm: { question: '「购物」里已经有没完成的提醒「买牛奶 」（到期 10月16日），还要再建一条吗？' } })
    if (first.ok || !first.confirm) throw new Error('expected a confirmation')
    expect((first.confirm.details as { existing: Array<{ reminder_id: string }> }).existing.map((x) => x.reminder_id)).toEqual(['R1'])
    expect(sent(call)).toEqual([['reminders.items.list', { list: '购物', status: 'incomplete', query: '买牛奶', limit: 500 }]])

    call.mockClear()
    expect((await invoke('reminders.create', { title: '买牛奶', list: '购物', confirmed: true })).ok).toBe(true)
    expect(sent(call)).toEqual([['reminders.items.create', { title: '买牛奶', list: '购物' }]])
  })

  it('查提醒:include_completed(第一版)= status all;cursor 变 offset', async () => {
    const { call, invoke } = setup(() => ({ reminders: [], total: 0, has_more: false }))
    await invoke('reminders.list', { list: '购物', include_completed: true })
    await invoke('reminders.list', { status: 'completed', due_after: '2026-10-01', due_before: '2026-10-31', query: '牛奶', limit: 10, cursor: '10' })
    expect(sent(call)).toEqual([
      ['reminders.items.list', { list: '购物', status: 'all' }],
      ['reminders.items.list', { status: 'completed', due_after: '2026-10-01', due_before: '2026-10-31', query: '牛奶', limit: 10, offset: 10 }],
    ])
  })

  it('改提醒:due: null / 空串 = 去掉到期;只发给了的字段', async () => {
    const { call, invoke } = setup(() => reminder())
    await invoke('reminders.update', { reminder_id: 'R1', due: null })
    await invoke('reminders.update', { reminder_id: 'R1', due: '', notes: '' })
    await invoke('reminders.update', { reminder_id: 'R1', list: '工作', priority: 'high' })
    expect(sent(call)).toEqual([
      ['reminders.items.update', { reminder_id: 'R1', due: null }],
      ['reminders.items.update', { reminder_id: 'R1', notes: '', due: null }],
      ['reminders.items.update', { reminder_id: 'R1', list: '工作', priority: 'high' }],
    ])
  })

  it('完成提醒:缺省就是标成完成', async () => {
    const { call, invoke } = setup(() => reminder({ completed: true }))
    await invoke('reminders.complete', { reminder_id: 'R1' })
    await invoke('reminders.complete', { reminder_id: 'R1', completed: false })
    expect(sent(call)).toEqual([
      ['reminders.items.complete', { reminder_id: 'R1', completed: true }],
      ['reminders.items.complete', { reminder_id: 'R1', completed: false }],
    ])
  })

  it('删提醒:没带 confirmed 先读出那一条,问句说出名字、列表、到期,❌ 删;带 confirmed 才删', async () => {
    const { call, invoke } = setup((m) => (m === 'reminders.items.get' ? reminder({ due: '2026-10-16T09:00:00' }) : { deleted: true }))
    expect(await invoke('reminders.delete', { reminder_id: 'R1' })).toMatchObject({
      ok: false,
      code: 'needs_confirmation',
      confirm: { question: '要删除提醒「买牛奶」（「购物」列表，到期 10月16日 09:00）吗？' },
    })
    expect(sent(call)).toEqual([['reminders.items.get', { reminder_id: 'R1' }]])
    call.mockClear()
    expect((await invoke('reminders.delete', { reminder_id: 'R1', confirmed: true })).ok).toBe(true)
    expect(sent(call)).toEqual([['reminders.items.delete', { reminder_id: 'R1', confirmed: true }]])
  })

  it('删提醒列表:问句说出列表名和里面有几条', async () => {
    const list = { id: 'L1', name: '购物', writable: true, is_default: false, immutable: false, source: { id: 'S', name: 'iCloud', type: 'caldav' }, reminder_count: 12 }
    const { call, invoke } = setup((m) => (m === 'reminders.lists.get' ? list : { deleted: true }))
    expect(await invoke('reminders.lists.delete', { list_id: 'L1' })).toMatchObject({
      ok: false,
      code: 'needs_confirmation',
      confirm: { question: '要删除提醒列表「购物」（iCloud）和里面的全部 12 条提醒吗？删了不能撤销。' },
    })
    call.mockClear()
    await invoke('reminders.lists.delete', { list_id: 'L1', confirmed: true })
    expect(sent(call)).toEqual([['reminders.lists.delete', { list_id: 'L1', confirmed: true }]])
  })

  it('参数不对:开工前就回 invalid_args,❌ 碰原生助手', async () => {
    const { call, invoke } = setup(() => null)
    const cases: Array<[string, Record<string, unknown>]> = [
      ['reminders.create', { title: '' }],
      ['reminders.create', { title: '跑步', due: '明早' }],
      ['reminders.create', { title: '跑步', recurrence: { frequency: 'daily' } }],
      ['reminders.create', { title: '跑步', priority: 'urgent' }],
      ['reminders.update', { reminder_id: 'R1' }],
      ['reminders.complete', { reminder_id: 'R1', completed: false, completion_date: '2026-10-15' }],
      ['reminders.list', { status: 'done' }],
      ['reminders.list', { due_after: '2026-10-20', due_before: '2026-10-10' }],
      ['reminders.lists.update', { list_id: 'L1' }],
      ['reminders.delete', {}],
    ]
    for (const [action, args] of cases) {
      expect(await invoke(action, args), `${action} ${JSON.stringify(args)}`).toMatchObject({ ok: false, code: 'invalid_args' })
    }
    expect(call).not.toHaveBeenCalled()
  })

  it('系统权限没给:os_permission 原样回给 agent,这一组标成不可用', async () => {
    const { invoke, da } = setup(() => {
      throw new NativeCallError('os_permission', 'macOS has not allowed 咕咕 to access Reminders')
    })
    expect(await invoke('reminders.list', {})).toEqual({ ok: false, code: 'os_permission', message: 'macOS has not allowed 咕咕 to access Reminders' })
    expect(da.blocked('reminders')).toMatchObject({ reason: 'os_permission' })
  })
})
