// @vitest-environment jsdom
// Save acknowledgments still emit onStatus (F20); ordinary typing must not flash a caption (#320).
// The runtime is the boundary here: status and saved move as they do on the real file.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, test, vi } from 'vitest'

const entry = {
  id: 'cfg', name: 'cfg.json', displayName: 'cfg.json', contentType: 'application/json', type: 'json', size: 2,
  createdAt: null, updatedAt: null, createdBy: { id: 'u1', name: 'A', kind: 'human' }, sourceMessageIds: [],
}
let saved = false
let statusChanged: (status: string) => void = () => {}
const file = {
  entry,
  type: 'json',
  readOnly: false,
  status: 'online',
  get saved() {
    return saved
  },
  data: {},
  toJSON: () => ({}),
  transact: (fn: () => void) => fn(),
  onChange: vi.fn(() => () => {}),
  onStatus: vi.fn((handler: (status: string) => void) => {
    statusChanged = handler
    return () => {}
  }),
  onRefused: vi.fn(() => () => {}),
  close: vi.fn(),
  presence: { self: { userId: 'u2', color: '' }, others: [], onChange: () => () => {}, set: () => {} },
}

const gugu = {
  linkTo: vi.fn(async ({ file }: { file: { id: string } }) => `gugu-file://${file.id}`),
  setTabTitle: vi.fn(async () => {}),
  getContext: vi.fn(async () => ({ chat: { id: 'chat-1', name: 'G', kind: 'group', groupId: 'chat-1' }, file: { chat: 'chat-1', id: 'cfg' }, locale: 'en', capabilities: [] })),
  onContextChanged: vi.fn(() => () => {}),
  onLink: vi.fn(() => () => {}),
  // The editor is not what this measures; it never arrives here.
  codemirror: vi.fn(() => new Promise(() => {})),
  files: {
    list: vi.fn(async () => [entry]),
    onChanged: vi.fn(() => () => {}),
    open: vi.fn(async () => file),
  },
}

const status = () => (document.getElementById('doc-status') as HTMLElement).textContent

beforeAll(async () => {
  const html = readFileSync(resolve(process.cwd(), 'apps/desktop/preinstalled-apps/workspace/index.html'), 'utf8')
  const page = new DOMParser().parseFromString(html, 'text/html')
  document.body.innerHTML = page.body.innerHTML
  Object.assign(globalThis, { gugu })
  Object.assign(window, { gugu })
  // @ts-expect-error — 内置 App 是不经构建的纯 ES module,没有类型;运行时 import 可用。
  await import('../../../../apps/desktop/preinstalled-apps/workspace/app.js')
  await vi.waitFor(() => expect(file.onStatus).toHaveBeenCalled())
})

describe('workspace App: quiet save acknowledgments', () => {
  test('ordinary online edits stay quiet, while read-only and offline states remain visible', () => {
    expect(status()).toBe('')
    saved = true
    statusChanged('online')
    expect(status()).toBe('')
    saved = false
    statusChanged('online')
    expect(status()).toBe('')
    file.readOnly = true
    statusChanged('online')
    expect(status()).toBe('Read-only')
    file.readOnly = false
    statusChanged('offline')
    expect(status()).toBe('Offline: changes catch up when back online')
    expect(document.getElementById('banner')?.hidden).toBe(false)
    statusChanged('online')
    expect(status()).toBe('')
    expect(document.getElementById('banner')?.hidden).toBe(true)
  })
})
