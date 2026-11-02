// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { publishChatSummaries } from '@/lib/chatSummariesBridge'
import { installIdentityDirectoryBridge, publishIdentityDirectory } from '@/lib/identityDirectoryBridge'
import { GlobalSearch } from './global-search'
import { resetSearchSession } from './search-session'

const remote = vi.hoisted(() => ({ messages: vi.fn(), turns: vi.fn(), titles: vi.fn() }))
const WORK = '0b1e7c1a-0000-4000-8000-000000000001'
const WORKSHOP = '0b1e7c1a-0000-4000-8000-000000000002'
const OTHER = '0b1e7c1a-0000-4000-8000-000000000003'
vi.mock('@renderer/lib/ipc', () => ({ rpc: { search: { taskTurns: remote.turns, commandPalette: remote.titles } } }))
vi.mock('@/lib/supabase', () => ({ chatDb: { rpc: remote.messages } }))
vi.mock('@/lib/guguLinks', () => ({ followLink: vi.fn() }))
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }))

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
Element.prototype.scrollIntoView ??= () => {}
let host: HTMLDivElement
let root: Root
let client: QueryClient
const input = () => host.querySelector<HTMLInputElement>('[data-testid=global-search-input]')!
const options = () => [...host.querySelectorAll<HTMLElement>('[role=option]')]
const settle = async () => {
  // Debounce changes the query in one React turn; QueryClient notifies on the next timer turn.
  for (let round = 0; round < 2; round++) await act(async () => { await vi.advanceTimersByTimeAsync(150) })
}
async function type(text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), text)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settle()
}
async function key(key: string) {
  await act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })
  await settle()
}
async function render(tasks = true) {
  await act(async () => root.render(<QueryClientProvider client={client}><GlobalSearch tasks={tasks} onClose={() => {}} /></QueryClientProvider>))
  await settle()
}

beforeEach(() => {
  vi.useFakeTimers()
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  remote.messages.mockReset().mockResolvedValue({ data: [
    { id: '0b1e7c1a-0000-4000-8000-000000000011', chat_id: WORK, sender_user_id: 'u1', sender_name: 'A', content: '回填说明', created_at: '2026-11-02T09:00:00Z', file_item_id: null },
    { id: '0b1e7c1a-0000-4000-8000-000000000012', chat_id: OTHER, sender_user_id: 'u2', sender_name: 'B', content: '回填.pdf', created_at: '2026-11-02T08:00:00Z', file_item_id: 'f1' },
  ], error: null })
  remote.turns.mockReset().mockResolvedValue([
    { sessionId: 's1', projectId: 'p1', title: 'work task', itemId: 'i1', role: 'assistant', excerpt: '回填完成', at: '2026-11-02T07:00:00Z' },
    { sessionId: 's2', projectId: 'p1', title: 'other task', itemId: 'i2', role: 'assistant', excerpt: '回填开始', at: '2026-11-02T06:00:00Z' },
  ])
  remote.titles.mockReset().mockResolvedValue([{ kind: 'session', id: 's1', projectId: 'p1', title: 'work task' }])
  publishChatSummaries([
    { id: WORK, kind: 'group', name: 'work', unread_count: 0 },
    { id: WORKSHOP, kind: 'group', name: 'workshop', unread_count: 0 },
  ])
  resetSearchSession()
  installIdentityDirectoryBridge()
  publishIdentityDirectory({ u1: {
    id: 'u1', display_name: '张伟', type: 'human', avatar: null, gugu_number: null, bio: null, owner_user_id: null,
    agent_public: null, desired_status: null, device_id: null, category: null, is_official: null, local_path: null, created_at: null, updated_at: null,
  } }, null)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  client.clear(); host.remove(); vi.useRealTimers()
  publishIdentityDirectory(null, null)
})

describe('explicit search prefixes', () => {
  it('offers all five prefixes before searching and replaces the old facet row', async () => {
    await render()
    expect(options().map((row) => row.textContent)).toEqual([
      expect.stringContaining('in:'), expect.stringContaining('from:'), expect.stringContaining('is:task'),
      expect.stringContaining('is:chat'), expect.stringContaining('has:file'),
    ])
    expect(remote.messages).not.toHaveBeenCalled()
    expect(host.querySelector('[role=tablist]')).toBeNull()
  })

  it.each(['in:wo', 'in：wo'])('requires selection for %s, then retains only the search words in the input', async (prefix) => {
    await render()
    await type(`${prefix} 回填`)
    expect(remote.messages).not.toHaveBeenCalled()
    expect(options()[0]?.textContent).toContain('work')
    await key('Tab')
    expect(input().value).toBe('回填')
    expect(host.querySelector('button[aria-label="globalSearch.removeChip"]')).not.toBeNull()
    expect(remote.messages).toHaveBeenLastCalledWith('message_search_as', { p_chat_id: WORK, p_query: '回填', p_limit: 100 })
  })

  it('includes local task names in in: completion and searches only the chosen task', async () => {
    await render()
    await type('in:work task')
    const task = options().find((row) => row.textContent?.includes('work task'))
    expect(task).toBeDefined()
    await act(async () => task!.click())
    await type('回填')
    expect(remote.messages).not.toHaveBeenCalled()
    expect(options()).toHaveLength(1)
    expect(options()[0]!.textContent).toContain('回填完成')
  })

  it('uses the shared pinyin ranking for from: and commits the chosen identity', async () => {
    await render()
    await type('from：zhang 回填')
    expect(remote.messages).not.toHaveBeenCalled()
    expect(options()[0]?.textContent).toContain('张伟')
    await key('Enter')
    expect(input().value).toBe('回填')
    expect(options()).toHaveLength(1)
    expect(options()[0]!.textContent).toContain('回填说明')
    expect(remote.turns).not.toHaveBeenCalled()
  })

  it('keeps IME Enter out of completion and lets the user choose the second match', async () => {
    await render()
    await type('in:wo 回填')
    await act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })) })
    expect(input().value).toBe('in:wo 回填')
    await key('ArrowDown')
    await key('Enter')
    expect(remote.messages).toHaveBeenLastCalledWith('message_search_as', { p_chat_id: WORKSHOP, p_query: '回填', p_limit: 100 })
  })

  it('keeps unsupported Chinese keys literal instead of adding aliases', async () => {
    await render()
    await type('在:work 回填')
    expect(remote.messages).toHaveBeenCalledWith('message_search_as', { p_chat_id: null, p_query: '在:work 回填', p_limit: 100 })
  })

  it.each([
    ['is:task', ['回填完成', '回填开始']],
    ['is：chat', ['回填说明', '回填.pdf']],
    ['has:file', ['回填.pdf']],
  ])('turns %s into a chip and filters content without tabs', async (prefix, expected) => {
    await render()
    await type(`${prefix} 回填`)
    await key('Tab')
    expect(input().value).toBe('回填')
    expect(options().map((row) => row.textContent)).toEqual(expected.map((text) => expect.stringContaining(text)))
    expect(host.querySelector('[role=tablist]')).toBeNull()
  })

  it('removes the last chip on empty Backspace; phone continues without local task queries', async () => {
    await render(false)
    await type('has:file')
    await key('Tab')
    expect(input().value).toBe('')
    await key('Backspace')
    expect(host.querySelector('button[aria-label="globalSearch.removeChip"]')).toBeNull()
    await type('回填')
    expect(remote.turns).not.toHaveBeenCalled()
    expect(options()).toHaveLength(2)
  })
})
