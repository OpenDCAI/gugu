// @vitest-environment jsdom
// 内置工作区 App 接手旧工作区的四样(真源 §2.4 c3d9f16d / fdf21cf0):上传、下载、「谁创建的」、来源消息。
// The list sorts by the last change, but keeps creation and editing attribution separate.
// 页面跑在假的 window.gugu 上 —— 判的是 App 怎么用这几个宿主动词、结果怎么画;动词本身由 L3 的运行时测。
// 宿主没给的动词,对应按钮就不出现(和 files.rename 一样)。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { until } from '../../../support/awaitCondition'

const now = Date.parse('2026-10-25T12:00:00Z')
const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString()

const entries = [
  {
    id: 'plan', name: 'plan.md', displayName: 'plan.md', contentType: 'text/markdown', type: 'text', size: 10,
    createdAt: ago(3600), updatedAt: ago(60), createdBy: { id: 'u1', name: '张三', kind: 'human' }, canDelete: true, sourceMessageIds: [],
  },
  {
    id: 'photo', name: 'photo.png', displayName: 'photo.png', contentType: 'image/png', type: 'binary', size: 100,
    createdAt: ago(120), updatedAt: ago(120), createdBy: { id: 'a1', name: '写手', kind: 'agent' }, canDelete: true, sourceMessageIds: ['m1', 'm2'],
  },
  {
    id: 'cfg', name: 'cfg.json', displayName: 'cfg.json', contentType: 'application/json', type: 'json', size: 2,
    createdAt: ago(7200), updatedAt: ago(7200), createdBy: { id: 'sys', name: '', kind: 'system' }, canDelete: true, sourceMessageIds: [],
  },
  // An entry without a creator (a file no person or agent made): listed, its creator left blank.
  { id: 'old',name: 'old.md', displayName: 'old.md', contentType: 'text/markdown', type: 'text', size: 1, updatedAt: ago(10) },
]

type Ctx = { chat: { id: string; name: string; kind: 'group' | 'topic'; groupId: string | null }; locale: string; capabilities: string[]; file?: { chat: string; id: string } }
const context: Ctx = { chat: { id: 'chat-1', name: 'G', kind: 'group', groupId: 'chat-1' }, locale: 'zh-CN', capabilities: ['files:read', 'files:write'] }
let contextChanged: (ctx: Ctx) => void = () => {}

const gugu = {
  linkTo: vi.fn(async ({ file }: { file: { id: string } }) => `gugu-file://${file.id}`),
  setTabTitle: vi.fn(async () => {}),
  getContext: vi.fn(async () => context),
  onContextChanged: vi.fn((fn: typeof contextChanged) => {
    contextChanged = fn
    return () => {}
  }),
  openBrowserTab: vi.fn(async () => {}),
  onLink: vi.fn(() => () => {}),
  showMessage: vi.fn(async (_id: string) => {}),
  files: {
    list: vi.fn(async () => entries),
    onChanged: vi.fn(() => () => {}),
    // Only what the host hands this page (context.file) is opened here; no file service in this rig.
    open: vi.fn(async () => { throw new Error('rig: no file service here') }),
    create: vi.fn(),
    remove: vi.fn(),
    // The host previews unclaimed files; the folder does not repeat a details screen.
    openWith: vi.fn(async (_entry: unknown, _options?: { ask?: boolean }) => {}),
    upload: vi.fn(async (): Promise<typeof entries> => []),
    download: vi.fn(async (_entry: unknown) => true),
  },
}

const $ = (id: string) => document.getElementById(id) as HTMLElement
// What the page shows, read from its DOM (审计 C4: no test-only view hangs on the product's window).
const app = () => ({
  entries: [...$('file-list').querySelectorAll('.file')],
  shown: document.body.classList.contains('show-doc') && !$('download').hidden ? $('doc-title').textContent : null,
  info: $('doc-info').hidden ? '' : $('doc-info').textContent ?? '',
})
const banner = () => ['banner', 'list-banner'].map((id) => $(id)).filter((node) => !node.hidden).map((node) => node.textContent).join('')
const clickFile = (id: string) => (document.querySelector(`[data-id="${id}"] .file-open`) as HTMLButtonElement).click()
// A row's ⋯, and the page's one menu it opens: what it says, an item by what it says.
const rowMore = (id: string) => document.querySelector(`[data-id="${id}"] .row-more`) as HTMLButtonElement
const menuItems = () => [...$('menu').querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
const offered = () => menuItems().map((item) => item.textContent)
const menuItem = (text: string) => menuItems().find((item) => item.textContent === text)!
const pressEscape = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

beforeAll(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now)
  const html = readFileSync(resolve(process.cwd(), 'apps/desktop/preinstalled-apps/workspace/index.html'), 'utf8')
  const page = new DOMParser().parseFromString(html, 'text/html')
  document.body.innerHTML = page.body.innerHTML
  for (const attr of Array.from(page.body.attributes)) document.body.setAttribute(attr.name, attr.value)
  Object.assign(globalThis, { gugu })
  Object.assign(window, { gugu })
  // @ts-expect-error — 内置 App 是不经构建的纯 ES module,没有类型;运行时 import 可用。
  await import('../../../../apps/desktop/preinstalled-apps/workspace/app.js')
  await vi.waitFor(() => expect(app().entries).toHaveLength(4))
})

afterAll(() => vi.restoreAllMocks())

describe('workspace App: what the old workspace panel did', () => {
  test('one list: newest change first, with the creator paired only with creation time', () => {
    expect(document.getElementById('activity'), '对照:父提交在列表下面还有一块「最近动态」').toBe(null)
    // plan.md was made an hour ago and edited a minute ago: its edit counts, so it sits above photo.png.
    expect(app().entries.map((li) => li.querySelector('.file-name')!.textContent)).toEqual(['old.md', 'plan.md', 'photo.png', 'cfg.json'])
    const cells = (id: string) => [...document.querySelector(`[data-id="${id}"] .file-meta`)!.children].map((cell) => cell.textContent)
    expect(cells('plan')).toEqual(['张三 创建 · 1小时前', '已编辑 · 1分钟前'])
    expect(cells('photo')).toEqual(['写手 (Agent) 创建 · 2分钟前'])
    expect(cells('cfg')).toEqual(['系统 创建 · 2小时前'])
    expect(cells('old'), 'no creation metadata: no invented attribution').toEqual([])
  })

  test('a file on screen shows its creator and source messages; a click asks the host to show one', async () => {
    // A claimed JSON stored as binary still has a download-only page in this App.
    const entry = { ...entries[1], id: 'big', name: 'large.json', displayName: 'large.json' }
    gugu.files.open.mockResolvedValueOnce({ type: 'binary', entry, close: vi.fn() } as never)
    contextChanged({ ...context, file: { chat: 'chat-1', id: 'big' } })
    await vi.waitFor(() => expect(app().shown).toBe('large.json'))
    expect($('doc-message').hidden).toBe(false)
    expect($('download').hidden).toBe(false)
    expect(app().info).toContain('写手 (Agent) 创建 · 2分钟前')
    const sources = Array.from(document.querySelectorAll<HTMLButtonElement>('#doc-info .source'))
    expect(sources.map((b) => b.textContent)).toEqual(['第 1 条', '第 2 条'])

    sources[1].click()
    expect(gugu.showMessage).toHaveBeenLastCalledWith('m2')
    await Promise.resolve()
    expect(banner()).toBe('')

    gugu.showMessage.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'not-found' }))
    sources[0].click()
    await vi.waitFor(() => expect(banner()).toBe('这条消息不在这个对话里了。'))
  })

  test('download saves the file on screen; a cancelled save dialog says nothing, a failure says so', async () => {
    expect($('download').hidden).toBe(false)
    $('banner').hidden = true
    gugu.files.download.mockResolvedValueOnce(false)
    $('download').click()
    await vi.waitFor(() => expect(gugu.files.download).toHaveBeenCalledTimes(1))
    expect(gugu.files.download.mock.calls[0][0]).toMatchObject({ id: 'big' })
    await Promise.resolve()
    expect(banner()).toBe('')

    gugu.files.download.mockRejectedValueOnce(new Error('disk full'))
    $('download').click()
    await vi.waitFor(() => expect(banner()).toContain('disk full'))
    contextChanged({ ...context })
    await vi.waitFor(() => expect(app().shown).toBe(null))
  })

  test('an edited document keeps creation and edit times separate in its header, without assigning an editor', async () => {
    const entry = entries[0]
    gugu.files.open.mockResolvedValueOnce({ type: 'binary', entry, close: vi.fn() } as never)
    contextChanged({ ...context, locale: 'en', file: { chat: 'chat-1', id: entry.id } })
    await vi.waitFor(() => expect(app().shown).toBe('plan.md'))
    expect([...$('doc-info').querySelectorAll('.file-activity')].map((line) => line.textContent)).toEqual([
      'Created by 张三 · 1 hour ago', 'Edited · 1 minute ago',
    ])
    contextChanged({ ...context })
    await vi.waitFor(() => expect(app().shown).toBe(null))
  })

  test('upload: the host picker; cancel refreshes quietly, too-large and partial failures are said and the list refreshed', async () => {
    expect($('upload').hidden).toBe(false)
    $('banner').hidden = true
    const lists = gugu.files.list.mock.calls.length
    const opens = gugu.files.open.mock.calls.length
    $('upload').click()
    await vi.waitFor(() => expect(gugu.files.list.mock.calls.length).toBe(lists + 1))
    expect(gugu.files.upload).toHaveBeenLastCalledWith({ chat: 'chat-1' }) // every call names its chat (真源原则 13)
    expect(banner()).toBe('')

    gugu.files.upload.mockRejectedValueOnce(Object.assign(new Error('上限 25 MiB'), { code: 'too-large' }))
    $('upload').click()
    await vi.waitFor(() => expect(banner()).toBe('文件太大：上限 25 MiB'))
    expect(gugu.files.list.mock.calls.length).toBe(lists + 2)

    // One binary file arrives: it is in the list, the page stays on what it showed.
    gugu.files.upload.mockResolvedValueOnce([entries[1]])
    $('upload').click()
    await vi.waitFor(() => expect(gugu.files.list.mock.calls.length).toBe(lists + 3))
    expect(gugu.files.open).toHaveBeenCalledTimes(opens)
  })

  // The preinstalled App ships with its host: every verb is there (审计 C1) — what a person may do is the capability.
  test('read-only has no upload and no new file, and still "Open with" on every file', async () => {
    contextChanged({ ...context, capabilities: ['files:read'] })
    await vi.waitFor(() => expect($('new-doc').hidden).toBe(true))
    expect($('upload').hidden).toBe(true)
    // Opening is reading: a read-only member still gets "Open with" on every file — the only item of its ⋯.
    for (const li of app().entries) {
      rowMore(li.getAttribute('data-id')!).click()
      expect(offered()).toEqual(['用别的 App 打开'])
    }
    pressEscape()
    contextChanged({ ...context })
    await vi.waitFor(() => expect($('new-doc').hidden).toBe(false))
    rowMore('cfg').click()
    expect(offered()).toEqual(['用别的 App 打开', '改名', '移动到…', '删除'])
    pressEscape()
    // owner 10-18: delete is offered only where the folder says this person may (entry.canDelete) — 'old' does not say so.
    rowMore('old').click()
    expect(offered()).toEqual(['用别的 App 打开', '改名', '移动到…'])
    pressEscape()
  })
})

// 摩擦单 F2(L5,09-29;真源 §2.6 617e20ea):工作区 App 是文件管理器 —— 点文件交给宿主挑 App(Finder 双击),
// 「用别的 App 打开」是右键那一下;挑中的恰好是这个 App 时,宿主把文件经 context.file 递回来,这里才打开。
describe('workspace App as a file manager: the host picks the App', () => {
  test('an unclaimed binary click is handed to the host, without a duplicate details page', async () => {
    gugu.files.openWith.mockClear()
    clickFile('photo')
    await vi.waitFor(() => expect(gugu.files.openWith).toHaveBeenCalledTimes(1))
    expect(gugu.files.openWith).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'photo' }))
    expect(app().shown).toBe(null)
    expect(document.body.classList.contains('show-doc')).toBe(false)
  })

  test('a click hands the file to the host and opens nothing here', async () => {
    gugu.files.openWith.mockClear()
    gugu.files.open.mockClear()
    clickFile('plan')
    await vi.waitFor(() => expect(gugu.files.openWith).toHaveBeenCalledTimes(1))
    expect(gugu.files.openWith.mock.calls[0]).toEqual([expect.objectContaining({ id: 'plan' })]) // no ask: the host decides
    await Promise.resolve()
    expect(gugu.files.open, '对照:以前这一下是自己用编辑器打开').not.toHaveBeenCalled()
    expect(app().shown).toBe(null)
  })

  test('every file offers "Open with" in its ⋯: the host\'s picker, asked for; choosing it closes the menu', async () => {
    gugu.files.openWith.mockClear()
    const more = rowMore('cfg')
    expect(more.getAttribute('aria-label')).toBe('更多')
    more.click()
    expect($('menu').hidden).toBe(false)
    expect(more.getAttribute('aria-expanded'), 'its ⋯ stays drawn while the menu is open').toBe('true')
    expect(document.activeElement, 'the keyboard is on the first item').toBe(menuItem('用别的 App 打开'))
    menuItem('用别的 App 打开').click()
    expect($('menu').hidden).toBe(true)
    expect(more.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement, 'and back on the ⋯').toBe(more)
    await vi.waitFor(() => expect(gugu.files.openWith).toHaveBeenCalledTimes(1))
    expect(gugu.files.openWith.mock.calls[0]).toEqual([expect.objectContaining({ id: 'cfg' }), { ask: true }])
  })

  test('rename from the ⋯ turns the row into its full name to edit; delete asks once more, and closing the menu takes that back', async () => {
    rowMore('cfg').click()
    menuItem('改名').click()
    expect($('menu').hidden).toBe(true)
    const input = document.querySelector('[data-id="cfg"] .rename-input') as HTMLInputElement
    expect(input.value).toBe('cfg.json')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await vi.waitFor(() => expect(document.querySelector('[data-id="cfg"] .rename-input')).toBe(null))

    rowMore('cfg').click()
    menuItem('删除').click()
    expect($('menu').hidden, 'the menu stays open for the question').toBe(false)
    expect(offered()).toEqual(['用别的 App 打开', '改名', '移动到…', '确认删除'])
    $('filter').dispatchEvent(new Event('pointerdown', { bubbles: true })) // a press elsewhere
    expect($('menu').hidden).toBe(true)
    expect(gugu.files.remove).not.toHaveBeenCalled()
    rowMore('cfg').click()
    expect(offered(), 'the question is taken back').toEqual(['用别的 App 打开', '改名', '移动到…', '删除'])
    menuItem('删除').click()
    menuItem('确认删除').click()
    expect($('menu').hidden).toBe(true)
    await vi.waitFor(() => expect(gugu.files.remove).toHaveBeenCalledWith(expect.objectContaining({ id: 'cfg' })))
  })

  test('the file the host hands back is opened here; its Back is the host\'s; going back closes it', async () => {
    gugu.files.open.mockClear()
    contextChanged({ ...context, file: { chat: 'chat-1', id: 'plan' } })
    await vi.waitFor(() => expect(gugu.files.open).toHaveBeenCalledTimes(1))
    expect(gugu.files.open).toHaveBeenLastCalledWith({ chat: 'chat-1', id: 'plan' }) // the handed file: ctx.file
    expect(document.body.classList.contains('host-opened')).toBe(true)
    contextChanged({ ...context }) // the host's Back
    await vi.waitFor(() => expect(document.body.classList.contains('host-opened')).toBe(false))
    expect(document.body.classList.contains('show-doc')).toBe(false)
    expect(app().shown).toBe(null)
  })

  // 复核 10-15: a file the host hands this App (it claims .json) but that is stored as a file (a .json over a document's size):
  // the panel says nothing — the file is opened, by this App — so the page says why it only offers the download.
  test('a file handed here that this App cannot show (a stored .json): it says itself that it can only be downloaded', async () => {
    const big = { ...entries[2]!, id: 'big', name: 'big.json', displayName: 'big.json', type: 'binary', size: 9_000_000 }
    gugu.files.open.mockResolvedValueOnce({ type: 'binary', entry: big, close: vi.fn() } as never)
    contextChanged({ ...context, file: { chat: 'chat-1', id: 'big' } })
    await until('the stored .json is the file shown', () => app().shown, (shown) => shown === 'big.json')
    expect($('doc-message').hidden).toBe(false)
    expect($('doc-message').textContent).toBe('这个文件在这里只能下载，不能在这里看和改。')
    contextChanged({ ...context }) // the host's Back: the file's page goes
    await until('Back took the file page away', () => !document.body.classList.contains('show-doc'))
  })

  // 摩擦单 F39(L5,味道):人看到的是「周五聚餐吃什么.dinner-vote.json」。宿主给出 displayName 和认领它的 App,
  // App 只管显示:列表写去掉认领后缀的名字、带那个 App 给这类文件声明的图标(owner 10-17);完整名字悬停可见。App 自己不读后缀。
  test('a file an App claims shows as people call it — the icon the App declared for it, no claim suffix; the full name on hover and in search', () => {
    const claimed = {
      ...entries[2], id: 'vote', name: '周五聚餐吃什么.dinner-vote.json', suffix: '.dinner-vote.json',
      displayName: '周五聚餐吃什么', claimedBy: { id: 'dinner-vote', name: 'Dinner vote', icon: 'data:image/png;base64,dm90ZQ==' },
    }
    const [place, changed] = gugu.files.onChanged.mock.calls.at(-1) as unknown as [unknown, (change: unknown) => void]
    expect(place).toEqual({ chat: 'chat-1' })
    // The chat says which file came, as it is (#7257): taken into the list as it stands — at once, the list not read again.
    const reads = gugu.files.list.mock.calls.length
    changed({ kind: 'entries', entries: [claimed], gone: [] })
    expect(document.querySelector('[data-id="vote"]')).not.toBe(null)
    expect(gugu.files.list.mock.calls.length).toBe(reads)
    const row = document.querySelector('[data-id="vote"] .file-open') as HTMLButtonElement
    expect(row.querySelector('.file-name')!.textContent).toBe('周五聚餐吃什么')
    const mark = row.querySelector('.file-mark') as HTMLImageElement
    expect(mark.tagName).toBe('IMG')
    expect(mark.src).toBe('data:image/png;base64,dm90ZQ==')
    expect(mark.alt).toBe('Dinner vote')
    expect(mark.title).toBe('Dinner vote')
    expect(row.title).toBe('周五聚餐吃什么.dinner-vote.json')
    // 对照:没有认领的文件(旧宿主没有这两个字段)照原名显示,画按种类的通用字形。
    const plain = document.querySelector('[data-id="plan"] .file-open') as HTMLButtonElement
    expect(plain.querySelector('.file-name')!.textContent).toBe('plan.md')
    expect(plain.querySelector('.file-mark')!.getAttribute('name')).toBe('file-text')
    expect(document.querySelector('[data-id="photo"] .file-mark')!.getAttribute('name')).toBe('file-image')
  })

  // owner 10-17:群文件夹里的 markdown 画成文件夹 App 的图标太怪。认领它的 App 没给这类文件声明图标(icon: null)时,
  // 画通用文件字形,❌ 退回 App 自己的图标或首字。
  test('a claimed file whose App declared no icon for its kind: the generic file glyph, not the App\'s mark', () => {
    const [, changed] = gugu.files.onChanged.mock.calls.at(-1) as unknown as [unknown, (change: unknown) => void]
    changed({ kind: 'entries', entries: [{ ...entries[2], id: 'bare', claimedBy: { id: 'workspace', name: '文件夹', icon: null } }], gone: [] })
    const mark = document.querySelector('[data-id="bare"] .file-mark') as HTMLElement
    expect(mark.tagName).toBe('GUGU-ICON')
    expect(mark.getAttribute('name')).toBe('file-text')
    expect(mark.textContent).toBe('')
    expect(mark.title).toBe('文件夹')
  })

  // #7257: what the chat says of its files is merged into the list — a file renamed elsewhere shows its new name, one
  // deleted goes — and the list is never read again for it.
  test('a file renamed or deleted elsewhere: the list takes it in as the chat says, without reading the list', () => {
    const [, changed] = gugu.files.onChanged.mock.calls.at(-1) as unknown as [unknown, (change: unknown) => void]
    const reads = gugu.files.list.mock.calls.length
    const plan = entries.find((entry) => entry.id === 'plan')!
    changed({ kind: 'entries', entries: [{ ...plan, name: 'plan-v2.md', displayName: 'plan-v2.md' }], gone: ['vote'] })
    expect(document.querySelector('[data-id="vote"]')).toBe(null)
    expect(document.querySelector('[data-id="plan"] .file-name')!.textContent).toBe('plan-v2.md')
    expect(gugu.files.list.mock.calls.length).toBe(reads)
  })
})
