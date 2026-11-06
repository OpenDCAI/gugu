// @vitest-environment jsdom
import { act, useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatDraft } from '../../../../apps/desktop/src/components/chat/useChatDraft'
import { useChatMessageSend } from '../../../../apps/desktop/src/components/chat/useChatMessageSend'
import { ChatComposerContextBands } from '../../../../apps/desktop/src/components/chat/ChatComposerContextBands'
import type { ChatMessageComposerProps } from '../../../../apps/desktop/src/components/chat/chatComposerModels'
import { waitForWhisperDelivery, WhisperDeliveryFailure } from '../../../../apps/desktop/src/store/whisperDelivery'
import { createReactHarness, renderWithAppProviders, message } from '../../../support/testHarness'
import type { MessageItem } from '@gugu/core/shared/types/chat'

const alice = { userId: 'alice', displayName: 'Alice' }
type Context = { chatId: string; peer: typeof alice | null }
let harness: ReturnType<typeof createReactHarness>
let result: ReturnType<typeof useChatMessageSend>
let context: Context
let choose: (next: Context) => void
let exit: () => void
let draftText: string
let publishMessages: (messages: MessageItem[]) => void

beforeEach(() => { harness = createReactHarness(); exit = vi.fn() })
afterEach(() => harness.cleanup())

async function setup(onSend: ChatMessageComposerProps['onSend'] = async () => {}) {
  function Probe() {
    const [current, setCurrent] = useState<Context>({ chatId: 'group-a', peer: alice })
    context = current; choose = setCurrent
    const [messages, setMessages] = useState<MessageItem[]>([])
    publishMessages = setMessages
    const draft = useChatDraft(current.chatId)
    draftText = draft.text
    result = useChatMessageSend({ chatId: current.chatId, isGroupChat: true, whisperTarget: current.peer, messages, onSend,
      onExitWhisper: () => { exit(); setCurrent(value => ({ ...value, peer: null })) } }, draft, [], [], useRef(null))
    return <ChatComposerContextBands isGroupChat onSend={onSend} whisperTarget={current.peer} returnedToPublic={result.returnedToPublic} />
  }
  await renderWithAppProviders(harness, <Probe />)
  return onSend
}

describe('whisper composer privacy state (#1932)', () => {
  it('waits for actual delivery and distinguishes an outbox failure from a rejected enqueue', async () => {
    let finish!: () => void
    const delivered = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    let finished = false
    const pending = waitForWhisperDelivery({ delivered }, 'private-id').then(() => { finished = true })
    await Promise.resolve()
    expect(finished).toBe(false)
    expect(delivered).toHaveBeenCalledWith('private-id')
    finish(); await pending
    expect(finished).toBe(true)
    await expect(waitForWhisperDelivery({ delivered: async () => { throw Error('network refused') } }, 'private-id')).rejects.toBeInstanceOf(WhisperDeliveryFailure)
  })

  it.each(['network refused', 'delivery timed out'])('keeps a queued failure (%s) private and exits only when its retry is acknowledged', async reason => {
    await setup(async () => { throw new WhisperDeliveryFailure('private-id', Error(reason)) })
    await act(async () => { await result.handleSend('already queued privately') })
    expect(context.peer).toEqual(alice)
    expect(exit).not.toHaveBeenCalled()
    expect(result.returnedToPublic).toBe(false)
    expect(draftText).toBe('')
    await act(async () => { publishMessages([message({ id: 'private-id', seq: -1, local_send_state: 'failed', is_whisper: true })]) })
    expect(context.peer).toEqual(alice)
    await act(async () => { publishMessages([message({ id: 'private-id', seq: -1, local_send_state: 'sending', is_whisper: true })]) })
    expect(context.peer).toEqual(alice)
    await act(async () => { publishMessages([message({ id: 'private-id', seq: 10, local_send_state: null, is_whisper: true })]) })
    expect(context.peer).toBeNull()
    expect(result.returnedToPublic).toBe(true)
  })

  it('names the private recipient, then keeps the public indication until the next public send', async () => {
    const send = vi.fn(async (..._args: unknown[]) => {})
    await setup(send)
    expect(harness.container.textContent).toContain('悄悄话给 Alice · 仅你与对方可见')
    expect(harness.container.querySelector('[role="status"]')).toBeNull()
    await act(async () => { await result.handleSend('private') })
    expect(send).toHaveBeenLastCalledWith('private', expect.objectContaining({ isWhisper: true, toUserIds: ['alice'] }))
    expect(context.peer).toBeNull()
    expect(harness.container.querySelector('[role="status"]')?.textContent).toBe('已回到群聊 · 下一条消息对群成员可见')
    await act(async () => { await result.handleSend('public') })
    expect(send.mock.calls[1][1]).not.toHaveProperty('isWhisper')
    expect(result.returnedToPublic).toBe(false)
  })

  it('keeps a failed whisper private and allows a successful private retry', async () => {
    const send = vi.fn(async () => {})
    send.mockRejectedValueOnce(new Error('send refused'))
    await setup(send)
    await act(async () => { await result.handleSend('retry privately') })
    expect(context.peer).toEqual(alice)
    expect(exit).not.toHaveBeenCalled()
    expect(result.returnedToPublic).toBe(false)
    expect(harness.container.textContent).toContain('仅你与对方可见')
    await act(async () => { await result.handleSend('retry privately') })
    expect(send).toHaveBeenLastCalledWith('retry privately', expect.objectContaining({ isWhisper: true, toUserIds: ['alice'] }))
    expect(result.returnedToPublic).toBe(true)
  })

  it('clears the public indication on switching chats, including when returning', async () => {
    await setup()
    await act(async () => { await result.handleSend('private') })
    await act(async () => { choose({ chatId: 'group-b', peer: null }) })
    expect(result.returnedToPublic).toBe(false)
    await act(async () => { choose({ chatId: 'group-a', peer: null }) })
    expect(result.returnedToPublic).toBe(false)
  })

  it.each([false, true])('does not exit a new chat visit when an old send finishes (return=%s)', async returning => {
    let finish!: () => void
    await setup(vi.fn(() => new Promise<void>(resolve => { finish = resolve })))
    let pending!: Promise<void>
    await act(async () => { pending = result.handleSend('in flight') })
    await act(async () => { choose({ chatId: 'group-b', peer: alice }) })
    if (returning) await act(async () => { choose({ chatId: 'group-a', peer: alice }) })
    await act(async () => { finish(); await pending })
    expect(exit).not.toHaveBeenCalled()
    expect(context.peer).toEqual(alice)
    expect(result.returnedToPublic).toBe(false)
  })

  it('does not clear a different private recipient selected while a send is pending', async () => {
    let finish!: () => void
    await setup(vi.fn(() => new Promise<void>(resolve => { finish = resolve })))
    let pending!: Promise<void>
    await act(async () => { pending = result.handleSend('to Alice') })
    await act(async () => { choose({ chatId: 'group-a', peer: { userId: 'bob', displayName: 'Bob' } }) })
    await act(async () => { finish(); await pending })
    expect(context.peer?.userId).toBe('bob')
    expect(exit).not.toHaveBeenCalled()
    expect(result.returnedToPublic).toBe(false)
  })
})
