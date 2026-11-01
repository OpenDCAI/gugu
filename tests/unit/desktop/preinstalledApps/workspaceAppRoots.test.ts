// @vitest-environment jsdom
// 会话架构 P4(场景 19):任务页里的文件夹 App 有两个根 —— 这个对话(主人和 agent 的私聊)的文件夹,和这条会话的工作目录。
// 工作目录一次只读一层(`files.list({ workspace, folder })`,文件面板同一条链):进一个文件夹才读那一层,读过的不再读;
// 那几层的变化经 onChanged 推来。父提交上没有工作目录这个根:这里每一格都红。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, test, vi } from 'vitest'
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
  },
}

const $ = (id: string) => document.getElementById(id) as HTMLElement
const names = () => [...$('file-list').querySelectorAll('.file .file-name')].map((n) => n.textContent)
const press = (name: string) => ([...$('file-list').querySelectorAll('.file')].find((li) => li.querySelector('.file-name')?.textContent === name)!.querySelector('.file-open') as HTMLButtonElement).click()
const crumbs = () => ($('crumbs').hidden ? null : [...$('crumbs').querySelectorAll('.crumb')].map((c) => c.textContent))
const crumb = (i: number) => ($('crumbs').querySelectorAll('.crumb')[i] as HTMLButtonElement).click()
const listed = () => gugu.files.list.mock.calls.map(([place]) => place)

beforeAll(async () => {
  const html = readFileSync(resolve(process.cwd(), 'apps/desktop/preinstalled-apps/workspace/index.html'), 'utf8')
  const page = new DOMParser().parseFromString(html, 'text/html')
  document.body.innerHTML = page.body.innerHTML
  Object.assign(globalThis, { gugu, CSS: { escape: (s: string) => s } })
  Object.assign(window, { gugu })
  // @ts-expect-error — 内置 App 是不经构建的纯 ES module,没有类型;运行时 import 可用。
  await import('../../../../apps/desktop/preinstalled-apps/workspace/app.js')
  await until('the roots drawn', () => names().length > 0)
})

describe('a session\'s tab: one folder, two roots', () => {
  test('the top is the two roots, and nothing is listed until one is entered', () => {
    expect(names()).toEqual(['对话的文件夹', '工作目录'])
    expect(listed()).toEqual([])
  })

  test('the working copy lists its top, then a folder only when it is entered — once', async () => {
    press('工作目录')
    await until('the top listed', () => names().includes('README.md'))
    expect(names()).toEqual(['src', 'README.md'])
    expect(crumbs()).toEqual(['文件夹', '工作目录'])
    press('src')
    await until('src listed', () => names().includes('main.md'))
    expect(names()).toEqual(['lib', 'main.md'])
    expect(crumbs()).toEqual(['文件夹', '工作目录', 'src'])
    expect(listed()).toEqual([{ workspace: WS, folder: '' }, { workspace: WS, folder: 'src' }])
    crumb(1)
    expect(names()).toEqual(['src', 'README.md'])
    press('src')
    expect(listed()).toHaveLength(2)
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
    crumb(0)
    expect(names()).toEqual(['对话的文件夹', '工作目录'])
    press('对话的文件夹')
    await until('the chat listed', () => names().includes('plan.md'))
    expect(listed().at(-1)).toEqual({ chat: 'dm-1' })
    expect(crumbs()).toEqual(['文件夹', '对话的文件夹'])
  })

  test('its conversation arriving later keeps the person where they are in the working copy (no jump to the top)', async () => {
    crumb(0)
    press('工作目录')
    await until('the top drawn', () => names().includes('src'))
    press('src')
    await until('src drawn', () => names().includes('main.md'))
    const calls = listed().length
    // The same working copy; the conversation changes (it was not there yet, then is): nothing to read again.
    contextChanged!({ ...context, chat: { ...context.chat, id: 'dm-2' } })
    await until('the context applied', () => gugu.files.onChanged.mock.calls.some(([place]) => (place as { chat?: string }).chat === 'dm-2'))
    expect([crumbs(), names().includes('main.md'), listed().length]).toEqual([['文件夹', '工作目录', 'src'], true, calls])
  })
})
