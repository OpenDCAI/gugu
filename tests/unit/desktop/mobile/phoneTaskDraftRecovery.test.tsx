// @vitest-environment jsdom
import type { ChatCommands } from '@gugu/session-chat-ui'
import { openMessageSender } from '../../../../apps/desktop/src/lib/openMessageSender'
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness, renderWithAppProviders, waitForCondition } from '../../../support/testHarness'
import { readComposer, writeComposer } from '../../../support/composerEditor'
import { stubVisibleIntersection } from '../../../support/visibleIntersection'

const transcript = vi.hoisted(() => ({ commands: undefined as ChatCommands | undefined }))
const auth = vi.hoisted(() => ({ owner: 'draft-owner-a' }))
const rpc = vi.hoisted(() => ({ invoke: vi.fn(() => new Promise(() => undefined)) }))
vi.mock('../../../../apps/desktop/src/lib/supabase', async (original) => ({ ...await original<typeof import('../../../../apps/desktop/src/lib/supabase')>(), getCurrentAuthUserId: async () => auth.owner }))
vi.mock('../../../../apps/desktop/src/mobile/local-agent/phoneHostRpc', () => ({ invokePhoneHost: rpc.invoke }))
vi.mock('../../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({
  SessionpageRpcError: class SessionpageRpcError extends Error {},
  fetchSessionOptions: vi.fn(() => new Promise(() => undefined)), setSessionOption: vi.fn(), sessionAttachmentRpc: vi.fn(() => ({})),
}))

vi.mock('../../../../apps/desktop/src/components/assistant-ui/session-transcript-view.aui', () => ({ SessionTranscriptView: (props: { composerContent: import('react').ReactNode; commands: ChatCommands }) => { transcript.commands = props.commands; return createElement('div', {}, props.composerContent) } }))

import { SessionConversation } from '../../../../apps/desktop/src/mobile/agent-watch/SessionConversation'
import { emptyAgentWatchTimeline } from '../../../../apps/desktop/src/mobile/agent-watch/agent-watch-store'
import { phoneTaskSendKey, readPhoneTaskSend, restorePhoneTaskDraft, sendPhoneTaskText } from '../../../../apps/desktop/src/mobile/local-agent/phoneTaskSend'

let harness: ReturnType<typeof createReactHarness>
const oldScroll = Element.prototype.scrollTo
const input = () => harness.container.querySelector<HTMLElement>('[data-testid="prompt-editor"]')!
const draft = () => { const field = input(); return field ? readComposer(field) : null }
const recovery = () => harness.container.querySelector<HTMLElement>('[data-testid="phone-task-draft-recovery"]')
const retry = () => harness.container.querySelector<HTMLElement>('[data-testid="phone-task-retry-original"]')!
async function leaveUnconfirmed(text: string) {
  const invoke = vi.fn().mockRejectedValue(new Error('lost acknowledgement'))
  await expect(sendPhoneTaskText('phone-draft', 'task-draft', text, invoke)).rejects.toThrow('lost acknowledgement')
  return invoke.mock.calls[0][2][0]
}
async function show(onSend = async (_text: string) => undefined) {
  await renderWithAppProviders(harness, createNode(SessionConversation, {
    timeline: emptyAgentWatchTimeline(), deviceId: 'phone-draft', sessionId: 'task-draft', phoneHost: true,
    agentName: 'Test agent', agentUserId: 'phone-agent', sessionRuntime: 'acp', respondingItemId: null, onRespond: () => undefined, onSend, pendingSends: [], sending: false,
    agentWorking: false, onStop: () => undefined, stopping: false, onLoadOlder: async () => undefined,
  }), { auth: { id: auth.owner } })
}
beforeEach(() => {
  stubVisibleIntersection()
  localStorage.clear(); auth.owner = 'draft-owner-a'; rpc.invoke.mockReset(); rpc.invoke.mockImplementation(() => new Promise(() => undefined)); harness = createReactHarness()
  Element.prototype.scrollTo = () => undefined
})
afterEach(() => { harness.cleanup(); Element.prototype.scrollTo = oldScroll; vi.unstubAllGlobals() })

describe('the existing phone task composer recovers an unacknowledged send', () => {
  it('restores the actual empty input without replay, then an explicit retry keeps the original id', async () => {
    const original = await leaveUnconfirmed('原来写了很长的任务内容')
    const accepted = vi.fn().mockResolvedValue({ accepted: true })
    rpc.invoke.mockImplementation((...args: unknown[]) => args[1] === 'sessionTimeline.sessionSend' ? accepted(...args) : new Promise(() => undefined))
    const ordinarySend = vi.fn(async () => undefined)
    await show(ordinarySend)
    await waitForCondition(() => draft() === original.text, 'actual composer restored')
    expect(accepted).not.toHaveBeenCalled()
    expect(recovery()?.textContent).toContain('查看原消息')
    await clickElement(retry())
    await waitForCondition(() => recovery() === null, 'acknowledged outbox removed')
    expect(accepted).toHaveBeenCalledTimes(1)
    expect(ordinarySend).not.toHaveBeenCalled()
    expect(accepted.mock.calls[0][2][0].clientRequestId).toBe(original.clientRequestId)
    expect(draft()).toBe('')
  })

  it('preserves newly typed words and lets the saved original be retried separately', async () => {
    const accepted = vi.fn().mockResolvedValue({ accepted: true })
    rpc.invoke.mockImplementation((...args: unknown[]) => args[1] === 'sessionTimeline.sessionSend' ? accepted(...args) : new Promise(() => undefined))
    await show()
    await waitForCondition(() => !!input(), 'actual composer mounted')
    await act(async () => {
      writeComposer(input(), '我正在写的新内容')
    })
    let original!: Awaited<ReturnType<typeof leaveUnconfirmed>>
    await act(async () => { original = await leaveUnconfirmed('之前未确认的原稿') })
    await waitForCondition(() => !!retry(), 'saved original offers retry')
    expect(draft()).toBe('我正在写的新内容')
    expect(recovery()?.textContent).toContain('之前未确认的原稿')
    await clickElement(retry())
    expect(accepted.mock.calls[0][2][0].clientRequestId).toBe(original.clientRequestId)
    expect(draft()).toBe('我正在写的新内容')
  })

  it('does not restore another account record and removes only its own untouched injected text on account change', async () => {
    await leaveUnconfirmed('属于账号A的原稿')
    await show()
    await waitForCondition(() => draft() === '属于账号A的原稿', 'owner A restored')
    auth.owner = 'draft-owner-b'
    await show()
    await waitForCondition(() => recovery() === null && draft() === '', 'owner B sees no owner A draft')
    expect(readPhoneTaskSend('draft-owner-a', 'phone-draft', 'task-draft')?.text).toBe('属于账号A的原稿')
    expect(readPhoneTaskSend('draft-owner-b', 'phone-draft', 'task-draft')).toBeNull()
  })

  it('keeps a corrupt record and shows a readable error without making a request', async () => {
    localStorage.setItem(phoneTaskSendKey(auth.owner, 'phone-draft', 'task-draft'), '{broken')
    const onSend = vi.fn(async () => undefined)
    await show(onSend)
    await waitForCondition(() => !!recovery()?.querySelector('[role="alert"]'), 'corrupt recovery failure visible')
    expect(onSend).not.toHaveBeenCalled()
    expect(localStorage.getItem(phoneTaskSendKey(auth.owner, 'phone-draft', 'task-draft'))).toBe('{broken')
  })

  it('does not overwrite whitespace or selected attachments when deciding whether a composer is empty', () => {
    const setText = vi.fn()
    expect(restorePhoneTaskDraft({ getState: () => ({ text: ' ', attachments: [] }), setText }, 'old')).toBe(false)
    expect(restorePhoneTaskDraft({ getState: () => ({ text: '', attachments: [{}] }), setText }, 'old')).toBe(false)
    expect(setText).not.toHaveBeenCalled()
  })
})

it('opens phone sender names through the same shell adapter with real session and user identities', async () => {
  await show()
  expect(transcript.commands?.onOpenSender).toBe(openMessageSender)
  expect(transcript.commands?.conversationAgentSession?.()).toBe('task-draft')
  expect(transcript.commands?.conversationAgentUserId?.()).toBe('phone-agent')
})
