// @vitest-environment jsdom
// Real shipped app.js, initially handed a Markdown document; the host file verbs are supplied here.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, beforeEach, expect, test, vi } from 'vitest'

type Context = { locale: string; chat: { id: string; name: string; kind: string; groupId: string }; capabilities: string[]; file?: { chat: string; id: string } }
const documents = new Map<string, ReturnType<typeof makeFile>>()
let sequence = 0
function makeFile(id: string, chat: string) {
  return {
    entry: { id, chat, name: `${id}.md`, displayName: `${id}.md`, createdAt: '2026-11-03T00:00:00Z', updatedAt: '2026-11-03T00:00:00Z', size: 12, type: 'text', contentType: 'text/markdown', sourceMessageIds: [] },
    type: 'text', text: '# A document', readOnly: false, status: 'online', close: vi.fn(),
    onChange: () => () => {}, onStatus: () => () => {},
    presence: { self: { userId: 'reader', color: '' }, others: [], onChange: () => () => {}, set: () => {} },
  }
}
function contextFor(id: string, chat: string): Context {
  documents.set(id, makeFile(id, chat))
  return { locale: 'en', chat: { id: chat, name: chat, kind: 'group', groupId: chat }, capabilities: ['files:read', 'files:write'], file: { chat, id } }
}
let context = contextFor('plan-0', 'chat-0')
let contextChanged = (_ctx: Context) => {}
const folders = (chat = context.chat.id) => [
  { id: 'target-a', chat, name: 'Target A', displayName: 'Target A', type: 'folder' },
  { id: 'target-b', chat, name: 'Target B', displayName: 'Target B', type: 'folder' },
  documents.get(context.file?.id ?? '')!.entry,
]
const gugu = {
  getContext: vi.fn(async () => context), onContextChanged: (fn: typeof contextChanged) => { contextChanged = fn; return () => {} },
  setTabTitle: vi.fn(async () => {}), onLink: () => () => {}, linkTo: vi.fn(async () => 'gugu-file://document'),
  markdown: async () => ({ render: (element: HTMLElement, text: string) => { element.textContent = text } }),
  // Source construction must not delay the document or its file menu.
  codemirror: vi.fn(() => new Promise(() => {})),
  files: {
    open: vi.fn(async (ref: { id: string }) => { const file = documents.get(ref.id); if (!file) throw new Error('Unknown fixture document'); return file }),
    list: vi.fn(async (_place: unknown) => folders()), onChanged: vi.fn(() => () => {}),
    viewPreferences: vi.fn(async () => ({ showAppData: false })), canDelete: vi.fn(async () => [false]),
    move: vi.fn(async (_entry: unknown, _target: unknown) => {}),
  },
}
const $ = (id: string) => document.getElementById(id)!
const offered = () => [...$('menu').querySelectorAll<HTMLButtonElement>('button')]
const targets = () => [...$('move-targets').querySelectorAll<HTMLButtonElement>('button')]
const paint = () => new Promise<void>((done) => requestAnimationFrame(() => done()))
const close = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
async function show(ctx: Context) {
  context = ctx
  contextChanged(ctx)
  if (ctx.file) await vi.waitFor(() => expect($('doc-title').textContent).toBe(documents.get(ctx.file!.id)!.entry.name))
}
function clickMove() {
  $('more').click()
  const move = offered().find((button) => button.textContent === 'Move to…')!
  expect(move).toBeDefined()
  move.click()
}
beforeAll(async () => {
  document.body.innerHTML = new DOMParser().parseFromString(readFileSync(resolve('apps/desktop/preinstalled-apps/workspace/index.html'), 'utf8'), 'text/html').body.innerHTML
  Object.assign(globalThis, { gugu }); Object.assign(window, { gugu })
  // @ts-expect-error — the preinstalled App is an unbundled ES module.
  await import('../../../../apps/desktop/preinstalled-apps/workspace/app.js')
  await vi.waitFor(() => expect($('preview').textContent).toBe('# A document'))
})
beforeEach(async () => {
  close()
  gugu.files.list.mockReset().mockImplementation(async () => folders())
  gugu.files.move.mockClear()
  if (sequence++) await show(contextFor(`plan-${sequence}`, `chat-${sequence}`))
})

test('cold document paints without reading or watching its folder, even before the source module is ready', () => {
  expect($('doc-title').textContent).toBe('plan-0.md')
  expect($('preview').textContent).toBe('# A document')
  expect(gugu.files.list).not.toHaveBeenCalled()
  expect(gugu.files.onChanged).not.toHaveBeenCalled()
  expect(document.querySelector('.cm-editor')).toBeNull()
})

test('cold document Move loads both folders and moves the handed file through the existing host verb', async () => {
  const entry = documents.get(context.file!.id)!.entry
  expect(gugu.files.list).not.toHaveBeenCalled()
  clickMove()
  await vi.waitFor(() => expect(targets().map((button) => button.textContent)).toContain('Target A'))
  expect(targets().map((button) => button.textContent)).toContain('Target B')
  expect(gugu.files.list).toHaveBeenCalledWith({ chat: entry.chat })
  targets().find((button) => button.textContent === 'Target A')!.click()
  await vi.waitFor(() => expect(gugu.files.move).toHaveBeenCalledWith(entry, { folder: 'target-a' }))
})

test('a late directory response cannot open a move dialog for a different document or conversation', async () => {
  const pending = Promise.withResolvers<ReturnType<typeof folders>>()
  const oldFolders = folders()
  gugu.files.list.mockImplementationOnce(() => pending.promise)
  try {
    clickMove()
    expect(gugu.files.list).toHaveBeenCalledOnce()
    await show(contextFor('replacement', 'another-chat'))
    pending.resolve(oldFolders)
    await paint()
    expect($('move-dialog').hidden).toBe(true)
    expect(gugu.files.move).not.toHaveBeenCalled()
  } finally { pending.resolve(oldFolders); await paint(); close() }
})

test('write permission withdrawn during the directory read cannot expose move targets', async () => {
  const pending = Promise.withResolvers<ReturnType<typeof folders>>()
  const listed = folders()
  gugu.files.list.mockImplementationOnce(() => pending.promise)
  try {
    clickMove()
    expect(gugu.files.list).toHaveBeenCalledOnce()
    await show({ ...context, capabilities: ['files:read'] })
    pending.resolve(listed)
    await paint()
    expect($('move-dialog').hidden).toBe(true)
    expect(gugu.files.move).not.toHaveBeenCalled()
  } finally { pending.resolve(listed); await paint(); close() }
})

test('a refused directory read reports its error without opening an unusable move dialog', async () => {
  gugu.files.list.mockRejectedValueOnce(new Error('List refused'))
  clickMove()
  await vi.waitFor(() => expect($('banner').textContent).toContain('List refused'))
  expect($('move-dialog').hidden).toBe(true)
  expect(gugu.files.move).not.toHaveBeenCalled()
})

test('a readonly document has no Move action and does not read the folder for its menu', () => {
  documents.get(context.file!.id)!.readOnly = true
  $('more').click()
  expect(offered().map((button) => button.textContent)).not.toContain('Move to…')
  expect(gugu.files.list).not.toHaveBeenCalled()
})

test('read-only capability has no Move action and does not read the folder for its menu', async () => {
  await show({ ...context, capabilities: ['files:read'] })
  $('more').click()
  expect(offered().map((button) => button.textContent)).not.toContain('Move to…')
  expect(gugu.files.list).not.toHaveBeenCalled()
})

test('the list entry retains its already-loaded folder tree and original move verb', async () => {
  const entry = documents.get(context.file!.id)!.entry
  const listed = folders()
  gugu.files.list.mockResolvedValue(listed)
  await show({ ...context, file: undefined })
  await vi.waitFor(() => expect(document.querySelector(`[data-id="${entry.id}"]`), $('doc-message').textContent ?? 'document message').not.toBeNull())
  const reads = gugu.files.list.mock.calls.length
  document.querySelector(`[data-id="${entry.id}"]`)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  offered().find((button) => button.textContent === 'Move to…')!.click()
  expect(targets().map((button) => button.textContent)).toContain('Target A')
  expect(gugu.files.list).toHaveBeenCalledTimes(reads)
  targets().find((button) => button.textContent === 'Target A')!.click()
  await vi.waitFor(() => expect(gugu.files.move).toHaveBeenCalledWith(entry, { folder: 'target-a' }))
})
