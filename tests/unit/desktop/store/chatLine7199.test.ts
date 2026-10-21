// @vitest-environment jsdom
// #7199 聊天面「吃一个会话 id」:store 只有一条活的线,「助理」App 里那条私聊摆在眼前时借线、离开时还给对话页。
import { act, createElement, useState, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatStoreProvider, useChatStore, type ChatContextValue } from '../../../../apps/desktop/src/store/chatContext'
import { chatSelectionOf, offLineChatValue, useChatLineClaim, useChatSelection } from '../../../../apps/desktop/src/store/chatLine'
import { ChatLineScope } from '../../../../apps/desktop/src/store/chatLineScope'
import { chat, chatStore, createReactHarness, message } from '../../../support/testHarness'

describe('which chat the chat page has selected', () => {
  it('is the one from before the borrow while the line is borrowed, otherwise the line itself', () => {
    expect(chatSelectionOf('dm', { chatId: 'dm', returnTo: 'a' })).toBe('a')
    expect(chatSelectionOf('x', { chatId: 'dm', returnTo: 'a' }), 'someone opened x while it was borrowed').toBe('x')
    expect(chatSelectionOf('a', null)).toBe('a')
  })
})

describe('a chat surface off the line', () => {
  const sendHere = vi.fn(async () => 'sent')
  it('shows its own chat still reading, sends there, and does nothing that follows the line', async () => {
    const store = chatStore({ activeChatId: 'a', chats: [chat({ id: 'a' }), chat({ id: 'dm', kind: 'ai' })], messages: [message({ id: 'm-a', chat_id: 'a' })], loadingMessages: false })
    const value = offLineChatValue(store, 'dm', null, sendHere)
    expect(value.activeChatId).toBe('dm')
    expect(value.activeChat?.id).toBe('dm')
    expect(value.messages, 'never another chat’s messages under this one').toEqual([])
    expect(value.loadingMessages).toBe(true)
    expect(value.sendMessage).toBe(sendHere)
    await value.toggleReaction('m-a', '👍')
    expect(store.toggleReaction).not.toHaveBeenCalled()
  })

  it('keeps the frame it had before the line left, and only for that chat', () => {
    const before = chatStore({ activeChatId: 'dm', messages: [message({ id: 'm-dm', chat_id: 'dm' })], loadingMessages: false })
    const now = chatStore({ activeChatId: 'a', chats: [chat({ id: 'dm', kind: 'ai' })], messages: [message({ id: 'm-a', chat_id: 'a' })] })
    expect(offLineChatValue(now, 'dm', before, sendHere).messages.map((m) => m.id)).toEqual(['m-dm'])
    expect(offLineChatValue(now, 'other', before, sendHere).messages, 'a frame of another chat is not this chat’s').toEqual([])
  })
})

// 一份有状态的假 store:线就是 activeChatId,setActiveChatId 换线。
let harness: ReturnType<typeof createReactHarness>
let setLineFromOutside: (id: string | null) => void = () => {}
let setActiveFromOutside: (active: boolean) => void = () => {}
const lines: Array<string | null> = []
const selections: Array<string | null> = []

function FakeStore({ initial, active: activeProp, children }: { initial: string | null; active: boolean; children?: ReactNode }) {
  const [line, setLine] = useState(initial)
  const [active, setActive] = useState(activeProp)
  const [prop, setProp] = useState(activeProp)
  if (prop !== activeProp) { setProp(activeProp); setActive(activeProp) }
  setLineFromOutside = setLine
  setActiveFromOutside = setActive
  lines.push(line)
  const value: ChatContextValue = chatStore({
    activeChatId: line,
    chats: [chat({ id: 'a' }), chat({ id: 'dm', kind: 'ai' }), chat({ id: 'x' })],
    messages: line ? [message({ id: `m-${line}`, chat_id: line })] : [],
    loadingMessages: false,
    setActiveChatId: setLine,
  })
  return createElement(ChatStoreProvider, { value }, createElement(Borrower, { active }), children)
}

function Borrower({ active }: { active: boolean }) {
  useChatLineClaim('dm', active)
  return null
}

function Selection() {
  const { activeChatId } = useChatStore('activeChatId')
  selections.push(useChatSelection(activeChatId))
  return null
}

function tree(active: boolean, extra: ReactNode = null) {
  return createElement(FakeStore, { initial: 'a', active }, createElement(Selection), extra)
}

beforeEach(() => {
  harness = createReactHarness()
  lines.length = 0
  selections.length = 0
})
afterEach(() => { harness.cleanup() })

describe('borrowing the line', () => {
  it('moves the line to the assistant chat while it is on screen and gives it back after', async () => {
    await harness.render(tree(false))
    expect(lines.at(-1)).toBe('a')
    await harness.render(tree(true))
    expect(lines.at(-1)).toBe('dm')
    expect(selections.at(-1), 'the chat page still has a selected').toBe('a')
    await harness.render(tree(false))
    expect(lines.at(-1)).toBe('a')
    expect(selections.at(-1)).toBe('a')
  })

  it('leaves a chat someone opened meanwhile as the line, not the one from before', async () => {
    await harness.render(tree(true))
    expect(lines.at(-1)).toBe('dm')
    // 点了一条通知:同一批里换线、换走这一屏。
    await act(async () => {
      setLineFromOutside('x')
      setActiveFromOutside(false)
    })
    expect(lines.at(-1)).toBe('x')
    expect(selections.at(-1)).toBe('x')
  })

  it('takes the line back when it is changed while the assistant chat stays on screen, remembering that chat for the chat page', async () => {
    await harness.render(tree(true))
    await act(async () => { setLineFromOutside('x') })
    expect(lines.at(-1)).toBe('dm')
    expect(selections.at(-1)).toBe('x')
    await harness.render(tree(false))
    expect(lines.at(-1)).toBe('x')
  })
})

describe('ChatLineScope', () => {
  const seen: Array<{ chatId: string | null; messages: string[]; loading: boolean }> = []
  function Surface() {
    const { activeChatId, messages, loadingMessages } = useChatStore('activeChatId', 'messages', 'loadingMessages')
    seen.push({ chatId: activeChatId, messages: messages.map((m) => m.id), loading: loadingMessages })
    return null
  }
  beforeEach(() => { seen.length = 0 })

  it('shows only its own chat: still reading before the line came, the frame it had after the line left', async () => {
    const scoped = createElement(ChatLineScope, { chatId: 'dm' }, createElement(Surface))
    await harness.render(tree(false, scoped))
    expect(seen.at(-1)).toEqual({ chatId: 'dm', messages: [], loading: true })
    await harness.render(tree(true, scoped))
    expect(seen.at(-1)).toEqual({ chatId: 'dm', messages: ['m-dm'], loading: false })
    await harness.render(tree(false, scoped))
    expect(lines.at(-1)).toBe('a')
    expect(seen.at(-1), 'the line went back to a; this surface keeps showing dm').toEqual({ chatId: 'dm', messages: ['m-dm'], loading: false })
  })
})
