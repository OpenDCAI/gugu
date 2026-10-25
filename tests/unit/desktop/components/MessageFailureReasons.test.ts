// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MessageBubble } from '../../../../apps/desktop/src/components/chat/MessageBubble'
import { clickElement, createNode, createReactHarness, message, renderWithAppProviders, waitForCondition } from '../../../support/testHarness'
const download = vi.hoisted(() => vi.fn())
vi.mock('../../../../apps/desktop/src/lib/attachmentBytes', async (original) => ({ ...(await original<object>()), downloadAttachment: download }))
vi.mock('../../../../apps/desktop/src/hooks/useAgentHarnessIdentity', () => ({ useAgentHarnessIdentity: () => 'codex' }))
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { harness.cleanup(); vi.unstubAllGlobals() })
const callbacks = { onReaction: () => {}, onQuote: () => {}, onForward: () => {}, onDelete: () => {} }
async function chooseAction(label: string) {
  const bubble = harness.container.querySelector('[data-testid="message-bubble-action-target"]')!
  await act(async () => { bubble.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 })) })
  const action = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.includes(label))
  await waitForCondition(() => !!action(), 'message action was never ready')
  await clickElement(action()!)
}

it('passes the persisted delivery cause to the existing failed-message menu', async () => {
  await renderWithAppProviders(harness, createNode(MessageBubble, { ...callbacks, msg: message({ is_mine: true, local_send_state: 'failed', local_send_error: 'Chat not found /Users/test/private sk-synthetic-secret' }), sendState: 'failed' }))
  const trigger = harness.container.querySelector<HTMLElement>('[data-testid="message-send-failed"]')!
  expect(trigger.title).toBe('Chat not found [path] [redacted token]')
  await clickElement(trigger)
  expect(document.querySelector('[data-testid="message-send-failed-menu"]')?.textContent).toContain(trigger.title)
})
it('preserves the attachment failure from the message download action', async () => {
  download.mockRejectedValueOnce(new Error('attachment 403'))
  const toast = vi.fn()
  await renderWithAppProviders(harness, createNode(MessageBubble, { ...callbacks, msg: message({ is_mine: true, content_type: 'attachment', content: '[附件] test.txt (text/plain)\n[Size] 1\n[Kind] file', file_item_id: 'item', file_version: 1 }) }), { toast })
  await chooseAction('下载')
  expect(toast).toHaveBeenCalledWith('无法下载文件', 'error', 'attachment 403')
})
