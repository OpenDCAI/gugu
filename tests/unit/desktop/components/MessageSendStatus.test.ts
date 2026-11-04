// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { SystemMessageNotice } from '../../../../apps/desktop/src/components/chat/SystemMessageNotice'
import { MessageSendStatus } from '../../../../apps/desktop/src/components/chat/MessageSendStatus'
import { deriveMessageSendState } from '@gugu/core/shared/ui/messageState'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import { setAttachmentUploadProgress } from '../../../../apps/desktop/src/lib/attachmentUploadProgress'
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
})
afterEach(() => {
  harness.cleanup()
  setAttachmentUploadProgress('progress-message')
})
describe('MessageSendStatus', () => {
  it('keeps zero-byte upload events indeterminate, including a retry reset', async () => {
    await renderWithAppProviders(harness, createNode(MessageSendStatus, { state: 'sending', messageId: 'progress-message' }),
      { chat: { retrySend: vi.fn(), discardSend: vi.fn() } })
    for (const attempt of [1, 2]) {
      await act(async () => setAttachmentUploadProgress('progress-message', { loaded: 0, total: 1024, attempt }))
      expect(document.body.querySelector('[role="progressbar"]')).toBeNull()
      expect(document.body.querySelector('.gg-ring-march')).not.toBeNull()
      await act(async () => setAttachmentUploadProgress('progress-message', { loaded: 256, total: 1024, attempt }))
      expect(document.body.querySelector('[role="progressbar"]')?.textContent).toBe('25%')
      expect(document.body.querySelector('.gg-ring-march')).toBeNull()
    }
  })
  it('shows the measured upload percentage in the existing sending indicator', async () => {
    setAttachmentUploadProgress('progress-message', { loaded: 512, total: 1024, attempt: 1 })
    await renderWithAppProviders(harness, createNode(MessageSendStatus, { state: 'sending', messageId: 'progress-message' }),
      { chat: { retrySend: vi.fn(), discardSend: vi.fn() } })
    const progress = document.body.querySelector('[role="progressbar"]')!
    expect(progress.getAttribute('aria-valuenow')).toBe('50')
    expect(progress.textContent).toBe('50%')
    expect(document.body.querySelector('.gg-ring-march')).toBeNull()
  })
  it('keeps the sending ring when the transport cannot measure the total', async () => {
    setAttachmentUploadProgress('progress-message', { loaded: 512, attempt: 1 })
    await renderWithAppProviders(harness, createNode(MessageSendStatus, { state: 'sending', messageId: 'progress-message' }),
      { chat: { retrySend: vi.fn(), discardSend: vi.fn() } })
    expect(document.body.querySelector('[role="progressbar"]')).toBeNull()
    expect(document.body.querySelector('.gg-ring-march')).not.toBeNull()
  })
  it('keeps an ambiguous attachment visibly unknown without a sending spinner or resend action', async () => {
    const state = deriveMessageSendState({ seq: -1, local_send_state: 'unknown' } as MessageItem, {})
    await renderWithAppProviders(harness, createNode(MessageSendStatus, { state, messageId: 'message-1' }),
      { chat: { retrySend: vi.fn(), discardSend: vi.fn() } })
    expect(document.body.querySelector('[data-send-state="unknown"]')?.textContent).toContain('状态待确认')
    expect(document.body.querySelector('.gg-ring-march')).toBeNull()
    expect(document.body.querySelector('[data-testid="message-send-retry"]')).toBeNull()
  })
  it('shows a terminal per-recipient archive refusal alongside other recipients still waiting', async () => {
    await renderWithAppProviders(harness, createNode(MessageSendStatus, { state: 'queued', messageId: 'm',
      blocks: [{ agent_user_id: 'archived', reason: 'agent_archived' }] }),
    { chat: { retrySend: vi.fn(), discardSend: vi.fn() } })
    const notice = document.body.querySelector('[data-agent-id="archived"]')!
    expect(notice.textContent).toContain('对方已归档、未送达')
    expect(document.body.querySelector('[data-send-state="receiving"]')).not.toBeNull()
    expect(document.body.querySelector('[data-testid="message-send-failed"]')).toBeNull()
  })
  it('uses the shared Base UI menu and wires retry/discard actions', async () => {
    const retrySend = vi.fn()
    const discardSend = vi.fn()
    await renderWithAppProviders(
      harness,
      createNode(MessageSendStatus, { state: 'failed', messageId: 'message-1', reason: 'Recipient left /Users/test/private sk-synthetic-secret\nstack detail' }),
      { chat: { retrySend, discardSend } },
    )
    const trigger = document.body.querySelector('[data-testid="message-send-failed"]') as HTMLElement
    expect(trigger.title).toBe('Recipient left [path] [redacted token]')
    await clickElement(trigger)
    expect(document.body.querySelector('[role="menu"][aria-label="未送达消息操作"]')).not.toBeNull()
    expect(document.body.querySelector('[data-testid="message-send-failed-menu"]')?.textContent).toContain('Recipient left [path] [redacted token]')
    const retry = document.body.querySelector('[data-testid="message-send-retry"]') as HTMLElement
    await clickElement(retry)
    expect(retrySend).toHaveBeenCalledWith('message-1')
    expect(document.body.querySelector('[data-testid="message-send-failed-menu"]')).toBeNull()
    await clickElement(trigger)
    const discard = document.body.querySelector('[data-testid="message-send-discard"]') as HTMLElement
    await clickElement(discard)
    expect(discardSend).toHaveBeenCalledWith('message-1')
  })
  it('shows three receiving dots without extra status text or changing the indicator footprint', async () => {
    await renderWithAppProviders(harness, createNode(MessageSendStatus, { state: 'queued', messageId: 'message-1' }), { chat: { retrySend: vi.fn(), discardSend: vi.fn() } })
    const dots = document.body.querySelector('[data-send-state="receiving"]')!
    expect(dots.getAttribute('aria-label')).toBe('等待接收')
    expect(dots.querySelectorAll('circle')).toHaveLength(3)
    expect(dots.textContent).toBe('')
    expect([dots.getAttribute('width'), dots.getAttribute('height')]).toEqual(['15', '15'])
    expect(document.body.querySelector('.gg-ring-march')).toBeNull()
  })
})

it('a queued topic notice exposes the existing failure controls, with no retry after its source was discarded', async () => {
  const discardSend = vi.fn()
  await renderWithAppProviders(harness, createNode(SystemMessageNotice, { message: {
    id: 'topic-request', sender_user_id: 'me', content_type: 'system', content: 'New topic',
    local_send_state: 'failed', local_send_error: 'Original message was discarded', local_send_retryable: false,
  } }), { chat: { discardSend } })
  const trigger = document.body.querySelector('[data-testid="message-send-failed"]') as HTMLElement
  expect(trigger).not.toBeNull()
  await clickElement(trigger)
  expect(document.body.querySelector('[data-testid="message-send-retry"]')).toBeNull()
  await clickElement(document.body.querySelector('[data-testid="message-send-discard"]') as HTMLElement)
  expect(discardSend).toHaveBeenCalledWith('topic-request')
})
