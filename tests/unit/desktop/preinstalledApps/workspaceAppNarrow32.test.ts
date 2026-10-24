// @vitest-environment jsdom
// 摩擦单 F32(L6 S7,统筹 05:28):话题分栏 339 px、群右栏 439 px 里,文件页的标题栏折成四行、「对照 / 预览」被切出右边。
// 窄栏(≤ 640 px,media query)下:文件名独占一行,动作一行 ——「源码 / 预览」加「⋯」(下载、用别的 App 打开收进去);
// 「对照」在窄栏里就是只剩一栏(主人 10-01:预览),所以窄栏不给它。宽栏照旧全部摊开。槽位标题跟宿主语言(否则是 manifest 的「文件夹」),群里叫群文件夹、私聊里叫文件夹。
// 排版本身(不溢出、按钮在边界内)在真 Electron 里用裸 CDP 截图 + DOM 读数验收;这里守的是 app.js 的逻辑。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, test, vi } from 'vitest'

const entries = [
  { id: 'photo', name: 'photo.png', displayName: 'photo.png', contentType: 'image/png', type: 'binary', size: 100, updatedAt: new Date().toISOString() },
  { id: 'plan', name: 'plan.md', displayName: 'plan.md', contentType: 'text/markdown', type: 'text', size: 10, updatedAt: new Date().toISOString() },
]
const context = { chat: { id: 'chat-1', name: 'G', kind: 'group', groupId: 'chat-1' }, locale: 'en-US', capabilities: ['files:read', 'files:write'] }

// The pane's width, as the page's own media query sees it.
const narrow = { matches: true, listeners: [] as (() => void)[] }
const setNarrow = (matches: boolean) => {
  narrow.matches = matches
  for (const fn of narrow.listeners) fn()
}

const gugu = {
  getContext: vi.fn(async () => context),
  onContextChanged: vi.fn(() => () => {}),
  openBrowserTab: vi.fn(async () => {}),
  onLink: vi.fn(() => () => {}),
  setTabTitle: vi.fn(async (_title: string) => {}),
  files: {
    list: vi.fn(async () => entries),
    onChanged: vi.fn(() => () => {}),
    open: vi.fn(async () => { throw new Error('rig: no file service here') }),
    create: vi.fn(),
    remove: vi.fn(),
    openWith: vi.fn(async () => {}),
    download: vi.fn(async () => true),
  },
}

const $ = (id: string) => document.getElementById(id) as HTMLElement
const pressed = () => ['edit', 'split', 'preview'].filter((m) => $(`mode-${m}`).getAttribute('aria-selected') === 'true')
// What is on screen, read from the DOM (审计 C4).
const shown = () => document.body.classList.contains('show-doc') && !$('download').hidden ? $('doc-title').textContent : null

beforeAll(async () => {
  const html = readFileSync(resolve(process.cwd(), 'apps/desktop/preinstalled-apps/workspace/index.html'), 'utf8')
  const page = new DOMParser().parseFromString(html, 'text/html')
  document.body.innerHTML = page.body.innerHTML
  for (const attr of Array.from(page.body.attributes)) document.body.setAttribute(attr.name, attr.value)
  Object.assign(window, {
    gugu,
    matchMedia: (query: string) => {
      expect(query).toBe('(max-width: 640px)') // the same width style.css folds the header at
      return { get matches() { return narrow.matches }, addEventListener: (_: string, fn: () => void) => narrow.listeners.push(fn) }
    },
  })
  Object.assign(globalThis, { gugu })
  // @ts-expect-error — 内置 App 是不经构建的纯 ES module,没有类型;运行时 import 可用。
  await import('../../../../apps/desktop/preinstalled-apps/workspace/app.js')
  await vi.waitFor(() => expect(document.querySelectorAll('.file')).toHaveLength(2))
})

describe('workspace App in a narrow pane (F32)', () => {
  test('side by side is not offered narrow: the default shows the preview (主人 10-01), and the choice comes back when it is wide', () => {
    // Control (the parent commit): 'edit' — a narrow pane opened a document on its source.
    expect(document.body.dataset.mode).toBe('preview')
    expect(pressed()).toEqual(['preview'])
    setNarrow(false)
    expect(document.body.dataset.mode, '对照:宽栏里默认就是并排').toBe('split')
    expect(pressed()).toEqual(['split'])
    setNarrow(true)
    $('mode-preview').click()
    expect(document.body.dataset.mode).toBe('preview')
    setNarrow(false)
    expect(document.body.dataset.mode, 'a choice made narrow stays when it widens').toBe('preview')
    $('mode-split').click()
    setNarrow(true)
    expect(document.body.dataset.mode).toBe('preview')
  })

  test('Download and Open with another App fold behind ⋯, which is there only when one of them is', async () => {
    expect($('more').hidden, 'nothing on screen: nothing to fold').toBe(true)
    const entry = { ...entries[0], id: 'big', name: 'large.json', displayName: 'large.json' }
    gugu.files.open.mockResolvedValueOnce({ type: 'binary', entry, close: vi.fn() } as never)
    const changed = (gugu.onContextChanged.mock.calls[0] as unknown as [(ctx: unknown) => void])[0]
    changed({ ...context, file: { chat: 'chat-1', id: 'big' } })
    await vi.waitFor(() => expect(shown()).toBe('large.json'))
    expect(gugu.setTabTitle).toHaveBeenLastCalledWith('large.json')
    expect($('more').hidden).toBe(false)
    expect($('more').getAttribute('aria-label')).toBe('More')
    expect($('menu').hidden).toBe(true)
    // Wide, style.css lays the two buttons in the row; narrow, ⋯ opens them in the page's one menu (a row's ⋯ opens it too).
    $('more').click()
    expect($('menu').hidden).toBe(false)
    expect($('more').getAttribute('aria-expanded')).toBe('true')
    expect([...$('menu').children].map((item) => item.textContent)).toEqual(['Download', 'Open with another App'])
    ;($('menu').firstElementChild as HTMLButtonElement).click()
    expect($('menu').hidden, 'choosing closes it').toBe(true)
    expect($('more').getAttribute('aria-expanded')).toBe('false')
    await vi.waitFor(() => expect(gugu.files.download).toHaveBeenCalledWith(expect.objectContaining({ id: 'big' })))

    $('more').click()
    expect(document.activeElement, 'the keyboard is in the menu').toBe($('menu').firstElementChild)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect($('menu').hidden).toBe(true)
    expect(document.activeElement, 'and back on ⋯ when it closes').toBe($('more'))
    $('more').click()
    $('mode-preview').focus() // Tab out of the menu
    expect($('menu').hidden, 'leaving the menu closes it').toBe(true)
    $('more').click()
    $('doc-title').dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect($('menu').hidden, 'a press outside closes it').toBe(true)
    $('more').click()
    $('more').click()
    expect($('menu').hidden, 'its ⋯ again closes it').toBe(true)

    changed({ ...context })
    await vi.waitFor(() => expect(shown()).toBe(null))
    expect(document.body.classList.contains('show-doc')).toBe(false)
    expect(gugu.setTabTitle).toHaveBeenLastCalledWith('Group folder')
  })

  test('the list is the only pane until a file is shown: no "pick a file" beside it, the empty note at the top', () => {
    expect(document.body.classList.contains('show-doc')).toBe(false)
    expect($('doc-message').textContent).not.toMatch(/pick a file/i)
    const files = document.querySelector('.files')!
    // 子文件夹: the crumbs sit between the head and the list (hidden at the top), then the list's own line for what went wrong.
    expect([...files.children].map((e) => e.id || e.classList[0]).slice(0, 5)).toEqual(['files-head', 'crumbs', 'list-banner', 'files-empty', 'file-list'])
  })

  // owner 10-11「私聊就叫做文件夹吧，群里面是群文件夹」: a topic goes by the chat it grew out of, which ctx.chat.groupId says.
  // Control (55ffebac2): every chat's slot said Group folder.
  test.each([
    [{ id: 'dm-1', name: 'B', kind: 'dm', groupId: null }, 'en-US', 'Folder'],
    [{ id: 'topic-dm', name: 'T', kind: 'topic', groupId: null }, 'zh-CN', '文件夹'],
    [{ id: 'topic-g', name: 'T', kind: 'topic', groupId: 'chat-1' }, 'zh-CN', '群文件夹'],
  ])('the slot\'s title follows the chat: %o in %s → %s', async (chat, locale, title) => {
    const changed = (gugu.onContextChanged.mock.calls[0] as unknown as [(ctx: unknown) => void])[0]
    changed({ ...context, chat, locale })
    await vi.waitFor(() => expect(gugu.setTabTitle).toHaveBeenLastCalledWith(title))
  })
})
