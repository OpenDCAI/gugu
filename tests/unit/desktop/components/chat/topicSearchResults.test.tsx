// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness, clickElement, deferred, renderWithAppProviders } from '../../../../support/testHarness'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@gugu/core/cloud/supabase', () => ({ createGuguSupabaseClient: () => ({ rpc }) }))
vi.mock('@/lib/sessionPublication', () => ({ getRendererAccessToken: () => 'test-token' }))
const { ChatTopicSearchResults } = await import('../../../../../apps/desktop/src/components/chat/ChatTopicSearchResults')
const { queryClient } = await import('../../../../../apps/desktop/src/session/renderer/lib/query-client')
const CHAT = '33333333-3333-4333-8333-333333333333'
const props = { topics: [{ chat_id: CHAT, name: 'Topic on downloads' }], query: 'needle', hasMainResults: false, onOpen: vi.fn() }
const row = (seq: number, text = 'A topic-only needle') => ({ id: `message-${seq}`, seq, content: text, sender_user_id: null,
  sender_name: '', content_type: 'text', thread_root_id: null, created_at: '2026-10-27T03:00:00Z' })
let harness: ReturnType<typeof createReactHarness>
const render = (query = props.query) => renderWithAppProviders(harness, createNode(ChatTopicSearchResults, { ...props, query }), { auth: { id: 'reader' } })

beforeEach(() => { queryClient.clear(); rpc.mockReset(); props.onOpen.mockClear(); harness = createReactHarness() })
afterEach(() => { harness.cleanup(); queryClient.clear() })

describe('group search includes the existing topic scope', () => {
  it('reads through the shared message search and opens a hit in its own topic', async () => {
    rpc.mockResolvedValue({ data: [row(10)], error: null })
    await render()
    await vi.waitFor(() => expect(harness.container.querySelector('[data-search-message="message-10"]')).not.toBeNull())
    expect(rpc).toHaveBeenCalledExactlyOnceWith('message_search_as', {
      p_chat_id: CHAT, p_query: 'needle', p_as_user_id: null, p_before_seq: null, p_limit: 50,
    })
    expect(harness.container.textContent).toContain('Topic on downloads')
    await clickElement(harness.container.querySelector('[data-search-message="message-10"]')!)
    expect(props.onOpen).toHaveBeenCalledExactlyOnceWith(CHAT, 'message-10')
  })

  it('uses the shared next cursor rather than truncating older topic matches', async () => {
    rpc.mockImplementation(async (_name, args) => ({ data: args.p_before_seq === null
      ? Array.from({ length: 50 }, (_, index) => row(100 - index)) : [row(40)], error: null }))
    await render()
    await vi.waitFor(() => expect(harness.container.querySelectorAll('[data-search-message]')).toHaveLength(50))
    await clickElement([...harness.container.querySelectorAll('button')].at(-1)!)
    await vi.waitFor(() => expect(harness.container.querySelectorAll('[data-search-message]')).toHaveLength(51))
    expect(rpc.mock.calls[1][1]).toMatchObject({ p_chat_id: CHAT, p_before_seq: 51 })
  })

  it('does not show a late answer for the previous query as the new query', async () => {
    const old = deferred<{ data: ReturnType<typeof row>[]; error: null }>()
    rpc.mockImplementation(async (_name, args) => args.p_query === 'needle' ? old.promise : { data: [row(20, 'new query answer')], error: null })
    await render()
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1))
    await render('new query')
    await vi.waitFor(() => expect(harness.container.textContent).toContain('new query answer'))
    old.resolve({ data: [row(10)], error: null })
    await vi.waitFor(() => expect(queryClient.isFetching()).toBe(0))
    expect(harness.container.textContent).not.toContain('A topic-only needle')
  })
})
