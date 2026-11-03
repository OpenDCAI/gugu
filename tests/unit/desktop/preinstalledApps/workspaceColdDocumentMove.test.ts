// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { beforeAll, expect, it, vi } from 'vitest'
import { until } from '../../../support/awaitCondition'

const file = { id: 'readme', chat: 'chat', name: 'README.md', displayName: 'README.md', type: 'text', contentType: 'text/markdown', parentId: null, path: 'README.md', systemRole: null, version: 1, createdAt: '2026-11-03T08:00:00Z', updatedAt: null, sourceMessageIds: [], size: 1 }
const folder = { ...file, id: 'docs', name: 'docs', displayName: 'docs', type: 'folder', path: 'docs' }
const entries = [file, folder]
const context = { tabId: 'file-context', file: { chat: 'chat', id: file.id }, chat: { id: 'chat', kind: 'group', name: 'Files', groupId: null }, workspace: { id: 'working-copy', sessionId: 'task' }, locale: 'en-US', capabilities: ['files:read', 'files:write'] }
let changed: (ctx: Record<string, unknown>) => Promise<void>
const gugu = {
  linkTo: async () => 'gugu-file://readme',
  getContext: async () => context, markdown: async () => ({ render: () => document.createDocumentFragment() }),
  setTabTitle: vi.fn(async () => {}), onContextChanged: (fn: typeof changed) => { changed = fn; return () => {} },
  onLink: () => () => {}, showContextMenu: vi.fn(async () => null),
  files: {
    list: vi.fn(async () => entries), canDelete: vi.fn(async () => [false]),
    move: vi.fn(async () => {}), viewPreferences: async () => ({ showAppData: false }),
    onChanged: () => () => {}, open: vi.fn(async () => ({ type: 'binary', entry: file, close() {} })),
  },
}
const el = (id: string) => document.getElementById(id)!
async function moveFromToolbar() {
  el('more').click()
  const move = [...el('menu').children].find((item) => item.textContent === 'Move to…') as HTMLButtonElement | undefined
  expect(move, 'the actual file toolbar offers Move').toBeDefined()
  move!.click()
}
beforeAll(async () => {
  document.body.innerHTML = new DOMParser().parseFromString(readFileSync(resolve('apps/desktop/preinstalled-apps/workspace/index.html'), 'utf8'), 'text/html').body.innerHTML
  Object.assign(globalThis, { gugu, CSS: { escape: (v: string) => v } }); Object.assign(window, { gugu })
  // @ts-expect-error The bundled App is JavaScript.
  await import('../../../../apps/desktop/preinstalled-apps/workspace/app.js')
  await until('the cold document is shown without listing its folder', () => el('doc-title').textContent === file.name)
})
it('shows the handed document without requesting the directory', () => {
  expect(document.body.classList.contains('show-doc')).toBe(true)
  expect(gugu.files.list).not.toHaveBeenCalled()
})
it('loads destinations on Move and moves the cold document into an existing folder', async () => {
  let finish!: (value: typeof entries) => void
  gugu.files.list.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  await moveFromToolbar()
  expect(gugu.files.list).toHaveBeenCalledWith({ chat: 'chat' })
  finish(entries)
  await setImmediate()
  expect(el('move-dialog').hidden, el('files-empty-message').textContent ?? '').toBe(false)
  expect(el('move-targets').textContent).toContain('docs')
  const target = [...el('move-targets').querySelectorAll('button')].find((item) => item.textContent === 'docs')!
  expect(target.disabled).toBe(false)
  target.click()
  await until('the actual file is moved to docs', () => gugu.files.move.mock.calls.length === 1)
  expect(gugu.files.move).toHaveBeenCalledWith(file, { folder: 'docs' })
  await setImmediate()
})
it('does not show a late Move dialog after its context loses file permission', async () => {
  el('move-cancel').click()
  gugu.files.list.mockReset().mockResolvedValue(entries)
  gugu.files.move.mockClear()
  let finish!: (value: typeof entries) => void
  gugu.files.list.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  await moveFromToolbar()
  await changed({ ...context, capabilities: [] })
  finish?.(entries)
  await setImmediate()
  expect(el('move-dialog').hidden).toBe(true)
  expect(gugu.files.move).not.toHaveBeenCalled()
})
