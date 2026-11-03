// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendAttachmentBatch } from '../../../../apps/desktop/src/components/chat/sendAttachmentBatch'
import { AttachmentsError } from '@gugu/core/cloud/attachmentsApi'
import type { MessageItem } from '@gugu/core/shared/types/chat'
const upload = vi.hoisted(() => vi.fn())
vi.mock('../../../../apps/desktop/src/lib/attachmentsEndpoint', async original => ({
  ...await original<typeof import('../../../../apps/desktop/src/lib/attachmentsEndpoint')>(),
  attachmentsEndpoint: async () => ({ supabaseUrl: 'https://db.test', anonKey: 'anon', token: 'token' }),
}))
vi.mock('@gugu/core/cloud/attachmentsApi', async original => ({ ...await original<typeof import('@gugu/core/cloud/attachmentsApi')>(), uploadAttachmentBytes: upload }))
vi.mock('../../../../apps/desktop/src/lib/chatThreadGate', () => ({ requireThreadCapableChat: async (id: string) => { if (id === 'dm') throw new Error('private chats do not support threads') } }))
function fixture() {
  const stageAttachment = vi.fn(async (_message: MessageItem) => {})
  const commitAttachment = vi.fn(async () => {})
  const failUpload = vi.fn(async () => {})
  const discard = vi.fn(async () => {})
  const outbox = { stageAttachment, commitAttachment, outbox: { delivered: () => new Promise<void>(() => {}), failUpload, discard } }
  const appendMessage = vi.fn(), onSent = vi.fn()
  return { stageAttachment, commitAttachment, failUpload, discard, args: {
    chatId: 'group', senderId: 'user', toUserIds: ['peer'], appendMessage, onSent, outbox,
    files: [new File(['png'], 'photo.png', { type: 'image/png' })],
  } }
}
beforeEach(() => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  upload.mockReset().mockImplementation(async (_endpoint, file) => `staging/${file.name}`)
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('attachment ownership transfers to the durable chat outbox', () => {
  it('persists its source id before showing a placeholder or starting an upload', async () => {
    const f = fixture()
    const id = await sendAttachmentBatch(f.args)
    const message = f.stageAttachment.mock.calls[0][0]
    expect(id).toBe(message.id)
    expect(f.args.appendMessage).toHaveBeenCalledWith(message)
    expect(f.stageAttachment.mock.invocationCallOrder[0]).toBeLessThan(f.args.appendMessage.mock.invocationCallOrder[0])
    expect(f.stageAttachment.mock.invocationCallOrder[0]).toBeLessThan(upload.mock.invocationCallOrder[0])
    expect(f.args.onSent).toHaveBeenCalledWith(f.args.files[0], 0)
    expect(f.commitAttachment).toHaveBeenCalledWith(message, { staging_key: 'staging/photo.png' }, expect.objectContaining({ message_id: id, to_user_ids: ['peer'] }), expect.anything())
  })
  it('keeps the original whisper, reply, thread and caption on the queued commit', async () => {
    const f = fixture()
    await sendAttachmentBatch({ ...f.args, isWhisper: true, replyToMessageId: 'source', threadRootId: 'thread', caption: '① Move this' })
    expect(f.args.appendMessage.mock.calls[0][0]).toMatchObject({ is_whisper: true, reply_to_message_id: 'source', thread_root_id: 'thread' })
    expect(f.commitAttachment).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ is_whisper: true, reply_to_message_id: 'source', thread_root_id: 'thread', caption: '① Move this' }), expect.anything())
  })
  it('persists ownership of all files while uploads are pending, without committing early', async () => {
    const f = fixture()
    let finish!: (key: string) => void
    upload.mockImplementation(() => new Promise<string>(resolve => { finish = resolve }))
    const done = sendAttachmentBatch(f.args)
    await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce())
    expect(f.args.onSent).not.toHaveBeenCalled()
    expect(f.commitAttachment).not.toHaveBeenCalled()
    finish('staging/photo')
    await done
    expect(f.commitAttachment).toHaveBeenCalledOnce()
  })
  it('returns uncommitted files to composer on upload failure and removes their markers', async () => {
    const f = fixture()
    upload.mockRejectedValue(new AttachmentsError('upload', 403, 'denied', 'quota denied'))
    await expect(sendAttachmentBatch({ ...f.args, files: [...f.args.files, new File(['pdf'], 'second.pdf')] })).rejects.toThrow('quota denied')
    expect(f.args.onSent).not.toHaveBeenCalled()
    expect(f.discard.mock.calls).toEqual(f.stageAttachment.mock.calls.map(([row]) => [row.id]))
    expect(f.commitAttachment).not.toHaveBeenCalled()
  })
  it('cleans earlier upload markers if staging a later file fails', async () => {
    const f = fixture()
    f.stageAttachment.mockResolvedValueOnce().mockRejectedValueOnce(new Error('disk full'))
    await expect(sendAttachmentBatch({ ...f.args, files: [...f.args.files, new File(['pdf'], 'second.pdf')] })).rejects.toThrow('disk full')
    expect(f.discard.mock.calls).toEqual(f.stageAttachment.mock.calls.map(([row]) => [row.id]))
    expect(f.args.onSent).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
  })
  it('failed durable staging leaves ownership in the composer and sends no bytes', async () => {
    const f = fixture()
    f.stageAttachment.mockRejectedValueOnce(new Error('disk full'))
    await expect(sendAttachmentBatch(f.args)).rejects.toThrow('disk full')
    expect(f.args.onSent).not.toHaveBeenCalled()
    expect(f.args.appendMessage).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
  })
  it('refuses private-chat threads before staging or uploading', async () => {
    const f = fixture()
    await expect(sendAttachmentBatch({ ...f.args, chatId: 'dm', threadRootId: 'root' })).rejects.toThrow('private chats')
    expect(upload).not.toHaveBeenCalled()
    expect(f.stageAttachment).not.toHaveBeenCalled()
  })
  it('puts the caption on the last image, preserving file order at commit readiness', async () => {
    const f = fixture()
    await sendAttachmentBatch({ ...f.args, files: [...f.args.files, new File(['pdf'], 'spec.pdf', { type: 'application/pdf' })], caption: 'look' })
    expect(f.commitAttachment.mock.calls).toEqual([
      [expect.anything(), { staging_key: 'staging/photo.png' }, expect.objectContaining({ caption: 'look', content_type: 'image/png' }), expect.anything()],
      [expect.anything(), { staging_key: 'staging/spec.pdf' }, expect.not.objectContaining({ caption: expect.anything() }), expect.anything()],
    ])
  })
})
it('waits for publication before consuming that File or committing the next file in the batch', async () => {
  const f = fixture()
  let finish!: () => void
  f.commitAttachment.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
  const done = sendAttachmentBatch({ ...f.args, files: [...f.args.files, new File(['pdf'], 'second.pdf')] })
  await vi.waitFor(() => expect(f.commitAttachment).toHaveBeenCalledOnce())
  expect(f.args.onSent).not.toHaveBeenCalled()
  finish()
  await done
  expect(f.commitAttachment).toHaveBeenCalledTimes(2)
  expect(f.args.onSent.mock.calls.map(([, index]) => index)).toEqual([0, 1])
})
it('returns uncommitted File objects through the existing rollback when native publication rejects', async () => {
  const f = fixture()
  f.commitAttachment.mockRejectedValueOnce(new Error('native publish refused'))
  await expect(sendAttachmentBatch({ ...f.args, files: [...f.args.files, new File(['pdf'], 'second.pdf')] })).rejects.toThrow('native publish refused')
  expect(f.args.onSent).not.toHaveBeenCalled()
  expect(f.commitAttachment).toHaveBeenCalledOnce()
  expect(f.discard.mock.calls).toEqual(f.stageAttachment.mock.calls.map(([row]) => [row.id]))
})
