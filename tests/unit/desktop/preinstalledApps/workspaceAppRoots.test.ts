// @vitest-environment jsdom
// The same Files App switches between chat and computer files without an intermediate roots page.
// 工作目录一次只读一层(`files.list({ workspace, folder })`,文件面板同一条链):进一个文件夹才读那一层,读过的不再读;
// 那几层的变化经 onChanged 推来。父提交上没有工作目录这个根:这里每一格都红。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { until } from '../../../support/awaitCondition'

const at = '2026-10-31T12:00:00Z'
type Entry = { id: string; name: string; displayName: string; type: string; contentType: string; parentId: string | null; path: string; workspace?: string; chat?: string; systemRole: null; version: number | null; createdBy: null; createdAt: string; updatedAt: string; sourceMessageIds: string[]; canDelete: boolean; size: number | null }
const WS = 'session:task-1'
const wc = (path: string, type: 'folder' | 'text'): Entry => {
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null
  const name = path.split('/').pop()!
  return { id: path, name, displayName: name, type, contentType: type === 'folder' ? 'inode/directory' : 'text/markdown', parentId: parent, path, workspace: WS, systemRole: null, version: null, createdBy: null, createdAt: at, updatedAt: at, sourceMessageIds: [], canDelete: true, size: type === 'folder' ? null : 3 }
}
const TREE: Record<string, Entry[]> = {
  '': [wc('src', 'folder'), wc('README.md', 'text')],
  src: [wc('src/main.md', 'text'), wc('src/lib', 'folder')],
}
const chatNote: Entry = { ...wc('x', 'text'), id: 'item-1', name: 'plan.md', displayName: 'plan.md', path: 'plan.md', parentId: null, workspace: undefined, chat: 'dm-1' }
delete chatNote.workspace
let touch = false

const context = {
  chat: { id: 'dm-1', name: 'Kip', kind: 'dm', groupId: null, members: [] },
  workspace: { id: WS, sessionId: 'task-1', agentId: 'user:kip' },
  locale: 'zh-CN',
  capabilities: ['files:read', 'files:write'],
}
let hear: ((change: unknown) => void) | null = null
let contextChanged: ((ctx: unknown) => void) | null = null
const gugu = {
  linkTo: vi.fn(async () => 'gugu-file://x'),
  setTabTitle: vi.fn(async () => {}),
  getContext: vi.fn(async () => context),
  onContextChanged: vi.fn((fn: (ctx: unknown) => void) => { contextChanged = fn; return () => {} }),
  onLink: vi.fn(() => () => {}),
  showContextMenu: vi.fn(async () => null),
  files: {
    viewPreferences: vi.fn(async () => ({ showAppData: false })),
    list: vi.fn(async (place: { chat?: string; workspace?: string; folder?: string }) =>
      place.workspace ? (TREE[place.folder ?? ''] ?? []).map((e) => ({ ...e })) : [{ ...chatNote }]),
    onChanged: vi.fn((place: { workspace?: string }, fn: (change: unknown) => void) => {
      if (place.workspace) hear = fn
      return () => {}
    }),
    open: vi.fn(),
    openWith: vi.fn(async () => {}),
    canDelete: vi.fn(async () => [false]),
  },
}

const $ = (id: string) => document.getElementById(id) as HTMLElement
const names = () => [...$('file-list').querySelectorAll('.file .file-name')].map((n) => n.textContent)
const press = (name: string) => ([...$('file-list').querySelectorAll('.file')].find((li) => li.querySelector('.file-name')?.textContent === name)!.querySelector('.file-open') as HTMLButtonElement).click()
const crumbs = () => ($('crumbs').hidden ? null : [...$('crumbs').querySelectorAll('.crumb')].map((c) => c.textContent))
const crumb = (i: number) => ($('crumbs').querySelectorAll('.crumb')[i] as HTMLButtonElement).click()
const listed = () => gugu.files.list.mock.calls.map(([place]) => place)
const switchRoot = (root: string) => (document.querySelector(`#place-switch [data-root="${root}"]`) as HTMLButtonElement).click()
const workspaceListed = () => listed().filter((place) => place.workspace)

beforeAll(async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ get matches() { return query === '(hover: none) and (pointer: coarse)' && touch }, addEventListener() {} }))
  const html = readFileSync(resolve(process.cwd(), 'apps/desktop/preinstalled-apps/workspace/index.html'), 'utf8')
  const page = new DOMParser().parseFromString(html, 'text/html')
  document.body.innerHTML = page.body.innerHTML
  Object.assign(globalThis, { gugu, CSS: { escape: (s: string) => s } })
  Object.assign(window, { gugu })
  // @ts-expect-error — 内置 App 是不经构建的纯 ES module,没有类型;运行时 import 可用。
  await import('../../../../apps/desktop/preinstalled-apps/workspace/app.js')
  await until('the roots drawn', () => names().length > 0)
})
afterAll(() => vi.unstubAllGlobals())

describe('a session\'s tab: one folder, two roots', () => {
  test('the two buttons stay above the chat files, with no roots page to enter', () => {
    expect(names()).toEqual(['plan.md'])
    expect(listed()).toEqual([{ chat: 'dm-1' }])
    expect([...$('place-switch').querySelectorAll('button')].map((button) => button.textContent)).toEqual(['聊天文件', '电脑文件'])
    expect($('place-switch').querySelector('[aria-pressed="true"]')?.getAttribute('data-root')).toBe('chat')
    expect(crumbs()).toBeNull()
  })

  test('the working copy lists its top, then a folder only when it is entered — once', async () => {
    switchRoot('workspace')
    await until('the top listed', () => names().includes('README.md'))
    expect(names()).toEqual(['src', 'README.md'])
    expect(crumbs()).toBeNull()
    press('src')
    await until('src listed', () => names().includes('main.md'))
    expect(names()).toEqual(['lib', 'main.md'])
    expect(crumbs()).toEqual(['电脑文件', 'src'])
    expect(workspaceListed()).toEqual([{ workspace: WS, folder: '' }, { workspace: WS, folder: 'src' }])
    crumb(0)
    expect(names()).toEqual(['src', 'README.md'])
    press('src')
    expect(workspaceListed()).toHaveLength(2)
  })

  test('a change in a folder listed reads that folder again; one in a folder never listed reads nothing', async () => {
    TREE.src = [...TREE.src!, wc('src/new.md', 'text')]
    hear!({ kind: 'changes', changes: [{ kind: 'create', path: 'src/new.md' }] })
    await until('src read again', () => names().includes('new.md'))
    const calls = listed().length
    hear!({ kind: 'changes', changes: [{ kind: 'update', path: 'src/lib/deep.md' }] })
    expect(listed()).toHaveLength(calls)
    TREE.src = TREE.src!.filter((e) => e.id !== 'src/new.md')
    hear!({ kind: 'changes', changes: [{ kind: 'delete', path: 'src/new.md' }] })
    await until('src read again', () => !names().includes('new.md'))
  })

  test('the conversation\'s folder is the other root: listed by its chat, whole, as in a group', async () => {
    switchRoot('chat')
    await until('the chat listed', () => names().includes('plan.md'))
    expect(listed().at(-1)).toEqual({ chat: 'dm-1' })
    expect(crumbs()).toBeNull()
  })

  test('its conversation arriving later keeps the person where they are in the working copy (no jump to the top)', async () => {
    switchRoot('workspace')
    await until('the top drawn', () => names().includes('src'))
    press('src')
    await until('src drawn', () => names().includes('main.md'))
    const calls = listed().length
    // The same working copy; the conversation changes (it was not there yet, then is): nothing to read again.
    contextChanged!({ ...context, chat: { ...context.chat, id: 'dm-2' } })
    await until('the context applied', () => gugu.files.onChanged.mock.calls.some(([place]) => (place as { chat?: string }).chat === 'dm-2'))
    expect([crumbs(), names().includes('main.md'), listed().length]).toEqual([['电脑文件', 'src'], true, calls])
  })

  test('a working copy\'s file has no link: none is asked for, and its menu goes by the path', async () => {
    expect(gugu.linkTo.mock.calls.filter((args: unknown[]) => (args[0] as { file?: Entry } | undefined)?.file?.workspace)).toEqual([])
    const row = [...document.querySelectorAll('li')].find((li) => li.textContent?.includes('main.md'))!
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    const items = () => [...document.getElementById('menu')!.querySelectorAll('button')].map((item) => item.textContent)
    await until('the menu open', () => items().length > 0)
    expect(items()).not.toContain('复制链接')
    expect(items()).toContain('复制相对路径')
  })

  test('computer-file selection offers no chat retention or source-location actions', () => {
    (document.querySelector('[data-id="src/main.md"] .file-pick') as HTMLButtonElement).click()
    const labels = [...$('pick-bar').querySelectorAll('button')].map((button) => button.textContent)
    expect(labels).toContain('下载')
    expect(labels).not.toContain('设为临时')
    expect(labels).not.toContain('设为持续保存')
    expect(labels).not.toContain('在聊天中定位')
  })

  test('each chat remembers its own root, with unavailable roots falling back to chat files', async () => {
    switchRoot('chat')
    await until('chat shown', () => names().includes('plan.md'))
    switchRoot('workspace')
    await until('computer shown', () => names().includes('README.md'))
    const other = { ...context, chat: { ...context.chat, id: 'other' }, workspace: { ...context.workspace, id: 'session:other' } }
    contextChanged!(other)
    await until('other chat defaults to chat files', () => names().includes('plan.md'))
    contextChanged!({ ...context, chat: { ...context.chat, id: 'dm-2' } })
    await until('previous choice restored', () => names().includes('README.md'))
    contextChanged!({ ...context, workspace: undefined })
    await until('missing computer falls back to chat files', () => names().includes('plan.md'))
    const button = document.querySelector('#place-switch [data-root="workspace"]') as HTMLButtonElement
    expect(button.getAttribute('aria-disabled')).toBe('true')
    button.click()
    expect($('list-banner').textContent).toBe('这个群没有绑电脑。项目群才有。')
    expect(names()).toEqual(['plan.md'])
  })

  test('phone computer files stay read-only, with no desktop navigation or draggable rows', async () => {
    touch = true
    contextChanged!({ ...context, chat: { ...context.chat, id: 'phone' } })
    await until('phone chat files shown', () => names().includes('plan.md'))
    switchRoot('workspace')
    await until('phone computer files shown', () => names().includes('README.md'))
    expect(($('upload') as HTMLButtonElement).hidden).toBe(true)
    expect(($('new-doc') as HTMLButtonElement).hidden).toBe(true)
    const row = document.querySelector('[data-id="README.md"]') as HTMLElement
    expect(row.draggable).toBe(false)
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    const labels = [...$('menu').querySelectorAll('button')].map((button) => button.textContent)
    for (const desktop of ['在新页签打开', '在旁边打开', '在文件管理器中显示', '改名', '删除']) expect(labels).not.toContain(desktop)
    switchRoot('chat')
    await until('phone chat files shown again', () => names().includes('plan.md'))
    expect(($('upload') as HTMLButtonElement).hidden).toBe(false)
    expect((document.querySelector('[data-id="item-1"]') as HTMLElement).draggable).toBe(false)
  })
})
