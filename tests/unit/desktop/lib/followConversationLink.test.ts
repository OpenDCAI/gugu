import { beforeEach, expect, it, vi } from 'vitest'
import { message } from '../../../support/testHarness'
const mocks = vi.hoisted(() => ({ get: vi.fn(), open: vi.fn(), image: vi.fn(), follow: vi.fn(), notice: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: { getMessageById: mocks.get } }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ getCurrentAuthUserId: async () => 'owner' }))
vi.mock('../../../../apps/desktop/src/lib/guguLinks', () => ({ openLinkTarget: mocks.open, followLink: mocks.follow }))
vi.mock('../../../../apps/desktop/src/lib/attachmentBytes', () => ({ openAttachmentImage: mocks.image }))
vi.mock('../../../../apps/desktop/src/lib/notices', () => ({ notify: mocks.notice }))
import { followConversationLink, openMessageAttachment } from '../../../../apps/desktop/src/lib/followConversationLink'
beforeEach(() => { vi.clearAllMocks() })
it('shows an error toast when a sent-file click cannot open its resource host', async () => {
  const id = '6417511d-8f36-4cbc-8cbb-81ce9f97df73', chat = '127ec4f0-30b1-4583-b469-706756153bdd'
  mocks.get.mockResolvedValue(message({ id, chat_id: chat, content_type: 'attachment', content: '[附件] proof.txt (text/plain)\n[Size] 9\n[Kind] file', file_item_id: 'file-item', file_version: 1 }))
  mocks.open.mockRejectedValueOnce(new Error('Tasks cannot be opened in this environment'))
  followConversationLink(`gugu-message-file://${id}?chat=${chat}`)
  await vi.waitFor(() => expect(mocks.notice).toHaveBeenCalledWith({ tier: 'error', title: expect.any(String) }))
  expect(mocks.notice.mock.calls[0][0].title).not.toBe('')
})
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

it('opens a scoped sent-file link through the authorized source message, preserving chat and version', async () => {
  const id = '6417511d-8f36-4cbc-8cbb-81ce9f97df73', chat = '127ec4f0-30b1-4583-b469-706756153bdd';
  const row = message({ id, chat_id: chat, content_type: 'attachment', content: '[附件] proof.txt (text/plain)\n[Size] 9\n[Kind] file', file_item_id: 'file-item', file_version: 4 });
  mocks.get.mockResolvedValue(row);
  expect(followConversationLink(`gugu-message-file://${id}?chat=${chat}`)).toBe(true);
  await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledWith({ kind: 'file', itemId: 'file-item', version: 4 }, { message: row }));
  mocks.open.mockClear();
  await expect(openMessageAttachment(id, 'another-chat')).rejects.toThrow('unavailable');
  expect(mocks.open).not.toHaveBeenCalled();
});

it('previews a sent image inside the existing viewer rather than opening a system application', async () => {
  const row = message({ id: 'receipt', content_type: 'attachment', content: '[附件] proof.png (image/png)\n[Size] 9\n[Kind] image', file_item_id: 'file-item', file_version: 4 });
  mocks.get.mockResolvedValue(row);
  await openMessageAttachment('receipt');
  expect(mocks.image).toHaveBeenCalledWith({ kind: 'item', itemId: 'file-item', version: 4 }, 'proof.png');
  expect(mocks.open).not.toHaveBeenCalled();
});
