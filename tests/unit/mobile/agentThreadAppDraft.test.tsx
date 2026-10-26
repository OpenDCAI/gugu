// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createNode, createReactHarness, waitForCondition } from '../../support/testHarness'
import { readComposer, writeComposer } from '../../support/composerEditor'
vi.mock('../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({
  SessionpageRpcError: class extends Error {}, fetchSessionOptions: vi.fn(() => new Promise(() => {})),
  setSessionOption: vi.fn(), sessionAttachmentRpc: vi.fn(() => ({})),
}))
import { AgentThread } from '../../../apps/desktop/src/mobile/agent-watch/AgentThread'
import { emptyAgentWatchTimeline } from '../../../apps/desktop/src/mobile/agent-watch/agent-watch-store'
let harness: ReturnType<typeof createReactHarness>
const oldScroll = Element.prototype.scrollTo
beforeEach(() => { harness = createReactHarness(); Element.prototype.scrollTo = () => undefined })
afterEach(() => { harness.cleanup(); Element.prototype.scrollTo = oldScroll })
it('puts each App draft in the real task composer once, preserving human edits and sending nothing', async () => {
  const onSend = vi.fn(), applied = vi.fn()
  const timeline = emptyAgentWatchTimeline()
  const render = (draft?: { text: string }) => harness.render(createNode(AgentThread, {
    timeline, deviceId: 'desktop', sessionId: 'task', sessionRuntime: 'acp', draft, onDraftApplied: applied,
    respondingItemId: null, onRespond: vi.fn(), onSend, pendingSends: [], sending: false, agentWorking: false,
    onStop: vi.fn(), stopping: false, onLoadOlder: async () => undefined,
  }))
  const field = () => harness.container.querySelector<HTMLElement>('[data-testid="prompt-editor"]')!
  const first = { text: 'Review the deck' }
  await render(first)
  await waitForCondition(() => !!field() && readComposer(field()) === first.text, 'the App draft is in the composer')
  await render(first)
  expect(readComposer(field())).toBe(first.text)
  await act(async () => writeComposer(field(), 'My existing notes'))
  await render({ text: 'Check slide 3' })
  await waitForCondition(() => readComposer(field()) === 'My existing notes\nCheck slide 3', 'the new draft appends to human edits')
  expect(applied).toHaveBeenCalledTimes(2)
  expect(onSend).not.toHaveBeenCalled()
})
