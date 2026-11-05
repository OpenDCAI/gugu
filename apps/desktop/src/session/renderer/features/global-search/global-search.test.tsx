// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import React, { act } from 'react'
import { runInAction } from 'mobx'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { conversationLink } from '@gugu/core/shared/ui/guguLink'
import { messageQuoteLink } from '@gugu/core/shared/ui/messageQuote'
import { publishChatSummaries } from '@/lib/chatSummariesBridge'
import { takeTaskReveal } from '@/hooks/useSourceMessageReveal'
import type { TaskTurnHit } from '@shared/core/search'
import { GlobalSearch } from './global-search'
import { messageKinds } from './use-global-search'
import { resetSearchSession, updateSearchSession, useSearchSession, type SearchSession } from './search-session'
import { installIdentityDirectoryBridge, publishIdentityDirectory } from '@/lib/identityDirectoryBridge'
import { publishSelfIdentity } from '@/lib/selfIdentityBridge'
import { dicebearAvatarDataUri } from '@/lib/dicebearAvatar'
import { displayIdentity } from '../../../../../../../tests/support/testHarness'
import { sessionAgentBindings } from '../sessions/stores/session-agent-bindings'
import { installPhoneImeDismiss } from '@/mobile/usePhoneImeDismiss'

const remote = vi.hoisted(() => ({ opened: [] as unknown[], turns: vi.fn(), indexStatus: vi.fn(), messages: vi.fn(), firstOfDay: vi.fn(), viewFilters: [] as unknown[][] }))
vi.mock('@/lib/guguLinks', () => ({ followLink: (target: unknown) => { remote.opened.push(target); return true } }))
vi.mock('@renderer/lib/ipc', async (original) => ({
  ...await original<typeof import('@renderer/lib/ipc')>(),
  rpc: { search: { taskTurns: remote.turns, taskTurnIndexStatus: remote.indexStatus } },
}))
vi.mock('@/lib/supabase', () => ({ chatDb: { rpc: remote.messages, from: (table: string) => {
  // The one REST read: messages_view, filtered and ordered, first row (firstMessageOn). Records the filters it was given.
  const chain: Record<string, (...args: unknown[]) => unknown> = {}
  for (const name of ['select', 'eq', 'neq', 'is', 'gte', 'order']) chain[name] = (...args: unknown[]) => { remote.viewFilters.push([table, name, ...args]); return chain }
  chain.limit = async () => remote.firstOfDay()
  return chain
} } }))
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string, params?: object) => params ? `${key} ${JSON.stringify(params)}` : key }) }))

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
Element.prototype.scrollIntoView ??= () => {}

const GROUP = '0b1e7c1a-0000-4000-8000-000000000001'
const OTHER = '0b1e7c1a-0000-4000-8000-000000000002'
const NEW = '0b1e7c1a-0000-4000-8000-0000000000aa'
const OLD = '0b1e7c1a-0000-4000-8000-0000000000bb'
const turn: TaskTurnHit = { sessionId: 's1', projectId: 'p1', title: '发布排查', archived: false, itemId: 's1:turn:s3:m', role: 'assistant', excerpt: '已经把回滚开关打开了', at: '2026-10-31 08:00:00' }
const rows = [
  { id: NEW, chat_id: GROUP, sender_user_id: 'u1', sender_name: '阿威', content_type: 'text', content: '收到，回滚脚本已经演练过', created_at: '2026-10-31T09:00:00Z', file_item_id: null },
  { id: OLD, chat_id: OTHER, sender_user_id: 'u2', sender_name: '小林', content_type: 'attachment', content: '回滚方案.pdf', created_at: '2026-10-30T09:00:00Z', file_item_id: 'f1' },
]
const systemRow = { ...rows[0]!, id: 'system-row', sender_user_id: null, sender_name: '未知用户', content_type: 'system', content: 'Codex 1 加入了群聊' }

let host: HTMLDivElement
let root: Root
let closed = 0
const ensureIdentity = vi.fn()
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  remote.opened = []
  closed = 0
  remote.turns.mockReset().mockResolvedValue([turn])
  remote.indexStatus.mockReset().mockResolvedValue({ state: 'ready' })
  focusManager.setFocused(true)
  remote.messages.mockReset().mockResolvedValue({ data: rows, error: null })
  remote.firstOfDay.mockReset(); remote.viewFilters = []
  publishSelfIdentity({ userId: 'me-1', displayName: null, guguNumber: null })
  localStorage.clear()
  installIdentityDirectoryBridge()
  publishIdentityDirectory({}, ensureIdentity.mockReset())
  runInAction(() => sessionAgentBindings.bindings.clear())
  publishChatSummaries([
    { id: GROUP, kind: 'group', unread_count: 0, name: '搜索测试群甲', last_message_at: '2026-10-31T00:00:00Z' },
    { id: OTHER, kind: 'group', unread_count: 0, name: '设计组', last_message_at: '2026-10-31T00:00:00Z' },
  ])
  resetSearchSession()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  focusManager.setFocused(undefined)
  await act(async () => root.unmount())
  host.remove()
  publishIdentityDirectory(null, null)
  runInAction(() => sessionAgentBindings.bindings.clear())
})

// The typed text settles after the panel's debounce; the two queries answer on the next turns.
const settle = async () => { for (let round = 0; round < 3; round++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)) }) }
async function render(text: string, tasks = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => root.render(<QueryClientProvider client={client}><GlobalSearch tasks={tasks} onClose={() => {}} onOpen={() => { closed++ }} /><SessionProbe /></QueryClientProvider>))
  await act(async () => updateSearchSession({ text }))
  await settle()
}
// React reads a controlled-or-not input's change through the native value setter, as a real date pick does.
const setDate = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}
let latestSession: SearchSession | null = null
function SessionProbe() { latestSession = useSearchSession(); return null }
const sessionSnapshot = () => latestSession
const options = () => [...host.querySelectorAll<HTMLElement>('[role=option]')]
const headers = () => [...host.querySelectorAll<HTMLElement>('[role=listbox] > button:not([role=option])')].map((button) => button.textContent)
const tab = (key: string) => [...host.querySelectorAll<HTMLElement>('[role=tab]')].find((button) => button.textContent!.startsWith(key))!

describe('global search sender avatars', () => {
  const photo = 'https://db.example/storage/v1/object/public/avatars/sender.png'

  it.each(['agent', 'human'] as const)('shows the %s sender photo through the real Avatar', async (type) => {
    publishIdentityDirectory({ u1: displayIdentity('u1', { type, display_name: 'Sender', avatar: photo }) }, ensureIdentity)
    await render('回滚')
    const image = options()[0]!.querySelector<HTMLImageElement>('img')
    expect(image?.src).toBe(photo)
    expect(image?.alt).toBe('Sender')
    expect(image?.style.width).toBe('20px')
    expect(image?.style.height).toBe('20px')
    expect(!!options()[0]!.querySelector('[data-agent]')).toBe(type === 'agent')
  })

  it('keeps the sender-id placeholder when the display name changes', async () => {
    publishIdentityDirectory({ u1: displayIdentity('u1', { avatar: null }) }, ensureIdentity)
    await render('回滚')
    expect(options()[0]!.querySelector('img')?.getAttribute('src')).toBe(dicebearAvatarDataUri('u1'))
    await act(async () => publishIdentityDirectory({ u1: displayIdentity('u1', { display_name: 'Renamed', avatar: null }) }, ensureIdentity))
    expect(options()[0]!.querySelector('img')?.getAttribute('src')).toBe(dicebearAvatarDataUri('u1'))
  })

  it('replaces a missing identity placeholder without querying again or changing the selected result', async () => {
    await render('回滚')
    const input = host.querySelector<HTMLInputElement>('[data-testid=global-search-input]')!
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    const selected = options().find((option) => option.getAttribute('aria-selected') === 'true')
    expect(ensureIdentity).toHaveBeenCalledWith(['u1'])
    expect(options()[0]!.querySelector('img')?.getAttribute('src')).toBe(dicebearAvatarDataUri('u1'))
    const messageCalls = remote.messages.mock.calls.length
    const taskCalls = remote.turns.mock.calls.length
    await act(async () => publishIdentityDirectory({ u1: displayIdentity('u1', { avatar: photo }) }, ensureIdentity))
    expect(options()[0]!.querySelector('img')?.getAttribute('src')).toBe(photo)
    expect(options().find((option) => option.getAttribute('aria-selected') === 'true')).toBe(selected)
    expect(remote.messages).toHaveBeenCalledTimes(messageCalls)
    expect(remote.turns).toHaveBeenCalledTimes(taskCalls)
  })

  it('keeps the file icon even when the sender has a photo', async () => {
    publishIdentityDirectory({ u2: displayIdentity('u2', { avatar: photo }) }, ensureIdentity)
    await render('回滚')
    const fileAvatar = options()[2]!.firstElementChild!
    expect(fileAvatar.querySelector('img')).toBeNull()
    expect(fileAvatar.querySelector('svg')).not.toBeNull()
  })

  it('follows the existing task-agent binding and keeps an unbound turn unchanged', async () => {
    publishIdentityDirectory({ agent: displayIdentity('agent', { type: 'agent', avatar: photo }) }, ensureIdentity)
    await render('回滚')
    expect(options()[1]!.firstElementChild?.textContent).toBe('g')
    await act(async () => sessionAgentBindings.note('s1', 'agent'))
    expect(options()[1]!.querySelector('img')?.getAttribute('src')).toBe(photo)
  })

  it('keeps the user side of a task unchanged even when that task has an agent binding', async () => {
    sessionAgentBindings.note('s1', 'agent')
    publishIdentityDirectory({ agent: displayIdentity('agent', { type: 'agent', avatar: photo }) }, ensureIdentity)
    remote.turns.mockResolvedValue([{ ...turn, role: 'user' }])
    await render('回滚')
    expect(options()[1]!.firstElementChild?.textContent).toBe('g')
    expect(options()[1]!.querySelector('img')).toBeNull()
  })
})

describe('global search panel', () => {
  for (const tasks of [true, false]) {
    const surface = tasks ? 'desktop' : 'phone chat-only entry'
    it(`excludes system rows from ${surface} search without losing ordinary messages (U-A)`, async () => {
      remote.turns.mockResolvedValue([])
      remote.messages.mockResolvedValue({ data: [systemRow, { ...rows[0]!, content: '收到加入了群聊的通知' }], error: null })
      await render('加入了群聊', tasks)
      expect(options()).toHaveLength(1)
      expect(options()[0]!.textContent).toContain('收到加入了群聊的通知')
      expect(host.textContent).not.toContain('Codex 1')
      expect(tab('globalSearch.facet.message').textContent).toBe('globalSearch.facet.message1')
    })

    it(`shows a neutral system identity for a senderless non-system hit in ${surface} search (U-B)`, async () => {
      // A cannot hide this case: a senderless text row must pass through the real mapping and rendering.
      remote.turns.mockResolvedValue([])
      remote.messages.mockResolvedValue({ data: [{ ...systemRow, content_type: 'text' }], error: null })
      await render('加入了群聊', tasks)
      expect(options()).toHaveLength(1)
      expect(options()[0]!.textContent).toContain('globalSearch.system')
      expect(host.textContent).not.toContain('未知用户')
      const avatar = options()[0]!.firstElementChild!
      expect(avatar.querySelector('svg')).not.toBeNull()
      expect(avatar.textContent).toBe('')
    })
  }

  it('keeps a real-user from chip filtering by sender id (U-from)', async () => {
    remote.messages.mockResolvedValue({ data: [systemRow, ...rows], error: null })
    await act(async () => updateSearchSession({ chips: [{ kind: 'from', userId: 'u1', name: '阿威' }] }))
    await render('回滚')
    expect(options()).toHaveLength(1)
    expect(options()[0]!.textContent).toContain('阿威')
    expect(options()[0]!.textContent).not.toContain('小林')
    expect(remote.turns).not.toHaveBeenCalled()
    expect(remote.messages).toHaveBeenCalledWith('message_search_as', { p_chat_id: null, p_query: '回滚', p_limit: 100 })
  })

  it('the phone IME dismisses after Enter still opens the selected message (#1385)', async () => {
    const remove = installPhoneImeDismiss(document)
    try {
      await render('回滚', false)
      const input = host.querySelector<HTMLInputElement>('[data-testid=global-search-input]')!
      input.focus()
      await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
      expect(remote.opened).toEqual([conversationLink(GROUP, NEW)])
      expect(closed).toBe(1)
      expect(document.activeElement).toBe(document.body)
    } finally { remove() }
  })
  it('searches local task content while indexing and refreshes the same query when ready', async () => {
    remote.indexStatus.mockResolvedValue({ state: 'preparing', done: 42, total: 100 })
    await render('回滚')
    expect(remote.turns).toHaveBeenCalledWith({ query: '回滚', limit: 100 })
    expect(host.querySelector('[role=status]')?.textContent).toBe('globalSearch.indexingTasksProgress {"percent":42}')
    expect(options()).toHaveLength(3)
    expect(host.textContent).not.toContain('globalSearch.emptyFor')
    remote.indexStatus.mockResolvedValue({ state: 'ready' })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 2_200)) })
    expect(remote.turns).toHaveBeenCalledWith({ query: '回滚', limit: 100 })
    expect(host.querySelector('[role=status]')).toBeNull()
    expect(options()).toHaveLength(3)
  })

  it('reports an indexing failure while still searching local task content', async () => {
    remote.indexStatus.mockResolvedValue({ state: 'failed' })
    await render('回滚')
    expect(options()).toHaveLength(3)
    expect(host.querySelector('[role=alert]')?.textContent).toBe('globalSearch.indexingTasksFailed')
    expect(host.textContent).not.toContain('globalSearch.emptyFor')
    expect(remote.turns).toHaveBeenCalledWith({ query: '回滚', limit: 100 })
  })
  it('lists chat messages and task content newest first, grouped by where they were said, the whole word highlighted', async () => {
    await render('回滚')
    expect(remote.messages).toHaveBeenCalledWith('message_search_as', { p_chat_id: null, p_query: '回滚', p_limit: 100 })
    expect(remote.turns).toHaveBeenCalledWith({ query: '回滚', limit: 100 })
    expect(headers()).toEqual(['搜索测试群甲', '发布排查· globalSearch.task', '设计组'])
    expect(options().map((option) => option.querySelector('mark')?.textContent)).toEqual(['回滚', '回滚', '回滚'])
    expect(tab('globalSearch.facet.all').textContent).toBe('globalSearch.facet.all3')
    expect(tab('globalSearch.facet.message').textContent).toBe('globalSearch.facet.message2')
    expect(tab('globalSearch.facet.file').textContent).toBe('globalSearch.facet.file1')
  })

  it('Tab moves through the filters; a filter shows only its hits', async () => {
    await render('回滚')
    const input = host.querySelector<HTMLInputElement>('[data-testid=global-search-input]')!
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })) })
    expect(tab('globalSearch.facet.message').getAttribute('aria-selected')).toBe('true')
    expect(options()).toHaveLength(2)
    await act(async () => tab('globalSearch.facet.task').click())
    expect(options().map((option) => option.textContent)).toEqual([expect.stringContaining('已经把回滚开关打开了')])
  })

  it('a group header narrows to that conversation, asking the cloud for that chat only and not the tasks', async () => {
    await render('回滚')
    remote.turns.mockClear()
    await act(async () => [...host.querySelectorAll<HTMLElement>('[role=listbox] > button:not([role=option])')][0]!.click())
    await settle()
    expect(remote.messages).toHaveBeenCalledWith('message_search_as', { p_chat_id: GROUP, p_query: '回滚', p_limit: 100 })
    expect(remote.turns).not.toHaveBeenCalled()
  })

  it('typed in: resolves to a conversation by name; an unknown one finds nothing instead of searching everywhere', async () => {
    await render('in:设计 回滚')
    expect(remote.messages).toHaveBeenCalledWith('message_search_as', { p_chat_id: OTHER, p_query: '回滚', p_limit: 100 })
    remote.messages.mockClear()
    await act(async () => updateSearchSession({ text: 'in:不存在的群 回滚' }))
    await settle()
    expect(remote.messages).not.toHaveBeenCalled()
    expect(host.textContent).toContain('globalSearch.unresolved')
  })

  it('Enter opens the selected hit at its message; a task hit opens the task at the found item', async () => {
    await render('回滚')
    const input = host.querySelector<HTMLInputElement>('[data-testid=global-search-input]')!
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(closed).toBe(1)
    expect(remote.opened).toEqual([conversationLink(GROUP, NEW)])
    await act(async () => options()[1]!.click())
    expect(remote.opened[1]).toEqual({ kind: 'session', sessionId: 's1', projectId: 'p1' })
    expect(takeTaskReveal('s1')).toBe(messageQuoteLink({ kind: 'session', sessionId: 's1', itemId: 's1:turn:s3:m' }))
  })

  it('scoped to one conversation, a line counts the hits in every other one and widens to them', async () => {
    await act(async () => updateSearchSession({ chips: [{ kind: 'in', chatId: GROUP }] }))
    await render('回滚')
    expect(remote.messages).toHaveBeenCalledWith('message_search_as', { p_chat_id: GROUP, p_query: '回滚', p_limit: 100 })
    expect(remote.messages).toHaveBeenCalledWith('message_search_as', { p_chat_id: null, p_query: '回滚', p_limit: 100 })
    const elsewhere = host.querySelector<HTMLElement>('[data-testid=global-search-elsewhere]')!
    expect(elsewhere.textContent).toBe('globalSearch.elsewhere {"count":"1"}')
    await act(async () => elsewhere.click())
    await settle()
    expect(host.querySelector('[data-testid=global-search-elsewhere]')).toBeNull()
    expect(headers()).toEqual(['搜索测试群甲', '发布排查· globalSearch.task', '设计组'])
  })

  it('with nothing typed in one conversation it offers the quick filters; a kind of message is a search with no words', async () => {
    await act(async () => updateSearchSession({ chips: [{ kind: 'in', chatId: GROUP }] }))
    await render('')
    const quick = [...host.querySelectorAll<HTMLElement>('[data-testid=global-search-quick] button')].map((button) => button.dataset.quick)
    expect(quick).toEqual(['member', 'date', 'media', 'file', 'link', 'mention'])
    await act(async () => host.querySelector<HTMLElement>('[data-quick=file]')!.click())
    await settle()
    expect(remote.messages).toHaveBeenCalledWith('message_search_as', { p_chat_id: GROUP, p_query: '', p_limit: 100 })
    expect(options().map((option) => option.textContent)).toEqual([expect.stringContaining('回滚方案.pdf')])
    expect(host.textContent).toContain('globalSearch.kind.file')
  })

  it('@我 lists the messages that mention the signed-in user, in either mention form', async () => {
    const mention = { ...rows[0]!, id: 'mention-row', content: '@[srchu](user:me-1) 回滚之前看一下', sender_user_id: 'u2', sender_name: '小林' }
    remote.messages.mockResolvedValue({ data: [mention, ...rows], error: null })
    await act(async () => updateSearchSession({ chips: [{ kind: 'in', chatId: GROUP }] }))
    await render('')
    await act(async () => host.querySelector<HTMLElement>('[data-quick=mention]')!.click())
    await settle()
    expect(options().map((option) => option.textContent)).toEqual([expect.stringContaining('回滚之前看一下')])
  })

  it('without a conversation in scope the member and date filters are not offered', async () => {
    await render('')
    expect([...host.querySelectorAll<HTMLElement>('[data-testid=global-search-quick] button')].map((button) => button.dataset.quick)).toEqual(['media', 'file', 'link', 'mention'])
  })

  it('a date alone opens that day’s first message of the conversation', async () => {
    remote.firstOfDay.mockResolvedValue({ data: [{ id: OLD }], error: null })
    await act(async () => updateSearchSession({ chips: [{ kind: 'in', chatId: GROUP }] }))
    await render('')
    const input = host.querySelector<HTMLInputElement>('input[type=date]')!
    await act(async () => setDate(input, '2026-10-30'))
    await settle()
    expect(remote.viewFilters).toContainEqual(['messages_view', 'eq', 'chat_id', GROUP])
    expect(remote.viewFilters).toContainEqual(['messages_view', 'neq', 'content_type', 'system'])
    expect(remote.viewFilters).toContainEqual(['messages_view', 'gte', 'created_at', new Date('2026-10-30T00:00:00').toISOString()])
    expect(closed).toBe(1)
    expect(remote.opened).toEqual([conversationLink(GROUP, OLD)])
  })

  it('a date with no message on or after it says so and opens nothing', async () => {
    remote.firstOfDay.mockResolvedValue({ data: [], error: null })
    await act(async () => updateSearchSession({ chips: [{ kind: 'in', chatId: GROUP }] }))
    await render('')
    const input = host.querySelector<HTMLInputElement>('input[type=date]')!
    await act(async () => setDate(input, '2026-11-04'))
    await settle()
    expect(host.querySelector('[role=status]')?.textContent).toBe('globalSearch.noMessageFrom {"date":"2026-11-04"}')
    expect(closed).toBe(0)
  })

  it('opening a message hit starts the trail over the message hits and remembers the words for this conversation', async () => {
    await act(async () => updateSearchSession({ chips: [{ kind: 'in', chatId: GROUP }] }))
    await render('回滚')
    await act(async () => options()[1]!.click())
    const { trail } = JSON.parse(JSON.stringify(sessionSnapshot()))
    expect(trail).toEqual({ hits: [{ chatId: GROUP, messageId: NEW }, { chatId: OTHER, messageId: OLD }], index: 1, query: '回滚' })
    expect(remote.opened).toEqual([conversationLink(OTHER, OLD)])
    await act(async () => updateSearchSession({ text: '' }))
    await settle()
    expect([...host.querySelectorAll('[data-testid=global-search-recent] button')].map((button) => button.textContent)).toEqual(['回滚'])
  })

  it('without local tasks (the phone) it searches chats only and has no task filter', async () => {
    await render('回滚', false)
    expect(remote.turns).not.toHaveBeenCalled()
    expect([...host.querySelectorAll('[role=tab]')].map((button) => button.textContent!.replace(/\d+$/, ''))).toEqual(['globalSearch.facet.all', 'globalSearch.facet.message', 'globalSearch.facet.file'])
  })
})

describe('quick-filter kinds', () => {
  const kinds = (row: { content_type: string; content: string | null; file_item_id: string | null }) => [...messageKinds(row, 'me-1')].sort()
  it('tells pictures and videos from other files, links from attachments, and finds an @ of me in either mention form', () => {
    const picture = ['[附件] 海报.png', '[URL] https://db.example/a.png', '[Size] 100', '[Kind] image'].join('\n')
    const video = ['[附件] 展览.mp4', '[URL] https://db.example/a.mp4', '[Size] 100', '[Kind] file'].join('\n')
    const sheet = ['[附件] 预算.xlsx', '[URL] https://db.example/a.xlsx', '[Size] 100', '[Kind] file'].join('\n')
    expect(kinds({ content_type: 'attachment', content: picture, file_item_id: null })).toEqual(['media'])
    expect(kinds({ content_type: 'attachment', content: video, file_item_id: null })).toEqual(['media'])
    expect(kinds({ content_type: 'attachment', content: sheet, file_item_id: null })).toEqual(['file'])
    expect(kinds({ content_type: 'text', content: '看这个 https://example.com/x', file_item_id: null })).toEqual(['link'])
    expect(kinds({ content_type: 'text', content: '@[小明](user:me-1) 你看下', file_item_id: null })).toEqual(['mention'])
    expect(kinds({ content_type: 'text', content: '@user:me-1 在吗', file_item_id: null })).toEqual(['mention'])
    expect(kinds({ content_type: 'text', content: '@[别人](user:other) 普通一句', file_item_id: null })).toEqual([])
  })
})
