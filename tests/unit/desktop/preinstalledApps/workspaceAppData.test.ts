// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, expect, test, vi } from 'vitest'

const marked = { publisher: 'gugu', id: 'kanban' }
const entry = (id: string, name: string, metadata = {}) => ({ id, name, displayName: name, path: name, type: 'json', contentType: 'application/json', parentId: null, sourceMessageIds: [], metadata })
const entries = [entry('board', 'renamed.txt', { app: marked }), entry('old', 'legacy.board.json'), entry('office', 'Budget.xlsx'), entry('document', 'notes.md', { document: { epoch: 1 } })]
const context = { chat: { id: 'chat-1', name: 'Group', kind: 'group', groupId: 'chat-1' }, locale: 'en', capabilities: ['files:read', 'files:write'] }
let show = false
let change = (_change: { kind: string; entries: ReturnType<typeof entry>[]; gone: string[] }) => {}
const menu = vi.fn(async (_options: unknown): Promise<string | null> => 'app-data')
const preferences = vi.fn(async (_place: unknown, options?: { showAppData?: boolean }) => {
  if (options?.showAppData !== undefined) show = options.showAppData
  return { showAppData: show }
})
const gugu = { getContext: async () => context, onContextChanged: vi.fn(), setTabTitle: vi.fn(), onLink: vi.fn(), markdown: async () => ({}), showContextMenu: menu,
  linkTo: vi.fn(async () => 'gugu-file://file'), files: { list: async () => entries, viewPreferences: preferences, onChanged: (_place: unknown, fn: typeof change) => { change = fn }, openWith: vi.fn() } }
const ids = () => [...document.querySelectorAll('#file-list > li.file')].map(node => (node as HTMLElement).dataset.id)
const blank = () => document.querySelector('aside.files') as HTMLElement
beforeAll(async () => {
  const parsed = new DOMParser().parseFromString(readFileSync(resolve('apps/desktop/preinstalled-apps/workspace/index.html'), 'utf8'), 'text/html')
  document.body.innerHTML = parsed.body.innerHTML
  for (const attr of Array.from(parsed.body.attributes)) document.body.setAttribute(attr.name, attr.value)
  Object.assign(globalThis, { gugu }); Object.assign(window, { gugu })
  // @ts-expect-error Plain App ES module.
  await import('../../../../apps/desktop/preinstalled-apps/workspace/app.js')
  await vi.waitFor(() => expect(ids()).toHaveLength(3))
})

test('defaults to hiding the metadata marker, without guessing from name or opener', () => {
  expect(ids()).toEqual(expect.arrayContaining(['old', 'office', 'document']))
  expect(ids()).not.toContain('board')
})
test('blank-area context action uses the host menu, persists the person preference, and follows renames/moves', async () => {
  blank().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 50, cancelable: true }))
  await vi.waitFor(() => expect(ids()).toHaveLength(4))
  expect(menu).toHaveBeenLastCalledWith({ x: 40, y: 50, items: [{ id: 'app-data', label: 'Show App data' }] })
  expect(preferences).toHaveBeenLastCalledWith({ chat: 'chat-1' }, { showAppData: true })
  blank().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'F10', shiftKey: true }))
  await vi.waitFor(() => expect(ids()).toHaveLength(3))
  expect(menu.mock.calls.at(-1)?.[0]).toMatchObject({ items: [{ label: 'Hide App data' }] })
  change({ kind: 'entries', entries: [entry('board', 'another-name.md', { app: marked })], gone: [] })
  expect(ids()).not.toContain('board')
})
test('name search follows visibility and a dismissed menu does not change preferences', async () => {
  const filter = document.getElementById('filter') as HTMLInputElement
  filter.value = 'renamed'
  filter.dispatchEvent(new Event('input', { bubbles: true }))
  await vi.waitFor(() => expect(ids()).toEqual([]))
  filter.value = ''; filter.dispatchEvent(new Event('input', { bubbles: true }))
  menu.mockResolvedValueOnce(null)
  const before = preferences.mock.calls.length
  blank().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  await vi.waitFor(() => expect(menu).toHaveBeenCalledTimes(3))
  expect(preferences.mock.calls.length).toBe(before)
})
