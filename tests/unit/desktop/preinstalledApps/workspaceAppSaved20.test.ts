// @vitest-environment jsdom
// 摩擦单 F20(L5,S1 复跑 cf4e6772f):B 用工作区 App 打开一个 JSON,一个字没改,头上一直是「Saving」。
// 修在运行时:`saved` 一变,onStatus 就触发(open-file.ts);App 只跟着 onStatus 画,不再每 400 ms 轮询(审计 C2)。
// 这里的运行时是假的:saved 变 true 时,照真运行时那样发一次 onStatus。
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
  await vi.waitFor(() => expect(gugu.files.open).toHaveBeenCalled())
})

describe('workspace App: the save badge of a file opened and left alone (F20)', () => {
  test('Saving while the server has not confirmed yet, then Saved when the runtime says saved moved — no change needed', async () => {
    await vi.waitFor(() => expect(status()).toBe('Saving'))
    saved = true
    statusChanged('online')
    expect(status()).toBe('Saved')
  })
})
