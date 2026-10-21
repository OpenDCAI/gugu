// #7199 备忘录(notes.* 6 个):JXA 驱动「备忘录」。验:清单与确认策略、脚本能编译、连接碰授权、列表的上限与摘要、
// 同名新建先问、删除问句念标题且删前核对、参数检查。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FamilyDeps } from '../../../../apps/desktop/electron/device-actions/catalog'
import { createNotesFamily, noteSnippet, NOTES_JXA_LIB, NOTES_SCRIPTS } from '../../../../apps/desktop/electron/device-actions/families/notes'
import { createDeviceActionGrantsStore } from '../../../../apps/desktop/electron/device-actions/grants-store'
import { MacScriptPermissionError, type ExecResult } from '../../../../apps/desktop/electron/device-actions/mac-scripts'
import type { CuaClient } from '../../../../apps/desktop/electron/device-actions/native/cua-client'
import type { MacHelperClient } from '../../../../apps/desktop/electron/device-actions/native/mac-helper-client'
import { createDeviceActionsProvider } from '../../../../apps/desktop/electron/device-actions/provider'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-notes-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

type Jxa = (script: string, input: unknown, options: { signal?: AbortSignal; timeoutMs?: number; app: string }) => Promise<unknown>

function setup(jxaImpl: Jxa) {
  const store = createDeviceActionGrantsStore(path.join(dir, 'grants.json'))
  const jxa = vi.fn(jxaImpl)
  const exec = vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', code: 0 }))
  const deps: FamilyDeps = {
    platform: 'darwin',
    nativeDir: null,
    now: () => new Date(),
    homedir: () => dir,
    clipboardRead: () => '',
    clipboardWrite: () => undefined,
    notify: () => undefined,
    openExternal: async () => undefined,
    trashItem: async () => undefined,
    jxa: jxa as unknown as FamilyDeps['jxa'],
    exec,
    macHelper: () => ({ available: () => ({ ok: true }), call: vi.fn(), dispose: () => undefined }) as unknown as MacHelperClient,
    cua: () => ({ available: () => ({ ok: true }), callTool: vi.fn(), stop: () => undefined, dispose: () => undefined }) as unknown as CuaClient,
  }
  const da = createDeviceActionsProvider({ store, families: [createNotesFamily()], deps })
  store.setGroup('notes', true)
  return { da, store, jxa }
}

const ctx = () => ({ callId: 'c', signal: new AbortController().signal, note: () => undefined })
const ran = (jxa: ReturnType<typeof vi.fn>, script: string) => jxa.mock.calls.filter(([s]) => s === NOTES_JXA_LIB + script)

describe('备忘录 notes.*', () => {
  it('登记 6 个工具;删除每次问,新建撞名才问', () => {
    const { da } = setup(async () => ({}))
    const actions = da.capability()!.actions
    expect(actions.map((a) => a.name).sort()).toEqual(['notes.create', 'notes.delete', 'notes.folders.list', 'notes.get', 'notes.list', 'notes.update'])
    expect(Object.fromEntries(actions.map((a) => [a.name, a.confirm]))).toEqual({
      'notes.create': 'on_conflict', 'notes.delete': 'always', 'notes.folders.list': 'never', 'notes.get': 'never', 'notes.list': 'never', 'notes.update': 'never',
    })
    for (const a of actions) expect(a.input_schema).toMatchObject({ type: 'object', additionalProperties: false })
  })

  it.runIf(process.platform === 'darwin' && fs.existsSync('/usr/bin/osacompile'))('每个 JXA 脚本都能编译', () => {
    for (const [name, script] of Object.entries(NOTES_SCRIPTS)) {
      const file = path.join(dir, `${name}.js`)
      fs.writeFileSync(file, NOTES_JXA_LIB + script)
      expect(() => execFileSync('/usr/bin/osacompile', ['-l', 'JavaScript', '-o', path.join(dir, `${name}.scpt`), file], { stdio: 'pipe' }), name).not.toThrow()
    }
  })

  it('连接:碰一下文件夹;系统一直没应答 → os_permission(提示去点允许),❌ 记成连上', async () => {
    const pending = setup(async () => { throw new MacScriptPermissionError('备忘录', '-1712', true) })
    pending.store.setGroup('notes', false)
    const r = await pending.da.connect('notes')
    expect(r).toMatchObject({ ok: false, code: 'os_permission', message: expect.stringContaining('Allow') })
    expect(!r.ok && r.settingsUrl).toContain('Privacy_Automation')
    expect(pending.store.read().groups.notes).toBeUndefined()
    const fine = setup(async () => ({ folders: 3 }))
    fine.store.setGroup('notes', false)
    expect(await fine.da.connect('notes')).toEqual({ ok: true })
    expect(fine.jxa.mock.calls[0]![0]).toContain("Application('Notes').folders.name()")
  })

  it('列备忘录:默认 25 条、上限 200;摘要去掉开头的标题、压空白、200 字', async () => {
    const { da, jxa } = setup(async () => ({ total: 30, notes: [{ id: 'n1', name: '购物', snippet: '购物\n牛奶\n\n鸡蛋 ' }] }))
    const r = await da.provider.run('notes.list', { searchText: '牛奶' }, ctx())
    expect(r).toMatchObject({ ok: true, data: { total: 30, returned: 1, truncated: true, notes: [{ id: 'n1', snippet: '牛奶 鸡蛋' }] } })
    expect(ran(jxa, NOTES_SCRIPTS.list)[0]![1]).toEqual({ folderName: undefined, accountName: undefined, searchText: '牛奶', limit: 25, snippet: 200 })
    await da.provider.run('notes.list', { limit: 5000 }, ctx())
    expect(ran(jxa, NOTES_SCRIPTS.list)[1]![1]).toMatchObject({ limit: 200 })
    expect(noteSnippet('T', `T\n${'x'.repeat(500)}`)).toHaveLength(200)
  })

  it('新建:同一个文件夹已有同名 → needs_confirmation(问句说清哪个文件夹、什么标题);带 confirmed 才建(force)', async () => {
    const jxa: Jxa = async (_s, input) => ((input as { force: boolean }).force
      ? { id: 'x-coredata://N2', name: '周会', folder: 'Notes' }
      : { conflict: true, folder: 'Notes', existing: ['x-coredata://N1'] })
    const { da } = setup(jxa)
    const args = { name: '周会', body: '<div>议程</div>' }
    expect(await da.provider.preflight!('notes.create', args)).toBeNull()
    expect(await da.provider.run('notes.create', args, ctx())).toMatchObject({
      ok: false, code: 'needs_confirmation', confirm: { question: '备忘录文件夹「Notes」里已经有一条叫「周会」的备忘录了，还要再建一条同名的吗？' },
    })
    expect(await da.provider.run('notes.create', { ...args, confirmed: true }, ctx())).toMatchObject({ ok: true, data: { id: 'x-coredata://N2' } })
    expect(await da.provider.preflight!('notes.create', { name: '  ' })).toMatchObject({ code: 'invalid_args' })
  })

  it('删除:问句念标题;删前核对标题,对不上 → invalid_args 且说出真标题', async () => {
    const { da, jxa } = setup(async () => ({ error: 'name_mismatch', name: '另一条' }))
    expect(await da.provider.preflight!('notes.delete', { id: 'x-coredata://N1', name: '旧密码' }))
      .toMatchObject({ code: 'needs_confirmation', confirm: { question: '要删除备忘录「旧密码」吗？（会先放进「最近删除」）' } })
    expect(await da.provider.preflight!('notes.delete', { id: 'x-coredata://N1' })).toMatchObject({ code: 'invalid_args' })
    const r = await da.provider.run('notes.delete', { id: 'x-coredata://N1', name: '旧密码', confirmed: true }, ctx())
    expect(r).toMatchObject({ ok: false, code: 'invalid_args', message: expect.stringContaining('另一条') })
    expect(ran(jxa, NOTES_SCRIPTS.delete)[0]![1]).toEqual({ id: 'x-coredata://N1', name: '旧密码' })
  })

  it('改 / 读:没给 name 也没给 body → invalid_args;找不到 → invalid_args;上锁的改不了', async () => {
    const { da } = setup(async (script) => (script.endsWith(NOTES_SCRIPTS.update) ? { error: 'locked' } : { error: 'not_found' }))
    expect(await da.provider.preflight!('notes.update', { id: 'x' })).toMatchObject({ code: 'invalid_args' })
    expect(await da.provider.run('notes.update', { id: 'x', body: '<div>新</div>' }, ctx())).toMatchObject({ ok: false, code: 'execution_failed', message: expect.stringContaining('locked') })
    expect(await da.provider.run('notes.get', { id: 'gone' }, ctx())).toMatchObject({ ok: false, code: 'invalid_args', message: expect.stringContaining('gone') })
  })
})
