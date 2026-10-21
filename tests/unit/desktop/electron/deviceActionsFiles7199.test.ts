// #7199 文件这一族(fs.* 16 个):只认连上了的位置(没连上的根按字面就拒、不碰盘;符号链接按真实位置判);
// 走目录树不进没连上的根与 ~/Library;覆盖 / 替换 / 扔进废纸篓先问人;原生助手、命令行收到的参数一字不差。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FamilyDeps, Outcome } from '../../../../apps/desktop/electron/device-actions/catalog'
import { execFileAsync, type ExecResult } from '../../../../apps/desktop/electron/device-actions/mac-scripts'
import { createFilesFamily } from '../../../../apps/desktop/electron/device-actions/families/files'
import { createDeviceActionGrantsStore } from '../../../../apps/desktop/electron/device-actions/grants-store'
import { NativeCallError, type MacHelperClient } from '../../../../apps/desktop/electron/device-actions/native/mac-helper-client'
import { createDeviceActionsProvider } from '../../../../apps/desktop/electron/device-actions/provider'

let dir: string
let home: string
let trashDir: string
let stores = 0
const realHome = process.env.HOME
/** 结果里的路径都是真实位置(macOS 的临时目录在 /private 下)。 */
const real = (p: string) => path.join(fs.realpathSync(home), path.relative(home, p))
const H = (rel: string) => path.join(home, rel)

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-files-'))
  home = path.join(dir, 'home')
  trashDir = path.join(dir, 'trash')
  fs.mkdirSync(trashDir)
  for (const d of ['Desktop', 'Documents/sub', 'Downloads', 'Elsewhere', 'Library/Containers/app', '.secret']) fs.mkdirSync(H(d), { recursive: true })
  fs.writeFileSync(H('Documents/note.txt'), 'line1\nline2\nline3\n')
  fs.writeFileSync(H('Documents/sub/deep.txt'), 'deep')
  fs.writeFileSync(H('Desktop/todo.txt'), '桌面上的待办')
  fs.writeFileSync(H('Elsewhere/x.txt'), 'x')
  fs.writeFileSync(H('Library/Containers/app/secret.txt'), 'other app data')
  fs.writeFileSync(H('.hidden.txt'), 'h')
  // 文稿里一个指向桌面的链接:借它跳到没连上的位置 ⇒ 要被拦。
  fs.symlinkSync(H('Desktop/todo.txt'), H('Documents/sneaky.txt'))
  process.env.HOME = home
})

afterEach(() => {
  process.env.HOME = realHome
  for (const d of ['Desktop', 'Downloads']) fs.chmodSync(path.join(home, d), 0o755)
  fs.rmSync(dir, { recursive: true, force: true })
})

const OK: ExecResult = { stdout: '', stderr: '', code: 0 }

function setup(options: {
  exec?: (file: string, args: readonly string[], opts?: { input?: string }) => Promise<ExecResult>
  call?: (method: string, params: Record<string, unknown>) => unknown
  ripgrep?: string | null
  grant?: string[]
} = {}) {
  const store = createDeviceActionGrantsStore(path.join(dir, `grants-${++stores}.json`))
  for (const g of options.grant ?? []) store.setGroup(g, true)
  const exec = vi.fn(options.exec ?? (async () => OK))
  const helperCall = vi.fn(async (method: string, params?: unknown) => (options.call ? options.call(method, (params ?? {}) as Record<string, unknown>) : null))
  const trashItem = vi.fn(async (p: string) => {
    fs.renameSync(p, path.join(trashDir, `${path.basename(p)}-${trashItem.mock.calls.length}`))
  })
  const deps: FamilyDeps = {
    platform: 'darwin',
    nativeDir: null,
    now: () => new Date(),
    homedir: () => home,
    clipboardRead: () => '',
    clipboardWrite: () => undefined,
    notify: () => undefined,
    openExternal: async () => undefined,
    trashItem,
    jxa: vi.fn() as unknown as FamilyDeps['jxa'],
    exec: exec as unknown as FamilyDeps['exec'],
    macHelper: () => ({ available: () => ({ ok: true }), call: helperCall as unknown as MacHelperClient['call'], dispose: () => undefined }),
    cua: () => {
      throw new Error('files never use cua-driver')
    },
  }
  const family = createFilesFamily({ findRipgrep: async () => (options.ripgrep === undefined ? '/fake/bin/rg' : options.ripgrep) })
  const actions = createDeviceActionsProvider({ store, families: [family], deps })
  const run = (name: string, args: Record<string, unknown>) =>
    actions.provider.run(name, args, { callId: 'c1', signal: new AbortController().signal, note: () => undefined })
  const preflight = (name: string, args: Record<string, unknown>) => actions.provider.preflight!(name, args)
  return { store, actions, run, preflight, exec, helperCall, trashItem, family }
}

/** 成功结果的 data;不是成功就当场红(带上错误码与原话)。 */
function data(outcome: Outcome): Record<string, unknown> {
  if (!outcome.ok) throw new Error(`expected ok, got ${outcome.code}: ${outcome.message}`)
  return outcome.data as Record<string, unknown>
}

describe('文件:分组、连接与清单', () => {
  it('16 个动作都登记在 files 名下;一个根都没连时全部不可用', () => {
    const { actions, family } = setup()
    expect(family.actions.map((a) => a.name).sort()).toEqual([
      'fs.copy', 'fs.find', 'fs.grep', 'fs.list', 'fs.mkdir', 'fs.move', 'fs.ocr', 'fs.patch', 'fs.read', 'fs.stat',
      'fs.tags', 'fs.tags_registry', 'fs.trash', 'fs.volumes.list', 'fs.write', 'fs.xattr',
    ])
    expect(family.actions.every((a) => a.group === 'files' && a.title && a.titleEn && a.description.length > 100)).toBe(true)
    expect(family.groups.map((g) => g.id)).toEqual(['files.desktop', 'files.documents', 'files.downloads', 'files.other'])
    const cap = actions.capability()!
    expect(cap.actions.every((a) => !a.available && a.unavailable_reason === 'not_granted')).toBe(true)
    expect(actions.provider.permit('fs.read')).toMatchObject({ ok: false, code: 'not_granted' })
  })

  it('连接时真读一次那个文件夹:读得到才记成连上', async () => {
    const { actions, store } = setup()
    expect(await actions.connect('files.documents')).toEqual({ ok: true })
    expect(store.read().groups['files.documents']).toBe(true)
    expect(actions.provider.permit('fs.list')).toEqual({ ok: true })
    expect(await actions.connect('files.other')).toEqual({ ok: true })
  })

  // chmod 000 拦不住 root(d22 上以 root 跑照样读得到),Windows 也没有这套权限位 ⇒ 这两处造不出「读不了」。
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('读不了 = os_permission + 系统设置入口,❌ 记成连上', async () => {
    const { actions, store } = setup()
    fs.chmodSync(H('Downloads'), 0o000)
    const denied = await actions.connect('files.downloads')
    expect(denied).toMatchObject({ ok: false, code: 'os_permission', settingsUrl: expect.stringContaining('Privacy_FilesAndFolders') })
    expect(!denied.ok && denied.message).toContain('下载')
    expect(store.read().groups['files.downloads']).toBeUndefined()
  })
})

describe('文件:位置', () => {
  it('只认连上了的位置;符号链接按真实位置判;没连上的根按字面就拒(❌ 先碰盘)', async () => {
    const { run } = setup({ grant: ['files.documents'] })
    expect(await run('fs.read', { path: '~/Documents/note.txt' })).toMatchObject({ ok: true, data: { content: 'line1\nline2\nline3\n', lines: 3 } })
    expect(await run('fs.read', { path: '~/Desktop/todo.txt' })).toMatchObject({ ok: false, code: 'invalid_args' })
    expect(await run('fs.read', { path: '~/Documents/sneaky.txt' })).toMatchObject({ ok: false, code: 'invalid_args' })
    // 不存在的路径:按字面拒的说「没连上」,碰了盘才会说「not found」。
    const untouched = await run('fs.read', { path: '~/Desktop/nothing-here.txt' })
    expect(untouched).toMatchObject({ ok: false, code: 'invalid_args', message: expect.stringContaining('not inside a location connected') })
    expect(await run('fs.read', { path: 'Documents/note.txt' })).toMatchObject({ ok: false, message: expect.stringContaining('absolute') })
  })

  it('「其他位置」不含桌面;换个大小写也溜不进去', async () => {
    const { run } = setup({ grant: ['files.other'] })
    expect(await run('fs.read', { path: '~/Elsewhere/x.txt' })).toMatchObject({ ok: true, data: { content: 'x' } })
    expect(await run('fs.read', { path: '~/Desktop/todo.txt' })).toMatchObject({ ok: false, code: 'invalid_args' })
    expect(await run('fs.read', { path: '~/desktop/todo.txt' })).toMatchObject({ ok: false, code: 'invalid_args' })
  })
})

describe('fs.list', () => {
  it('文件夹在前;点开头的不列;没连上的根标 notConnected', async () => {
    const { run } = setup({ grant: ['files.other', 'files.documents'] })
    const r = data(await run('fs.list', { path: '~' }))
    const entries = r.entries as Array<Record<string, unknown>>
    expect(entries.map((e) => e.name)).toEqual(['Desktop', 'Documents', 'Downloads', 'Elsewhere', 'Library'])
    expect(entries.find((e) => e.name === 'Desktop')).toMatchObject({ type: 'directory', notConnected: true })
    expect(entries.find((e) => e.name === 'Documents')?.notConnected).toBeUndefined()
    expect(entries[0].modified).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/)
  })

  it('递归:不进没连上的根、不进 ~/Library、不跟符号链接;pattern 与 limit', async () => {
    const { run } = setup({ grant: ['files.other', 'files.documents'] })
    const r = data(await run('fs.list', { path: '~', recursive: true, pattern: '*.txt' }))
    const paths = (r.entries as Array<{ path: string; type: string }>).map((e) => e.path).sort()
    expect(paths).toEqual([real(H('Documents/note.txt')), real(H('Documents/sneaky.txt')), real(H('Documents/sub/deep.txt')), real(H('Elsewhere/x.txt'))])
    expect((r.entries as Array<{ path: string; type: string }>).find((e) => e.path.endsWith('sneaky.txt'))?.type).toBe('symlink')
    // 没连上的桌面、下载,和 ~/Library。
    expect(r.skippedFolders).toBe(3)
    // 从 ~/Library 里面开始列,就进得去。
    const lib = data(await run('fs.list', { path: '~/Library', recursive: true }))
    expect((lib.entries as Array<{ name: string }>).map((e) => e.name)).toContain('secret.txt')
    const cut = data(await run('fs.list', { path: '~/Documents', limit: 1 }))
    expect(cut).toMatchObject({ total: 3, truncated: true })
    expect((cut.entries as unknown[]).length).toBe(1)
  })
})

describe('fs.read', () => {
  it('按行读、截断、二进制要 base64、图片给 agent 看', async () => {
    const { run } = setup({ grant: ['files.documents'] })
    expect(await run('fs.read', { path: '~/Documents/note.txt', lineStart: 2, lineEnd: 3 })).toMatchObject({ ok: true, data: { content: 'line2\nline3\n', lineStart: 2, lineEnd: 3 } })
    expect(await run('fs.read', { path: '~/Documents/note.txt', maxBytes: 3 })).toMatchObject({ ok: true, data: { content: 'lin', truncated: true, lines: null } })
    fs.writeFileSync(H('Documents/blob.bin'), Buffer.from([1, 2, 0, 3]))
    expect(await run('fs.read', { path: '~/Documents/blob.bin' })).toMatchObject({ ok: false, code: 'invalid_args', message: expect.stringContaining('base64') })
    expect(await run('fs.read', { path: '~/Documents/blob.bin', encoding: 'base64' })).toMatchObject({ ok: true, data: { content: 'AQIAAw==', truncated: false } })
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 7)])
    fs.writeFileSync(H('Documents/shot.png'), png)
    const pic = await run('fs.read', { path: '~/Documents/shot.png' })
    expect(pic).toMatchObject({ ok: true, data: { mimeType: 'image/png', pictures: [{ label: 'shot.png', mimeType: 'image/png', data: png.toString('base64') }] } })
    expect(data(pic).content).toBeUndefined()
  })

  it('参数不对在 preflight 就回', async () => {
    const { preflight } = setup({ grant: ['files.documents'] })
    expect(await preflight('fs.read', { path: '~/Documents/note.txt', lineStart: 5, lineEnd: 2 })).toMatchObject({ code: 'invalid_args' })
    expect(await preflight('fs.read', { path: '~/Documents/note.txt', encoding: 'utf-16' })).toMatchObject({ code: 'invalid_args' })
    expect(await preflight('fs.list', { path: '~', pattern: '{a,b' })).toMatchObject({ code: 'invalid_args' })
  })
})

describe('fs.write / fs.patch / fs.mkdir', () => {
  it('新建直接写(缺的文件夹顺手建);覆盖已有的先问人,同意后原子替换且保留权限', async () => {
    const { run } = setup({ grant: ['files.documents'], exec: execFileAsync })
    expect(await run('fs.write', { path: '~/Documents/new/a.txt', content: '你好' })).toMatchObject({ ok: true, data: { created: true, bytesWritten: 6 } })
    expect(fs.readFileSync(H('Documents/new/a.txt'), 'utf8')).toBe('你好')
    fs.chmodSync(H('Documents/note.txt'), 0o640)
    const ask = await run('fs.write', { path: '~/Documents/note.txt', content: 'NEW' })
    expect(ask).toMatchObject({ ok: false, code: 'needs_confirmation', confirm: { question: expect.stringContaining(real(H('Documents/note.txt'))) } })
    expect(fs.readFileSync(H('Documents/note.txt'), 'utf8')).toBe('line1\nline2\nline3\n')
    const replaced = await run('fs.write', { path: '~/Documents/note.txt', content: 'NEW', confirmed: true })
    expect(replaced).toMatchObject({ ok: true, data: { created: false } })
    expect(data(replaced).metadataKept).toBeUndefined()
    expect(fs.readFileSync(H('Documents/note.txt'), 'utf8')).toBe('NEW')
    expect(fs.statSync(H('Documents/note.txt')).mode & 0o777).toBe(0o640)
    expect(fs.readdirSync(H('Documents')).some((n) => n.includes('.gugu-'))).toBe(false)
    expect(await run('fs.write', { path: '~/Documents/note.txt', content: 'x', mode: 'create' })).toMatchObject({ ok: false, code: 'invalid_args' })
    expect(await run('fs.write', { path: '~/Documents/note.txt', content: '+1', mode: 'append' })).toMatchObject({ ok: true })
    expect(fs.readFileSync(H('Documents/note.txt'), 'utf8')).toBe('NEW+1')
    expect(await run('fs.write', { path: '~/Documents/none/b.txt', content: 'x', createDirectories: false })).toMatchObject({ ok: false, code: 'invalid_args' })
  })

  it.runIf(process.platform === 'darwin')('覆盖保留扩展属性(Finder 标签、下载来源)', async () => {
    const { run } = setup({ grant: ['files.documents'], exec: execFileAsync })
    execFileSync('/usr/bin/xattr', ['-w', 'com.gugu.test', 'kept', H('Documents/note.txt')])
    await run('fs.write', { path: '~/Documents/note.txt', content: 'NEW', confirmed: true })
    expect(execFileSync('/usr/bin/xattr', ['-p', 'com.gugu.test', H('Documents/note.txt')], { encoding: 'utf8' }).trim()).toBe('kept')
  })

  it('fs.patch:每处必须恰好匹配一次,任何一处不对就一个字都不写;dryRun 只给 diff', async () => {
    const { run } = setup({ grant: ['files.documents'], exec: execFileAsync })
    const before = fs.readFileSync(H('Documents/note.txt'), 'utf8')
    const ambiguous = await run('fs.patch', { path: '~/Documents/note.txt', edits: [{ search: 'line2', replace: 'B' }, { search: 'line', replace: 'L' }] })
    expect(ambiguous).toMatchObject({ ok: false, code: 'invalid_args', message: expect.stringContaining('edits[1] ("line") matches 2 times') })
    expect(fs.readFileSync(H('Documents/note.txt'), 'utf8')).toBe(before)
    const dry = await run('fs.patch', { path: '~/Documents/note.txt', edits: [{ search: 'line2', replace: 'second' }], dryRun: true })
    expect(data(dry)).toMatchObject({ written: false, diff: '@@ line 2 @@\n-line2\n+second' })
    expect(fs.readFileSync(H('Documents/note.txt'), 'utf8')).toBe(before)
    expect(await run('fs.patch', { path: '~/Documents/note.txt', edits: [{ search: 'line', replace: 'L', replaceAll: true }] })).toMatchObject({ ok: true, data: { written: true } })
    expect(fs.readFileSync(H('Documents/note.txt'), 'utf8')).toBe('L1\nL2\nL3\n')
  })

  it('fs.mkdir:已存在也算成功;路径落在没连上的地方就拒', async () => {
    const { run } = setup({ grant: ['files.documents'] })
    expect(await run('fs.mkdir', { path: '~/Documents/a/b' })).toMatchObject({ ok: true, data: { alreadyExisted: false } })
    expect(fs.statSync(H('Documents/a/b')).isDirectory()).toBe(true)
    expect(await run('fs.mkdir', { path: '~/Documents/a/b' })).toMatchObject({ ok: true, data: { alreadyExisted: true } })
    expect(await run('fs.mkdir', { path: '~/Elsewhere/new' })).toMatchObject({ ok: false, code: 'invalid_args' })
  })
})

describe('fs.move / fs.copy / fs.trash', () => {
  it('fs.move:目标已有 → 没说 overwrite 就拒,说了也先问人,同意后旧的进废纸篓再移', async () => {
    const { run, trashItem } = setup({ grant: ['files.documents'] })
    fs.writeFileSync(H('Documents/dst.txt'), 'old')
    const args = { source: '~/Documents/note.txt', destination: '~/Documents/dst.txt' }
    expect(await run('fs.move', args)).toMatchObject({ ok: false, code: 'invalid_args', message: expect.stringContaining('overwrite: true') })
    expect(await run('fs.move', { ...args, overwrite: true })).toMatchObject({ ok: false, code: 'needs_confirmation', confirm: { question: expect.stringContaining('废纸篓') } })
    expect(trashItem).not.toHaveBeenCalled()
    expect(await run('fs.move', { ...args, overwrite: true, confirmed: true })).toMatchObject({ ok: true, data: { replaced: true } })
    expect(trashItem).toHaveBeenCalledWith(real(H('Documents/dst.txt')))
    expect(fs.readFileSync(H('Documents/dst.txt'), 'utf8')).toBe('line1\nline2\nline3\n')
    expect(fs.existsSync(H('Documents/note.txt'))).toBe(false)
  })

  it('fs.move:符号链接移的是链接本身(哪怕它指向没连上的地方);根本身不给移', async () => {
    const { run } = setup({ grant: ['files.documents', 'files.other'] })
    expect(await run('fs.move', { source: '~/Documents/sneaky.txt', destination: '~/Documents/link.txt' })).toMatchObject({ ok: true })
    expect(fs.lstatSync(H('Documents/link.txt')).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(H('Desktop/todo.txt'), 'utf8')).toBe('桌面上的待办')
    expect(await run('fs.move', { source: '~/Documents', destination: '~/Elsewhere/Documents' })).toMatchObject({ ok: false, message: expect.stringContaining('connected location itself') })
    expect(await run('fs.move', { source: '~/Documents/note.txt', destination: '~/Desktop/note.txt' })).toMatchObject({ ok: false, code: 'invalid_args' })
  })

  it('fs.copy:先 APFS 克隆(cp -c),克隆不了再普通复制;文件夹带 -R', async () => {
    const exec = vi.fn(async (_file: string, args: readonly string[]) => (args[0] === '-c' ? { ...OK, code: 1, stderr: 'clonefile failed' } : OK))
    const { run } = setup({ grant: ['files.documents', 'files.other'], exec })
    expect(await run('fs.copy', { source: '~/Documents/note.txt', destination: '~/Elsewhere/note.txt' })).toMatchObject({ ok: true, data: { cloned: false } })
    expect(exec.mock.calls.map(([file, args]) => [file, ...args])).toEqual([
      ['/bin/cp', '-c', '-p', real(H('Documents/note.txt')), real(H('Elsewhere/note.txt'))],
      ['/bin/cp', '-p', real(H('Documents/note.txt')), real(H('Elsewhere/note.txt'))],
    ])
    exec.mockClear()
    exec.mockImplementation(async () => OK)
    expect(await run('fs.copy', { source: '~/Documents/sub', destination: '~/Elsewhere/sub' })).toMatchObject({ ok: true, data: { cloned: true } })
    expect(exec.mock.calls[0]).toEqual(['/bin/cp', ['-c', '-p', '-R', real(H('Documents/sub')), real(H('Elsewhere/sub'))], expect.anything()])
    expect(await run('fs.copy', { source: '~/Documents/sub', destination: '~/Elsewhere/sub2', recursive: false })).toMatchObject({ ok: false, code: 'invalid_args' })
    expect(await run('fs.copy', { source: '~', destination: '~/Elsewhere/all' })).toMatchObject({ ok: false, code: 'invalid_args' })
  })

  it('fs.trash:一律先问人(问句点名要扔的每一项);有一项不在连上的位置就一项都不扔', async () => {
    const { run, preflight, trashItem } = setup({ grant: ['files.documents'] })
    const args = { path: ['~/Documents/note.txt', '~/Documents/sub'] }
    const ask = await preflight('fs.trash', args)
    expect(ask).toMatchObject({ code: 'needs_confirmation' })
    const question = (ask as { confirm: { question: string } }).confirm.question
    expect(question).toContain('~/Documents/note.txt')
    expect(question).toContain('~/Documents/sub')
    expect(await preflight('fs.trash', { ...args, confirmed: true })).toBeNull()
    expect(await run('fs.trash', { path: ['~/Documents/note.txt', '~/Desktop/todo.txt'], confirmed: true })).toMatchObject({ ok: false, code: 'invalid_args' })
    expect(trashItem).not.toHaveBeenCalled()
    expect(await run('fs.trash', { ...args, confirmed: true })).toMatchObject({ ok: true, data: { trashed: [real(H('Documents/note.txt')), real(H('Documents/sub'))] } })
    expect(fs.existsSync(H('Documents/note.txt'))).toBe(false)
    expect(await run('fs.trash', { path: '~/Documents', confirmed: true })).toMatchObject({ ok: false, message: expect.stringContaining('connected location itself') })
  })
})

describe('Spotlight / ripgrep / 命令行', () => {
  it('fs.find:按连上的位置限定范围;结果再筛掉没连上的根与噪音;kind 按内容类型判', async () => {
    const lines = [H('Desktop/a.png'), H('Documents/b.png'), H('Elsewhere/node_modules/c.png'), H('Elsewhere/d.png')].map(real)
    const exec = vi.fn(async () => ({ ...OK, stdout: `${lines.join('\n')}\n` }))
    const { run } = setup({ grant: ['files.documents', 'files.other'], exec })
    const r = data(await run('fs.find', { name: 'foo', kind: 'image' }))
    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec.mock.calls[0]).toEqual(['/usr/bin/mdfind', ['-onlyin', fs.realpathSync(home), 'kMDItemFSName == "*foo*"cd && (kMDItemContentTypeTree == "public.image")'], expect.anything()])
    expect((r.results as Array<{ path: string }>).map((x) => x.path)).toEqual([real(H('Documents/b.png')), real(H('Elsewhere/d.png'))])
    expect(r).toMatchObject({ total: 2, filteredOut: 1 })
    // 没连「其他位置」:只在连上的根里各搜一次。
    const only = setup({ grant: ['files.documents', 'files.downloads'], exec })
    exec.mockClear()
    await only.run('fs.find', { query: '身份证' })
    expect(exec.mock.calls.map((c) => (c as unknown as [string, string[]])[1])).toEqual([
      ['-onlyin', real(H('Documents')), '身份证'],
      ['-onlyin', real(H('Downloads')), '身份证'],
    ])
  })

  it('fs.grep:没装 ripgrep → unsupported;从个人文件夹搜时不把没连上的根、~/Library、点开头的交给 rg', async () => {
    expect(await setup({ grant: ['files.other'], ripgrep: null }).run('fs.grep', { pattern: 'x', path: '~' })).toMatchObject({ ok: false, code: 'unsupported', message: expect.stringContaining('ripgrep') })
    const out = [
      { type: 'begin', data: { path: { text: real(H('Elsewhere/x.txt')) } } },
      { type: 'context', data: { path: { text: real(H('Elsewhere/x.txt')) }, lines: { text: 'before\n' }, line_number: 1 } },
      { type: 'match', data: { path: { text: real(H('Elsewhere/x.txt')) }, lines: { text: 'hit x\n' }, line_number: 2 } },
    ].map((m) => JSON.stringify(m)).join('\n')
    const exec = vi.fn(async () => ({ ...OK, stdout: out }))
    const { run } = setup({ grant: ['files.other', 'files.documents'], exec })
    const r = await run('fs.grep', { pattern: 'x', path: '~', contextLines: 1, caseSensitive: false })
    expect(r).toMatchObject({ ok: true, data: { total: 1, matches: [{ path: real(H('Elsewhere/x.txt')), lineNumber: 2, content: 'hit x', contextBefore: ['before'] }] } })
    const [file, args] = exec.mock.calls[0] as unknown as [string, string[]]
    expect(file).toBe('/fake/bin/rg')
    expect(args).toEqual(expect.arrayContaining(['--json', '-i', '-C', '1', '-m', '100']))
    expect(args.slice(args.indexOf('--') + 1)).toEqual(['x', ...['Documents', 'Elsewhere'].map((d) => real(H(d)))])
  })

  it('fs.stat 带 Spotlight:读 mdls 的 plist,日期换成本地时间', async () => {
    const plist = `<?xml version="1.0"?><plist version="1.0"><dict>
<key>kMDItemContentType</key><string>public.plain-text</string>
<key>kMDItemKind</key><string>纯文本文稿</string>
<key>kMDItemLastUsedDate</key><date>2026-10-15T06:00:00Z</date>
<key>kMDItemUserTags</key><array><string>工作</string><string>A&amp;B</string></array>
<key>kMDItemWhereFroms</key><array/>
</dict></plist>`
    const exec = vi.fn(async () => ({ ...OK, stdout: plist }))
    const { run } = setup({ grant: ['files.documents', 'files.desktop'], exec })
    const s = data(await run('fs.stat', { path: '~/Documents/note.txt', spotlight: true }))
    expect(exec).toHaveBeenCalledWith('/usr/bin/mdls', ['-plist', '-', real(H('Documents/note.txt'))], expect.anything())
    expect(s).toMatchObject({ type: 'file', size: 18, mode: expect.stringMatching(/^0\d{3}$/), spotlight: { contentType: 'public.plain-text', kind: '纯文本文稿', tags: ['工作', 'A&B'], whereFrom: [] } })
    const lastOpened = (s.spotlight as { lastOpened: string }).lastOpened
    expect(lastOpened).toMatch(/[+-]\d\d:\d\d$/)
    expect(Date.parse(lastOpened)).toBe(Date.parse('2026-10-15T06:00:00Z'))
    expect(await run('fs.stat', { path: '~/Documents/sneaky.txt' })).toMatchObject({ ok: true, data: { path: real(H('Desktop/todo.txt')), linkTarget: H('Desktop/todo.txt') } })
  })

  it('fs.xattr:安全属性(quarantine)改 / 删先问人;读值按十六进制取回再判是不是文字', async () => {
    const exec = vi.fn(async (_f: string, args: readonly string[]) => (args[0] === '-px' ? { ...OK, stdout: '68 65 6C 6C 6F\n' } : { ...OK, stdout: 'com.apple.quarantine\ncom.x\n' }))
    const { run } = setup({ grant: ['files.documents'], exec })
    const p = real(H('Documents/note.txt'))
    expect(await run('fs.xattr', { path: '~/Documents/note.txt', action: 'delete', name: 'com.apple.quarantine' })).toMatchObject({ ok: false, code: 'needs_confirmation' })
    expect(exec).not.toHaveBeenCalled()
    expect(await run('fs.xattr', { path: '~/Documents/note.txt', action: 'delete', name: 'com.apple.quarantine', confirmed: true })).toMatchObject({ ok: true })
    expect(exec).toHaveBeenLastCalledWith('/usr/bin/xattr', ['-d', 'com.apple.quarantine', p], expect.anything())
    expect(await run('fs.xattr', { path: '~/Documents/note.txt', action: 'get', name: 'com.x' })).toMatchObject({ ok: true, data: { value: 'hello', size: 5 } })
    expect(await run('fs.xattr', { path: '~/Documents/note.txt', action: 'set', name: 'com.x', value: 'v' })).toMatchObject({ ok: true })
    expect(exec).toHaveBeenLastCalledWith('/usr/bin/xattr', ['-w', 'com.x', 'v', p], expect.anything())
    expect(await run('fs.xattr', { path: '~/Documents/note.txt', action: 'list' })).toMatchObject({ ok: true, data: { attributes: ['com.apple.quarantine', 'com.x'] } })
  })
})

describe('原生助手(文字识别 / 标签 / 磁盘)', () => {
  it('fs.ocr:把真实路径与语言交给 vision.ocr;助手的错照原码回', async () => {
    const call = vi.fn((method: string) => {
      if (method !== 'vision.ocr') throw new Error(method)
      return { text: '你好\nhello', confidence: 0.9, lineCount: 2, lines: [] }
    })
    const { run, helperCall } = setup({ grant: ['files.documents'], call })
    expect(await run('fs.ocr', { path: '~/Documents/note.txt', languages: ['en'] })).toMatchObject({ ok: true, data: { text: '你好\nhello', lineCount: 2 } })
    expect(helperCall).toHaveBeenCalledWith('vision.ocr', { path: real(H('Documents/note.txt')), languages: ['en'] }, expect.anything())
    call.mockImplementation(() => {
      throw new NativeCallError('invalid_args', 'not an image macOS can read')
    })
    expect(await run('fs.ocr', { path: '~/Documents/note.txt' })).toMatchObject({ ok: false, code: 'invalid_args', message: 'not an image macOS can read' })
    call.mockImplementation(() => {
      throw new NativeCallError('unsupported', '开发环境还没编原生组件')
    })
    expect(await run('fs.ocr', { path: '~/Documents/note.txt' })).toMatchObject({ ok: false, code: 'unsupported' })
  })

  it('fs.tags add:读现有的、补上没有的、整套写回,再让 Spotlight 重读', async () => {
    const p = real(H('Documents/note.txt'))
    const call = vi.fn((method: string, params: Record<string, unknown>) =>
      method === 'files.tags.get' ? { results: [{ path: p, tags: [{ name: '工作', color: 'red' }] }] } : { path: p, tags: params.tags })
    const { run, helperCall, exec } = setup({ grant: ['files.documents'], call })
    const r = await run('fs.tags', { path: '~/Documents/note.txt', action: 'add', tags: ['工作', { name: '重要', color: 'orange' }] })
    expect(r).toMatchObject({ ok: true, data: { tags: [{ name: '工作', color: 'red' }, { name: '重要', color: 'orange' }] } })
    expect(helperCall).toHaveBeenNthCalledWith(1, 'files.tags.get', { paths: [p] }, expect.anything())
    expect(helperCall).toHaveBeenNthCalledWith(2, 'files.tags.set', { path: p, tags: [{ name: '工作', color: 'red' }, { name: '重要', color: 'orange' }] }, expect.anything())
    expect(exec).toHaveBeenCalledWith('/usr/bin/mdimport', ['-i', p], expect.anything())
    expect(await setup({ grant: ['files.documents'] }).preflight('fs.tags', { path: '~/Documents/note.txt', action: 'add', tags: [{ name: 'x', color: 'pink' }] })).toMatchObject({ code: 'invalid_args' })
  })

  it('fs.tags_registry rename:只动连上的位置里真带这个标签的文件,先报数量问人', async () => {
    const inDocs = real(H('Documents/note.txt'))
    const exec = vi.fn(async (file: string) => (file === '/usr/bin/mdfind' ? { ...OK, stdout: `${real(H('Desktop/todo.txt'))}\n${inDocs}\n` } : OK))
    const call = vi.fn((method: string, params: Record<string, unknown>) =>
      method === 'files.tags.get'
        ? { results: (params.paths as string[]).map((path) => ({ path, tags: [{ name: '旧', color: 'blue' }, { name: '留着', color: 'none' }] })) }
        : { path: params.path, tags: params.tags })
    const { run, helperCall } = setup({ grant: ['files.documents'], exec, call })
    const ask = await run('fs.tags_registry', { action: 'rename', oldName: '旧', newName: '新' })
    expect(ask).toMatchObject({ ok: false, code: 'needs_confirmation', confirm: { question: expect.stringContaining('1 个文件'), details: { files: [inDocs], total: 1 } } })
    expect(helperCall.mock.calls.some(([m]) => m === 'files.tags.set')).toBe(false)
    expect(await run('fs.tags_registry', { action: 'rename', oldName: '旧', newName: '新', confirmed: true })).toMatchObject({ ok: true, data: { filesModified: 1 } })
    expect(helperCall).toHaveBeenCalledWith('files.tags.set', { path: inDocs, tags: [{ name: '新', color: 'blue' }, { name: '留着', color: 'none' }] }, expect.anything())
    expect(exec).toHaveBeenCalledWith('/usr/bin/mdfind', ['-onlyin', real(H('Documents')), 'kMDItemUserTags == "旧"cd'], expect.anything())
  })

  it('fs.volumes.list:原生助手列卷,mountPoint 只取那一个', async () => {
    const call = vi.fn(() => ({ volumes: [{ mountPoint: '/', name: 'Macintosh HD' }, { mountPoint: '/Volumes/U', name: 'U' }] }))
    const { run, helperCall } = setup({ grant: ['files.downloads'], call })
    expect(await run('fs.volumes.list', { mountPoint: '/Volumes/U' })).toMatchObject({ ok: true, data: { total: 1, volumes: [{ name: 'U' }] } })
    expect(helperCall).toHaveBeenCalledWith('files.volumes', {}, expect.anything())
    expect(await run('fs.volumes.list', { mountPoint: '/nope' })).toMatchObject({ ok: false, code: 'invalid_args' })
  })
})
