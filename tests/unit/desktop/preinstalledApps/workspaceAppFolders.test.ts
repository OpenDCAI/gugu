// @vitest-environment jsdom
// 群文件夹 App 的子文件夹(gugu-supabase 20261016012659):
// 文件夹在前,点进去、面包屑与「上一级」回来;最上层里「附件」不是一行,它里面的文件和最上层的文件列在一起(owner 10-28);新建文件夹在当前文件夹里、建完就改名;
// 「移动到…」列出能去的文件夹(不含自己和自己里面的、现在的位置不可选);上传进当前文件夹,撞了名问「两个都留 / 替换原来的」;
// 「附件」还是能移进去的文件夹;删文件夹先说里面有几项。页面跑在假的 window.gugu 上 —— 判的是 App 怎么用宿主动词、怎么画。
// 父提交上没有文件夹:这里每一格都红。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { until } from '../../../support/awaitCondition'

// Every entry shares one fixed clock: creation order must not become a newer timestamp across a millisecond boundary.
const ago = (seconds: number) => new Date(Date.parse('2026-10-28T12:00:00Z') - seconds * 1000).toISOString()
type Entry = { id: string; name: string; displayName: string; type: string; contentType: string; parentId: string | null; path: string; systemRole: string | null; version: number; createdBy: { id: string; name: string; kind: string }; createdAt: string; updatedAt: string; sourceMessageIds: string[]; canDelete: boolean }
const me = { id: 'u1', name: '张三', kind: 'human' }
const entry = (id: string, name: string, type: string, parentId: string | null, path: string, more: Partial<Entry> = {}): Entry => ({
  id, name, displayName: name, type, contentType: type === 'folder' ? 'inode/directory' : type === 'binary' ? 'image/png' : 'text/markdown',
  parentId, path, systemRole: null, version: 1, createdBy: me, createdAt: ago(600), updatedAt: ago(60), sourceMessageIds: [], canDelete: true, ...more,
})
const ENTRIES: Entry[] = []
const reset = () => {
  // The recent sort uses updatedAt. Seed one clock for the whole fixture: a
  // millisecond boundary between constructors must not reorder the next case.
  const times = { createdAt: ago(600), updatedAt: ago(60) }
  ENTRIES.splice(0, ENTRIES.length,
    // 「附件」 is shown by its role, whatever its row says (a stored name here that is not the shown one, so it tells).
    entry('att', 'attachments-store', 'folder', null, 'attachments-store', { systemRole: 'attachments', createdBy: { id: '', name: '', kind: 'system' } }),
    entry('contracts', '合同', 'folder', null, '合同'),
    entry('y2026', '2026', 'folder', 'contracts', '合同/2026'),
    entry('deal', '甲方.pdf', 'binary', 'y2026', '合同/2026/甲方.pdf'),
    // A change a little newer than shot.png's: the order between them is not left to the milliseconds the rig takes.
    entry('notes', 'notes.md', 'text', null, 'notes.md', { updatedAt: ago(50) }),
    entry('shot', 'shot.png', 'binary', 'att', 'attachments-store/shot.png'))
  for (const item of ENTRIES) Object.assign(item, times)
}

const context = { chat: { id: 'chat-1', name: 'G', kind: 'group', groupId: 'chat-1' }, locale: 'zh-CN', capabilities: ['files:read', 'files:write'] }
const coded = (code: string, message: string) => Object.assign(new Error(message), { code })

const gugu = {
  linkTo: vi.fn(async ({ file }: { file: { id: string } }) => `gugu-file://${file.id}`),
  setTabTitle: vi.fn(async () => {}),
  getContext: vi.fn(async () => context),
  onContextChanged: vi.fn(() => () => {}),
  openBrowserTab: vi.fn(async () => {}),
  onLink: vi.fn(() => () => {}),
  showMessage: vi.fn(async () => {}),
  files: {
    // Asked as a row's menu opens (a list carries no delete answer); the rig answers from its fixtures.
    canDelete: vi.fn(async (files: unknown) => [files].flat().map((file) => (file as { canDelete?: boolean }).canDelete === true)),
    viewPreferences: vi.fn(async () => ({ showAppData: false })),
    list: vi.fn(async () => ENTRIES.map((e) => ({ ...e }))),
    onChanged: vi.fn(() => () => {}),
    open: vi.fn(async (e: Entry) => ({ entry: e, type: 'binary', blob: async () => new Blob([new Uint8Array([7])]), close: () => {} })),
    create: vi.fn(),
    remove: vi.fn(async (e: Entry) => void ENTRIES.splice(ENTRIES.findIndex((x) => x.id === e.id), 1)),
    rename: vi.fn(async (e: Entry, name: string) => ({ ...e, name })),
    replace: vi.fn(async (e: Entry) => ({ ...e, version: e.version + 1 })),
    mkdir: vi.fn(async ({ path }: { path: string }) => {
      const parts = path.split('/')
      const parent = ENTRIES.find((e) => e.type === 'folder' && e.path === parts.slice(0, -1).join('/'))
      const made = entry(`new-${ENTRIES.length}`, parts.at(-1)!, 'folder', parent?.id ?? null, path)
      ENTRIES.push(made)
      return made
    }),
    move: vi.fn(async (e: Entry, to: { folder: string }) => {
      if (to.folder === 'contracts' && e.name === 'notes.md' && ENTRIES.some((x) => x.parentId === 'contracts' && x.name === 'notes.md')) {
        throw coded('name-taken', 'workspace_name_taken: notes.md already exists in this folder')
      }
      const row = ENTRIES.find((x) => x.id === e.id)!
      row.parentId = to.folder || null
      return { ...row }
    }),
    openWith: vi.fn(async () => {}),
    upload: vi.fn(async (): Promise<Entry[]> => []),
    download: vi.fn(async () => true),
  },
}

const $ = (id: string) => document.getElementById(id) as HTMLElement
const names = () => [...$('file-list').querySelectorAll('.file .file-name')].map((n) => n.textContent)
const row = (id: string) => document.querySelector(`[data-id="${id}"]`) as HTMLElement
const open = (id: string) => (row(id).querySelector('.file-open') as HTMLButtonElement).click()
const more = (id: string) => ({ click: () => row(id).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
const menuItem = (text: string) => [...$('menu').querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === text)!
const crumbs = () => ($('crumbs').hidden ? null : [...$('crumbs').querySelectorAll('.crumb')].map((c) => c.textContent))
// What the page says, where a person can see it: with the App's own style.css applied (a style element while a test
// reads it), a line counts only when neither it nor anything it is in is hidden or not drawn — the list page does not draw
// the file's pane (F32), so a line in there says nothing to a person on the list.
const drawn = (el: Element | null) => {
  for (let at = el; at && at !== document.documentElement; at = at.parentElement) {
    if ((at as HTMLElement).hidden || getComputedStyle(at).display === 'none') return false
  }
  return el !== null
}
const said = () => [...document.querySelectorAll('.banner')].filter(drawn).map((b) => b.textContent)
const STYLE = readFileSync(resolve(process.cwd(), 'apps/desktop/preinstalled-apps/workspace/style.css'), 'utf8')
const styled = () => document.head.appendChild(Object.assign(document.createElement('style'), { textContent: STYLE }))
// What a case waits for (until has no deadline, and this project gives a case none — @@@no-case-budget): only the end of
// what was done — a call made, the upload's button back, the list read again. Never an exact value: the value is held
// with expect once the step has ended, so a wrong one is red there and then; only a step that never ends waits.
/** The upload's own end: its button is back once the files are in the list and anything to ask is asked. */
const uploaded = () => until('the upload done', () => !($('upload') as HTMLButtonElement).disabled)
/** The App reads the list again (a read replaces all it held): through the upload's door, the refresh with an end to wait for. */
const refreshed = async () => {
  $('upload').click()
  await uploaded()
}
/** After something done that reads the list again when it is over (a move, a rename): that read, drawn once it is back. */
const readAgain = (after: number) => until('the list read again', () => gugu.files.list.mock.calls.length > after)
/** Entering a folder (a row, a crumb, 上一级) and the filter draw there and then: nothing to wait for. */
const goTop = () => {
  if (!$('crumbs').hidden) ($('crumbs').querySelector('.crumb') as HTMLButtonElement).click()
  expect($('crumbs').hidden, 'back at the top').toBe(true)
}

beforeAll(async () => {
  reset()
  const html = readFileSync(resolve(process.cwd(), 'apps/desktop/preinstalled-apps/workspace/index.html'), 'utf8')
  const page = new DOMParser().parseFromString(html, 'text/html')
  document.body.innerHTML = page.body.innerHTML
  for (const attr of Array.from(page.body.attributes)) document.body.setAttribute(attr.name, attr.value)
  Object.assign(globalThis, { gugu, CSS: { escape: (s: string) => s } })
  Object.assign(window, { gugu })
  // @ts-expect-error — 内置 App 是不经构建的纯 ES module,没有类型;运行时 import 可用。
  await import('../../../../apps/desktop/preinstalled-apps/workspace/app.js')
  await until('the list drawn', () => names().length > 0)
})

beforeEach(async () => {
  // Each case starts from the same list, shared with no case before it: nothing focused (a name field left open by a red
  // case holds the list — it is not drawn while a name is typed), no filter, and the list read again by the App itself
  // from the entries as they start — so what a red case left in it (an upload, a folder it made) is not there.
  (document.activeElement as HTMLElement | null)?.blur?.()
  reset()
  gugu.files.upload.mockReset().mockImplementation(async () => [])
  ;($('filter') as HTMLInputElement).value = ''
  $('filter').dispatchEvent(new Event('input'))
  await refreshed()
  for (const banner of document.querySelectorAll<HTMLElement>('.banner')) banner.hidden = true
  $('conflicts').hidden = true
  goTop()
  expect(names(), 'each case starts from the same list').toEqual(['合同', 'notes.md', 'shot.png'])
})

describe('the folder on screen', () => {
  test.each(['refresh', 'event'])('equal timestamps keep name order after an unchanged %s', async (change) => {
    ENTRIES.find((e) => e.id === 'notes')!.updatedAt = ago(60)
    ENTRIES.push(entry('other', 'other.md', 'text', null, 'other.md'))
    await refreshed()
    expect(names()).toEqual(['合同', 'notes.md', 'other.md', 'shot.png'])
    if (change === 'refresh') {
      ENTRIES.reverse()
      await refreshed()
    } else {
      const [, changed] = gugu.files.onChanged.mock.calls.at(-1) as unknown as [unknown, (change: unknown) => void]
      changed({ kind: 'entries', entries: [{ ...ENTRIES.find((e) => e.id === 'notes')! }], gone: [] })
    }
    expect(names()).toEqual(['合同', 'notes.md', 'other.md', 'shot.png'])
  })

  test('same-name folders from different paths keep id order in search after refresh and events', async () => {
    ENTRIES.push(entry('z-folder', 'shared', 'folder', 'contracts', '合同/shared'))
    ENTRIES.push(entry('a-folder', 'shared', 'folder', 'y2026', '合同/2026/shared'))
    await refreshed()
    ;($('filter') as HTMLInputElement).value = 'shared'
    $('filter').dispatchEvent(new Event('input'))
    const ids = () => [...$('file-list').querySelectorAll<HTMLElement>('.file')].map((e) => e.dataset.id)
    expect(ids()).toEqual(['a-folder', 'z-folder'])
    ENTRIES.reverse()
    await refreshed()
    expect(ids()).toEqual(['a-folder', 'z-folder'])
    const [, changed] = gugu.files.onChanged.mock.calls.at(-1) as unknown as [unknown, (change: unknown) => void]
    changed({ kind: 'entries', entries: [{ ...ENTRIES.find((e) => e.id === 'a-folder')! }], gone: [] })
    expect(ids()).toEqual(['a-folder', 'z-folder'])
  })

  // owner 10-28: what was sent in the chat is not one folder further down — 「附件」's files are at the top with the rest.
  test('the top: folders first, then the files there and in 「附件」 (no 「附件」 row); inside a folder only what is in it', async () => {
    expect(names()).toEqual(['合同', 'notes.md', 'shot.png'])
    expect(row('att'), '「附件」 is not a row at the top').toBe(null)
    expect(row('shot').querySelector('.file-path'), 'nor said of its files').toBe(null)
    expect(row('contracts').querySelector('.file-meta')!.textContent).toContain('1 项')
    open('contracts')
    expect(names()).toEqual(['2026'])
    expect(crumbs()).toEqual(['群文件夹', '合同'])
    open('y2026')
    expect(names()).toEqual(['甲方.pdf'])
    expect(crumbs()).toEqual(['群文件夹', '合同', '2026'])
    // Up goes one level; the crumb of the top goes to the top.
    ;($('crumbs').querySelector('.back') as HTMLButtonElement).click()
    expect(names()).toEqual(['2026'])
    goTop()
    expect(names()).toEqual(['合同', 'notes.md', 'shot.png'])
  })

  test('filtering searches every folder, each match saying the folder it is in', async () => {
    $('filter').setAttribute('value', '甲方')
    ;($('filter') as HTMLInputElement).value = '甲方'
    $('filter').dispatchEvent(new Event('input'))
    expect(names()).toEqual(['甲方.pdf'])
    expect(row('deal').querySelector('.file-path')!.textContent).toBe('合同/2026')
    ;($('filter') as HTMLInputElement).value = ''
    $('filter').dispatchEvent(new Event('input'))
  })
})

describe('making, moving, uploading, deleting', () => {
  test('新建文件夹 makes one in the folder on screen, with a name not taken there, and opens its name to edit', async () => {
    open('contracts')
    expect(names()).toEqual(['2026'])
    gugu.files.mkdir.mockClear()
    $('new-doc').click()
    menuItem('新建文件夹').click()
    await until('files.mkdir asked', () => gugu.files.mkdir.mock.calls.length > 0)
    expect(gugu.files.mkdir.mock.calls).toEqual([[{ chat: 'chat-1', path: '合同/新建文件夹' }]])
    await until('the name field', () => document.querySelector('.rename-input') !== null)
    expect((document.querySelector('.rename-input') as HTMLInputElement).value).toBe('新建文件夹')
    document.querySelector('.rename-input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  })

  test('「移动到…」 lists where it can go — not itself or what is in it; where it is now cannot be picked — and moves it there', async () => {
    more('contracts')!.click()
    menuItem('移动到…').click()
    expect($('move-dialog').hidden).toBe(false)
    expect($('move-title').textContent).toBe('把「合同」移到')
    const targets = [...$('move-targets').querySelectorAll<HTMLButtonElement>('.move-target')]
    expect(targets.map((t) => t.textContent)).toEqual(['群文件夹（现在在这里）', '附件'])
    expect(targets[0]!.disabled).toBe(true)
    $('move-cancel').click()
    expect($('move-dialog').hidden).toBe(true)

    gugu.files.move.mockClear()
    more('notes')!.click()
    menuItem('移动到…').click()
    const into = [...$('move-targets').querySelectorAll<HTMLButtonElement>('.move-target')].find((t) => t.textContent === '2026')!
    const listed = gugu.files.list.mock.calls.length
    into.click()
    await readAgain(listed)
    expect(gugu.files.move.mock.calls).toEqual([[expect.objectContaining({ id: 'notes' }), { folder: 'y2026' }]])
    expect(names()).toEqual(['合同', 'shot.png'])
  })

  test('a move to a folder that has the name says so', async () => {
    ENTRIES.push(entry('dup', 'notes.md', 'text', 'contracts', '合同/notes.md'))
    await refreshed() // the list now has the second notes.md
    more('notes')!.click()
    menuItem('移动到…').click()
    const css = styled()
    try {
      const listed = gugu.files.list.mock.calls.length
      ;[...$('move-targets').querySelectorAll<HTMLButtonElement>('.move-target')].find((t) => t.textContent === '合同')!.click()
      await readAgain(listed)
      expect(said()).toEqual(['这个文件夹里已经有「notes.md」了'])
    } finally {
      css.remove()
    }
  })

  test('a name taken on rename is said on the list, where the person is; the next thing done there takes it back', async () => {
    const css = styled()
    try {
      expect(said(), 'the instrument: nothing said yet').toEqual([])
      gugu.files.rename.mockRejectedValueOnce(coded('name-taken', '这个文件夹里已经有「合同」了'))
      more('notes')!.click()
      menuItem('改名').click()
      const input = document.querySelector('.rename-input') as HTMLInputElement
      input.value = '合同'
      const listed = gugu.files.list.mock.calls.length
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
      await readAgain(listed)
      expect(said()).toEqual(['这个文件夹里已经有「合同」了'])
      // The control the instrument needs: the same line in the file's pane is not seen on the list page.
      $('banner').hidden = false
      $('banner').textContent = 'in the file pane'
      expect(said()).toEqual(['这个文件夹里已经有「合同」了'])
      $('banner').hidden = true
      open('contracts')
      expect(names()).toEqual(['2026'])
      expect(said()).toEqual([])
    } finally {
      css.remove()
    }
  })

  test('upload goes into the folder on screen; a name already there is asked about: keep both, or replace the old one', async () => {
    open('contracts')
    open('y2026')
    expect(names()).toEqual(['甲方.pdf'])
    // Picked as 甲方.pdf; the database named it 「甲方 (2).pdf」 (the upload says both).
    const copy = { ...entry('deal2', '甲方 (2).pdf', 'binary', 'y2026', '合同/2026/甲方 (2).pdf'), clashWith: 'deal' }
    gugu.files.upload.mockImplementationOnce(async () => {
      ENTRIES.push(copy)
      return [copy]
    })
    $('upload').click()
    await uploaded()
    // The question is up by the upload's end (asked as the files come in, never later).
    expect($('conflicts').hidden).toBe(false)
    expect(gugu.files.upload.mock.calls.at(-1)).toEqual([{ chat: 'chat-1', folder: 'y2026' }])
    expect($('conflict-list').textContent).toContain('「甲方.pdf」已经有了，新传的这份叫「甲方 (2).pdf」。')
    const buttons = [...$('conflict-list').querySelectorAll('button')].map((b) => b.textContent)
    expect(buttons).toEqual(['两个都留', '替换原来的'])
    ;[...$('conflict-list').querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '替换原来的')!.click()
    await until('deal2 removed', () => gugu.files.remove.mock.calls.some(([e]) => (e as { id?: string } | undefined)?.id === 'deal2'))
    expect(gugu.files.replace).toHaveBeenCalledWith(expect.objectContaining({ id: 'deal' }), expect.any(Blob), { expectedVersion: 1 })
    expect($('conflicts').hidden).toBe(true)
  })

  test('a file picked as 「甲方 (2).pdf」 next to 甲方.pdf is just that: nothing is asked, nothing replaced', async () => {
    open('contracts')
    open('y2026')
    expect(names()).toEqual(['甲方.pdf'])
    const picked = { ...entry('deal2', '甲方 (2).pdf', 'binary', 'y2026', '合同/2026/甲方 (2).pdf'), clashWith: null }
    gugu.files.upload.mockImplementationOnce(async () => {
      ENTRIES.push(picked)
      return [picked]
    })
    gugu.files.replace.mockClear()
    $('upload').click()
    await uploaded()
    // Both kept, side by side (same change time here: the order between them is not what this reads).
    expect([...names()].sort()).toEqual(['甲方 (2).pdf', '甲方.pdf'])
    expect($('conflicts').hidden).toBe(true)
    expect(gugu.files.replace).not.toHaveBeenCalled()
  })

  test('an empty subfolder says so of itself, not of the whole group folder', async () => {
    ENTRIES.push(entry('void', '空的', 'folder', null, '空的'))
    await refreshed() // the list now has the empty folder
    open('void')
    expect(crumbs()).toEqual(['群文件夹', '空的'])
    expect($('files-empty').hidden).toBe(false)
    expect($('files-empty-message').textContent).toBe('这个文件夹还是空的。')
  })

  test('a new folder\'s name field stays while a change is heard, and the folder is made where the list says it is now', async () => {
    open('contracts')
    expect(names()).toEqual(['2026'])
    open('y2026')
    expect(names()).toEqual(['甲方.pdf'])
    // Elsewhere, 合同 is renamed 协议: only its own entry is heard — what is in it still carries its old path.
    const heard = (gugu.files.onChanged.mock.calls.at(-1) as unknown as [unknown, (change: unknown) => void])[1]
    const renamedParent = { ...ENTRIES.find((e) => e.id === 'contracts')!, name: '协议', displayName: '协议', path: '协议' }
    // The folder as it is now (what the next list reads): 协议, and what is in it under 协议/.
    for (const e of ENTRIES) {
      if (e.id === 'contracts') Object.assign(e, { name: '协议', displayName: '协议', path: '协议' })
      else if (e.path.startsWith('合同/')) e.path = `协议/${e.path.slice(3)}`
    }
    heard({ kind: 'entries', entries: [renamedParent], gone: [] })
    gugu.files.mkdir.mockClear()
    $('new-doc').click()
    menuItem('新建文件夹').click()
    await until('files.mkdir asked', () => gugu.files.mkdir.mock.calls.length > 0)
    expect(gugu.files.mkdir.mock.calls).toEqual([[{ chat: 'chat-1', path: '协议/2026/新建文件夹' }]])
    await until('the name field', () => document.querySelector('.rename-input') !== null)
    const input = document.querySelector('.rename-input') as HTMLInputElement
    input.focus()
    // The folder's own change arrives while the name is being typed: the field is not drawn away.
    heard({ kind: 'entries', entries: [renamedParent], gone: [] })
    expect(document.querySelector('.rename-input')).toBe(input)
    // Dragging in the field selects text: the row is not draggable meanwhile.
    expect((input.closest('li') as HTMLElement).draggable).toBe(false)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await until('the name field gone', () => document.querySelector('.rename-input') === null)
  })

  test('deleting a folder asks once more, saying how much is in it', async () => {
    more('contracts')!.click()
    menuItem('删除').click()
    expect(menuItem('删除它和里面的 2 项')).toBeTruthy()
    menuItem('删除它和里面的 2 项').click()
    await until('contracts removed', () => gugu.files.remove.mock.calls.some(([e]) => (e as { id?: string } | undefined)?.id === 'contracts'))
  })
})


describe('workspace file resource drag', () => {
  test('exports the host URL from a read-only file, after it is ready, without permitting a folder move', async () => {
    let finish!: (link: string) => void
    gugu.linkTo.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve }))
    const filter = $('filter') as HTMLInputElement
    const capabilities = context.capabilities
    context.capabilities = ['files:read']
    try {
      filter.value = 'notes'
      filter.dispatchEvent(new Event('input', { bubbles: true }))
      expect(row('notes').draggable).toBe(false)
      const link = 'gugu-file://123e4567-e89b-42d3-a456-426614174000'
      finish(link)
      await until('the resource link is ready to drag', () => row('notes').draggable)
      expect(gugu.linkTo).toHaveBeenLastCalledWith({ kind: 'file', file: expect.objectContaining({ id: 'notes' }) })
      const values = new Map<string, string>()
      const start = new Event('dragstart', { bubbles: true })
      Object.defineProperty(start, 'dataTransfer', { value: { setData: (type: string, value: string) => values.set(type, value) } })
      row('notes').dispatchEvent(start)
      expect(Object.fromEntries(values)).toEqual({ 'text/plain': link, 'text/uri-list': link })
      gugu.files.move.mockClear()
      $('file-list').dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }))
      expect(gugu.files.move).not.toHaveBeenCalled()
      row('notes').dispatchEvent(new Event('dragend', { bubbles: true }))
    } finally {
      context.capabilities = capabilities
      filter.value = ''
      filter.dispatchEvent(new Event('input', { bubbles: true }))
    }
  })
})
