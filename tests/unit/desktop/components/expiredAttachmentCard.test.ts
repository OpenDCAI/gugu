// @vitest-environment jsdom
import { act, createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import { formatAttachmentMetadata, parseAttachmentContent } from '@gugu/core/shared/ui/attachmentModels'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { ExpiredAttachmentCard } from '../../../../apps/desktop/src/components/chat/ExpiredAttachmentCard'

const f = vi.hoisted(() => ({ message: vi.fn(), metadata: vi.fn(), cached: vi.fn(), send: vi.fn(), forget: vi.fn(), signed: vi.fn() }))
vi.mock('@/lib/chat', () => ({ chatService: { getMessageById: f.message } }))
vi.mock('@/lib/attachmentBytes', () => ({ attachmentResolver: { metadata: f.metadata, forget: f.forget, resolve: f.signed }, cachedAttachmentCopy: f.cached }))
vi.mock('@/components/chat/sendAttachmentBatch', () => ({ sendAttachmentBatch: f.send }))
vi.mock('react-i18next', async (importOriginal) => ({ ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key }) }))

const original = { id: 'message', chat_id: 'group', sender_user_id: 'user-1', to_user_ids: ['private-reader'],
  is_whisper: true, thread_root_id: 'thread', is_thread_root: false, retracted_at: null,
  file_item_id: 'file', file_version: 1,
  content: formatAttachmentMetadata({ fileName: 'large.bin', mimeType: 'application/octet-stream', kind: 'file', sizeBytes: 60, url: 'https://fixture.invalid/file' }).split('\n').filter((_line, index) => index !== 1).join('\n'),
} as MessageItem
const meta = parseAttachmentContent(original.content, original)!
describe('expired attachment re-upload', () => {
  let harness: ReturnType<typeof createReactHarness>, queries: QueryClient, toast: ReturnType<typeof vi.fn>
  beforeEach(() => {
    harness = createReactHarness(); queries = new QueryClient(); toast = vi.fn()
    vi.clearAllMocks()
    f.message.mockResolvedValue(original)
    f.metadata.mockResolvedValue({ status: 'expired', sha256: 'ab'.repeat(32) })
    f.cached.mockResolvedValue(new Blob(['local copy']))
    f.send.mockResolvedValue('new-message')
  })
  afterEach(() => { harness.cleanup(); queries.clear() })
  async function render(isMine = true) {
    await renderWithAppProviders(harness, createElement(QueryClientProvider, { client: queries },
      createElement(ExpiredAttachmentCard, { meta, messageId: 'message', isMine })), { toast })
  }
  async function click() {
    const button = [...harness.container.querySelectorAll('button')].find(el => el.textContent === 'attachmentView.reupload')!
    await act(async () => { button.click() })
  }
  it('shows expiry without reading bytes or signing and offers re-upload only to the sender', async () => {
    await render(false)
    expect(harness.container.textContent).toContain('attachmentView.fileExpired')
    expect(harness.container.textContent).not.toContain('attachmentView.reupload')
    for (const mock of [f.message, f.metadata, f.cached, f.send, f.signed]) expect(mock).not.toHaveBeenCalled()
  })
  it('rechecks the real sender and ACL, then reuses normal send with the original private audience and thread', async () => {
    await render(); await click()
    expect(f.message).toHaveBeenCalledWith('message', 'user-1')
    expect(f.metadata).toHaveBeenCalledWith(meta.source)
    expect(f.cached).toHaveBeenCalledWith('ab'.repeat(32))
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.send.mock.calls[0][0]).toMatchObject({ chatId: 'group', senderId: 'user-1', toUserIds: ['private-reader'], isWhisper: true, threadRootId: 'thread' })
    expect(f.send.mock.calls[0][0].files[0]).toMatchObject({ name: 'large.bin', size: 10 })
    expect(f.signed).not.toHaveBeenCalled()
    expect(toast).not.toHaveBeenCalled()
  })
  it('keeps replies to an original thread root in that thread', async () => {
    f.message.mockResolvedValue({ ...original, is_thread_root: true, thread_root_id: null })
    await render(); await click()
    expect(f.send.mock.calls[0][0].threadRootId).toBe('message')
  })
  it.each([null, { ...original, sender_user_id: 'other' }, { ...original, retracted_at: 'now' }])('refuses a missing, other-sender or retracted original before reading local bytes (%s)', async row => {
    f.message.mockResolvedValue(row)
    await render(); await click()
    expect(toast).toHaveBeenCalledWith('attachmentView.fileGone', 'error')
    expect(f.metadata).not.toHaveBeenCalled(); expect(f.cached).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled()
  })
  it('asks for the original file when no full local copy exists, without downloading it again', async () => {
    f.cached.mockResolvedValue(null)
    await render(); await click()
    expect(harness.container.textContent).toContain('attachmentView.selectOriginal')
    expect(f.send).not.toHaveBeenCalled(); expect(f.signed).not.toHaveBeenCalled()
  })
  it('refuses a stale expiry action after the reference is gone or already ready', async () => {
    for (const status of ['gone', 'ready']) {
      f.metadata.mockResolvedValue({ status, sha256: 'ab'.repeat(32) })
      await render(); await click()
    }
    expect(f.cached).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledTimes(2)
  })
})
