// #7199 这台电脑能做的事 —— 把各动作族拼起来的那一层:默认全关;分组连上才能调;连上的组里还能单独关某个动作;
// 「全部拒绝」一键全停;「连接」先碰系统授权,碰不通不记成连上;原生组件不在就说清楚;族里抛的错统一成设备动作的错误码。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActionFamily, FamilyDeps } from '../../../../apps/desktop/electron/device-actions/catalog'
import { ok } from '../../../../apps/desktop/electron/device-actions/catalog'
import { createDeviceActionGrantsStore } from '../../../../apps/desktop/electron/device-actions/grants-store'
import { createDeviceActionsProvider } from '../../../../apps/desktop/electron/device-actions/provider'
import { MacScriptPermissionError } from '../../../../apps/desktop/electron/device-actions/mac-scripts'
import { NativeCallError } from '../../../../apps/desktop/electron/device-actions/native/mac-helper-client'
import { createClipboardFamily } from '../../../../apps/desktop/electron/device-actions/families/clipboard'
import { createExtrasFamily } from '../../../../apps/desktop/electron/device-actions/families/extras'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-dap-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const ctx = () => ({ callId: 'c', signal: new AbortController().signal, note: () => undefined })

function deps(over: Partial<FamilyDeps> = {}): FamilyDeps {
  return {
    platform: 'darwin',
    nativeDir: '/x',
    now: () => new Date('2026-10-15T08:00:00Z'),
    homedir: () => dir,
    clipboardRead: () => 'clip',
    clipboardWrite: vi.fn(),
    notify: vi.fn(async () => ({ shown: true })),
    openExternal: vi.fn(async () => undefined),
    trashItem: vi.fn(async () => undefined),
    jxa: vi.fn(async () => ({})),
    exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
    macHelper: () => ({ available: () => ({ ok: true as const }), call: vi.fn(async () => ({})) as never, dispose: () => undefined }),
    cua: () => ({ available: () => ({ ok: true as const }), callTool: vi.fn(async () => ({ content: [] })), stop: () => undefined, dispose: () => undefined }),
    ...over,
  }
}

/** 一族假的:「日历」要原生助手、连接时碰授权;「看」随便调。 */
function fakeFamily(probe: () => Promise<ReturnType<typeof ok> | { ok: false; code: 'os_permission'; message: string }>, run = vi.fn(async () => ok({ done: true }))): ActionFamily {
  return {
    groups: [
      { id: 'calendar', platforms: ['darwin'], needs: 'macHelper', settingsUrl: 'x-apple.systempreferences:cal', probe },
      { id: 'files.desktop', platforms: ['darwin'], section: 'files' },
      { id: 'files.documents', platforms: ['darwin'], section: 'files' },
    ],
    actions: [
      { name: 'calendar.events.create', group: 'calendar', title: '建日程', titleEn: 'Create event', description: 'd', risk: 'medium', confirm: 'never', input_schema: { type: 'object' }, run },
      { name: 'calendar.events.delete', group: 'calendar', title: '删日程', titleEn: 'Delete event', description: 'd', risk: 'high', confirm: 'always', input_schema: { type: 'object' }, question: () => '要删吗?', run },
      { name: 'fs.read', group: 'files', title: '读文件', titleEn: 'Read file', description: 'd', risk: 'medium', confirm: 'never', input_schema: { type: 'object' }, run },
    ],
  }
}

function setup(over: Partial<FamilyDeps> = {}, family = fakeFamily(async () => ok(null))) {
  const store = createDeviceActionGrantsStore(path.join(dir, 'grants.json'))
  return { store, p: createDeviceActionsProvider({ store, families: [family], deps: deps(over) }) }
}

describe('设备动作 provider', () => {
  it('默认全关:全部登记、全部 not_granted 并写清去哪打开;permit 拒;没登记的动作 unknown_action', () => {
    const { p } = setup()
    const cap = p.capability()!
    expect(cap.actions.map((a) => a.name)).toEqual(['calendar.events.create', 'calendar.events.delete', 'fs.read'])
    expect(cap.actions.every((a) => !a.available && a.unavailable_reason === 'not_granted' && a.unavailable_detail?.includes('Settings → Devices'))).toBe(true)
    expect(p.provider.permit('calendar.events.create')).toMatchObject({ ok: false, code: 'not_granted' })
    expect(p.provider.permit('shell.run')).toMatchObject({ ok: false, code: 'unknown_action' })
  })

  it('连接:碰通了才记成连上(带连接时间);碰不通回 os_permission + 系统设置那一页,❌ 记成连上', async () => {
    const denied = setup({}, fakeFamily(async () => ({ ok: false, code: 'os_permission', message: '没给' })))
    expect(await denied.p.connect('calendar')).toEqual({ ok: false, code: 'os_permission', message: '没给', settingsUrl: 'x-apple.systempreferences:cal' })
    expect(denied.store.read().groups.calendar).toBeUndefined()
    expect(denied.p.blocked('calendar')).toEqual({ reason: 'os_permission', message: '没给' })

    const { p, store } = setup()
    expect(await p.connect('calendar')).toEqual({ ok: true })
    expect(store.read().connectedAt.calendar).toBeTruthy()
    expect(p.provider.permit('calendar.events.create')).toEqual({ ok: true })
    expect(p.capability()!.actions.find((a) => a.name === 'calendar.events.create')?.available).toBe(true)
    p.disconnect('calendar')
    expect(p.provider.permit('calendar.events.create')).toMatchObject({ ok: false, code: 'not_granted' })
    expect(store.read().connectedAt.calendar).toBeUndefined()
  })

  it('连上的组里单独关一个动作:只有它不能调,清单里标出来;恢复后照常', async () => {
    const { p, store } = setup()
    await p.connect('calendar')
    store.setActionEnabled('calendar.events.delete', false)
    expect(p.provider.permit('calendar.events.delete')).toMatchObject({ ok: false, code: 'not_granted', message: expect.stringContaining('turned off "Delete event"') })
    expect(p.provider.permit('calendar.events.create')).toEqual({ ok: true })
    expect(p.capability()!.actions.find((a) => a.name === 'calendar.events.delete')).toMatchObject({ available: false, unavailable_reason: 'not_granted' })
    store.resetActionOverrides()
    expect(p.provider.permit('calendar.events.delete')).toEqual({ ok: true })
  })

  it('「全部拒绝」:连上了的也一个都不让调;关掉就恢复原样', async () => {
    const { p, store } = setup()
    await p.connect('calendar')
    store.setDenyAll(true)
    expect(p.provider.permit('calendar.events.create')).toMatchObject({ ok: false, code: 'not_granted', message: expect.stringContaining('Deny all') })
    expect(p.capability()!.actions.every((a) => !a.available)).toBe(true)
    store.setDenyAll(false)
    expect(p.provider.permit('calendar.events.create')).toEqual({ ok: true })
  })

  it('文件动作:四个根连上任何一个就能调(路径在动作里按根判);说明里写出连上了哪几处', async () => {
    const { p } = setup()
    expect(p.provider.permit('fs.read')).toMatchObject({ ok: false, code: 'not_granted' })
    await p.connect('files.documents')
    expect(p.provider.permit('fs.read')).toEqual({ ok: true })
    expect(p.capability()!.actions.find((a) => a.name === 'fs.read')?.description).toContain('Connected locations: 文稿')
    expect(p.actionsOf('files.desktop').map((a) => a.name)).toEqual(['fs.read'])
  })

  it('原生组件不在(开发环境没编):连不上、调不了,都说清是 unsupported 与原因', async () => {
    const missing = { available: () => ({ ok: false as const, message: '开发环境还没编原生组件' }), call: vi.fn() as never, dispose: () => undefined }
    const { p, store } = setup({ macHelper: () => missing })
    expect(await p.connect('calendar')).toMatchObject({ ok: false, code: 'unsupported', message: '开发环境还没编原生组件' })
    store.setGroup('calendar', true)
    expect(p.provider.permit('calendar.events.create')).toMatchObject({ ok: false, code: 'unsupported' })
    expect(p.capability()!.actions[0]).toMatchObject({ available: false, unavailable_reason: 'unsupported', unavailable_detail: '开发环境还没编原生组件' })
  })

  it('confirm=always:没带 confirmed 一律 needs_confirmation(问那一句);带了才放行', async () => {
    const { p } = setup()
    expect(await p.provider.preflight!('calendar.events.delete', {})).toMatchObject({ ok: false, code: 'needs_confirmation', confirm: { question: '要删吗?' } })
    expect(await p.provider.preflight!('calendar.events.delete', { confirmed: true })).toBeNull()
    expect(await p.provider.preflight!('calendar.events.create', {})).toBeNull()
  })

  it('confirmsItself:清单上仍是「每次先问你」,但开工前不拦(问句要动作自己查出名字);读授权状态那类做成了不清「系统没给权限」', async () => {
    const run = vi.fn(async () => ok({ status: 'denied' }))
    const family = fakeFamily(async () => ok(null))
    const store = createDeviceActionGrantsStore(path.join(dir, 'grants.json'))
    const p = createDeviceActionsProvider({
      store,
      families: [{
        ...family,
        actions: [
          ...family.actions,
          { name: 'calendar.x.delete', group: 'calendar', title: '删', titleEn: 'Delete x', description: 'd', risk: 'high', confirm: 'always', confirmsItself: true, input_schema: { type: 'object' }, run },
          { name: 'calendar.status', group: 'calendar', title: '状态', titleEn: 'Status', description: 'd', risk: 'low', confirm: 'never', succeedsWithoutPermission: true, input_schema: { type: 'object' }, run },
        ],
      }],
      deps: deps(),
    })
    expect(p.capability()!.actions.find((a) => a.name === 'calendar.x.delete')?.confirm).toBe('always')
    expect(await p.provider.preflight!('calendar.x.delete', {})).toBeNull()
    await p.connect('calendar')
    run.mockRejectedValueOnce(new NativeCallError('os_permission', '日历没授权'))
    await p.provider.run('calendar.x.delete', {}, ctx())
    expect(p.blocked('calendar')).toMatchObject({ reason: 'os_permission' })
    await p.provider.run('calendar.status', {}, ctx())
    expect(p.blocked('calendar')).toMatchObject({ reason: 'os_permission' })
  })

  it('这台电脑做不了的动作(unsupportedReason):照样登记,标 unsupported 并说为什么;调不了', async () => {
    const family = fakeFamily(async () => ok(null))
    const store = createDeviceActionGrantsStore(path.join(dir, 'grants.json'))
    const p = createDeviceActionsProvider({
      store,
      families: [{ ...family, actions: [...family.actions, { name: 'calendar.vision', group: 'calendar', title: '视觉', titleEn: 'Vision', description: 'd', risk: 'medium', confirm: 'never', input_schema: { type: 'object' }, unsupportedReason: () => '缺视觉模型', run: async () => ok(null) }] }],
      deps: deps(),
    })
    await p.connect('calendar')
    expect(p.provider.permit('calendar.vision')).toEqual({ ok: false, code: 'unsupported', message: '缺视觉模型' })
    expect(p.capability()!.actions.find((a) => a.name === 'calendar.vision')).toMatchObject({ available: false, unavailable_reason: 'unsupported', unavailable_detail: '缺视觉模型' })
    expect(p.unsupportedReason('calendar.vision')).toBe('缺视觉模型')
    expect(p.provider.permit('calendar.events.create')).toEqual({ ok: true })
  })

  it('族里抛的错收口:原生助手的 os_permission → 同码并标这一组;脚本没授权 → os_permission;别的 → execution_failed', async () => {
    const run = vi.fn()
    const { p } = setup({}, fakeFamily(async () => ok(null), run))
    await p.connect('calendar')
    run.mockRejectedValueOnce(new NativeCallError('os_permission', '日历没授权'))
    expect(await p.provider.run('calendar.events.create', {}, ctx())).toEqual({ ok: false, code: 'os_permission', message: '日历没授权' })
    expect(p.capability()!.actions[0]).toMatchObject({ available: false, unavailable_reason: 'os_permission' })
    run.mockResolvedValueOnce(ok({ done: true }))
    expect(await p.provider.run('calendar.events.create', {}, ctx())).toEqual({ ok: true, data: { done: true } })
    expect(p.capability()!.actions[0].available).toBe(true)
    run.mockRejectedValueOnce(new MacScriptPermissionError('邮件', '-1743'))
    expect(await p.provider.run('calendar.events.create', {}, ctx())).toMatchObject({ ok: false, code: 'os_permission' })
    run.mockRejectedValueOnce(new Error('boom'))
    expect(await p.provider.run('calendar.events.create', {}, ctx())).toEqual({ ok: false, code: 'execution_failed', message: 'Create event: boom' })
  })

  it('结果里的大图:过设备频道前缩到长边 1568(还大再缩一档);缩不下来就不带、如实说', async () => {
    const big = 'A'.repeat(800_000)
    const run = vi.fn(async () => ok({ text: 'x', pictures: [{ label: 'shot', mimeType: 'image/png', data: big }, { label: 'small', mimeType: 'image/png', data: 'AAAA' }] }))
    const shrinkImage = vi.fn(async (_image: { mimeType: string; data: string }, o: { maxEdge: number }) => ({ mimeType: 'image/jpeg', data: o.maxEdge === 1568 ? 'B'.repeat(750_000) : 'C'.repeat(1000), width: o.maxEdge, height: 1 }))
    const { p } = setup({ shrinkImage }, fakeFamily(async () => ok(null), run))
    await p.connect('calendar')
    const out = await p.provider.run('calendar.events.create', {}, ctx())
    expect(shrinkImage.mock.calls.map((c) => c[1].maxEdge)).toEqual([1568, 1024])
    expect(out).toEqual({ ok: true, data: { text: 'x', pictures: [{ label: 'shot', mimeType: 'image/jpeg', data: 'C'.repeat(1000) }, { label: 'small', mimeType: 'image/png', data: 'AAAA' }] } })

    shrinkImage.mockImplementation(async () => ({ mimeType: 'image/jpeg', data: 'D'.repeat(900_000), width: 1, height: 1 }))
    const huge = await p.provider.run('calendar.events.create', {}, ctx())
    expect(huge).toMatchObject({ ok: true, data: { pictures: [{ label: 'small' }], pictures_omitted: expect.stringContaining('shot') } })
  })

  it('按平台登记:Windows 上只有那边有的组(剪贴板、通知……),Mac 专属的不出现', () => {
    const store = createDeviceActionGrantsStore(path.join(dir, 'grants.json'))
    const p = createDeviceActionsProvider({ store, families: [fakeFamily(async () => ok(null)), createClipboardFamily(), createExtrasFamily()], deps: deps({ platform: 'win32' }) })
    expect(p.groups().map((g) => g.id)).toEqual(['clipboard', 'notification', 'url'])
    expect(p.capability()!.actions.map((a) => a.name)).toEqual(['clipboard.read', 'clipboard.write', 'notification.show', 'url.open'])
  })

  it('剪贴板读到图片:图进 pictures(给 agent 看),❌ 塞进文字', async () => {
    const store = createDeviceActionGrantsStore(path.join(dir, 'grants.json'))
    const p = createDeviceActionsProvider({
      store,
      families: [createClipboardFamily()],
      deps: deps({ clipboardReadImage: async () => ({ mimeType: 'image/png', data: 'AAAA', width: 2, height: 1 }) }),
    })
    await p.connect('clipboard')
    expect(await p.provider.run('clipboard.read', {}, ctx())).toEqual({
      ok: true,
      data: { text: 'clip', truncated: false, has_image: true, image_size: { width: 2, height: 1 }, pictures: [{ label: 'clipboard image', mimeType: 'image/png', data: 'AAAA' }] },
    })
  })
})
