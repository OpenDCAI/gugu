// @vitest-environment jsdom
import { act, createElement, useEffect, useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createNode, createReactHarness, renderWithAppProviders, waitForCondition } from '../../support/testHarness'
import { readComposer, writeComposer } from '../../support/composerEditor'
import { stubVisibleIntersection } from '../../support/visibleIntersection'
const lifeRead = vi.hoisted(() => vi.fn())
const transcriptCommands = vi.hoisted(() => vi.fn())
const transcriptView = vi.hoisted(() => ({ setScrollMode: vi.fn(), openItem: vi.fn(() => false) }))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({
  SessionpageRpcError: class extends Error {}, fetchSessionOptions: vi.fn(() => new Promise(() => {})),
  setSessionOption: vi.fn(), onMachineEvent: vi.fn(() => () => {}), onLinkChange: vi.fn(() => () => {}),
  machineRpc: () => ({ sessions: { lifeView: lifeRead } }),
}))
vi.mock('../../../apps/desktop/src/components/assistant-ui/session-transcript-view.aui', () => ({ SessionTranscriptView: (props: { composerContent: import('react').ReactNode; commands?: unknown; pendingMessages?: unknown; onReady?: (view: unknown) => void }) => {
  transcriptCommands(props.commands, props.pendingMessages)
  const [ready, setReady] = useState(false)
  const onReady = props.onReady
  useEffect(() => { const timer = setTimeout(() => { onReady?.(transcriptView); setReady(true) }, 20); return () => clearTimeout(timer) }, [onReady])
  return ready ? createElement('div', {}, props.composerContent) : null
} }))

import { SessionConversation } from '../../../apps/desktop/src/mobile/agent-watch/SessionConversation'
import { emptyAgentWatchTimeline } from '../../../apps/desktop/src/mobile/agent-watch/agent-watch-store'
import { state, changed, EMPTY } from '../../../apps/desktop/src/lib/sessionInputOutboxBridge'
import type { SessionInputOutbox } from '../../../apps/desktop/src/lib/sessionInputOutbox'
import { SessionInputQueue } from '../../../apps/desktop/src/components/chat/SessionInputQueue'
import { translateSessionMessage } from '../../../apps/desktop/src/session/renderer/localization/locale-store'
let harness: ReturnType<typeof createReactHarness>
const oldScroll = Element.prototype.scrollTo
const oldWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')!
beforeEach(() => { Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 }); harness = createReactHarness(); stubVisibleIntersection(); Element.prototype.scrollTo = () => undefined })
afterEach(() => { Object.defineProperty(window, 'innerWidth', oldWidth); harness.cleanup(); Element.prototype.scrollTo = oldScroll; vi.unstubAllGlobals();
  Object.assign(state(), { accountId: null, queue: null, rows: EMPTY, valid: () => false }); changed(); lifeRead.mockReset(); transcriptView.setScrollMode.mockClear()
})
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
  expect(lifeRead).not.toHaveBeenCalled()
})

it('keeps the running task Send action until its local outbox commit resolves', async () => {
  // A successful local commit belongs to the active sender account.
  Object.assign(state(), { accountId: 'owner', valid: () => true })
  let commit!: () => void
  const onSend = vi.fn(() => new Promise<void>(resolve => { commit = resolve }))
  const onStop = vi.fn()
  await renderWithAppProviders(harness, createNode(SessionConversation, {
    timeline: emptyAgentWatchTimeline(), deviceId: 'desktop', sessionId: 'send-state-1451', agentName: 'Test agent', sessionRuntime: 'acp',
    respondingItemId: null, onRespond: vi.fn(), onSend, pendingSends: [], sending: false, agentWorking: true,
    onStop, stopping: false, onLoadOlder: async () => undefined,
  }))
  const field = () => harness.container.querySelector<HTMLElement>('[data-testid="prompt-editor"]')!
  const send = () => harness.container.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')
  const stop = () => harness.container.querySelector('[data-composer-action="stop"]')
  await waitForCondition(() => !!field(), 'task composer ready')
  expect(stop()).not.toBeNull()
  await act(async () => writeComposer(field(), 'one queued intent'))
  expect(send()?.disabled).toBe(false)
  await act(async () => { send()!.click(); send()!.click(); send()!.click() })
  await waitForCondition(() => onSend.mock.calls.length === 1, 'task reaches local outbox')
  expect(transcriptView.setScrollMode).toHaveBeenCalledExactlyOnceWith({ kind: 'tail' })
  // The reader can leave while this commit is pending; success cannot restore following.
  transcriptView.setScrollMode.mockClear()
  // The draft retains custody until onSend confirms the durable outbox commit.
  expect(readComposer(field())).toBe('one queued intent')
  expect(send()?.disabled).toBe(true)
  expect(stop()).toBeNull()
  expect(onStop).not.toHaveBeenCalled()
  await act(async () => commit())
  expect(readComposer(field())).toBe('')
  expect(transcriptView.setScrollMode).not.toHaveBeenCalled()
  expect(stop()).not.toBeNull()
  expect(onStop).not.toHaveBeenCalled()
})


it('does not republish transcript commands while typing or clearing a phone draft', async () => {
  const onSend = vi.fn(async () => {})
  const props = {
    timeline: emptyAgentWatchTimeline(), deviceId: 'desktop', sessionId: 'stable-commands-1451', agentName: 'Test agent', sessionRuntime: 'acp' as const,
    respondingItemId: null, onRespond: vi.fn(), onSend, pendingSends: [], sending: false, agentWorking: false,
    onStop: vi.fn(), stopping: false, onLoadOlder: async () => undefined,
  }
  await renderWithAppProviders(harness, createNode(SessionConversation, props))
  const field = () => harness.container.querySelector<HTMLElement>('[data-testid="prompt-editor"]')!
  await waitForCondition(() => !!field(), 'phone composer ready')
  const original = transcriptCommands.mock.lastCall![0]
  const originalPending = transcriptCommands.mock.lastCall![1]
  transcriptCommands.mockClear()
  await act(async () => writeComposer(field(), 'typing a message'))
  await act(async () => writeComposer(field(), 'typing a longer message'))
  await act(async () => harness.container.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')!.click())
  expect(onSend).toHaveBeenCalledTimes(1)
  expect(transcriptCommands.mock.calls.length).toBeGreaterThan(0)
  for (const [commands, pending] of transcriptCommands.mock.calls) { expect(commands).toBe(original); expect(pending).toBe(originalPending) }
  const replacementStop = vi.fn()
  await renderWithAppProviders(harness, createNode(SessionConversation, { ...props, onStop: replacementStop }))
  const updated = transcriptCommands.mock.lastCall![0] as { onStop: () => void }
  updated.onStop()
  expect(replacementStop).toHaveBeenCalledTimes(1)
})

it('shows an online host refusal through the existing input queue failure status and retry action', async () => {
  const failure = { code: 'send-failed' as const, message: 'Provider login expired' }
  const input = { id: 'failed-local', accountId: 'owner', deviceId: 'desktop', sessionId: 'failure-1451', text: 'queued intent', createdAt: 1, queued: true, failure }
  const flush = vi.fn(async () => {})
  Object.assign(state(), { accountId: 'owner', queue: Promise.resolve({ flush } as unknown as SessionInputOutbox), rows: [input], valid: () => true })
  lifeRead.mockResolvedValue({ sessionId: 'failure-1451', version: 1, kind: 'ready', pending: { count: 0, items: [] } })
  await renderWithAppProviders(harness, createNode(SessionConversation, {
    timeline: emptyAgentWatchTimeline(), deviceId: 'desktop', sessionId: 'failure-1451', agentName: 'Test agent', sessionRuntime: 'acp',
    respondingItemId: null, onRespond: vi.fn(), onSend: vi.fn(), pendingSends: [], sending: false, agentWorking: true,
    onStop: vi.fn(), stopping: false, onLoadOlder: async () => undefined,
    footerNotice: createNode(SessionInputQueue, { sessionId: 'failure-1451', waitingForConnection: false }),
  }))
  await waitForCondition(() => !!harness.container.querySelector('[data-testid="prompt-editor"]'), 'phone composer ready')
  const status = harness.container.querySelector('[data-native-input-id="failed-local"] [data-send-state="failed"]')
  expect(status?.textContent).toContain(failure.message)
  expect(harness.container.querySelector('[data-queued-prompt-id="failed-local"]')).toBeNull()
  expect(state().rows).toEqual([input])
  const retry = [...status!.querySelectorAll('button')].find(button => button.textContent === translateSessionMessage('transcript.retrySend'))!
  await act(async () => retry.click())
  expect(flush).toHaveBeenCalledWith(true)
})
