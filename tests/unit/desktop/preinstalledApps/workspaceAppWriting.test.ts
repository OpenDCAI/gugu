// @vitest-environment jsdom
// Folder documents, Notion/Craft polish (owner 10-30): judged on the real app.js and the real CodeMirror (bound by a
// stand-in that puts the file's text in). A task ticked where it is read ticks its line in the source; the source's
// selection is wrapped in (and out of) a mark; the reading block's + inserts after its source span;
// an empty document says what can be done; front matter is one block in the source, not a setext heading.
// The preview is a stand-in that marks lines as gugu.markdown's `sourceLines` does (judged in markdown-entry.test.ts).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import * as language from '@codemirror/language'
import * as cmState from '@codemirror/state'
import { EditorSelection } from '@codemirror/state'
import * as cmView from '@codemirror/view'
import { EditorView } from '@codemirror/view'
import * as lezerHighlight from '@lezer/highlight'
import { basicSetup } from 'codemirror'
import * as autocomplete from '@codemirror/autocomplete'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { until } from '../../../support/awaitCondition'
// @ts-expect-error — the built-in App's source-edit commands are plain ES modules.
import { isFrontmatter, listInsertion, moveBlock, previewBlock, sourceBlocks, turnBlockChanges } from '../../../../apps/desktop/preinstalled-apps/workspace/blocks.js'

const TEXT = ['# 计划', '', '- [ ] 写完', '- [x] 定了', '', '正文 一句'].join('\n')
const entry = {
  id: 'plan', chat: 'chat-1', name: 'plan.md', displayName: 'plan', contentType: 'text/markdown', type: 'text', size: 9,
  createdAt: null, updatedAt: null, createdBy: null, sourceMessageIds: [],
}
let changed: (event: { local: boolean }) => void = () => {}
const file = {
  entry,
  type: 'text',
  readOnly: false,
  status: 'online',
  saved: true,
  text: TEXT,
  anchor: (at: number) => at,
  resolve: (anchor: number) => anchor,
  onChange: vi.fn((handler: (event: { local: boolean }) => void) => {
    changed = handler
    return () => {}
  }),
  onStatus: vi.fn(() => () => {}),
  close: vi.fn(),
  presence: { self: { userId: 'u2', color: '' }, others: [], onChange: () => () => {}, set: () => {} },
}

// The blocks of TEXT as `sourceLines` marks them; task items carry the dialect's disabled checkbox.
const md = {
  render: vi.fn((element: Element, text: string) => {
    if (!text.trim()) {
      element.innerHTML = '<div class="gg-md"></div>'
      return
    }
    const lines = text.split('\n')
    const task = (n: number) => {
      const done = /\[x\]/i.test(lines[n - 1]!)
      return `<li data-line="${n}-${n}"><input type="checkbox" disabled${done ? ' checked' : ''}> ${lines[n - 1]!.slice(6)}</li>`
    }
    element.innerHTML = `<div class="gg-md"><h1 data-line="1-1">计划</h1><ul data-line="3-4">${task(3)}${task(4)}</ul><p data-line="6-6">${lines[5]}</p></div>`
  }),
}
// The host's menu (showContextMenu): it takes the App's rows and answers with the picked one's id, or null.
type Row = { id: string; label: string; enabled?: boolean; items?: Row[] } | { type: 'separator' }
let shown: { items: Row[]; answer: (id: string | null) => void } | null = null
const rowsOf = (items: Row[] = shown?.items ?? []) => items.filter((row): row is Exclude<Row, { type: 'separator' }> => !('type' in row))
const labels = (items?: Row[]) => rowsOf(items).map((row) => row.label)
const rowNamed = (label: string, items?: Row[]) => rowsOf(items).find((row) => row.label === label)!
const answered = () => new Promise<void>((done) => setTimeout(done, 0))
async function pick(label: string, within?: string) {
  const row = rowNamed(label, within ? rowNamed(within).items : undefined)
  expect(row.items, label).toBeUndefined()
  const open = shown!
  shown = null
  open.answer(row.id)
  await answered()
}
function dismiss() {
  const open = shown
  shown = null
  open?.answer(null)
}
const menuItems = () => [...$('menu').querySelectorAll('button')]
const gugu = {
  showContextMenu: vi.fn(({ items }: { items: Row[] }) => new Promise<string | null>((answer) => { shown?.answer(null); shown = { items, answer } })),
  navigation: { go: vi.fn(async (_delta: number) => true) },
  linkTo: vi.fn(async ({ file, at }: { file: { id: string }; at?: { lines: string } }) => `gugu-file://${file.id}${at ? `#${at.lines}` : ''}`),
  setTabTitle: vi.fn(async () => {}),
  getContext: vi.fn(async () => ({ chat: { id: 'chat-1', name: 'G', kind: 'group', groupId: 'chat-1' }, file: { chat: 'chat-1', id: 'plan' }, locale: 'en', navigation: { canBack: true, canForward: false, backToConversation: true }, capabilities: ['files:read', 'files:write'] })),
  onContextChanged: vi.fn(() => () => {}),
  onLink: vi.fn(() => () => {}),
  dispatch: vi.fn(async (_text: string, _options: unknown) => ({ to: { chat: 'chat-1' } })),
  clipboard: { writeText: vi.fn(async (_text: string) => {}) },
  codemirror: vi.fn(async () => ({ EditorView, EditorState: cmState.EditorState, basicSetup, markdown, markdownLanguage, view: cmView, state: cmState, language, autocomplete, lezerHighlight })),
  markdown: vi.fn(async () => md),
  bind: {
    codemirror: vi.fn((view: EditorView, f: typeof file) => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: f.text } })
      return () => {}
    }),
  },
  files: {
    viewPreferences: vi.fn(async () => ({ showAppData: false })), list: vi.fn(async () => [entry]),
    onChanged: vi.fn(() => () => {}), open: vi.fn(async () => file),
    canDelete: vi.fn(async () => [true]), forward: vi.fn(async () => {}),
    download: vi.fn(async () => true), openWith: vi.fn(async () => {}),
  },
}

const previewPointerHandlers = new Set<EventListenerOrEventListenerObject>()

const $ = (id: string) => document.getElementById(id) as HTMLElement
const view = () => EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!
const line = (n: number) => view().state.doc.line(n)
const select = (from: number, to: number) => view().dispatch({ selection: EditorSelection.single(from, to) })
function hoverBlock(block: Element) {
  vi.spyOn(block, 'getBoundingClientRect').mockReturnValue(new DOMRect(56, 100, 600, 30))
  block.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 80, clientY: 110 }))
}
/** The text changed in the source: the file says so and the preview draws it again. */
async function redraw() {
  file.text = view().state.doc.toString()
  md.render.mockClear()
  changed({ local: false })
  await until('the preview is drawn again', () => md.render.mock.calls.length > 0)
}

beforeAll(async () => {
  Range.prototype.getBoundingClientRect ??= () => new DOMRect()
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList
  const html = readFileSync(resolve(process.cwd(), 'apps/desktop/preinstalled-apps/workspace/index.html'), 'utf8')
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML
  const preview = $('preview')
  const add = preview.addEventListener.bind(preview), remove = preview.removeEventListener.bind(preview)
  vi.spyOn(preview, 'addEventListener').mockImplementation((type, listener, options) => {
    if (type === 'pointermove' && listener) previewPointerHandlers.add(listener)
    add(type, listener, options)
  })
  vi.spyOn(preview, 'removeEventListener').mockImplementation((type, listener, options) => {
    if (type === 'pointermove' && listener) previewPointerHandlers.delete(listener)
    remove(type, listener, options)
  })
  Object.assign(globalThis, { gugu })
  Object.assign(window, { gugu })
  // @ts-expect-error — 内置 App 是不经构建的纯 ES module,没有类型;运行时 import 可用。
  await import('../../../../apps/desktop/preinstalled-apps/workspace/app.js')
  await until('the file is in the editor', () => document.querySelector('.cm-editor') !== null && view().state.doc.toString() === TEXT)
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('markdown redesign: the real document page', () => {
  const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))
  const paragraph = () => $('preview').querySelector('p[data-line="6-6"]')!
  const close = () => { dismiss(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) }

  beforeEach(async () => {
    file.readOnly = false
    close()
    $('mode-preview').click()
    await frame()
  })

  afterEach(() => {
    file.readOnly = false
    close()
    $('mode-preview').click()
  })

  test('M1 reading has no paragraph pointermove listener', () => {
    expect(previewPointerHandlers.size).toBe(0)
  })

  test('M1 reading pointer bursts do not measure blocks or their pane', async () => {
    const block = paragraph()
    const box = vi.spyOn(block, 'getBoundingClientRect').mockReturnValue(new DOMRect(56, 100, 600, 30))
    const pane = vi.spyOn($('preview'), 'getBoundingClientRect')
    for (let n = 0; n < 20; n++) block.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 80, clientY: 110 }))
    await frame()
    expect(box).not.toHaveBeenCalled()
    expect(pane).not.toHaveBeenCalled()
    expect($('block-controls').hidden).toBe(true)
  })

  test('M2 the insertion button is absent, with one standard vertical-more control', () => {
    expect(document.getElementById('block-insert')).toBeNull()
    expect($('block-controls').querySelectorAll('button')).toHaveLength(1)
    expect($('block-handle').querySelector('gugu-icon')?.getAttribute('name')).toBe('more-horizontal')
  })

  test('M3 editing starts its block menu with insertion and constructs its nine items on expansion', async () => {
    $('mode-split').click()
    hoverBlock(paragraph())
    await frame()
    $('block-handle').click()
    await until('the block menu is in the host', () => shown !== null)
    expect(labels()[0]).toBe('Insert below this paragraph')
    expect(shown!.items.filter((row) => 'type' in row)).toHaveLength(1)
    expect(labels(rowNamed('Insert below this paragraph').items)).toEqual(['Table', 'Image…', 'File…', 'Heading', 'List', 'To-do', 'Quote', 'Code block', 'Divider'])
    close()
  })

  test('M5 reading right-click offers only block links and citing, with the original line fingerprint', async () => {
    const block = paragraph()
    block.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 80, clientY: 110 }))
    await until('the block links are in the host menu', () => shown !== null)
    expect(gugu.showContextMenu).toHaveBeenLastCalledWith(expect.objectContaining({ x: 80, y: 110 }))
    expect(labels()).toEqual(['Copy link to block', 'Cite'])
    await pick('Copy link to block')
    await until('the block link is copied', () => gugu.clipboard.writeText.mock.calls.length > 0)
    expect(gugu.linkTo).toHaveBeenLastCalledWith(expect.objectContaining({ file: entry, at: expect.objectContaining({ lines: '6' }) }))
    block.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await until('the block links are in the host menu again', () => shown !== null)
    await pick('Cite')
    await until('the block is cited', () => gugu.dispatch.mock.calls.length > 0)
    expect(gugu.dispatch).toHaveBeenLastCalledWith('', { draft: true, refs: [expect.objectContaining({ file: entry, at: expect.objectContaining({ lines: '6', h: expect.any(String) }) })] })
  })

  test('M6 a read-only file has no side control in any mode', async () => {
    file.readOnly = true
    try {
      for (const mode of ['preview', 'split', 'edit']) {
        $(`mode-${mode}`).click()
        hoverBlock(paragraph())
        await frame()
        expect($('block-controls').hidden).toBe(true)
      }
    } finally {
      file.readOnly = false
      $('mode-preview').click()
    }
  })

  test('M7 the open document offers the same permitted file actions in the approved order', async () => {
    $('more').click()
    await frame()
    expect(menuItems().map((item) => item.textContent)).toEqual(['Forward', 'Copy link', 'Open with another App', 'Download', 'Rename', 'Move to…', 'Delete'])
    close()
  })

  test('M7 a read-only document never offers rename, move or delete even in a writable folder', () => {
    file.readOnly = true
    $('more').click()
    const labels = menuItems().map((item) => item.textContent)
    expect(labels).toEqual(['Forward', 'Copy link', 'Open with another App', 'Download'])
  })

  test('editing coalesces pointer bursts into one placement and one geometry read per frame', async () => {
    $('mode-split').click()
    const block = paragraph()
    const box = vi.spyOn(block, 'getBoundingClientRect').mockReturnValue(new DOMRect(56, 100, 600, 30))
    for (let n = 0; n < 20; n++) block.dispatchEvent(new MouseEvent('pointermove', { bubbles: true }))
    expect(box).not.toHaveBeenCalled()
    await frame()
    expect(box).toHaveBeenCalledTimes(1)
    expect($('block-controls').hidden).toBe(false)
    box.mockClear()
    block.dispatchEvent(new MouseEvent('pointermove', { bubbles: true }))
    $('mode-preview').click()
    await frame()
    expect(box).not.toHaveBeenCalled()
    expect(previewPointerHandlers.size).toBe(0)
    expect($('block-controls').hidden).toBe(true)
  })

  test('a keyboard-focused source block has the same menu without requiring preview hover', async () => {
    $('mode-edit').click()
    const coords = vi.spyOn(view(), 'coordsAtPos').mockReturnValue({ left: 56, right: 60, top: 100, bottom: 130 })
    view().focus()
    select(line(6).from, line(6).from)
    await frame()
    expect(coords).toHaveBeenCalledWith(line(6).from)
    expect($('block-controls').hidden).toBe(false)
    $('block-handle').click()
    await until('the same block menu is in the host', () => shown !== null)
    expect(labels()[0]).toBe('Insert below this paragraph')
    close()
    coords.mockRestore()
  })
})

describe('folder documents: reading', () => {
  test('a handed file exposes its host-owned Back to conversation through the existing navigation API', async () => {
    const back = $('page-back') as HTMLButtonElement;
    expect(back.disabled).toBe(false);
    expect(back.textContent).toContain('Back to conversation');
    back.click();
    expect(gugu.navigation.go).toHaveBeenCalledWith(-1);
  });
  test('a document opens on its reading; a task ticked there ticks its line in the source, and only that', async () => {
    expect(document.body.dataset.mode).toBe('preview')
    const boxes = [...$('preview').querySelectorAll<HTMLInputElement>('input[type=checkbox]')]
    expect(boxes.map((box) => box.disabled), 'tickable in a file this person may change').toEqual([false, false])
    boxes[0]!.checked = true
    boxes[0]!.dispatchEvent(new Event('change', { bubbles: true }))
    expect(line(3).text).toBe('- [x] 写完')
    boxes[1]!.checked = false
    boxes[1]!.dispatchEvent(new Event('change', { bubbles: true }))
    expect(view().state.doc.toString()).toBe(['# 计划', '', '- [x] 写完', '- [ ] 定了', '', '正文 一句'].join('\n'))
    view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: TEXT } })
    await redraw()
  })

  test.each([
    ['Heading', '## ', 3], ['List', '* ', 2], ['To-do', '- [ ] ', 6],
    ['Quote', '> ', 2], ['Code block', '```\n\n```', 4], ['Divider', '***', 3],
  ])('%s inserts after the entire multi-line block, with its caret in the template', async (label, text, caret) => {
    $('mode-split').click()
    const block = $('preview').querySelector('ul[data-line="3-4"]')!
    hoverBlock(block)
    await new Promise<void>((done) => requestAnimationFrame(() => done()))
    expect($('block-controls').hidden).toBe(false)
    $('block-handle').click()
    await until('the block menu is in the host', () => shown !== null)
    expect(labels(rowNamed('Insert below this paragraph').items)).toEqual(['Table', 'Image…', 'File…', 'Heading', 'List', 'To-do', 'Quote', 'Code block', 'Divider'])
    await pick(label, 'Insert below this paragraph')
    const at = TEXT.indexOf('- [x] 定了') + '- [x] 定了'.length
    const prefix = label === 'To-do' ? '\n' : '\n\n'
    expect(view().state.doc.toString()).toBe(`${TEXT.slice(0, at)}${prefix}${text}${TEXT.slice(at)}`)
    expect(view().state.selection.main.head).toBe(at + prefix.length + Number(caret))
    expect(document.body.dataset.mode).toBe('split')
    expect($('block-controls').hidden).toBe(true)
    view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: TEXT } })
    await redraw()
    $('mode-preview').click()
  })

  test('read-only documents offer block links and citing on right-click, without a side control', () => {
    file.readOnly = true
    try {
      hoverBlock($('preview').querySelector('p[data-line="6-6"]')!)
      expect($('block-controls').hidden).toBe(true)
      $('preview').querySelector('p[data-line="6-6"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
      expect(labels()).toEqual(['Copy link to block', 'Cite'])
      dismiss()
      view().focus()
    } finally {
      file.readOnly = false
    }
  })

  test('leaving gets a short grace, returning to the preview or handle cancels it, and scrolling still hides immediately', () => {
    const block = $('preview').querySelector('p[data-line="6-6"]')!
    vi.useFakeTimers()
    try {
      $('mode-split').click()
      hoverBlock(block)
      vi.advanceTimersToNextFrame()
      $('preview').dispatchEvent(new MouseEvent('pointerleave'))
      vi.advanceTimersByTime(149)
      expect($('block-controls').hidden).toBe(false)
      $('block-controls').dispatchEvent(new MouseEvent('pointerenter'))
      vi.advanceTimersByTime(200)
      expect($('block-controls').hidden).toBe(false)

      $('block-controls').dispatchEvent(new MouseEvent('pointerleave'))
      $('preview').dispatchEvent(new MouseEvent('pointerenter'))
      vi.advanceTimersByTime(200)
      expect($('block-controls').hidden).toBe(false)
      $('preview').dispatchEvent(new MouseEvent('pointerleave'))
      vi.advanceTimersByTime(150)
      expect($('block-controls').hidden).toBe(true)

      hoverBlock(block)
      vi.advanceTimersToNextFrame()
      $('preview').dispatchEvent(new Event('scroll'))
      expect($('block-controls').hidden).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  test('Escape keeps a focused handle through the hide grace; focus leaving hides it', async () => {
    vi.useFakeTimers()
    try {
      $('mode-split').click()
      hoverBlock($('preview').querySelector('p[data-line="6-6"]')!)
      vi.advanceTimersToNextFrame()
      // Enter on the focused handle: a click with no pointer (detail 0), so the focus stays on the handle.
      $('block-handle').focus()
      $('block-handle').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }))
      expect(shown).not.toBeNull()
      dismiss()
      await vi.advanceTimersByTimeAsync(0)
      expect(document.activeElement).toBe($('block-handle'))
      $('block-controls').dispatchEvent(new MouseEvent('pointerleave'))
      $('doc-title').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      vi.advanceTimersByTime(150)
      expect($('block-controls').hidden).toBe(false)
      $('mode-edit').focus()
      expect(document.activeElement).toBe($('mode-edit'))
      vi.advanceTimersByTime(150)
      expect($('block-controls').hidden).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('folder documents: writing', () => {
  test.each([
    ['## **Title** and `code`', '**Title** and `code`'],
    ['Title\n=====', 'Title'],
    ['- [ ] first\n- [x] second', 'first\nsecond'],
    ['> - [ ] nested', 'nested'],
    ['````js\nconst fence = "```"\n````', 'const fence = "```"'],
    ['literal - item and # marks with `tick`', 'literal - item and # marks with `tick`'],
  ])('conversion preserves content characters and only changes parsed block markers: %s', async (source, content) => {
    view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: source } })
    const block = sourceBlocks(view().state, { language })[0]
    view().dispatch({ changes: turnBlockChanges(view().state, { language }, block, 'quote') })
    expect(view().state.doc.toString()).toBe(content.split('\n').map((line) => line.trim() ? `> ${line}` : line).join('\n'))
    view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: TEXT } })
    await redraw()
  })

  test('source neighbors include tables and invisible link definitions, with front matter kept as a boundary', async () => {
    const source = '---\ntitle: Test\n---\n\nBefore.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n[ref]: https://example.com\n\nAfter.'
    view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: source } })
    const blocks = sourceBlocks(view().state, { language })
    expect(blocks.map((block: { name: string }) => block.name)).toEqual(['Frontmatter', 'Paragraph', 'Table', 'LinkReference', 'Paragraph'])
    expect(isFrontmatter(blocks[0])).toBe(true)
    const move = moveBlock(view().state.doc, blocks[1], blocks[2], true)
    view().dispatch({ changes: move.changes })
    expect(view().state.doc.toString()).toBe(source.replace('Before.\n\n| a | b |\n| - | - |\n| 1 | 2 |', '| a | b |\n| - | - |\n| 1 | 2 |\n\nBefore.'))
    view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: TEXT } })
    await redraw()
  })

  test.each(['list', 'quote'])('converting to %s keeps blank lines blank', async (kind) => {
    const source = '> one\n>\n> two'
    view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: source } })
    const block = sourceBlocks(view().state, { language })[0]
    view().dispatch({ changes: turnBlockChanges(view().state, { language }, block, kind) })
    const prefix = kind === 'list' ? '- ' : '> '
    expect(view().state.doc.toString()).toBe(`${prefix}one\n\n${prefix}two`)
    view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: TEXT } })
    await redraw()
  })

  test('a multi-line paragraph becomes one heading without replacing its content characters', async () => {
    const source = 'First line\nsecond line\nthird line'
    view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: source } })
    const block = sourceBlocks(view().state, { language })[0]
    const changes = turnBlockChanges(view().state, { language }, block, 'heading')
    expect(changes.filter((change: { to: number; from: number }) => change.to > change.from).map((change: { from: number; to: number }) => view().state.doc.sliceString(change.from, change.to))).toEqual(['\n', '\n'])
    view().dispatch({ changes })
    expect(view().state.doc.toString()).toBe('## First line second line third line')
    view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: TEXT } })
    await redraw()
  })

  test('preview lookup rejects invalid spans and parser disagreement, with local neighbor lookahead', async () => {
    const source = 'First.\n\n$$\na+b\n\nc+d\n$$\n\n' + 'Later.\n\n'.repeat(200)
    view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: source } })
    const ensure = vi.fn(language.ensureSyntaxTree)
    const cm = { language: { ensureSyntaxTree: ensure } }
    expect(previewBlock(view().state, cm, [1, 1])?.name).toBe('Paragraph')
    expect(ensure.mock.calls[0]).toEqual([view().state, 'First.\n'.length, 100])
    expect(previewBlock(view().state, cm, [3, 7])).toBeNull()
    ensure.mockClear()
    expect(previewBlock(view().state, cm, [0, 1])).toBeNull()
    expect(previewBlock(view().state, cm, [9999, 9999])).toBeNull()
    expect(ensure).not.toHaveBeenCalled()
    view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: TEXT } })
    await redraw()
  })

  test('a partial syntax tree retains the complete next block for Move down', async () => {
    const source = 'Before.\n\n- One\n- Two\n- Three\n\nAfter.\n\n' + 'Later.\n\n'.repeat(200)
    view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: source } })
    const ensure = vi.fn((state: cmState.EditorState, upto: number) => {
      const parse = markdownLanguage.parser.startParse(state.doc.toString())
      parse.stopAt(upto)
      let tree
      while (!(tree = parse.advance())) { /* Complete this partial parse, not the whole document. */ }
      return tree
    })
    const blocks = sourceBlocks(view().state, { language: { ensureSyntaxTree: ensure } }, 'Before.'.length)
    expect(blocks.map((block: { name: string }) => block.name)).toEqual(['Paragraph', 'BulletList'])
    expect(view().state.doc.sliceString(blocks[1].from, blocks[1].to)).toBe('- One\n- Two\n- Three')
    const move = moveBlock(view().state.doc, blocks[0], blocks[1], true)
    view().dispatch({ changes: move.changes })
    expect(view().state.doc.toString()).toBe(source.replace('Before.\n\n- One\n- Two\n- Three', '- One\n- Two\n- Three\n\nBefore.'))
    view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: TEXT } })
    await redraw()
  })

  test.each([
    ['- One\n- Two', 'list', '- ', '\n'],
    ['- - nested', 'list', '- ', '\n'],
    ['* [ ] One\n* [x] Two', 'todo', '* [ ] ', '\n'],
    ['- One\n- Two', 'todo', '* [ ] ', '\n\n'],
    ['- [ ] One\n- [x] Two', 'list', '* ', '\n\n'],
  ])('list insertion follows the last item’s type and marker: %s → %s', async (source, kind, expected, prefix) => {
    view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: source } })
    const block = sourceBlocks(view().state, { language })[0]
    const template = kind === 'todo' ? '- [ ] ' : '- '
    expect(listInsertion(view().state, { language }, block, kind, template)).toMatchObject({ text: expected, prefix })
    view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: TEXT } })
    await redraw()
  })

  test.each(['```\n```', '```\n\n```'])('empty code keeps a target template on conversion: %s', async (source) => {
    for (const [kind, expected] of [['heading', '## '], ['list', '- '], ['quote', '> ']]) {
      view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: source } })
      const block = sourceBlocks(view().state, { language })[0]
      view().dispatch({ changes: turnBlockChanges(view().state, { language }, block, kind) })
      expect(view().state.doc.toString()).toBe(expected)
    }
    view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: TEXT } })
    await redraw()
  })

  test('the source\'s selection is wrapped in a mark and out of it again; a link leaves the caret in its ()', () => {
    $('mode-edit').click()
    const from = line(6).from
    select(from, from + 2)
    $('fmt-bold').click()
    expect(line(6).text).toBe('**正文** 一句')
    expect(view().state.sliceDoc(view().state.selection.main.from, view().state.selection.main.to), 'still the words').toBe('正文')
    $('fmt-bold').click()
    expect(line(6).text).toBe('正文 一句')
    select(from, from + 2)
    $('fmt-link').click()
    expect(line(6).text).toBe('[正文]() 一句')
    expect(view().state.selection.main.head - from, 'between the ()').toBe(5)
    view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: TEXT } })
  })

  test('front matter is one quiet block in the source, not a setext heading', () => {
    view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: '---\ntitle: x\nowner: y\n---\n\n正文' } })
    const names: string[] = []
    language.ensureSyntaxTree(view().state, view().state.doc.length, 5000)!.iterate({ enter: (node) => { names.push(node.name) } })
    expect(names).toContain('Frontmatter')
    expect(names.filter((name) => /Heading/.test(name))).toEqual([])
    view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: TEXT } })
  })

  test('an empty document says what can be done where its reading would be: write, or ask an agent for a draft', async () => {
    $('mode-preview').click()
    view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: '' } })
    await redraw()
    expect($('doc-empty').hidden).toBe(false)
    expect(document.body.classList.contains('empty-doc')).toBe(true)
    expect($('doc-empty-title').textContent).toBe('This document is empty')
    $('empty-draft').click()
    expect(gugu.dispatch).toHaveBeenCalledWith('Draft this document for me: ', { draft: true, refs: [{ file: entry }] })
    $('empty-write').click()
    expect(document.body.dataset.mode).toBe('edit')
    view().dispatch({ changes: { from: 0, to: 0, insert: TEXT } })
    await redraw()
    expect($('doc-empty').hidden).toBe(true)
  })
})
