// @vitest-environment jsdom
import { act, createElement, useLayoutEffect, useRef } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ChatContext, ChatState, ChatView } from '@gugu/session-chat-ui'
import { createReactHarness } from '../../../support/testHarness'

const mock = vi.hoisted(() => ({ props: {} as Record<string, unknown>, scroll: vi.fn() }))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/chat/chat-transcript', () => ({
  ChatTranscript: (props: Record<string, unknown>) => {
    mock.props = props
    const slot = useRef<HTMLDivElement>(null)
    const ready = props.onReady as (view: Partial<ChatView>) => void
    useLayoutEffect(() => { ready({ composerSlot: slot.current!, scrollToBottom: mock.scroll }) }, [ready])
    return <div ref={slot} />
  },
}))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/ui/assistant-ui/thread-scroll-to-bottom', () => ({
  ThreadScrollToBottom: ({ atBottom, onScrollToBottom }: { atBottom: boolean; onScrollToBottom(): void }) =>
    <button disabled={atBottom} onClick={onScrollToBottom}>Jump to latest</button>,
}))
import { AgentConversationView } from '../../../../apps/desktop/src/session/renderer/lib/chat/agent-conversation-view'

const harness = createReactHarness()
afterEach(() => { harness.cleanup(); mock.scroll.mockClear() })

it('restores following only through the live view and keeps the host bottom callback', async () => {
  const changed = vi.fn()
  await harness.render(createElement(AgentConversationView, { context: {} as ChatContext, state: {} as ChatState,
    composerContent: createElement('div', null, 'Composer'), onAtBottomChange: changed }))
  const button = harness.container.querySelector('button')!
  expect(button, 'native records need a normal recovery control').not.toBeNull()
  expect(button.disabled).toBe(true)
  await act(async () => { (mock.props.onAtBottomChange as (value: boolean) => void)(false) })
  expect(changed).toHaveBeenLastCalledWith(false)
  expect(button.disabled).toBe(false)
  expect(mock.scroll).not.toHaveBeenCalled()
  await act(async () => { button.click() })
  expect(mock.scroll).toHaveBeenCalledExactlyOnceWith({ behavior: 'smooth' })
  expect(button.disabled, 'the view, not the click, confirms arrival').toBe(false)
  await act(async () => { (mock.props.onAtBottomChange as (value: boolean) => void)(true) })
  expect(button.disabled).toBe(true)
  expect(harness.container.querySelector('button')).toBe(button)
})
