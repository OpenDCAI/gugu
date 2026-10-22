// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem } from '@gugu/core/shared/types/chat'

/**
 * `gugu.compose(text)` naming no place: the shell's one sheet (ChatPickSheet) offers the person's chats and, on the desktop,
 * this computer's tasks under 「我的任务」 — the page's own task ticked, its project's next. The App hears only the pick.
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

const { ComposeTargetPicker } = await import('../../../../apps/desktop/src/components/chat/ComposeTargetPicker')
const { pickComposeTarget } = await import('../../../../apps/desktop/src/components/chat/composeTargetAsk')

let container: HTMLDivElement
let root: Root
beforeEach(async () => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(createElement(ComposeTargetPicker)))
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const rowIds = () => [...document.body.querySelectorAll('[data-pick-row]')].map((row) => row.getAttribute('data-pick-row'))
const ticked = () => [...document.body.querySelectorAll('[data-pick-row][data-selected]')].map((row) => row.getAttribute('data-pick-row'))
const click = (element: Element | null | undefined) => act(async () => { element!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
const button = (text: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent === text)

describe('ComposeTargetPicker', () => {
  it('in a task\'s tab: 「我的任务」 first, the page\'s task ticked, its project next; a pick is the place, nothing more', async () => {
    let picked: Promise<unknown> = Promise.resolve()
    await act(async () => { picked = pickComposeTarget({ tasks: true, current: 's-here' }) })
    expect(use).toHaveBeenCalled()
    expect([...document.body.querySelectorAll('[data-pick-section]')].map((s) => s.getAttribute('data-pick-section'))).toEqual(['tasks', 'chats'])
    expect(rowIds()).toEqual(['session:s-here', 'session:s-sibling', 'session:s-other', 'chat:c-group', 'chat:c-dm'])
    expect(ticked()).toEqual(['session:s-here'])
    expect(document.body.textContent).toContain('Papers')

    // One at a time: picking a chat unticks the task.
    await click(document.body.querySelector('[data-pick-row="chat:c-dm"]'))
    expect(ticked()).toEqual(['chat:c-dm'])
    await click(button('放入输入框'))
    await expect(picked).resolves.toEqual({ chat: 'c-dm' })
    expect(rowIds()).toEqual([])
  })

  it('chats only when there are no tasks to offer (the phone, or images riding along); cancelling answers null', async () => {
    let picked: Promise<unknown> = Promise.resolve()
    await act(async () => { picked = pickComposeTarget({ tasks: false, current: null }) })
    expect(rowIds()).toEqual(['chat:c-group', 'chat:c-dm'])
    expect(ticked()).toEqual([])
    expect(button('放入输入框')?.disabled).toBe(true)
    await click(button('取消'))
    await expect(picked).resolves.toBeNull()
  })

  it('on the App\'s own page: 「我的任务」 still first, newest first, nothing ticked; a search narrows chats and tasks alike', async () => {
    await act(async () => { void pickComposeTarget({ tasks: true, current: null }) })
    expect(rowIds()).toEqual(['session:s-other', 'session:s-sibling', 'session:s-here', 'chat:c-group', 'chat:c-dm'])
    expect(ticked()).toEqual([])
    const field = document.body.querySelector('input') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'same')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(rowIds()).toEqual(['session:s-sibling'])
  })
})
