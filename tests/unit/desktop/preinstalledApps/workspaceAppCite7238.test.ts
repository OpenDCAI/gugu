// @vitest-environment jsdom
// #7238: the 群文件夹 App cites a markdown file's places as pills to their lines, and a pill opens the file there. Judged on
// the real app.js and the real CodeMirror (bound by a stand-in that puts the file's text in): Cite hands
// `gugu.dispatch('', { draft: true, refs })` — each range of the selection a pill with `at: { lines, h }` and its words, no quote; a
// selection in the preview is cited by the lines its blocks were written on; ＋ Keep gathers places for one Cite; a
// pill's link marks its lines in the source and the preview, found again when the file changed above them (and said),
// and only said when the lines themselves changed. A place is the file's it came for; a JSON file's cite stays a quote.
// The preview is a stand-in that marks lines as gugu.markdown's `sourceLines` does (judged in markdown-entry.test.ts).
// Every wait is on a fact (until), not a clock.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { json } from '@codemirror/lang-json'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import * as language from '@codemirror/language'
import * as cmState from '@codemirror/state'
import { EditorSelection } from '@codemirror/state'
import * as cmView from '@codemirror/view'
import { EditorView } from '@codemirror/view'
import * as lezerHighlight from '@lezer/highlight'
import { basicSetup } from 'codemirror'
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
// @ts-expect-error — 内置 App 是不经构建的纯 ES module,没有类型;运行时 import 可用。
import { fingerprint } from '../../../../apps/desktop/preinstalled-apps/workspace/lines.js'
import { until } from '../../../support/awaitCondition'

const TEXT = ['# 发布计划', '', '目标：十月上线', '负责人：小王', '', '## 风险', '- 支付接口可能延期', '', '- 甲', '- 乙'].join('\n')
const entry = {
  id: 'plan', chat: 'chat-1', name: 'plan.md', displayName: 'plan', contentType: 'text/markdown', type: 'text', size: 9,
  createdAt: null, updatedAt: null, createdBy: null, sourceMessageIds: [],
}
let changed: (event: { local: boolean; entry?: true }) => void = () => {}
let statusChanged: (status: string) => void = () => {}
const file = {
  entry,
  type: 'text',
  readOnly: false,
  status: 'online',
  saved: true,
  text: TEXT,
  onChange: vi.fn((handler: (event: { local: boolean; entry?: true }) => void) => {
    changed = handler
    return () => {}
  }),
  onStatus: vi.fn((handler: (status: string) => void) => {
    statusChanged = handler
    return () => {}
  }),
  close: vi.fn(),
  presence: { self: { userId: 'u2', color: '' }, others: [], onChange: () => () => {}, set: () => {} },
}

// One block per run of lines between blank lines, saying its lines (1-based) as `sourceLines` does — a run of list
// lines a list whose items say theirs too.
const md = {
  render: vi.fn((element: Element, text: string) => {
    const blocks: string[] = []
    let start = 0
    const lines = text.split('\n')
    lines.forEach((line, i) => {
      if (line.trim() && (i === 0 || !lines[i - 1]!.trim())) start = i + 1
      if (!line.trim() || (i < lines.length - 1 && lines[i + 1]!.trim())) return
      const run = lines.slice(start - 1, i + 1)
      blocks.push(run.every((l) => l.startsWith('- '))
        ? `<ul data-line="${start}-${i + 1}">${run.map((l, k) => `<li data-line="${start + k}-${start + k}">${l.slice(2)}</li>`).join('')}</ul>`
        : `<p data-line="${start}-${i + 1}">${run.join(' ')}</p>`)
    })
    element.innerHTML = `<div class="gg-md">${blocks.join('')}</div>`
  }),
}
// A JSON file: shown as its indented text.
const config = {
  ...file, entry: { ...entry, id: 'cfg', name: 'cfg.json', contentType: 'application/json', type: 'json' }, type: 'json',
  toJSON: () => ({ a: '**粗**', b: '# 不是标题' }), onChange: () => () => {}, onStatus: () => () => {},
}
// Another markdown file, opened as itself (its text, when it is opened, as plan's).
const slowFile = () => ({ ...file, entry: { ...entry, id: 'slow', name: 'slow.md' }, text: file.text, onChange: () => () => {}, onStatus: () => () => {} })
const ctxOf = (id: string) => ({ chat: { id: 'chat-1', name: 'G', kind: 'group', groupId: 'chat-1' }, file: { chat: 'chat-1', id }, locale: 'en', capabilities: ['files:read', 'files:write'] })
let link: (event: { type: 'link'; tab: string; path: string; query: Record<string, string>; file: string | null }) => void = () => {}
let contextChanged: (ctx: ReturnType<typeof ctxOf>) => void = () => {}
const gugu = {
  linkTo: vi.fn(async ({ file }: { file: { id: string } }) => `gugu-file://${file.id}`),
  setTabTitle: vi.fn(async () => {}),
  getContext: vi.fn(async () => ctxOf('plan')),
  onContextChanged: vi.fn((handler: typeof contextChanged) => {
    contextChanged = handler
    return () => {}
  }),
  onLink: vi.fn((handler: typeof link) => {
    link = handler
    return () => {}
  }),
  dispatch: vi.fn(async (_text: string, _options: unknown) => ({ to: { chat: 'g-1' } })),
  codemirror: vi.fn(async () => ({ EditorView, EditorState: cmState.EditorState, basicSetup, markdown, markdownLanguage, json, view: cmView, state: cmState, language, lezerHighlight })),
  markdown: vi.fn(async () => md),
  // The file's text in the editor, as the binding puts it there.
  bind: {
    codemirror: vi.fn((view: EditorView, f: typeof file) => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: f.text } })
      return () => {}
    }),
  },
  files: {
    viewPreferences: vi.fn(async () => ({ showAppData: false })), list: vi.fn(async () => [entry]), onChanged: vi.fn(() => () => {}), open: vi.fn(async (handle: { id: string }): Promise<unknown> => (handle.id === 'cfg' ? config : handle.id === 'slow' ? slowFile() : file)) },
}

const $ = (id: string) => document.getElementById(id) as HTMLElement
const view = () => EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!
const line = (n: number) => view().state.doc.line(n)
const select = (...ranges: [number, number][]) => view().dispatch({ selection: EditorSelection.create(ranges.map(([from, to]) => EditorSelection.range(from, to))) })
const marked = (cls: string) => [...document.querySelectorAll('.cm-line')].flatMap((l, i) => (l.classList.contains(cls) ? [i + 1] : []))
const previewMarked = (cls: string) => [...document.querySelectorAll(`#preview .${cls}`)].map((b) => b.getAttribute('data-line'))
const refsOfLastCompose = () => (gugu.dispatch.mock.calls.at(-1)![1] as { refs: unknown[] }).refs
/** The editor's text changed by someone else: the file says so and the preview draws it again. */
async function edit(change: { from: number; to?: number; insert: string }) {
  view().dispatch({ changes: change })
  file.text = view().state.doc.toString()
  md.render.mockClear()
  changed({ local: false })
  await until('the preview is drawn again', () => md.render.mock.calls.length > 0)
}

beforeAll(async () => {
  // jsdom lays nothing out: a range has no boxes (the selection bar then has no place, as a hidden pane's).
  Range.prototype.getBoundingClientRect ??= () => new DOMRect()
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList
  const html = readFileSync(resolve(process.cwd(), 'apps/desktop/preinstalled-apps/workspace/index.html'), 'utf8')
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML
  Object.assign(globalThis, { gugu })
  Object.assign(window, { gugu })
  // @ts-expect-error — 内置 App 是不经构建的纯 ES module,没有类型;运行时 import 可用。
  await import('../../../../apps/desktop/preinstalled-apps/workspace/app.js')
  await until('the file is in the editor', () => document.querySelector('.cm-editor') !== null && view().state.doc.toString() === TEXT)
})

beforeEach(() => {
  gugu.dispatch.mockClear()
  select([0, 0])
  document.getSelection()?.removeAllRanges()
})

describe('Cite: pills to the picked lines, no quote', () => {
  test('the native menu keeps its picked lines after focus changes and quotes a whole file without selection', async () => {
    select([line(3).from, line(4).to])
    const root = $('editor')
    expect(root.dataset.guguFileViewer).toBeTruthy()
    const request = { action: 'snapshot', requestId: 'native', selection: { text: '' } }
    root.dispatchEvent(new CustomEvent('gugu:file-viewer-menu', { detail: request }))
    expect(request.selection.text).toBe('目标：十月上线\n负责人：小王')
    select([0, 0])
    root.dispatchEvent(new CustomEvent('gugu:file-viewer-menu', { detail: { ...request, action: 'quote-selection' } }))
    await until('native Cite composed', () => gugu.dispatch.mock.calls.length > 0)
    expect(refsOfLastCompose()).toEqual([{ file: entry, at: { lines: '3-4', h: fingerprint('目标：十月上线\n负责人：小王') }, label: 'Lines 3–4 · 目标：十月上线 负责人：小王' }])
    root.dispatchEvent(new CustomEvent('gugu:file-viewer-menu', { detail: { ...request, action: 'snapshot', requestId: 'whole' } }))
    root.dispatchEvent(new CustomEvent('gugu:file-viewer-menu', { detail: { ...request, action: 'quote-file', requestId: 'whole' } }))
    await until('whole file composed', () => gugu.dispatch.mock.calls.length === 2)
    expect(refsOfLastCompose()).toEqual([{ file: entry }])
  })

  test('each range of the selection is one pill: its lines and their fingerprint, the lines then its words', async () => {
    select([line(3).from, line(4).to], [line(7).from + 2, line(7).from + 6])
    $('cite-sel').click()
    await until('Cite has composed', () => gugu.dispatch.mock.calls.length > 0)
    expect(gugu.dispatch).toHaveBeenCalledOnce()
    expect(gugu.dispatch.mock.calls[0]![0]).toBe('')
    expect(refsOfLastCompose()).toEqual([
      { file: entry, at: { lines: '3-4', h: fingerprint('目标：十月上线\n负责人：小王') }, label: 'Lines 3–4 · 目标：十月上线 负责人：小王' },
      // A phrase inside a line: that line, and the words picked.
      { file: entry, at: { lines: '7', h: fingerprint('- 支付接口可能延期') }, label: 'Line 7 · 支付接口' },
    ])
  })

  test('picked in the source, a pill\'s words read as the preview\'s: no heading or list marker', async () => {
    select([line(6).from, line(7).to])
    $('cite-sel').click()
    await until('Cite has composed', () => gugu.dispatch.mock.calls.length > 0)
    expect(gugu.dispatch).toHaveBeenCalledOnce()
    expect((refsOfLastCompose() as { label: string }[])[0]!.label).toBe('Lines 6–7 · 风险 支付接口可能延期')
  })

  test('a selection in the preview is cited by the lines its first and last block were written on', async () => {
    const blocks = [...document.querySelectorAll('#preview [data-line]')]
    // From the paragraph on lines 3–4 into the block on lines 6–7 (a heading and its list, no blank line between).
    const [from, to] = [blocks.find((b) => b.getAttribute('data-line') === '3-4')!, blocks.find((b) => b.getAttribute('data-line') === '6-7')!]
    const range = document.createRange()
    range.setStart(from.firstChild!, 0)
    range.setEnd(to.firstChild!, 6)
    document.getSelection()!.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    $('cite-sel').click()
    await until('Cite has composed', () => gugu.dispatch.mock.calls.length > 0)
    expect(gugu.dispatch).toHaveBeenCalledOnce()
    const [ref] = refsOfLastCompose() as { at: { lines: string; h: string } }[]
    expect(ref!.at).toEqual({ lines: '3-7', h: fingerprint(TEXT.split('\n').slice(2, 7).join('\n')) })
  })

  test('＋ Keep gathers places — marked where they are — for one Cite with the selection, then lets them go', async () => {
    select([line(1).from, line(1).to])
    $('hold-sel').click()
    expect($('held-bar').hidden).toBe(false)
    expect($('held-count').textContent).toBe('1 spot')
    expect(marked('cm-held')).toEqual([1])
    expect(previewMarked('md-held')).toEqual(['1-1'])
    select([line(3).from, line(3).to])
    $('held-cite').click()
    await until('Cite has composed', () => gugu.dispatch.mock.calls.length > 0)
    expect(gugu.dispatch).toHaveBeenCalledOnce()
    expect((refsOfLastCompose() as { at: { lines: string } }[]).map((ref) => ref.at.lines)).toEqual(['1', '3'])
    expect($('held-bar').hidden).toBe(true)
    expect(marked('cm-held')).toEqual([])
  })
})

describe('a pill opens the file at its lines', () => {
  const pill = (lines: string, h: string) => link({ type: 'link', tab: 'main', path: '', query: { lines, h }, file: 'plan' })
  const h = fingerprint('目标：十月上线\n负责人：小王')

  test('marked in the source and the preview, until the next press on the file', () => {
    pill('3-4', h)
    expect(marked('cm-found')).toEqual([3, 4])
    expect(previewMarked('md-found')).toEqual(['3-4'])
    expect($('banner').hidden).toBe(true)
    $('editor').dispatchEvent(new Event('pointerdown'))
    expect(marked('cm-found')).toEqual([])
    expect(previewMarked('md-found')).toEqual([])
  })

  test('a list item: that item framed in the preview, not its whole list as well', () => {
    pill('10', fingerprint('- 乙'))
    expect(marked('cm-found')).toEqual([10])
    expect(previewMarked('md-found')).toEqual(['10-10'])
  })

  test('lines added above since: found where they are now, and said', async () => {
    await edit({ from: 0, insert: '新增一行\n\n' })
    pill('3-4', h)
    expect(marked('cm-found')).toEqual([5, 6])
    expect(previewMarked('md-found')).toEqual(['5-6'])
    expect($('banner').textContent).toBe('The cited lines moved: Lines 5–6')
    // Said until the next press: the file's status coming in (saved, as edits land) does not take it away (mac1 A/B
    // 10-15: the first status after a page opened hid it).
    statusChanged('online')
    expect($('banner').hidden).toBe(false)
    $('preview').dispatchEvent(new Event('pointerdown'))
    expect($('banner').hidden).toBe(true)
  })

  test('the lines themselves changed since: said, and nothing marked', async () => {
    const at = view().state.doc.toString().indexOf('小王')
    await edit({ from: at, to: at + 2, insert: '小李' })
    pill('3-4', h)
    expect(marked('cm-found')).toEqual([])
    expect($('banner').textContent).toBe('The cited lines changed since: this is where they were')
  })
})

describe("a pill's place is the file's it came for; a JSON file's cite stays a quote", () => {
  test('a place for a file still opening is not shown on the file opened next, even where its lines read the same', async () => {
    // A file slow to open (it never comes): the page is on it when its pill's place comes (#7232), then plan is opened.
    gugu.files.open.mockImplementationOnce(() => new Promise(() => {}))
    contextChanged(ctxOf('slow'))
    await until('the slow file is being opened', () => gugu.files.open.mock.calls.at(-1)?.[0].id === 'slow')
    // The slow file's place: its link names it (#7257 `file`).
    link({ type: 'link', tab: 'main', path: '', query: { lines: '1', h: fingerprint(file.text.split('\n')[0]!) }, file: 'slow' })
    contextChanged(ctxOf('plan'))
    await until('plan is in the editor again', () => document.querySelector('.cm-editor') !== null && view().state.doc.toString() === file.text)
    expect(marked('cm-found')).toEqual([])
    expect(previewMarked('md-found')).toEqual([])
    expect($('banner').hidden).toBe(true)
    // The slow file's place was dropped when plan began opening (#7257): the slow file, opened later, is drawn with
    // nothing marked.
    contextChanged(ctxOf('slow'))
    await until('the slow file is in the editor', () => $('doc-title').textContent === 'slow.md' && document.querySelector('.cm-editor') !== null && view().state.doc.toString() === file.text)
    expect(marked('cm-found')).toEqual([])
    expect($('banner').hidden).toBe(true)
    // A place whose link names another file is not shown on this one, though its line 1 reads the same.
    link({ type: 'link', tab: 'main', path: '', query: { lines: '1', h: fingerprint(file.text.split('\n')[0]!) }, file: 'elsewhere' })
    expect(marked('cm-found')).toEqual([])
  })

  test('JSON: each range quoted with the lines it is shown on, and a pill to the file — its words as they are', async () => {
    contextChanged(ctxOf('cfg'))
    await until('the JSON file is shown', () => document.querySelector('.cm-editor') !== null && view().state.doc.toString().includes('不是标题'))
    select([line(2).from, line(3).to])
    $('cite-sel').click()
    await until('Cite has composed', () => gugu.dispatch.mock.calls.length > 0)
    expect(gugu.dispatch.mock.calls).toEqual([['Lines 2–3\n>   "a": "**粗**",\n>   "b": "# 不是标题"', { draft: true, refs: [{ file: config.entry }] }]])
  })
})
