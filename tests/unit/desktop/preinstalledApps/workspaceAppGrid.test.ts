// @vitest-environment jsdom
// 群文件夹的第二步(owner 10-28 定稿):图片和视频默认是网格(每个类型各记各的列表 / 网格);筛选 chip(上传者 / 存放 /
// 保留方式,只在有得选时出现,可以叠加、一键清除);⋯ › 详情(大小、谁传的、在哪、存在哪台机器、保留到哪天、各个版本);
// 存在离线机器上的文件变淡,点它说「上线后才能打开」而不去开;宽的时候是表格,表头能排序。页面跑在假的 window.gugu 上。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { until } from '../../../support/awaitCondition'

const now = Date.parse('2026-10-28T12:00:00Z')
const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString()
const DAY = 86400
const zhang = { id: 'u1', name: '张三', kind: 'human' }
const yu = { id: 'u2', name: '小雨', kind: 'human' }
const file = (id: string, name: string, contentType: string, size: number, at: string, more: Record<string, unknown> = {}) => ({
  id, name, displayName: name, suffix: name.slice(name.lastIndexOf('.')), contentType, type: /^text\/|json/.test(contentType) ? 'text' : 'binary', size,
  parentId: null, path: name, systemRole: null, version: 1, createdAt: at, updatedAt: at, createdBy: zhang, sourceMessageIds: [], canDelete: true, ...more,
})
const ENTRIES = [
  file('spec', 'spec.pdf', 'application/pdf', 1_200_000, ago(600), { keep: { expiresAt: new Date(now + 3 * DAY * 1000).toISOString(), mine: true }, sourceMessageIds: ['m1'], version: 2, updatedAt: ago(300), updatedBy: yu }),
  file('shot', 'shot.png', 'image/png', 3_000, ago(1200), { keep: { expiresAt: null, mine: true } }),
  file('clip', 'clip.mp4', 'video/mp4', 300_000, ago(DAY + 60), { createdBy: yu, keep: { expiresAt: null, mine: false } }),
  // On a machine that is off, but with a temporary cloud copy (a project chat's image): it still opens.
  file('poster', 'poster.png', 'image/png', 5_000, ago(2 * DAY), { storedOn: { machine: 'GF server', owner: '张三', mine: true, online: false }, keep: { expiresAt: new Date(now + 5 * DAY * 1000).toISOString(), mine: true } }),
  file('ckpt', 'ckpt.tgz', 'application/gzip', 2_000_000, ago(3 * DAY), { storedOn: { machine: 'GF server', owner: '张三', mine: true, online: false }, keep: null }),
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
    download: vi.fn(async () => true),
    keep: vi.fn(async () => {}),
    versions: vi.fn(async () => [{ n: 2, by: yu, at: ago(300), size: 1_200_000 }, { n: 1, by: zhang, at: ago(600), size: 1_100_000 }]),
  },
}

const $ = (id: string) => document.getElementById(id) as HTMLElement
const ids = () => [...$('file-list').querySelectorAll<HTMLElement>('li.file')].map((li) => li.dataset.id)
const cells = () => [...$('file-list').querySelectorAll<HTMLElement>('li.file.cell')].map((li) => li.dataset.id)
const row = (id: string) => document.querySelector(`[data-id="${id}"]`) as HTMLElement
const kind = (name: string) => $('kinds').querySelector<HTMLButtonElement>(`[data-kind="${name}"]`)!
const view = (name: string) => $('views').querySelector<HTMLButtonElement>(`[data-view="${name}"]`)!
const chip = (name: string) => $('chips').querySelector<HTMLButtonElement>(`[data-filter="${name}"]`)
const item = (text: string) => [...$('menu').querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)!
const pressEscape = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
const facts = () => Object.fromEntries([...$('details').querySelectorAll('dt')].map((dt) => [dt.textContent, dt.nextElementSibling!.textContent]))
const banner = () => [$('banner'), $('list-banner')].filter((node) => !node.hidden).map((node) => node.textContent).join('')

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
  await until('the list drawn', () => ids().length > 0)
})

afterAll(() => vi.restoreAllMocks())

beforeEach(() => {
  pressEscape()
  pressEscape()
  if ($('chips').querySelector('.chips-clear')) $('chips').querySelector<HTMLButtonElement>('.chips-clear')!.click()
  kind('all').click()
})

describe('the grid', () => {
  test('images and videos open as a grid, the rest as a list; each kind keeps its own on this device', () => {
    expect(cells()).toEqual([])
    kind('media').click()
    expect(cells()).toEqual(['shot', 'clip', 'poster'])
    expect(view('grid').getAttribute('aria-pressed')).toBe('true')
    expect(row('clip').querySelector('.cell-play'), 'a video says so on its picture').not.toBe(null)
    view('list').click()
    expect(cells()).toEqual([])
    expect(localStorage.getItem('workspace.view.media')).toBe('list')
    kind('all').click()
    view('grid').click()
    expect(cells()).toEqual(['spec', 'shot', 'clip', 'poster', 'ckpt'])
    view('list').click()
    kind('media').click()
    expect(cells(), 'media still as it was left').toEqual([])
    view('grid').click()
  })
})

describe('filters', () => {
  test('a chip only where there is something to pick by; picking narrows the list, filters add up, one press clears them', () => {
    expect([...$('chips').querySelectorAll('.chip')].map((c) => (c as HTMLElement).dataset.filter)).toEqual(['who', 'where', 'keep'])
    chip('who')!.click()
    expect([...$('menu').querySelectorAll('[role="menuitemradio"]')].map((b) => b.textContent)).toEqual(['全部', '张三', '小雨'])
    item('小雨').click()
    expect(ids()).toEqual(['clip'])
    expect(chip('who')!.textContent).toBe('上传者: 小雨')
    expect(chip('who')!.getAttribute('aria-pressed')).toBe('true')
    chip('who')!.click()
    item('全部').click()
    chip('keep')!.click()
    item('临时').click()
    expect(ids()).toEqual(['spec', 'poster'])
    chip('where')!.click()
    item('GF server').click()
    expect(ids()).toEqual(['poster'])
    chip('who')!.click()
    item('小雨').click()
    expect(ids()).toEqual([])
    expect($('files-empty-message').textContent).toBe('没有符合条件的文件。')
    $('chips').querySelector<HTMLButtonElement>('.chips-clear')!.click()
    expect(ids()).toEqual(['spec', 'shot', 'clip', 'poster', 'ckpt'])
  })

  test('in a kind without the choice, its chip is not there', () => {
    kind('docs').click()
    expect(chip('where'), 'no document of this list stays on a machine').toBe(null)
    expect(chip('who'), 'one uploader: nothing to pick between').toBe(null)
  })
})

describe('details', () => {
  test('⋯ › 详情: the file in full, where it is kept and until when, its versions; Escape closes it', async () => {
    row('spec').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    item('详情').click()
    expect($('details').hidden).toBe(false)
    expect($('details').querySelector('.details-title')!.textContent).toBe('spec.pdf')
    const said = facts()
    expect(said['大小']).toBe('1.1 MB · PDF')
    expect(said['上传']).toMatch(/^张三 · /)
    expect(said['改动']).toMatch(/^小雨 · .* · 第 2 版$/)
    expect(said['位置']).toBe('群文件夹')
    expect(said['保留']).toMatch(/^临时 · .*清除云端副本$/)
    await until('its versions', () => $('details').querySelectorAll('.details-versions li').length === 2)
    expect(gugu.files.versions).toHaveBeenCalledWith(expect.objectContaining({ id: 'spec' }))
    expect([...$('details').querySelectorAll('.details-actions button')].map((b) => b.textContent)).toEqual(['打开', '下载', '在聊天中定位'])
    pressEscape()
    expect($('details').hidden).toBe(true)
  })

  test('a file kept on a machine says which, and whether it is on', () => {
    row('ckpt').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    item('详情').click()
    expect(facts()['存放']).toBe('GF server · 离线')
    expect(facts()['保留']).toBe('没有云端副本')
  })
})

describe('a machine that is off', () => {
  // Whether the machine is on is read when the file is opened, never from the list as it was loaded (native #107: it came
  // back online and the folder kept refusing until reloaded): the host opens it and says why if it cannot, and the list is
  // read again so the mark follows the machine.
  test('its file is faint; a press still hands it to the host and reads the list again', async () => {
    expect(row('ckpt').hasAttribute('data-offline')).toBe(true)
    expect(row('ckpt').querySelector<HTMLElement>('.file-host')!.dataset.online).toBe('false')
    gugu.files.openWith.mockClear()
    const reads = gugu.files.list.mock.calls.length
    row('ckpt').querySelector<HTMLButtonElement>('.file-open')!.click()
    await until('handed to the host', () => gugu.files.openWith.mock.calls.length > 0)
    expect(gugu.files.openWith).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'ckpt' }))
    expect(banner()).not.toContain('离线')
    await until('the list read again', () => gugu.files.list.mock.calls.length > reads)
    gugu.files.openWith.mockClear()
    expect(row('poster').hasAttribute('data-offline'), 'its cloud copy opens meanwhile').toBe(false)
    row('poster').querySelector<HTMLButtonElement>('.file-open')!.click()
    await until('handed to the host', () => gugu.files.openWith.mock.calls.length > 0)
  })
})

describe('the table (a wide pane)', () => {
  test('its head names the columns; the sortable ones sort the list', () => {
    const head = $('file-list').querySelector('.table-head')!
    expect([...head.querySelectorAll('[data-cell]')].map((c) => c.textContent)).toEqual(['名称', '修改时间', '大小'])
    expect(head.querySelector('[role="checkbox"]')?.getAttribute('aria-label')).toBe('全选')
    expect([...row('spec').querySelectorAll<HTMLElement>('.file-cell')].map((c) => c.dataset.cell)).toEqual(['when', 'size'])
    head.querySelector<HTMLButtonElement>('[data-cell="size"]')!.click()
    expect(ids()).toEqual(['ckpt', 'spec', 'clip', 'poster', 'shot'])
    $('file-list').querySelector<HTMLButtonElement>('.table-head [data-cell="when"]')!.click()
    expect(ids()).toEqual(['spec', 'shot', 'clip', 'poster', 'ckpt'])
  })
})
