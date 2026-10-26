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
  createdAt: null, updatedAt: null, createdBy: { id: 'u1', name: 'A', kind: 'human' }, sourceMessageIds: [],
}
let changed: () => void = () => {}
const file = {
  entry,
  type: 'text',
  readOnly: false,
  status: 'online',
  saved: true,
  text: '# 计划\n\n$E = mc^2$',
  onChange: vi.fn((handler: () => void) => {
    changed = handler
    return () => {}
  }),
  onStatus: vi.fn(() => () => {}),
  onRefused: vi.fn(() => () => {}),
  close: vi.fn(),
  presence: { self: { userId: 'u2', color: '' }, others: [], onChange: () => () => {}, set: () => {} },
}

const md = { render: vi.fn((_element: Element, _text: string, _options: unknown) => {}) }
const gugu = {
  linkTo: vi.fn(async ({ file }: { file: { id: string } }) => `gugu-file://${file.id}`),
  setTabTitle: vi.fn(async () => {}),
  getContext: vi.fn(async () => ({ chat: { id: 'chat-1', name: 'G', kind: 'group', groupId: 'chat-1' }, file: { chat: 'chat-1', id: 'plan' }, locale: 'en', capabilities: ['files:read'] })),
  onContextChanged: vi.fn(() => () => {}),
  codemirror: vi.fn(async () => ({ EditorView, basicSetup, markdown, markdownLanguage, view: cmView, state: cmState })),
  onLink: vi.fn(() => () => {}),
  markdown: vi.fn(async () => md),
  bind: { codemirror: vi.fn(() => () => {}) },
  files: {
    list: vi.fn(() => new Promise(() => {})),
    onChanged: vi.fn(() => () => {}),
    open: vi.fn(async () => file),
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
    expect(gugu.files.open).toHaveBeenCalled()
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

  test('rendered again when the file changes (debounced), with what it says now', async () => {
    md.render.mockClear()
    file.text = '# 计划 v2'
    changed()
    await vi.waitFor(() => expect(md.render).toHaveBeenCalledOnce())
    expect(md.render.mock.calls[0]![1]).toBe('# 计划 v2')
  })
})
