import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { commitPreparedChatAttachment, prepareChatAttachment, sendFileToChat } from '../../../../apps/desktop/src/lib/attachmentsEndpoint'
import { i18n } from '../../../../apps/desktop/src/i18n'
const f = vi.hoisted(() => ({ upload: vi.fn(), commit: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/sessionPublication', () => ({ getRendererAccessToken: () => 'published-test-token' }))
vi.mock('@gugu/core/cloud/attachmentsApi', () => ({ uploadAttachmentBytes: f.upload, commitAttachment: f.commit,
  configuredEndpoint: (token: string) => ({ supabaseUrl: 'https://db.test', anonKey: 'anon', token }) }))
const endpoint = { supabaseUrl: 'https://db.test', anonKey: 'anon', token: 'published-test-token' }
const args = { message_id: 'message', chat_id: 'group', sender_user_id: 'owner', file_name: 'selected.pdf', to_user_ids: ['agent'], thread_root_id: 'thread', caption: 'caption' }
const message = { id: 'message', chat_id: 'group', sender_user_id: 'owner', file_item_id: 'item', file_version: 3 }
const file = () => new File(['pdf'], 'selected.pdf', { type: 'application/pdf' })
function native(local = true) {
  const invoke = vi.fn(async (_channel: string, request: { file?: unknown }) => request.file ? { id: 'item', version: 3, message } : local)
  const getPathForFile = vi.fn(() => '/project/actual.pdf')
  vi.stubGlobal('window', { electronAPI: { invoke, getPathForFile } })
  return { invoke, getPathForFile }
}
beforeEach(() => { vi.resetAllMocks(); f.upload.mockResolvedValue('staging'); f.commit.mockResolvedValue({ id: 'cloud-message' }) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
describe('project composer attachments use the group-file publisher', () => {
  it('planning leaves the file private; ordered commit sends path and message together without whole-file IPC', async () => {
    const n = native(), selected = file(), arrayBuffer = vi.spyOn(selected, 'arrayBuffer').mockRejectedValue(new Error('No whole-file IPC'))
    const prepared = await prepareChatAttachment(endpoint, selected, { chat_id: 'group', as: 'owner' })
    expect(prepared).toEqual({ local: selected })
    expect(n.invoke).toHaveBeenCalledExactlyOnceWith('files:publish', { chatId: 'group' })
    expect(n.getPathForFile).not.toHaveBeenCalled()
    await expect(commitPreparedChatAttachment(endpoint, prepared, args)).resolves.toEqual(message)
    expect(n.invoke).toHaveBeenLastCalledWith('files:publish', { chatId: 'group', file: { name: 'selected.pdf', path: '/project/actual.pdf', size: 3, contentType: 'application/pdf' }, message: args })
    expect(arrayBuffer).not.toHaveBeenCalled(); expect(f.upload).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled()
  })
  it('the single-file sender uses the same preparation and atomic commit', async () => {
    const n = native()
    n.invoke.mockImplementation(async (_channel, request) => request.file ? { id: 'item', version: 3, message: { ...message, id: (request as { message: typeof args }).message.message_id } } : true)
    await expect(sendFileToChat(file(), { chatId: 'group', senderId: 'owner', toUserIds: ['agent'] })).resolves.toMatchObject({ file_item_id: 'item', file_version: 3 })
    expect(n.invoke).toHaveBeenCalledTimes(2); expect(f.upload).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled()
  })
  it('keeps one cloud uploader and commit for an ordinary or explicitly cloud-enabled group', async () => {
    const n = native(false), selected = file()
    const prepared = await prepareChatAttachment(endpoint, selected, { chat_id: 'group', as: 'owner' })
    expect(prepared).toEqual({ staging_key: 'staging' }); await commitPreparedChatAttachment(endpoint, prepared, args)
    expect(n.invoke).toHaveBeenCalledOnce(); expect(n.getPathForFile).not.toHaveBeenCalled()
    expect(f.upload).toHaveBeenCalledWith(endpoint, { bytes: selected, name: selected.name, contentType: 'application/pdf' }, { chat_id: 'group', as: 'owner' }, { onPlan: undefined, retry: false })
    expect(f.commit).toHaveBeenCalledWith(endpoint, { ...args, staging_key: 'staging' })
  })
  it('uploads an image when sent, also in a project chat whose other files stay on the machine', async () => {
    const n = native(), image = new File(['png'], 'shot.png', { type: 'image/png' })
    await expect(prepareChatAttachment(endpoint, image, { chat_id: 'group', as: 'owner' })).resolves.toEqual({ staging_key: 'staging' })
    expect(n.invoke).not.toHaveBeenCalled()
    expect(f.upload).toHaveBeenCalledWith(endpoint, { bytes: image, name: 'shot.png', contentType: 'image/png' }, { chat_id: 'group', as: 'owner' }, { onPlan: undefined, retry: false })
  })
  it('does not put a whisper into the shared project folder', async () => {
    const n = native(), selected = file(), prepared = await prepareChatAttachment(endpoint, selected, { chat_id: 'group', as: 'owner', is_whisper: true })
    expect(n.invoke).not.toHaveBeenCalled(); expect(prepared).toEqual({ staging_key: 'staging' })
    await expect(commitPreparedChatAttachment(endpoint, { local: selected }, { ...args, is_whisper: true })).rejects.toThrow('audience changed')
    expect(n.invoke).not.toHaveBeenCalled()
  })
  it('reauthorizes through the same cloud uploader when the sender\'s storage setting changed after planning', async () => {
    const n = native(), selected = file(), prepared = await prepareChatAttachment(endpoint, selected, { chat_id: 'group', as: 'owner' })
    n.invoke.mockResolvedValueOnce(null as never)
    await expect(commitPreparedChatAttachment(endpoint, prepared, args)).resolves.toEqual({ id: 'cloud-message' })
    expect(f.upload).toHaveBeenCalledExactlyOnceWith(endpoint, { bytes: selected, name: selected.name, contentType: 'application/pdf' }, { chat_id: 'group', as: 'owner' }, { onPlan: undefined, retry: false })
    expect(f.commit).toHaveBeenCalledExactlyOnceWith(endpoint, { ...args, staging_key: 'staging' })
  })
  it('propagates a publication or atomic message refusal without falling back to cloud', async () => {
    const n = native(), prepared = await prepareChatAttachment(endpoint, file(), { chat_id: 'group', as: 'owner' })
    n.invoke.mockRejectedValueOnce(new Error('outside workspace'))
    await expect(commitPreparedChatAttachment(endpoint, prepared, args)).rejects.toThrow(i18n.t('attachmentView.fileUnavailable', { ns: 'messaging' }))
    n.invoke.mockRejectedValueOnce(new Error('not a member'))
    await expect(commitPreparedChatAttachment(endpoint, prepared, args)).rejects.toThrow(i18n.t('attachmentView.fileUnavailable', { ns: 'messaging' }))
    expect(f.upload).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled()
  })
  it.each([{ ...message, file_item_id: 'other' }, { ...message, file_version: 4 }, { ...message, sender_user_id: 'other' }, { ...message, chat_id: 'other' }, { ...message, id: 'other' }, undefined])('rejects a substituted message or version receipt', async value => {
    const n = native(), prepared = await prepareChatAttachment(endpoint, file(), { chat_id: 'group', as: 'owner' })
    n.invoke.mockResolvedValueOnce({ id: 'item', version: 3, message: value } as never)
    await expect(commitPreparedChatAttachment(endpoint, prepared, args)).rejects.toThrow('not committed')
    expect(f.upload).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled()
  })
})
