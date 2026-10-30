import { beforeEach, expect, it, vi } from 'vitest'
import { message } from '../../../support/testHarness'
const mocks = vi.hoisted(() => ({ get: vi.fn(), open: vi.fn(), follow: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: { getMessageById: mocks.get } }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ getCurrentAuthUserId: async () => 'owner' }))
vi.mock('../../../../apps/desktop/src/lib/guguLinks', () => ({ openLinkTarget: mocks.open, followLink: mocks.follow }))
import { followConversationLink, openMessageAttachment } from '../../../../apps/desktop/src/lib/followConversationLink'
beforeEach(() => { vi.clearAllMocks() })
it('resolves an authorized message receipt to the existing file route with its pinned version', async () => {
  const row = message({ id: 'receipt', content_type: 'attachment', content: '[附件] proof.txt (text/plain)\n[Size] 9\n[Kind] file', file_item_id: 'file-item', file_version: 4 })
  mocks.get.mockResolvedValue(row)
  await openMessageAttachment('receipt')
  expect(mocks.get).toHaveBeenCalledWith('receipt', 'owner')
  expect(mocks.open).toHaveBeenCalledWith({ kind: 'file', itemId: 'file-item', version: 4 }, { message: row })
})
it('does not open a missing or retracted attachment', async () => {
  mocks.get.mockResolvedValue(null)
  await expect(openMessageAttachment('gone')).rejects.toThrow('unavailable')
  expect(mocks.open).not.toHaveBeenCalled()
})
it('leaves ordinary links on the existing link route', () => {
  followConversationLink('gugu-file://existing?v=3')
  expect(mocks.follow).toHaveBeenCalledWith('gugu-file://existing?v=3')
  expect(mocks.get).not.toHaveBeenCalled()
})
