// @vitest-environment jsdom
// #6718: the workspace App's preview is gugu's own markdown rendering (gugu.markdown(), markdown-entry.ts) — no parse
// of the App's own. Judged here: what the App hands it (the preview pane, the file's text, `comfortable`, frontmatter,
// the file itself for relative links), and that it renders again when the file changes. The rendering is the
// runtime's (markdown-entry.test.ts); the editor is the real CodeMirror, bound by a stand-in.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import * as cmState from '@codemirror/state'
import * as cmView from '@codemirror/view'
import { EditorView } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { beforeAll, describe, expect, test, vi } from 'vitest'

const entry = {
  id: 'plan', chat: 'chat-1', name: 'plan.md', displayName: 'plan', contentType: 'text/markdown', type: 'text', size: 9,
  createdAt: '2026-10-25T01:00:00Z', updatedAt: null, createdBy: { id: 'u1', name: 'A', kind: 'human' }, sourceMessageIds: [],
  detailsPending: true,
}
const changes = new Set<(event: { local: boolean; entry?: true }) => void>()
const changed = (event: { local: boolean; entry?: true }) => { for (const fn of changes) fn(event) }
const file = {
  entry,
  type: 'text',
  readOnly: false,
  status: 'online',
  saved: true,
  text: '# 计划\n\n$E = mc^2$',
  onChange: vi.fn((handler: (event: { local: boolean; entry?: true }) => void) => {
    changes.add(handler)
    return () => changes.delete(handler)
  }),
  onStatus: vi.fn(() => () => {}),
  onRefused: vi.fn(() => () => {}),
  close: vi.fn(),
  presence: { self: { userId: 'u2', color: '' }, others: [], onChange: () => () => {}, set: () => {} },
}

const md = { render: vi.fn((_element: Element, _text: string, _options: unknown) => {}) }
const context = { chat: { id: 'chat-1', name: 'G', kind: 'group', groupId: 'chat-1' }, file: { chat: 'chat-1', id: 'plan' }, locale: 'en', capabilities: ['files:read', 'files:write'] }
let contextChanged = (_ctx: typeof context) => {}
const gugu = {
  linkTo: vi.fn(async ({ file }: { file: { id: string } }) => `gugu-file://${file.id}`),
  setTabTitle: vi.fn(async () => {}),
  getContext: vi.fn(async () => context),
  onContextChanged: vi.fn((handler: typeof contextChanged) => { contextChanged = handler; handler(context); return () => {} }),
  codemirror: vi.fn(async () => ({ EditorView, basicSetup, markdown, markdownLanguage, view: cmView, state: cmState })),
  onLink: vi.fn(() => () => {}),
  markdown: vi.fn(async () => md),
  bind: { codemirror: vi.fn(() => () => {}) },
  files: {
    list: vi.fn(async () => [entry]),
    rename: vi.fn(async (_entry: typeof entry, _name: string) => {}),
    onChanged: vi.fn(() => () => {}),
    open: vi.fn(async () => { await Promise.resolve(); return file }),
  },
}

beforeAll(async () => {
  const html = readFileSync(resolve(process.cwd(), 'apps/desktop/preinstalled-apps/workspace/index.html'), 'utf8')
  const page = new DOMParser().parseFromString(html, 'text/html')
  document.body.innerHTML = page.body.innerHTML
  Object.assign(globalThis, { gugu })
  Object.assign(window, { gugu })
  // @ts-expect-error — 内置 App 是不经构建的纯 ES module,没有类型;运行时 import 可用。
  await import('../../../../apps/desktop/preinstalled-apps/workspace/app.js')
  await vi.waitFor(() => expect(md.render).toHaveBeenCalled())
})

describe('workspace App: the preview is gugu.markdown()', () => {
  test('a file page opens without listing or watching the hidden folder', () => {
    expect(gugu.files.open).toHaveBeenCalledOnce()
    expect(gugu.files.list).not.toHaveBeenCalled()
    expect(gugu.files.onChanged).not.toHaveBeenCalled()
  })

  test('the file\'s text into the preview pane, as a document to read, with the file for its relative links', () => {
    expect(gugu.markdown).toHaveBeenCalledOnce()
    const [element, text, options] = md.render.mock.calls[0]!
    expect(element).toBe(document.getElementById('preview'))
    expect(text).toBe('# 计划\n\n$E = mc^2$')
    // Each block says its lines (#7238): a selection there is cited by them, a pill's lines are found there.
    expect(options).toEqual({ density: 'comfortable', frontmatter: true, sourceLines: true, file: entry })
  })

  test('entry decorations update the information line without re-rendering the preview', () => {
    md.render.mockClear()
    file.entry = { ...entry, detailsPending: false, createdBy: { ...entry.createdBy, name: 'Hydrated creator' } }
    changed({ local: false, entry: true })
    expect(document.getElementById('doc-info')!.textContent).toContain('Hydrated creator')
    expect(md.render).not.toHaveBeenCalled()
  })

  test('decoration arriving after a rename cannot replace the newer entry', async () => {
    const pending = { ...entry, id: 'renamed-file' }
    file.entry = pending
    contextChanged({ ...context, file: { chat: 'chat-1', id: pending.id } })
    await vi.waitFor(() => expect(gugu.files.open).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(document.getElementById('doc-info')!.hidden).toBe(true))
    const renamed = { ...pending, name: 'renamed.md', detailsPending: false, createdBy: { ...entry.createdBy, name: 'Current creator' } }
    gugu.files.list.mockResolvedValueOnce([renamed])
    document.getElementById('more')!.click()
    const rename = [...document.querySelectorAll<HTMLButtonElement>('#menu button')].find((button) => button.textContent === 'Rename')!
    rename.click()
    const input = document.querySelector<HTMLInputElement>('#doc-title .rename-input')!
    input.value = renamed.name
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await vi.waitFor(() => expect(document.getElementById('doc-title')!.textContent).toBe(renamed.name))
    expect(gugu.files.rename).toHaveBeenLastCalledWith(pending, renamed.name)
    file.entry = { ...pending, detailsPending: false, createdBy: { ...entry.createdBy, name: 'Stale creator' } }
    changed({ local: false, entry: true })
    expect(document.getElementById('doc-info')!.textContent).toContain('Current creator')
    expect(document.getElementById('doc-info')!.textContent).not.toContain('Stale creator')
  })

  test('rendered again when the file changes (debounced), with what it says now', async () => {
    md.render.mockClear()
    file.text = '# 计划 v2'
    changed({ local: false })
    await vi.waitFor(() => expect(md.render).toHaveBeenCalledOnce())
    expect(md.render.mock.calls[0]![1]).toBe('# 计划 v2')
  })
})
