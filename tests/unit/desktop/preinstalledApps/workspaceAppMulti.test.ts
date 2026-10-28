// @vitest-environment jsdom
// 群文件夹第三步(owner 10-28):多选 —— 勾选框、Ctrl/⌘、Shift 连续选、长按(手机);选中以后一次下载(API 20:桌面问
// 一次文件夹、手机走系统分享)、一起设为临时或一直保留(只交自己传的、有云端副本的,其余说明跳过了几个)、在聊天中
// 一条一条定位(1/3 ‹ ›)。换文件夹、换类型都放开选中。页面跑在假的 window.gugu 上。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { until } from '../../../support/awaitCondition'

const now = Date.parse('2026-10-28T12:00:00Z')
const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString()
const zhang = { id: 'u1', name: '张三', kind: 'human' }
const b = { id: 'u2', name: 'B 号', kind: 'human' }
const file = (id: string, name: string, contentType: string, at: string, more: Record<string, unknown> = {}) => ({
  id, name, displayName: name, suffix: name.slice(name.lastIndexOf('.')), contentType, type: 'binary', size: 1000, parentId: null, path: name,
  systemRole: null, version: 1, createdAt: at, updatedAt: at, createdBy: zhang, sourceMessageIds: [], canDelete: true, ...more,
})
const ENTRIES = [
  file('a', 'a.pdf', 'application/pdf', ago(100), { keep: { expiresAt: null, mine: true }, sourceMessageIds: ['m-a'] }),
  file('b', 'b.pdf', 'application/pdf', ago(200), { createdBy: b, keep: { expiresAt: null, mine: false }, sourceMessageIds: ['m-b'] }),
  file('c', 'c.zip', 'application/zip', ago(300), { keep: { expiresAt: null, mine: true } }),
  file('d', 'd.md', 'text/markdown', ago(400), { type: 'text', keep: null, sourceMessageIds: ['m-d'] }),
]

const context = { chat: { id: 'chat-1', name: 'G', kind: 'group', groupId: 'chat-1' }, locale: 'zh-CN', capabilities: ['files:read', 'files:write'] }
const gugu = {
  linkTo: vi.fn(async ({ file }: { file: { id: string } }) => `gugu-file://${file.id}`),
  setTabTitle: vi.fn(async () => {}),
  getContext: vi.fn(async () => context),
  onContextChanged: vi.fn(() => () => {}),
  onLink: vi.fn(() => () => {}),
  showMessage: vi.fn(async () => {}),
  clipboard: { writeText: vi.fn(async () => {}) },
  files: {
    viewPreferences: vi.fn(async () => ({ showAppData: false })),
    list: vi.fn(async () => ENTRIES.map((e) => ({ ...e }))),
    onChanged: vi.fn(() => () => {}),
    openWith: vi.fn(async () => {}),
    download: vi.fn(async (files: unknown[]) => (Array.isArray(files) ? files.length : true)),
    keep: vi.fn(async (files: unknown[]) => ({ changed: files.length })),
  },
}

const $ = (id: string) => document.getElementById(id) as HTMLElement
const ids = () => [...$('file-list').querySelectorAll<HTMLElement>('li.file')].map((li) => li.dataset.id)
const row = (id: string) => document.querySelector(`[data-id="${id}"]`) as HTMLElement
const box = (id: string) => row(id).querySelector<HTMLButtonElement>('.file-pick')!
const open = (id: string, init: MouseEventInit = {}) => row(id).querySelector('.file-open')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }))
const picked = () => ids().filter((id) => row(id!).classList.contains('picked'))
const bar = () => $('pick-bar')
const barButton = (text: string) => [...bar().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)!
const banner = () => [$('banner'), $('list-banner')].filter((node) => !node.hidden).map((node) => node.textContent).join('')
const pressEscape = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

beforeAll(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now)
  localStorage.clear()
  const html = readFileSync(resolve(process.cwd(), 'apps/desktop/preinstalled-apps/workspace/index.html'), 'utf8')
  const page = new DOMParser().parseFromString(html, 'text/html')
  document.body.innerHTML = page.body.innerHTML
  for (const attr of Array.from(page.body.attributes)) document.body.setAttribute(attr.name, attr.value)
  Object.assign(globalThis, { gugu })
  Object.assign(window, { gugu })
  // @ts-expect-error — 内置 App 是不经构建的纯 ES module,没有类型;运行时 import 可用。
  await import('../../../../apps/desktop/preinstalled-apps/workspace/app.js')
  await until('the list drawn', () => ids().length === 4)
})

afterAll(() => vi.restoreAllMocks())

beforeEach(() => {
  pressEscape()
  gugu.files.openWith.mockClear()
})

describe('picking', () => {
  test('a box picks; while anything is picked a press picks too, not opens; Escape lets go of all', () => {
    expect(bar().hidden).toBe(true)
    box('a').click()
    expect(picked()).toEqual(['a'])
    expect(bar().querySelector('.pick-count')!.textContent).toBe('已选 1 项')
    expect($('file-list').classList.contains('picking')).toBe(true)
    open('c')
    expect(picked()).toEqual(['a', 'c'])
    expect(gugu.files.openWith).not.toHaveBeenCalled()
    open('a')
    expect(picked()).toEqual(['c'])
    pressEscape()
    expect(picked()).toEqual([])
    expect(bar().hidden).toBe(true)
  })

  test('Ctrl or ⌘ picks without opening; Shift picks the run from the one pressed last, in the order on screen', () => {
    open('a', { ctrlKey: true })
    expect(picked()).toEqual(['a'])
    open('d', { shiftKey: true })
    expect(picked()).toEqual(['a', 'b', 'c', 'd'])
    pressEscape()
    open('b', { metaKey: true })
    open('b', { metaKey: true })
    expect(picked()).toEqual([])
    expect(gugu.files.openWith).not.toHaveBeenCalled()
  })

  test('a long press (a finger) picks, and the click after it does not open', async () => {
    const target = row('b').querySelector('.file-open')!
    target.dispatchEvent(Object.assign(new MouseEvent('pointerdown', { bubbles: true }), { pointerType: 'touch' }))
    await new Promise((done) => setTimeout(done, 600))
    target.dispatchEvent(Object.assign(new MouseEvent('pointerup', { bubbles: true }), { pointerType: 'touch' }))
    open('b')
    expect(picked()).toEqual(['b'])
    expect(gugu.files.openWith).not.toHaveBeenCalled()
  })

  test('another kind lets go of what was picked', () => {
    box('a').click()
    $('kinds').querySelector<HTMLButtonElement>('[data-kind="docs"]')!.click()
    expect(bar().hidden).toBe(true)
    $('kinds').querySelector<HTMLButtonElement>('[data-kind="all"]')!.click()
    expect(picked()).toEqual([])
  })
})

describe('what is picked, at once', () => {
  test('downloaded together (one 「save to」 for them all), and said how many', async () => {
    box('a').click()
    box('c').click()
    barButton('下载').click()
    await until('saved', () => banner(), (text) => text === '已保存 2 个文件。')
    expect(gugu.files.download).toHaveBeenLastCalledWith([expect.objectContaining({ id: 'a' }), expect.objectContaining({ id: 'c' })])
  })

  test('made temporary: only my own cloud copies asked for; someone else\'s and one without a copy said apart', async () => {
    for (const id of ['a', 'b', 'c', 'd']) box(id).click()
    const reads = gugu.files.list.mock.calls.length
    barButton('设为临时').click()
    await until('the list read again', () => gugu.files.list.mock.calls.length > reads)
    expect(gugu.files.keep).toHaveBeenLastCalledWith([expect.objectContaining({ id: 'a' }), expect.objectContaining({ id: 'c' })], 'temporary')
    await until('said', () => banner(), (text) => text === '已改 2 个。 1 个不是你上传的，没改。 1 个没有云端副本，没改。')
  })

  test('found in the chat one message after another, oldest first: 1/3 ‹ ›', () => {
    for (const id of ['a', 'b', 'c', 'd']) box(id).click()
    barButton('在聊天中定位').click()
    expect(gugu.showMessage).toHaveBeenLastCalledWith('m-d')
    expect(bar().querySelector('.pick-at')!.textContent).toBe('1/3')
    expect(barButton('‹').disabled).toBe(true)
    barButton('›').click()
    expect(gugu.showMessage).toHaveBeenLastCalledWith('m-b')
    barButton('›').click()
    expect(gugu.showMessage).toHaveBeenLastCalledWith('m-a')
    expect(bar().querySelector('.pick-at')!.textContent).toBe('3/3')
    expect(barButton('›').disabled).toBe(true)
    barButton('‹').click()
    expect(gugu.showMessage).toHaveBeenLastCalledWith('m-b')
  })

  test('none from the chat: said so, nothing shown', () => {
    gugu.showMessage.mockClear()
    box('c').click()
    barButton('在聊天中定位').click()
    expect(gugu.showMessage).not.toHaveBeenCalled()
    expect(banner()).toBe('选中的文件都不是从聊天里来的。')
  })
})
