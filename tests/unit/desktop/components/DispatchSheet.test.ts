// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem } from '@gugu/core/shared/types/chat'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

/**
 * `gugu.dispatch` naming no target: the shell's one sheet (on ChatPickSheet) offers what the call may go to — the page's
 * chat's agents and people, this computer's tasks (the page's own ticked, its project's next), a new agent, chats for a
 * draft — above it what will go: the text, theirs to change, and each pill. The App hears only the pick and the text.
 */

const chats: ChatItem[] = [
  { id: 'c-group', kind: 'group', name: 'Reading group' },
  { id: 'c-dm', kind: 'dm', name: '', peer_user_id: 'u-alpha' },
].map((overrides) => ({
  status: 'active', created_at: '2026-01-01T00:00:00.000Z', last_message_at: null, last_message_preview: null, unread_count: 0,
  pinned_message_id: null, last_read_seq: 0, next_message_seq: 1, ...overrides,
}) as ChatItem)
vi.mock('../../../../apps/desktop/src/store/chatContext', () => ({
  useChatStore: () => ({ chats, identitiesById: { 'u-alpha': { display_name: 'Alpha', avatar: null, type: 'human' } } }),
}))
const session = (conversationId: string, projectId: string, title: string, lastInteractedAt: string) =>
  ({ conversationId, projectId, title, lastInteractedAt, supported: true, harness: 'codex', runtime: 'acp', agentStatus: null })
const use = vi.fn(() => () => undefined)
vi.mock('../../../../apps/desktop/src/session/renderer/features/assistant/assistant-home-sessions', () => ({
  localHomeSessions: {
    use,
    sessions: [
      session('s-other', 'p-2', 'Other project, newest', '2026-10-22T10:00:00Z'),
      session('s-sibling', 'p-1', 'Same project', '2026-10-22T09:00:00Z'),
      session('s-here', 'p-1', 'This page', '2026-10-22T08:00:00Z'),
    ],
  },
}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/projects/stores/project-selectors', () => ({
  getProjectStore: (id: string) => ({ name: id === 'p-1' ? 'Papers' : 'Website' }),
}))

const { DispatchSheet } = await import('../../../../apps/desktop/src/components/chat/DispatchSheet')
const { pickDispatchTarget } = await import('../../../../apps/desktop/src/components/chat/dispatchAsk')
const ask = (over: Record<string, unknown>) => pickDispatchTarget({ draft: true, offers: ['chat', 'my-agent'], text: 'cite', pills: [], chat: null, current: null, visible: false, ...over } as never)

let container: HTMLDivElement
let root: Root
beforeEach(async () => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(createElement(DispatchSheet)))
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const rowIds = () => [...document.body.querySelectorAll('[data-pick-row]')].map((row) => row.getAttribute('data-pick-row'))
const ticked = () => [...document.body.querySelectorAll('[data-pick-row][data-selected]')].map((row) => row.getAttribute('data-pick-row'))
const click = (element: Element | null | undefined) => act(async () => { element!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
const button = (text: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent === text)
const type = async (field: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!.call(field, value)
  field.dispatchEvent(new Event('input', { bubbles: true }))
})

describe('DispatchSheet', () => {
  it('a draft from a task\'s tab: 「我的任务」 first, the page\'s task ticked, its project next; a pick is the place, nothing more', async () => {
    let picked: Promise<unknown> = Promise.resolve()
    await act(async () => { picked = ask({ current: 's-here' }) })
    expect(use).toHaveBeenCalled()
    expect([...document.body.querySelectorAll('[data-pick-section]')].map((s) => s.getAttribute('data-pick-section'))).toEqual(['tasks', 'chats'])
    expect(rowIds()).toEqual(['session:s-here', 'session:s-sibling', 'session:s-other', 'chat:c-group', 'chat:c-dm'])
    expect(ticked()).toEqual(['session:s-here'])
    expect(document.body.textContent).toContain('Papers')

    // One at a time: picking a chat unticks the task.
    await click(document.body.querySelector('[data-pick-row="chat:c-dm"]'))
    expect(ticked()).toEqual(['chat:c-dm'])
    await click(button('放入输入框'))
    await expect(picked).resolves.toEqual({ to: { chat: 'c-dm' }, visible: false, text: 'cite' })
    expect(rowIds()).toEqual([])
  })

  it('chats only when there are no tasks to offer (the phone, or images riding along); cancelling answers null', async () => {
    let picked: Promise<unknown> = Promise.resolve()
    await act(async () => { picked = ask({ offers: ['chat'] }) })
    expect(rowIds()).toEqual(['chat:c-group', 'chat:c-dm'])
    expect(ticked()).toEqual([])
    expect(button('放入输入框')?.disabled).toBe(true)
    // One at a time: the foot counts nothing (the forward sheet's 「已选 N 个」 is for several).
    expect(document.body.textContent).not.toContain('已选')
    await click(button('取消'))
    await expect(picked).resolves.toBeNull()
  })

  it('a search narrows chats and tasks alike', async () => {
    await act(async () => { void ask({}) })
    expect(rowIds()).toEqual(['session:s-other', 'session:s-sibling', 'session:s-here', 'chat:c-group', 'chat:c-dm'])
    expect(ticked()).toEqual([])
    await type(document.body.querySelector('input') as HTMLInputElement, 'same')
    expect(rowIds()).toEqual(['session:s-sibling'])
  })

  it('a message: the chat\'s agents, its people, tasks, a new agent; the text shown and theirs to change, the pills under it, visible for a member', async () => {
    let picked: Promise<unknown> = Promise.resolve()
    await act(async () => {
      picked = ask({
        draft: false,
        offers: ['agent-in-chat', 'person-in-chat', 'my-agent', 'new-agent'],
        text: 'Host this round',
        pills: ['round.soup.json'],
        chat: { id: 'c-group', name: 'Reading group', members: [{ id: 'user:a', name: 'Kip', kind: 'agent' }, { id: 'user:p', name: 'Wei', kind: 'human' }] },
      })
    })
    expect([...document.body.querySelectorAll('[data-pick-section]')].map((s) => s.getAttribute('data-pick-section'))).toEqual(['chat-agents', 'chat-people', 'tasks', 'new'])
    expect(rowIds()).toEqual(['member:user:a', 'member:user:p', 'session:s-other', 'session:s-sibling', 'session:s-here', 'new:agent'])
    const text = document.body.querySelector('[data-testid="dispatch-text"]') as HTMLTextAreaElement
    expect(text.value).toBe('Host this round')
    expect([...document.body.querySelectorAll('[data-testid="dispatch-pill"]')].map((p) => p.textContent)).toEqual(['@round.soup.json'])
    // Nothing picked: nothing to send.
    expect(button('发送')?.disabled).toBe(true)
    // A task: no 「visible」, that is a chat's.
    await click(document.body.querySelector('[data-pick-row="session:s-here"]'))
    expect(document.body.querySelector('[data-testid="dispatch-visible"]')).toBeNull()
    await click(document.body.querySelector('[data-pick-row="member:user:a"]'))
    await click(document.body.querySelector('[data-testid="dispatch-visible"]'))
    await type(text, 'Host this round, hard mode')
    await click(button('发送'))
    await expect(picked).resolves.toEqual({ to: { chat: 'c-group', member: 'user:a' }, visible: true, text: 'Host this round, hard mode' })
  })

  it('a new agent: its row picks { new }', async () => {
    let picked: Promise<unknown> = Promise.resolve()
    await act(async () => { picked = ask({ draft: false, offers: ['new-agent'], text: 'Make a deck' }) })
    expect(rowIds()).toEqual(['new:agent'])
    await click(document.body.querySelector('[data-pick-row="new:agent"]'))
    await click(button('发送'))
    await expect(picked).resolves.toEqual({ to: { new: true }, visible: false, text: 'Make a deck' })
  })
})
