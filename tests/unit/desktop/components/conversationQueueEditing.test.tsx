// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { useConversationQueue } from '../../../../apps/desktop/src/components/chat/useConversationQueue'

const { write } = vi.hoisted(() => ({ write: vi.fn<(...args: unknown[]) => Promise<null>>(async () => null) }))
vi.mock('../../../../apps/desktop/src/components/assistant/assistantTimelineClient', () => ({ changeConversationQueue: write }))
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup(); vi.useRealTimers(); write.mockClear() })
const target = { deviceId: 'mine', sessionId: 'same-session', local: false }
let queue: ReturnType<typeof useConversationQueue>
function Host({ prompts }: { prompts: Parameters<typeof useConversationQueue>[1] }) {
  queue = useConversationQueue(target, prompts, true)
  return createElement('div')
}
it('flushes a reserved edit before switching entry points and restores the original normal draft', async () => {
  vi.useFakeTimers()
  const prompts = [{ id: 'q1', text: 'original' }]
  await harness.render(createElement(Host, { prompts }))
  await act(async () => { queue.props.onBeginEditQueuedPrompt('q1', 'unsent normal draft') })
  await harness.render(createElement(Host, { prompts: [{ ...prompts[0]!, queueEdit: { draftText: 'original', originalDraftText: 'unsent normal draft' } }] }))
  await act(async () => { queue.props.onChangeQueuedPromptEdit('changed on the phone') })
  await act(async () => { harness.cleanup(); await Promise.resolve() })
  expect(write.mock.calls.at(-1)).toEqual([false, 'mine', 'same-session', { kind: 'edit', id: 'q1', text: 'original', queueEdit: { draftText: 'changed on the phone', originalDraftText: 'unsent normal draft' } }, undefined])
})
it('cancels the debounce before finishing, so a late autosave cannot reopen the queue reservation', async () => {
  vi.useFakeTimers()
  await harness.render(createElement(Host, { prompts: [{ id: 'q1', text: 'original', queueEdit: { draftText: 'draft', originalDraftText: 'normal' } }] }))
  await act(async () => { queue.props.onChangeQueuedPromptEdit('final'); queue.props.onFinishQueuedPromptEdit('final') })
  await act(async () => { await vi.advanceTimersByTimeAsync(500) })
  expect(write).toHaveBeenCalledTimes(1)
  expect(write.mock.calls[0]?.[3]).toEqual({ kind: 'edit', id: 'q1', text: 'final', queueEdit: null })
})
