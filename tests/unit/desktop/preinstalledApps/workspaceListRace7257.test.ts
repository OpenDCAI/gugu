// @vitest-environment jsdom
// #7257(复核 2 第 1 点):群文件夹把 files.onChanged 说的文件当场并进列表，又在打开群、上传、改名、删除之后整张重列。
// 列表在路上时听到的改动，等那张(可能是改动之前的)列表回来后再放上去一遍 —— 不被它盖掉;
// 后问的列表才是显示的那张:先问的(别的群的)晚回来，丢掉。
// 真 app.js 跑在假的运行时上(workspaceAppEntries.test.ts 的那套):每次 list 都扣住，由测试放行。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, test, vi } from 'vitest'
import { until } from '../../../support/awaitCondition'

const at = new Date(Date.now() - 3600_000).toISOString()
const entryOf = (id: string, chat: string) => ({
  id, chat, name: `${id}.md`, displayName: `${id}.md`, contentType: 'text/markdown', type: 'text', size: 1,
  createdAt: at, updatedAt: at, createdBy: { id: 'u1', name: '张三', kind: 'human' }, sourceMessageIds: [],
})
type Entry = ReturnType<typeof entryOf>
type Ctx = { chat: { id: string; name: string; kind: 'group'; groupId: string }; locale: string; capabilities: string[] }
const ctxOf = (chat: string): Ctx => ({ chat: { id: chat, name: chat, kind: 'group', groupId: chat }, locale: 'zh-CN', capabilities: ['files:read', 'files:write'] })
let contextChanged: (ctx: Ctx) => void = () => {}
let heard: (change: unknown) => void = () => {}
/** Each list asked, held open until the test answers it. */
const lists: { chat: string; answered: boolean; answer: (entries: Entry[]) => void }[] = []
const out = (chat: string) => lists.filter((list) => list.chat === chat && !list.answered)
const answer = (list: (typeof lists)[number], entries: Entry[]) => {
  list.answered = true
  list.answer(entries)
}

const gugu = {
  linkTo: vi.fn(async ({ file }: { file: { id: string } }) => `gugu-file://${file.id}`),
  setTabTitle: vi.fn(async () => {}),
  getContext: vi.fn(async () => ctxOf('chat-1')),
  onContextChanged: vi.fn((fn: typeof contextChanged) => {
    contextChanged = fn
    return () => {}
  }),
  openBrowserTab: vi.fn(async () => {}),
  onLink: vi.fn(() => () => {}),
  showMessage: vi.fn(async () => {}),
  files: {
    list: vi.fn((place: { chat: string }) => new Promise<Entry[]>((done) => lists.push({ chat: place.chat, answered: false, answer: done }))),
    onChanged: vi.fn((_place: unknown, fn: typeof heard) => {
      heard = fn
      return () => {}
    }),
    open: vi.fn(async () => { throw new Error('rig: no file service here') }),
    create: vi.fn(),
    remove: vi.fn(),
    openWith: vi.fn(async () => {}),
    upload: vi.fn(async () => []),
    download: vi.fn(async () => true),
  },
}
const $ = (id: string) => document.getElementById(id) as HTMLElement
const listed = () => [...$('file-list').querySelectorAll<HTMLElement>('.file')].map((li) => li.dataset.id).sort()
/** A task boundary: every microtask an answered list queued has run (not a wall-clock wait). */
const settled = () => new Promise<void>((done) => setTimeout(done, 0))

beforeAll(async () => {
  const page = new DOMParser().parseFromString(readFileSync(resolve(__dirname, '../../../../apps/desktop/preinstalled-apps/workspace/index.html'), 'utf8'), 'text/html')
  document.body.innerHTML = page.body.innerHTML
  for (const attr of Array.from(page.body.attributes)) document.body.setAttribute(attr.name, attr.value)
  Object.assign(globalThis, { gugu })
  Object.assign(window, { gugu })
  // @ts-expect-error — 内置 App 是不经构建的纯 ES module,没有类型;运行时 import 可用。
  await import('../../../../apps/desktop/preinstalled-apps/workspace/app.js')
})

describe('group folder: what the chat says while its list is on its way (#7257)', () => {
  test('a file made while the list is out, the list from before it: the file stays — and the list is not asked again', async () => {
    await until('chat-1 is listed', () => out('chat-1').length === 1)
    heard({ kind: 'entries', entries: [entryOf('x', 'chat-1')], gone: [] })
    expect(listed(), 'taken in at once').toEqual(['x'])
    answer(out('chat-1')[0]!, [entryOf('plan', 'chat-1')])
    await until('chat-1 list drawn', () => listed().includes('plan'))
    await settled()
    expect(listed(), '对照:父提交里那张改动之前的列表把 x 盖掉了').toEqual(['plan', 'x'])
    expect(lists.filter((list) => list.chat === 'chat-1')).toHaveLength(1)
  }, 30_000)

  test('control: the list back first, the file heard after', async () => {
    contextChanged(ctxOf('chat-2'))
    await until('chat-2 is listed', () => out('chat-2').length === 1)
    answer(out('chat-2')[0]!, [entryOf('plan2', 'chat-2')])
    await until('chat-2 list drawn', () => listed().includes('plan2'))
    heard({ kind: 'entries', entries: [entryOf('y', 'chat-2')], gone: [] })
    expect(listed()).toEqual(['plan2', 'y'])
  }, 30_000)

  test('a file deleted while the list is out, the list from before the delete: it does not come back', async () => {
    contextChanged(ctxOf('chat-3'))
    await until('chat-3 is listed', () => out('chat-3').length === 1)
    heard({ kind: 'entries', entries: [], gone: ['old'] })
    answer(out('chat-3')[0]!, [entryOf('keep', 'chat-3'), entryOf('old', 'chat-3')])
    await until('chat-3 list drawn', () => listed().includes('keep'))
    await settled()
    expect(listed()).toEqual(['keep'])
  }, 30_000)

  test('two chats\' lists out: the one asked last is shown — the other, back later, is dropped', async () => {
    contextChanged(ctxOf('chat-4'))
    await until('chat-4 is listed', () => out('chat-4').length === 1)
    contextChanged(ctxOf('chat-5'))
    await until('chat-5 is listed', () => out('chat-5').length === 1)
    answer(out('chat-5')[0]!, [entryOf('five', 'chat-5')])
    await until('chat-5 list drawn', () => listed().includes('five'))
    answer(out('chat-4')[0]!, [entryOf('four', 'chat-4')])
    await settled()
    expect(listed()).toEqual(['five'])
  }, 30_000)
})
