// #7199 通讯录(contacts.* 7 个):经原生助手。这里判 TS 这一层 —— 参数挡在开工前、只把认得的字段交给助手、
// 要人点头的(删除 / 丢数据的修改 / 同名新建)由助手回 needs_confirmation 并点名,provider ❌ 先用只认得 id 的泛问句截走;
// 系统没给通讯录权限 → os_permission(连接不记成连上,调用标成不可用)。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FamilyDeps } from '../../../../apps/desktop/electron/device-actions/catalog'
import { createContactsFamily } from '../../../../apps/desktop/electron/device-actions/families/contacts'
import { createDeviceActionGrantsStore } from '../../../../apps/desktop/electron/device-actions/grants-store'
import { NativeCallError } from '../../../../apps/desktop/electron/device-actions/native/mac-helper-client'
import { createDeviceActionsProvider } from '../../../../apps/desktop/electron/device-actions/provider'

let dir: string
let stores = 0

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-dac-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const ctx = () => ({ callId: 'c', signal: new AbortController().signal, note: () => undefined })

type Call = (method: string, params?: unknown, options?: { signal?: AbortSignal; timeoutMs?: number }) => Promise<unknown>

function setup(call: Call = async () => ({ ok: 1 }), available = true) {
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
    macHelper: () => ({
      available: () => (available ? { ok: true as const } : { ok: false as const, message: '原生组件不在' }),
      call: helperCall as never,
      dispose: () => undefined,
    }),
    cua: () => ({ available: () => ({ ok: true as const }), callTool: vi.fn(async () => ({ content: [] })), stop: () => undefined, dispose: () => undefined }),
  }
  const store = createDeviceActionGrantsStore(path.join(dir, `grants-${++stores}.json`))
  const p = createDeviceActionsProvider({ store, families: [createContactsFamily()], deps })
  /** 像 host 那样走一遍:permit → preflight → run。 */
  const invoke = async (action: string, args: Record<string, unknown>) => {
    const permit = await p.provider.permit(action)
    if (!permit.ok) return permit
    const pre = await p.provider.preflight?.(action, args)
    if (pre) return pre
    return p.provider.run(action, args, ctx())
  }
  return { p, store, helperCall, invoke }
}

/** 连上「通讯录」(probe 走 permissions.request,假助手回 granted)。 */
async function connected(call: Call = async () => ({ ok: 1 })) {
  const s = setup(async (method, params, options) => (method === 'permissions.request' ? { status: 'granted' } : call(method, params, options)))
  expect(await s.p.connect('contacts')).toEqual({ ok: true })
  s.helperCall.mockClear()
  return s
}

const methodsCalled = (helperCall: ReturnType<typeof vi.fn>) => helperCall.mock.calls.map((c) => c[0])

describe('通讯录动作', () => {
  it('登记 7 个名字、都在 contacts 组;删除是高风险,会问人的三个带 confirmed 参数', () => {
    const { p } = setup()
    const actions = p.capability()!.actions
    expect(actions.map((a) => a.name)).toEqual(['contacts.list', 'contacts.get', 'contacts.me', 'contacts.create', 'contacts.update', 'contacts.delete', 'contacts.export'])
    expect(actions.every((a) => a.group === 'contacts')).toBe(true)
    const byName = Object.fromEntries(actions.map((a) => [a.name, a]))
    expect(byName['contacts.delete']).toMatchObject({ risk: 'high', confirm: 'always' })
    expect(byName['contacts.list']).toMatchObject({ risk: 'medium', confirm: 'never' })
    for (const name of ['contacts.create', 'contacts.update', 'contacts.delete']) {
      expect((byName[name].input_schema.properties as Record<string, unknown>).confirmed).toEqual(expect.objectContaining({ type: 'boolean' }))
    }
  })

  it('连接:真去要通讯录授权;没给 → os_permission + 系统设置那一页,❌ 记成连上', async () => {
    const denied = setup(async () => ({ status: 'denied' }))
    const r = await denied.p.connect('contacts')
    expect(denied.helperCall).toHaveBeenCalledWith('permissions.request', { kind: 'contacts' }, expect.anything())
    expect(r).toMatchObject({ ok: false, code: 'os_permission', settingsUrl: expect.stringContaining('Privacy_Contacts') })
    expect(!r.ok && r.message).toContain('通讯录')
    expect(denied.store.read().groups.contacts).toBeUndefined()

    const granted = await connected()
    expect(granted.store.read().groups.contacts).toBe(true)
    expect(granted.p.provider.permit('contacts.list')).toEqual({ ok: true })
  })

  it('原生助手不在:整组不可用并说清为什么', async () => {
    const { p } = setup(undefined, false)
    await expect(p.connect('contacts')).resolves.toMatchObject({ ok: false, code: 'unsupported' })
    expect(p.blocked('contacts')).toEqual({ reason: 'unsupported', message: '原生组件不在' })
  })

  it('list:search / group 原样交给助手,limit 缺省 50、最多 500', async () => {
    const { invoke, helperCall } = await connected(async () => ({ total: 0, contacts: [] }))
    expect(await invoke('contacts.list', {})).toEqual({ ok: true, data: { total: 0, contacts: [] } })
    expect(helperCall).toHaveBeenLastCalledWith('contacts.list', { limit: 50 }, expect.objectContaining({ timeoutMs: 60_000 }))
    await invoke('contacts.list', { search: ' 张三 ', group: '同事', limit: 9999 })
    expect(helperCall).toHaveBeenLastCalledWith('contacts.list', { search: '张三', group: '同事', limit: 500 }, expect.anything())
    expect(await invoke('contacts.list', { limit: 'lots' })).toMatchObject({ ok: false, code: 'invalid_args' })
  })

  it('get / export:id 或 name 至少一个,开工前就挡;给了谁就按谁找', async () => {
    const { invoke, helperCall } = await connected(async () => ({ id: 'A' }))
    expect(await invoke('contacts.get', {})).toMatchObject({ ok: false, code: 'invalid_args', message: expect.stringContaining('id') })
    expect(await invoke('contacts.export', { name: '  ' })).toMatchObject({ ok: false, code: 'invalid_args' })
    expect(helperCall).not.toHaveBeenCalled()
    await invoke('contacts.get', { name: '张三' })
    expect(helperCall).toHaveBeenLastCalledWith('contacts.get', { name: '张三' }, expect.anything())
    await invoke('contacts.get', { id: 'ID-1', name: '张三' })
    expect(helperCall).toHaveBeenLastCalledWith('contacts.get', { id: 'ID-1' }, expect.anything())
    await invoke('contacts.export', { id: 'ID-2' })
    expect(helperCall).toHaveBeenLastCalledWith('contacts.export', { id: 'ID-2' }, expect.anything())
    await invoke('contacts.me', {})
    expect(helperCall).toHaveBeenLastCalledWith('contacts.me', {}, expect.anything())
  })

  it('create 的参数检查:没名字、公司没写公司名、邮箱 / 网址 / 生日不像样 → invalid_args,❌ 交给助手', async () => {
    const { invoke, helperCall } = await connected()
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ note: 'x' }, 'firstName'],
      [{ firstName: '三', company: true }, 'organization'],
      [{ firstName: '三', emails: [{ value: 'not-an-email' }] }, 'emails'],
      [{ firstName: '三', phones: [{ label: 'mobile', value: 'call me' }] }, 'phones'],
      [{ firstName: '三', urls: [{ value: 'example.com' }] }, 'urls'],
      [{ firstName: '三', birthday: '1990/05/03' }, 'birthday'],
      [{ firstName: '三', addresses: [{ label: 'home' }] }, 'addresses'],
      [{ firstName: '三', emails: 'a@b.com' }, 'emails'],
      [{ firstName: '三', homePage: 'www.x.com' }, 'homePage'],
    ]
    for (const [args, word] of cases) {
      expect(await invoke('contacts.create', args)).toMatchObject({ ok: false, code: 'invalid_args', message: expect.stringContaining(word) })
    }
    expect(helperCall).not.toHaveBeenCalled()
  })

  it('create:只交认得的字段;同名已在 → 助手回 needs_confirmation(点名那几位);带 confirmed 才建', async () => {
    const question = '通讯录里已经有 1 位「张三」：「张三」（Acme · 138 0000 0000）。还要再新建一个同名联系人吗？'
    const { invoke, helperCall } = await connected(async (_method, params) => {
      if ((params as { confirmed?: boolean }).confirmed !== true) throw new NativeCallError('needs_confirmation', question, { existing: [{ id: 'OLD', name: '张三' }] })
      return { id: 'NEW', name: '张三' }
    })
    const args = {
      firstName: '三',
      lastName: '张',
      birthday: '--05-03',
      phones: [{ label: 'mobile', value: '+86 138 0000 0001' }],
      emails: [{ label: 'work', value: 'zs@acme.com' }],
      sneaky: 'dropped',
    }
    const first = await invoke('contacts.create', args)
    expect(first).toEqual({ ok: false, code: 'needs_confirmation', message: question, confirm: { question, details: { existing: [{ id: 'OLD', name: '张三' }] } } })
    expect(helperCall).toHaveBeenLastCalledWith('contacts.create', {
      firstName: '三',
      lastName: '张',
      birthday: '--05-03',
      phones: [{ label: 'mobile', value: '+86 138 0000 0001' }],
      emails: [{ label: 'work', value: 'zs@acme.com' }],
      confirmed: false,
    }, expect.anything())
    expect(await invoke('contacts.create', { ...args, confirmed: true })).toEqual({ ok: true, data: { id: 'NEW', name: '张三' } })
    expect(helperCall.mock.lastCall?.[1]).toMatchObject({ confirmed: true })
    expect(helperCall.mock.lastCall?.[1]).not.toHaveProperty('sneaky')
  })

  it('update:要有 id 和至少一个字段;字段原样交给助手(清空用 "");会丢数据时助手的问句原样给人', async () => {
    const question = '修改「张三」会删掉：电话 138 0000 0000。确定吗？'
    const { invoke, helperCall } = await connected(async (_m, params) => {
      if ((params as { confirmed?: boolean }).confirmed !== true) throw new NativeCallError('needs_confirmation', question, { removes: ['电话 138 0000 0000'] })
      return { id: 'A' }
    })
    expect(await invoke('contacts.update', { firstName: '三' })).toMatchObject({ code: 'invalid_args', message: expect.stringContaining('id') })
    expect(await invoke('contacts.update', { id: 'A' })).toMatchObject({ code: 'invalid_args', message: expect.stringContaining('Nothing to change') })
    expect(helperCall).not.toHaveBeenCalled()
    const r = await invoke('contacts.update', { id: 'A', phones: [{ value: '139 0000 0000' }], note: '' })
    expect(r).toMatchObject({ ok: false, code: 'needs_confirmation', confirm: { question, details: { removes: ['电话 138 0000 0000'] } } })
    expect(helperCall).toHaveBeenLastCalledWith('contacts.update', { id: 'A', phones: [{ value: '139 0000 0000' }], note: '', confirmed: false }, expect.anything())
    expect(await invoke('contacts.update', { id: 'A', phones: [{ value: '139 0000 0000' }], confirmed: true })).toEqual({ ok: true, data: { id: 'A' } })
  })

  it('delete:provider ❌ 先截(它只看得到 id);助手点名问,带 confirmed 才删', async () => {
    const question = '要从这台电脑的通讯录里删除「张三」（Acme · 138 0000 0000）吗？删除后无法撤销。'
    const { p, invoke, helperCall } = await connected(async (_m, params) => {
      if ((params as { confirmed?: boolean }).confirmed !== true) throw new NativeCallError('needs_confirmation', question, { contact: { id: 'A', name: '张三' } })
      return { deleted: true, id: 'A', name: '张三' }
    })
    expect(await p.provider.preflight?.('contacts.delete', { id: 'A' })).toBeNull()
    expect(await invoke('contacts.delete', {})).toMatchObject({ code: 'invalid_args' })
    const asked = await invoke('contacts.delete', { id: 'A' })
    expect(asked).toMatchObject({ ok: false, code: 'needs_confirmation', confirm: { question: expect.stringContaining('「张三」') } })
    expect(helperCall).toHaveBeenLastCalledWith('contacts.delete', { id: 'A', confirmed: false }, expect.anything())
    // 只有布尔 true 才算点过头:false、字符串 "yes" 都照样先问。
    for (const notYes of [false, 'yes', 1]) {
      expect(await invoke('contacts.delete', { id: 'A', confirmed: notYes })).toMatchObject({ code: 'needs_confirmation' })
      expect(helperCall).toHaveBeenLastCalledWith('contacts.delete', { id: 'A', confirmed: false }, expect.anything())
    }
    expect(await invoke('contacts.delete', { id: 'A', confirmed: true })).toEqual({ ok: true, data: { deleted: true, id: 'A', name: '张三' } })
    expect(helperCall).toHaveBeenLastCalledWith('contacts.delete', { id: 'A', confirmed: true }, expect.anything())
  })

  it('调用时系统权限被收回:助手的 os_permission 原样回,并把这一组标成不可用', async () => {
    const { p, invoke } = await connected(async () => {
      throw new NativeCallError('os_permission', 'macOS has not allowed 咕咕 to access Contacts: System Settings → Privacy & Security → Contacts → turn on 咕咕.')
    })
    expect(await invoke('contacts.list', {})).toMatchObject({ ok: false, code: 'os_permission', message: expect.stringContaining('Privacy & Security → Contacts') })
    expect(p.capability()!.actions.find((a) => a.name === 'contacts.me')).toMatchObject({ available: false, unavailable_reason: 'os_permission' })
    expect(p.blocked('contacts')).toMatchObject({ reason: 'os_permission' })
  })

  it('没连上「通讯录」:一个都调不了,也不碰助手', async () => {
    const { invoke, helperCall } = setup()
    expect(await invoke('contacts.list', {})).toMatchObject({ ok: false, code: 'not_granted' })
    expect(methodsCalled(helperCall)).toEqual([])
  })
})
