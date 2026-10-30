// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SearchMessageHit, SearchResults } from '@gugu/core/shared/search/types'
import { conversationLink } from '@gugu/core/shared/ui/guguLink'
import { publishChatSummaries } from '@/lib/chatSummariesBridge'

const calls = vi.hoisted(() => ({ links: [] as string[], queries: [] as unknown[], dispatched: [] as string[], paged: false }))
vi.mock('@/lib/guguLinks', () => ({ followLink: (href: string) => { calls.links.push(href); return true } }))
vi.mock('@renderer/lib/commands/registry', () => ({ commandRegistry: { dispatch: (id: string) => { calls.dispatched.push(id); return true } } }))
vi.mock('@renderer/localization/use-session-messages', () => ({
  useSessionMessages: () => ({ translate: (key: string, values?: Record<string, string>) => (values ? `${key}:${Object.values(values).join(',')}` : key) }),
}))
vi.mock('@renderer/lib/hooks/useDebounce', () => ({ useDebounce: <T,>(value: T) => value }))
const G = '0b1e7c1a-0000-4000-8000-0000000000aa', A = '0b1e7c1a-0000-4000-8000-00000000000a', B = '0b1e7c1a-0000-4000-8000-00000000000b'
const hits: SearchMessageHit[] = [
  { kind: 'message', id: A, chatId: G, threadRootId: null, seq: 2, senderId: null, createdAt: '2026-10-27T06:02:00Z', text: '回滚那段', attachment: null, highlights: [{ start: 0, end: 2 }], rank: { score: 1, reasons: [] } },
  { kind: 'message', id: B, chatId: G, threadRootId: null, seq: 1, senderId: null, createdAt: '2026-10-26T06:02:00Z', text: '回滚预案-v2.pdf', attachment: 'file', highlights: [{ start: 0, end: 2 }], rank: { score: 1, reasons: [] } },
]
vi.mock('@renderer/lib/ipc', () => ({
  rpcOn: () => ({ search: { global: async (request: { cursor?: string | null }) => {
    calls.queries.push(request)
    // paged: one result per page, so the bar has to fetch the second page itself.
    const results = !calls.paged ? hits : request.cursor ? hits.slice(1) : hits.slice(0, 1)
    const nextCursor = calls.paged && !request.cursor ? 'page-2' : null
    return { results, facets: { total: 2, file: 1, image: 0, link: 0, otherChats: 23 }, coverage: { complete: true, chats: [] }, nextCursor } satisfies SearchResults
  } } }),
}))
import { COMMANDS } from '@shared/commands'
import { modalStore } from '@renderer/lib/modal/modal-store'
import { GlobalSearchModal } from './global-search-modal'
import { closeSearchBar, openGlobalSearch, readSearchSession, stepHit, takeGlobalSearchOpen, useIsSearchCurrent } from './search-session'

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
Element.prototype.scrollIntoView ??= () => {}

let host: HTMLDivElement
let root: Root
const onClose = vi.fn()
async function render() {
  await act(async () => {
    root.render(<QueryClientProvider client={new QueryClient()}><GlobalSearchModal onClose={onClose} onSuccess={() => {}} /></QueryClientProvider>)
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}
const input = () => host.querySelector<HTMLInputElement>('[data-testid="global-search-input"]')!
const key = (init: KeyboardEventInit) => act(() => { input().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init })) })

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  calls.links = []; calls.queries = []; calls.dispatched = []; calls.paged = false; onClose.mockReset()
  publishChatSummaries([{ id: G, kind: 'group', unread_count: 0, name: '产品讨论', last_message_at: '2026-10-27T00:00:00Z' }])
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('global search modal', () => {
  it('opens scoped to a chat from an in-chat entry, newest first, and queries through the shared filters', async () => {
    openGlobalSearch({ text: '回滚', chips: [{ kind: 'in', chatId: G }] })
    expect(calls.dispatched).toEqual(['app.globalSearch'])
    await render()
    expect(host.textContent).toContain('in: 产品讨论')
    expect(calls.queries.at(-1)).toMatchObject({ query: { text: '回滚', sort: 'recent', filters: { in: [{ kind: 'chat', id: G }] } } })
    expect(host.textContent).toContain('globalSearch.facetAll:2')
    expect(host.textContent).toContain('globalSearch.otherChats:23')
    expect(host.querySelectorAll('mark')).toHaveLength(2)
  })

  it('tells the user what to fix in a malformed filter, never the parser message', async () => {
    openGlobalSearch({ text: 'has:video' })
    await render()
    expect(host.textContent).toContain('globalSearch.queryInvalid')
    expect(host.textContent).not.toMatch(/Unknown has: filter/)
    expect(calls.queries).toEqual([])
  })

  it('removes the last chip with Backspace on an empty field, widening to every chat', async () => {
    openGlobalSearch({ chips: [{ kind: 'in', chatId: G }] })
    await render()
    await key({ key: 'Backspace' })
    expect(readSearchSession().chips).toEqual([])
    expect(readSearchSession().sort).toBe('relevant')
  })

  it('does not open a result on an IME composition Enter, and opens the selected one on a real Enter', async () => {
    openGlobalSearch({ text: '回滚' })
    await render()
    await key({ key: 'Enter', keyCode: 229 })
    expect(calls.links).toEqual([])
    await key({ key: 'ArrowDown' })
    await key({ key: 'Enter' })
    expect(calls.links).toEqual([conversationLink(G, B)])
    expect(onClose).toHaveBeenCalled()
    expect(readSearchSession()).toMatchObject({ selectedId: B, barChatId: G })
  })

  it('steps through the same results from the chat bar, wrapping around', async () => {
    openGlobalSearch({ text: '回滚' })
    await render()
    await key({ key: 'Enter' })
    await act(() => stepHit(1))
    await act(() => stepHit(1))
    await act(() => stepHit(-1))
    expect(calls.links).toEqual([conversationLink(G, A), conversationLink(G, B), conversationLink(G, A), conversationLink(G, B)])
  })

  it('gives the bar the same total as the modal and loads the next page when stepping past the loaded ones', async () => {
    calls.paged = true
    openGlobalSearch({ text: '回滚' })
    await render()
    expect(readSearchSession()).toMatchObject({ total: 2, results: [{ id: A }], nextCursor: 'page-2' })
    await key({ key: 'Enter' })
    await act(() => stepHit(1))
    expect(calls.queries.at(-1)).toMatchObject({ cursor: 'page-2' })
    expect(readSearchSession()).toMatchObject({ total: 2, selectedId: B, nextCursor: null })
    expect(calls.links).toEqual([conversationLink(G, A), conversationLink(G, B)])
  })

  it('frames exactly the message the bar is on, in its own chat, until the bar closes', async () => {
    openGlobalSearch({ text: '回滚' })
    await render()
    const seen: Record<string, boolean> = {}
    function Row({ chat, id }: { chat: string; id: string }) { seen[`${chat}/${id}`] = useIsSearchCurrent(chat, id); return null }
    const rows = createRoot(document.createElement('div'))
    await act(async () => { rows.render(<><Row chat={G} id={A} /><Row chat={G} id={B} /><Row chat="other" id={A} /></>) })
    await key({ key: 'Enter' })
    expect(seen).toEqual({ [`${G}/${A}`]: true, [`${G}/${B}`]: false, [`other/${A}`]: false })
    act(() => closeSearchBar())
    expect(seen[`${G}/${A}`]).toBe(false)
    act(() => rows.unmount())
  })

  it('lands focus in the composer of the chat being entered, waiting for it to render', async () => {
    const slot = (chatId: string) => {
      const element = document.createElement('div')
      element.setAttribute('data-chat-slot', chatId)
      element.innerHTML = '<textarea data-testid="chat-composer"></textarea>'
      document.body.append(element)
      return element
    }
    const showing = slot('other-chat')
    openGlobalSearch({ text: '回滚' })
    await render()
    await key({ key: 'Enter' })
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)) })
    expect(document.activeElement?.tagName).not.toBe('TEXTAREA')
    const entered = slot(G)
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)) })
    expect(document.activeElement).toBe(entered.querySelector('textarea'))
    showing.remove(); entered.remove()
  })

  it('closes on a jump without handing focus back to the element it was opened from', async () => {
    const row = document.createElement('button')
    document.body.append(row)
    row.focus()
    modalStore.setModal('globalSearchModal', {})
    expect(modalStore.previousFocus).toBe(row)
    openGlobalSearch({ text: '回滚' })
    await render()
    await key({ key: 'Enter' })
    // The modal renderer restores previousFocus on close; a jump leaves none to restore.
    expect(modalStore.previousFocus).toBeNull()
    modalStore.closeModal()
    row.remove()
  })

  it('keeps stepping through results while typing in the composer', () => {
    expect([COMMANDS['chat.searchNext'].ignoreInputs, COMMANDS['chat.searchPrevious'].ignoreInputs]).toEqual([false, false])
  })

  it('opens a fresh search from the shortcut alone, but keeps what an entry point prepared', () => {
    openGlobalSearch({ text: '回滚', chips: [{ kind: 'in', chatId: G }] })
    takeGlobalSearchOpen()
    expect(readSearchSession()).toMatchObject({ text: '回滚', chips: [{ kind: 'in', chatId: G }] })
    takeGlobalSearchOpen()
    expect(readSearchSession()).toMatchObject({ text: '', chips: [] })
  })
})
