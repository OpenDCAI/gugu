// @vitest-environment jsdom
import { act, createElement, useEffect, useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createNode, createReactHarness, renderWithAppProviders, waitForCondition } from '../../support/testHarness'
import { readComposer, writeComposer } from '../../support/composerEditor'
vi.mock('../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({
  SessionpageRpcError: class extends Error {}, fetchSessionOptions: vi.fn(() => new Promise(() => {})),
  setSessionOption: vi.fn(), sessionAttachmentRpc: vi.fn(() => ({})),
}))
vi.mock('../../../apps/desktop/src/components/assistant-ui/session-transcript-view.aui', () => ({ SessionTranscriptView: (props: { composerContent: import('react').ReactNode }) => {
  const [ready, setReady] = useState(false)
  useEffect(() => { const timer = setTimeout(() => setReady(true), 20); return () => clearTimeout(timer) }, [])
  return ready ? createElement('div', {}, props.composerContent) : null
} }))

import { SessionConversation } from '../../../apps/desktop/src/mobile/agent-watch/SessionConversation'
import { emptyAgentWatchTimeline } from '../../../apps/desktop/src/mobile/agent-watch/agent-watch-store'
let harness: ReturnType<typeof createReactHarness>
const oldScroll = Element.prototype.scrollTo
beforeEach(() => { harness = createReactHarness(); Element.prototype.scrollTo = () => undefined })
afterEach(() => { harness.cleanup(); Element.prototype.scrollTo = oldScroll })
it('puts each App draft in the real task composer once, preserving human edits and sending nothing', async () => {
  const onSend = vi.fn(), applied = vi.fn()
  const timeline = emptyAgentWatchTimeline()
  const render = (draft?: { text: string }) => renderWithAppProviders(harness, createNode(SessionConversation, {
    timeline, deviceId: 'desktop', sessionId: 'task', agentName: 'Test agent', sessionRuntime: 'acp', draft, onDraftApplied: applied,
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
  await vi.waitFor(() => expect(readComposer(field())).toBe('My existing notes\nCheck slide 3'))
  expect(applied).toHaveBeenCalledTimes(2)
  expect(onSend).not.toHaveBeenCalled()
})
