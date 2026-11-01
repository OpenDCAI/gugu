// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { conversationLink } from '@gugu/core/shared/ui/guguLink'
import { messageQuoteLink } from '@gugu/core/shared/ui/messageQuote'
import { publishChatSummaries } from '@/lib/chatSummariesBridge'
import { takeTaskReveal } from '@/hooks/useSourceMessageReveal'
import type { TaskTurnHit } from '@shared/core/search'
import { GlobalSearch } from './global-search'
import { resetSearchSession, updateSearchSession } from './search-session'

const remote = vi.hoisted(() => ({ opened: [] as unknown[], turns: vi.fn(), messages: vi.fn() }))
vi.mock('@/lib/guguLinks', () => ({ followLink: (target: unknown) => { remote.opened.push(target); return true } }))
vi.mock('@renderer/lib/ipc', () => ({ rpc: { search: { taskTurns: remote.turns } } }))
vi.mock('@/lib/supabase', () => ({ chatDb: { rpc: remote.messages } }))
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }))

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
Element.prototype.scrollIntoView ??= () => {}

const GROUP = '0b1e7c1a-0000-4000-8000-000000000001'
const OTHER = '0b1e7c1a-0000-4000-8000-000000000002'
const turn: TaskTurnHit = { sessionId: 's1', projectId: 'p1', title: '发布排查', archived: false, itemId: 's1:turn:s3:m', role: 'assistant', excerpt: '已经把回滚开关打开了', at: '2026-10-31 08:00:00' }
const rows = [
  { id: 'm-new', chat_id: GROUP, sender_user_id: 'u1', sender_name: '阿威', content: '收到，回滚脚本已经演练过', created_at: '2026-10-31T09:00:00Z', file_item_id: null },
  { id: 'm-old', chat_id: OTHER, sender_user_id: 'u2', sender_name: '小林', content: '回滚方案.pdf', created_at: '2026-10-30T09:00:00Z', file_item_id: 'f1' },
]

let host: HTMLDivElement
let root: Root
let closed = 0
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  remote.opened = []
  closed = 0
  remote.turns.mockReset().mockResolvedValue([turn])
  remote.messages.mockReset().mockResolvedValue({ data: rows, error: null })
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
  await act(async () => root.unmount())
  host.remove()
})

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 220)) })
async function render(text: string, tasks = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => root.render(<QueryClientProvider client={client}><GlobalSearch tasks={tasks} onClose={() => { closed++ }} /></QueryClientProvider>))
  await act(async () => updateSearchSession({ text }))
  await settle()
}
const options = () => [...host.querySelectorAll<HTMLElement>('[role=option]')]
const headers = () => [...host.querySelectorAll<HTMLElement>('[role=listbox] > button:not([role=option])')].map((button) => button.textContent)
const tab = (key: string) => [...host.querySelectorAll<HTMLElement>('[role=tab]')].find((button) => button.textContent!.startsWith(key))!

describe('global search panel', () => {
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
    expect(remote.messages).toHaveBeenLastCalledWith('message_search_as', { p_chat_id: GROUP, p_query: '回滚', p_limit: 100 })
    expect(remote.turns).not.toHaveBeenCalled()
  })

  it('typed in: resolves to a conversation by name; an unknown one finds nothing instead of searching everywhere', async () => {
    await render('in:设计 回滚')
    expect(remote.messages).toHaveBeenLastCalledWith('message_search_as', { p_chat_id: OTHER, p_query: '回滚', p_limit: 100 })
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
    expect(remote.opened).toEqual([conversationLink(GROUP, 'm-new')])
    await act(async () => options()[1]!.click())
    expect(remote.opened[1]).toEqual({ kind: 'session', sessionId: 's1', projectId: 'p1' })
    expect(takeTaskReveal('s1')).toBe(messageQuoteLink({ kind: 'session', sessionId: 's1', itemId: 's1:turn:s3:m' }))
  })

  it('without local tasks (the phone) it searches chats only and has no task filter', async () => {
    await render('回滚', false)
    expect(remote.turns).not.toHaveBeenCalled()
    expect([...host.querySelectorAll('[role=tab]')].map((button) => button.textContent!.replace(/\d+$/, ''))).toEqual(['globalSearch.facet.all', 'globalSearch.facet.message', 'globalSearch.facet.file'])
  })
})
