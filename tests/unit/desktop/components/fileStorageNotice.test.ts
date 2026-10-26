// @vitest-environment jsdom
import { act, createElement } from 'react'
import { notifyManager } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chat, createReactHarness, message, renderWithAppProviders } from '../../../support/testHarness'
import type { ChatItem, MessageItem } from '@gugu/core/shared/types/chat'
import { FileStorageNotice } from '../../../../apps/desktop/src/components/chat/FileStorageNotice'
import { attachmentQueryClient } from '../../../../apps/desktop/src/lib/attachmentQueryClient'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase', async (original) => ({ ...await original<typeof import('@/lib/supabase')>(), chatDb: { rpc } }))
vi.mock('react-i18next', async (original) => ({ ...await original<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string, values?: { used: string; limit: string }) => key + (values ? ` ${values.used} / ${values.limit}` : '') }),
}))
const healthy = { used_and_reserved_bytes: 100, limit_bytes: 1000, warning: false, full: false }
describe('group manager storage notice', () => {
  let harness: ReturnType<typeof createReactHarness>
  beforeEach(() => {
    harness = createReactHarness(); attachmentQueryClient.clear(); rpc.mockReset().mockResolvedValue({ data: healthy, error: null })
    notifyManager.setNotifyFunction(callback => { act(callback) })
  })
  afterEach(() => { harness.cleanup(); attachmentQueryClient.clear(); notifyManager.setNotifyFunction(callback => { callback() }) })
  async function render(role: ChatItem['my_role'] = 'admin', messages: MessageItem[] = [], kind: ChatItem['kind'] = 'group') {
    await renderWithAppProviders(harness, createElement(FileStorageNotice, { chatId: 'group' }), {
      chat: { chats: [chat({ id: 'group', kind, my_role: role })], messages },
    })
  }
  async function settled(assertion: () => void) {
    await vi.waitFor(async () => { await act(async () => {}); assertion() })
  }
  it.each(['owner', 'admin'] as const)('queries only the existing read-only usage RPC as the actual %s account', async role => {
    await render(role)
    await settled(() => expect(rpc).toHaveBeenCalledExactlyOnceWith('file_transfer_group_usage', { p_chat: 'group', p_as: 'user-1' }))
    expect(harness.container.querySelector('[role="status"]')).toBeNull()
  })
  it('does not query for ordinary members, unknown roles or private chats', async () => {
    await render('member'); await render(null); await render('owner', [], 'dm')
    expect(rpc).not.toHaveBeenCalled()
    expect(harness.container.textContent).toBe('')
  })
  it.each([false, true])('shows the configured warning or full state including reserved bytes (%s)', async full => {
    rpc.mockResolvedValue({ data: { used_and_reserved_bytes: 900, limit_bytes: 1000, warning: true, full }, error: null })
    await render()
    await settled(() => expect(harness.container.textContent).toContain(full ? 'attachmentView.storageFull' : 'attachmentView.storageWarning'))
    expect(harness.container.textContent).toContain('900 B / 1000 B')
  })
  it('refreshes after a new attachment, while an unrelated text message does not cause another usage request', async () => {
    await render(); await settled(() => expect(rpc).toHaveBeenCalledTimes(1))
    await render('admin', [message({ chat_id: 'group', id: 'text', content_type: 'text' })])
    expect(rpc).toHaveBeenCalledTimes(1)
    rpc.mockResolvedValue({ data: { ...healthy, warning: true }, error: null })
    await render('admin', [message({ chat_id: 'group', id: 'file', content_type: 'attachment' })])
    await settled(() => expect(harness.container.textContent).toContain('attachmentView.storageWarning'))
    expect(rpc).toHaveBeenCalledTimes(2)
  })
  it.each([{ data: null, error: { message: 'not configured' } }, { data: {}, error: null }])('shows unavailable and permits retry without inventing zero usage (%s)', async refusal => {
    rpc.mockResolvedValueOnce(refusal)
    await render()
    await settled(() => expect(harness.container.textContent).toContain('attachmentView.usageUnavailable'))
    await act(async () => { harness.container.querySelector('button')!.click() })
    await settled(() => expect(harness.container.querySelector('[role="status"]')).toBeNull())
    expect(rpc).toHaveBeenCalledTimes(2)
  })
})
