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
// The person's own agents (contacts they own), wherever they run.
const agent = (id: string, display_name: string) => ({ id, display_name, avatar: null, type: 'agent', owner_user_id: 'me' })
vi.mock('../../../../apps/desktop/src/components/settings/channels/channelAgents', () => ({
  useOwnedAgents: () => [agent('a-other', 'Other agent'), agent('a-sibling', 'Same project'), agent('a-here', 'This page')],
}))

const computers = [
  { device_id: 'first', label: 'First computer', is_online: true },
  { device_id: 'second', label: 'Second computer', is_online: true },
  { device_id: 'offline', label: 'Offline computer', is_online: false },
].map((one) => ({ ...one, hostname: one.device_id, platform: 'darwin', status: one.is_online ? 'online' : 'offline', last_seen_at: '2026-10-26T01:00:00Z', capabilities: { terminals: [], runtimes: [] } }))
vi.mock('../../../../apps/desktop/src/store/devicesContext', () => ({
  useDevicesStore: () => ({ devices: computers, phones: [{ ...computers[0], device_id: 'phone', capabilities: { host_kind: 'phone', host_runtime_capability: 1, terminals: [], runtimes: ['pi'] } }], loading: false, error: null }),
}))
vi.mock('../../../../apps/desktop/src/store/auth', () => ({ useAuth: () => ({ user: null }) }))

const { DispatchSheet } = await import('../../../../apps/desktop/src/components/chat/DispatchSheet')
const { pickDispatchTarget } = await import('../../../../apps/desktop/src/components/chat/dispatchAsk')
const ask = (over: Record<string, unknown>) => pickDispatchTarget({ draft: true, offers: ['chat', 'my-agent'], text: 'cite', pills: [], chat: null, preselect: null, visible: false, ...over } as never)

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
  it('uses the phone New task machine picker for a new agent, defaults to context, and returns the selected computer', async () => {
    let picked: Promise<unknown> = Promise.resolve()
    await act(async () => { picked = ask({ draft: false, offers: ['new-agent'], spawnOn: 'first' }) })
    await click(document.body.querySelector('[data-pick-row="new:agent"]'))
    expect(document.body.querySelector('[data-testid="dispatch-machine"]')?.textContent).toContain('First computer')
    await click(document.body.querySelector('[data-testid="dispatch-machine"]'))
    expect(document.body.querySelector('[data-testid="agent-watch-pick-machine"]')).not.toBeNull()
    expect(document.body.querySelector('[data-device-id="phone"]')).toBeNull()
    expect(document.body.querySelector<HTMLButtonElement>('[data-device-id="offline"]')?.disabled).toBe(true)
    await click(document.body.querySelector('[data-device-id="second"]'))
    expect(document.body.querySelector('[data-testid="dispatch-machine"]')?.textContent).toContain('Second computer')
    await click(document.body.querySelector('[data-testid="dispatch-sheet-action"]'))
    await expect(picked).resolves.toEqual({ to: { new: true, device: 'second' }, visible: false, text: 'cite' })
  })

  it('a draft from a task\'s tab: 「我的 agent」 first, the page\'s own ticked and first, only those with a session here; a pick is the place', async () => {
    let picked: Promise<unknown> = Promise.resolve()
    await act(async () => { picked = ask({ preselect: 'user:a-here', local: ['user:a-here', 'user:a-other'] }) })
    expect([...document.body.querySelectorAll('[data-pick-section]')].map((s) => s.getAttribute('data-pick-section'))).toEqual(['agents', 'chats'])
    expect(rowIds()).toEqual(['agent:user:a-here', 'agent:user:a-other', 'chat:c-group', 'chat:c-dm'])
    expect(ticked()).toEqual(['agent:user:a-here'])

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

  it('a search narrows chats and agents alike', async () => {
    await act(async () => { void ask({}) })
    expect(rowIds()).toEqual(['agent:user:a-other', 'agent:user:a-sibling', 'agent:user:a-here', 'chat:c-group', 'chat:c-dm'])
    expect(ticked()).toEqual([])
    await type(document.body.querySelector('input') as HTMLInputElement, 'same')
    expect(rowIds()).toEqual(['agent:user:a-sibling'])
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
    expect([...document.body.querySelectorAll('[data-pick-section]')].map((s) => s.getAttribute('data-pick-section'))).toEqual(['chat-agents', 'chat-people', 'agents', 'new'])
    expect(rowIds()).toEqual(['member:user:a', 'member:user:p', 'agent:user:a-other', 'agent:user:a-sibling', 'agent:user:a-here', 'new:agent'])
    const text = document.body.querySelector('[data-testid="dispatch-text"]') as HTMLTextAreaElement
    expect(text.value).toBe('Host this round')
    expect([...document.body.querySelectorAll('[data-testid="dispatch-pill"]')].map((p) => p.textContent)).toEqual(['@round.soup.json'])
    // Nothing picked: nothing to send.
    expect(button('发送')?.disabled).toBe(true)
    // An agent of theirs: no 「visible」, that is a chat's.
    await click(document.body.querySelector('[data-pick-row="agent:user:a-here"]'))
    expect(document.body.querySelector('[data-testid="dispatch-visible"]')).toBeNull()
    await click(document.body.querySelector('[data-pick-row="member:user:a"]'))
    await click(document.body.querySelector('[data-testid="dispatch-visible"]'))
    await type(text, 'Host this round, hard mode')
    await click(button('发送'))
    await expect(picked).resolves.toEqual({ to: { chat: 'c-group', member: 'user:a' }, visible: true, text: 'Host this round, hard mode' })
  })

  it('a forum assignment: the post shown read only, the person\'s own agents, 「指派」; the pick is the agent', async () => {
    let picked: Promise<unknown> = Promise.resolve()
    await act(async () => { picked = ask({ draft: false, offers: ['my-agent'], text: '', assign: { title: '并发问题' }, preselect: 'user:a-sibling' }) })
    expect(document.body.querySelector('[data-testid="dispatch-assign"]')?.textContent).toContain('并发问题')
    expect(document.body.querySelector('[data-testid="dispatch-text"]')).toBeNull()
    expect(rowIds()).toEqual(['agent:user:a-sibling', 'agent:user:a-other', 'agent:user:a-here'])
    expect(ticked()).toEqual(['agent:user:a-sibling'])
    await click(document.body.querySelector('[data-testid="dispatch-sheet-action"]'))
    await expect(picked).resolves.toEqual({ to: { agent: 'user:a-sibling' }, visible: false, text: '' })
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
