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

let touch = false
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
    forward: vi.fn(async () => {}) as ReturnType<typeof vi.fn> | undefined,
  },
}

const $ = (id: string) => document.getElementById(id) as HTMLElement
const ids = () => [...$('file-list').querySelectorAll<HTMLElement>('li.file')].map((li) => li.dataset.id)
const row = (id: string) => document.querySelector(`[data-id="${id}"]`) as HTMLElement
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
  Object.assign(window, { gugu, matchMedia: (query: string) => ({ get matches() { return touch && query.includes('pointer: coarse') } }) })
  // @ts-expect-error — 内置 App 是不经构建的纯 ES module,没有类型;运行时 import 可用。
  await import('../../../../apps/desktop/preinstalled-apps/workspace/app.js')
  await until('the list drawn', () => ids().length === 4)
})

afterAll(() => vi.restoreAllMocks())

beforeEach(() => {
  pressEscape()
  pressEscape()
  touch = false
  gugu.files.openWith.mockClear()
})

describe('picking', () => {
  test('modifier selection highlights the row; a later press toggles, and Escape lets go of all', () => {
    expect(bar().hidden).toBe(true)
    open('a', { ctrlKey: true })
    expect(picked()).toEqual(['a'])
    expect(bar().querySelector('.pick-count')!.textContent).toBe('已选 1 项')
    expect(row('a').getAttribute('aria-selected')).toBe('true')
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

  test('a long press opens the file menu; choosing Select enters selection without opening', async () => {
    touch = true
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const target = row('b').querySelector('.file-open')!
      target.dispatchEvent(Object.assign(new MouseEvent('pointerdown', { bubbles: true }), { pointerType: 'touch' }))
      await vi.advanceTimersByTimeAsync(500)
      target.dispatchEvent(Object.assign(new MouseEvent('pointerup', { bubbles: true }), { pointerType: 'touch' }))
      open('b')
      expect(picked()).toEqual([])
      expect($('menu').hidden).toBe(false)
      expect($('menu').querySelector('.menu-file')!.textContent).toContain('b.pdf')
      const select = [...$('menu').querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === '选择')!
      select.click()
      expect(picked()).toEqual(['b'])
      expect($('select-files').getAttribute('aria-pressed')).toBe('true')
      expect(gugu.files.openWith).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }

  })

  test('single click still opens; the desktop has no per-row overflow button', () => {
    open('a')
    expect(gugu.files.openWith).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'a' }))
    expect(picked()).toEqual([])
    expect(document.querySelector('.row-more')).toBe(null)
  })

  test.each([450, 550])('a native touch contextmenu at %ims opens once, before or after the hold timer', async (nativeAt) => {
    touch = true
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const target = row('b').querySelector('.file-open')!
      target.dispatchEvent(Object.assign(new MouseEvent('pointerdown', { bubbles: true }), { pointerType: 'touch' }))
      await vi.advanceTimersByTimeAsync(nativeAt)
      target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
      expect($('menu').hidden).toBe(false)
      await vi.advanceTimersByTimeAsync(500)
      expect($('menu').hidden).toBe(false)
      target.dispatchEvent(Object.assign(new MouseEvent('pointerup', { bubbles: true }), { pointerType: 'touch' }))
      open('b')
      expect($('menu').hidden).toBe(false)
      expect(picked()).toEqual([])
      expect(gugu.files.openWith).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  test('deselecting the last desktop menu selection restores single-click opening', () => {
    row('b').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    const select = [...$('menu').querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === '选择')!
    select.click()
    expect(picked()).toEqual(['b'])
    open('b')
    expect(picked()).toEqual([])
    expect($('select-files').getAttribute('aria-pressed')).toBe('false')
    open('a')
    expect(gugu.files.openWith).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'a' }))
  })

  test('the wide header selects all, reports a partial selection, and clears all', () => {
    const all = $('file-list').querySelector<HTMLButtonElement>('[aria-label="全选"]')!
    all.click()
    expect(picked()).toEqual(['a', 'b', 'c', 'd'])
    expect(all.getAttribute('aria-checked')).toBe('true')
    open('b')
    expect(all.getAttribute('aria-checked')).toBe('mixed')
    all.click()
    all.click()
    expect(picked()).toEqual([])
    expect(all.getAttribute('aria-checked')).toBe('false')
    expect(bar().parentElement).toBe(document.querySelector('aside.files'))
  })

  test('mobile Select works before anything is picked and the separate checkbox never opens a file', () => {
    touch = true
    $('select-files').click()
    expect($('select-files').getAttribute('aria-pressed')).toBe('true')
    const checkbox = row('c').querySelector<HTMLButtonElement>('[role="checkbox"]')!
    expect(checkbox.nextElementSibling?.className).toBe('file-open')
    checkbox.click()
    expect(picked()).toEqual(['c'])
    expect(gugu.files.openWith).not.toHaveBeenCalled()
    checkbox.click()
    expect(picked()).toEqual([])
    expect($('select-files').getAttribute('aria-pressed')).toBe('true')
    $('select-files').click()
    expect(picked()).toEqual([])
    expect($('select-files').getAttribute('aria-pressed')).toBe('false')
  })

  test('right-click during selection acts on the selected files, including when another row is under the pointer', async () => {
    open('a', { ctrlKey: true })
    open('c')
    row('b').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 90, clientY: 20 }))
    const actions = [...$('menu').querySelectorAll<HTMLButtonElement>('button')]
    expect(actions.map((item) => item.textContent)).toEqual(['转发', '下载', '设为临时', '一直保留', '在聊天中定位', '取消选择'])
    actions[1]!.click()
    await until('batch download called', () => gugu.files.download.mock.calls.length > 0)
    expect(gugu.files.download).toHaveBeenLastCalledWith([expect.objectContaining({ id: 'a' }), expect.objectContaining({ id: 'c' })])
  })

  test('Shift+F10 opens the focused row menu; Ctrl+A selects only when the list owns the keys', () => {
    const target = row('a').querySelector<HTMLButtonElement>('.file-open')!
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }))
    expect($('menu').hidden).toBe(false)
    expect(document.activeElement?.textContent).toBe('打开')
    pressEscape()
    expect(document.activeElement).toBe(target)
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true }))
    expect(picked()).toEqual(['a', 'b', 'c', 'd'])
    pressEscape()
    $('filter').dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true }))
    expect(picked()).toEqual([])
  })

  test('box selection still uses the rows crossed, without opening them', () => {
    for (const [index, id] of ['a', 'b', 'c', 'd'].entries()) {
      vi.spyOn(row(id), 'getBoundingClientRect').mockReturnValue({ left: 0, right: 100, top: index * 30, bottom: index * 30 + 20 } as DOMRect)
    }
    const list = $('file-list')
    list.dispatchEvent(Object.assign(new MouseEvent('pointerdown', { button: 0, clientX: 0, clientY: 0 }), { pointerType: 'mouse' }))
    list.dispatchEvent(new MouseEvent('pointermove', { clientX: 110, clientY: 55, cancelable: true }))
    list.dispatchEvent(new MouseEvent('pointerup'))
    expect(picked()).toEqual(['a', 'b'])
    expect($('lasso').hidden).toBe(true)
    expect(gugu.files.openWith).not.toHaveBeenCalled()
  })

  test('mobile More and retention reuse the same menu and retain disabled reasons', () => {
    touch = true
    row('b').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    const choose = (label: string) => [...$('menu').querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === label)!.click()
    choose('更多 ›')
    choose('保留方式 ›')
    const options = [...$('menu').querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
    expect(options.map((item) => item.disabled)).toEqual([true, true])
    expect(options[0]!.title).toBe('只有上传这份文件的人能改它保留多久。')
    choose('‹ 保留方式')
    choose('‹ 更多')
    expect($('menu').querySelector('button')!.textContent).toBe('打开')
  })

  test('another kind lets go of what was picked', () => {
    open('a', { ctrlKey: true })
    $('kinds').querySelector<HTMLButtonElement>('[data-kind="docs"]')!.click()
    expect(bar().hidden).toBe(true)
    $('kinds').querySelector<HTMLButtonElement>('[data-kind="all"]')!.click()
    expect(picked()).toEqual([])
  })
})

describe('转发 (API 23)', () => {
  const menuOf = (id: string) => {
    row(id).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 90, clientY: 20 }))
    return [...$('menu').querySelectorAll<HTMLButtonElement>('button')]
  }

  test('a file\'s menu: Forward first in the use group (as a message\'s menu has it before Download); the host\'s page gets that file', async () => {
    const items = menuOf('a')
    const labels = items.map((item) => item.textContent)
    expect(labels.slice(labels.indexOf('转发'), labels.indexOf('转发') + 3)).toEqual(['转发', '下载', '复制链接'])
    items.find((item) => item.textContent === '转发')!.click()
    await until('forward asked', () => gugu.files.forward!.mock.calls.length > 0)
    expect(gugu.files.forward).toHaveBeenLastCalledWith([expect.objectContaining({ id: 'a' })])
  })

  test('picked files: one Forward for them all, in the order on screen; the selection is let go once the host\'s page is up', async () => {
    gugu.files.forward!.mockClear()
    open('c', { ctrlKey: true })
    open('a', { ctrlKey: true })
    barButton('转发').click()
    await until('forward asked', () => gugu.files.forward!.mock.calls.length > 0)
    expect(gugu.files.forward).toHaveBeenLastCalledWith([expect.objectContaining({ id: 'a' }), expect.objectContaining({ id: 'c' })])
    await until('let go', () => picked().length === 0)
  })

  test('a host before API 23 (no files.forward): no Forward anywhere, rather than one that fails', () => {
    const forward = gugu.files.forward
    delete gugu.files.forward
    try {
      expect(menuOf('a').map((item) => item.textContent)).not.toContain('转发')
      pressEscape()
      open('a', { ctrlKey: true })
      expect([...bar().querySelectorAll('button')].map((item) => item.textContent)).not.toContain('转发')
    } finally {
      gugu.files.forward = forward
    }
  })
})

describe('what is picked, at once', () => {
  test('downloaded together (one 「save to」 for them all), and said how many', async () => {
    open('a', { ctrlKey: true })
    open('c', { ctrlKey: true })
    barButton('下载').click()
    await until('saved', () => banner(), (text) => text === '已保存 2 个文件。')
    expect(gugu.files.download).toHaveBeenLastCalledWith([expect.objectContaining({ id: 'a' }), expect.objectContaining({ id: 'c' })])
  })

  test('made temporary: only my own cloud copies asked for; someone else\'s and one without a copy said apart', async () => {
    for (const id of ['a', 'b', 'c', 'd']) open(id, { ctrlKey: true })
    const reads = gugu.files.list.mock.calls.length
    barButton('设为临时').click()
    await until('the list read again', () => gugu.files.list.mock.calls.length > reads)
    expect(gugu.files.keep).toHaveBeenLastCalledWith([expect.objectContaining({ id: 'a' }), expect.objectContaining({ id: 'c' })], 'temporary')
    await until('said', () => banner(), (text) => text === '已改 2 个。 1 个不是你上传的，没改。 1 个没有云端副本，没改。')
  })

  test('found in the chat one message after another, oldest first: 1/3 ‹ ›', () => {
    for (const id of ['a', 'b', 'c', 'd']) open(id, { ctrlKey: true })
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
    open('c', { ctrlKey: true })
    barButton('在聊天中定位').click()
    expect(gugu.showMessage).not.toHaveBeenCalled()
    expect(banner()).toBe('选中的文件都不是从聊天里来的。')
  })

  test('Ctrl+A clears the previous selection’s chat location', () => {
    open('a', { ctrlKey: true })
    barButton('在聊天中定位').click()
    expect(bar().querySelector('.pick-at')!.textContent).toBe('1/1')
    row('a').querySelector('.file-open')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true }))
    expect(picked()).toEqual(['a', 'b', 'c', 'd'])
    expect(bar().querySelector('.pick-at')).toBe(null)
    expect(barButton('在聊天中定位')).toBeDefined()
  })
})
