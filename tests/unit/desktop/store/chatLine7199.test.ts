// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chat, chatStore, createReactHarness, message } from '../../../support/testHarness'
import { chatWindowStub, topicHistoryStub } from '../../../support/chatWindowStub'
import { ChatStoreProvider, useChatStore } from '../../../../apps/desktop/src/store/chatContext'
import { ChatLineScope } from '../../../../apps/desktop/src/store/chatLineScope'

let harness: ReturnType<typeof createReactHarness>
let windows: ReturnType<typeof chatWindowStub>
let selected: string | null
let scoped: ReturnType<typeof useChatStore>
function Selection() { selected = useChatStore('activeChatId').activeChatId; return null }
function Surface() { scoped = useChatStore(); return null }
function tree() {
  return createElement(ChatStoreProvider, { value: chatStore({ ...windows, activeChatId: 'a',
    chats: [chat({ id: 'a' }), chat({ id: 'dm' })], messages: [message({ id: 'a1', chat_id: 'a' })] }) },
  createElement(Selection), createElement(ChatLineScope, { chatId: 'dm' }, createElement(Surface)))
}
beforeEach(() => {
  harness = createReactHarness(); windows = chatWindowStub()
  windows.messageWindows.write('dm', () => [message({ id: 'dm1', chat_id: 'dm' })])
})
afterEach(() => harness.cleanup())

describe('explicit conversation scopes', () => {
  it('keeps receiving its own chat while the main selection remains another chat', async () => {
    await harness.render(tree())
    expect(selected).toBe('a')
    expect(scoped.activeChatId).toBe('dm')
    expect(scoped.messages.map((row) => row.id)).toEqual(['dm1'])
    act(() => windows.messageWindows.write('dm', (rows) => [...rows, message({ id: 'dm2', chat_id: 'dm', seq: 2 })]))
    expect(scoped.messages.map((row) => row.id)).toEqual(['dm1', 'dm2'])
    expect(selected).toBe('a')
  })
  it('uses the account actions instead of disabling the actions of an unselected chat', async () => {
    const reaction = vi.fn(async () => {})
    const anchor = vi.fn(async () => {})
    windows.conversations.actions = () => ({ ...topicHistoryStub(), toggleReaction: reaction, loadMessageAnchor: anchor })
    await harness.render(tree())
    await scoped.toggleReaction('dm1', '👍')
    await scoped.loadMessageAnchor('older-dm-row')
    expect(reaction).toHaveBeenCalledWith('dm1', '👍')
    expect(anchor).toHaveBeenCalledWith('older-dm-row')
    expect(selected).toBe('a')
  })
})
