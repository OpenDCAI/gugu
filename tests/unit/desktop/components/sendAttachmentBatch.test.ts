// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendAttachmentBatch } from '../../../../apps/desktop/src/components/chat/sendAttachmentBatch'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { i18n } from '../../../../apps/desktop/src/i18n'
// #2188 附件批执行器契约:提交点 = commit 后读回验证通过(onSent 按件回报),任一件失败 fail-loud 中止。
// #7290 gugu-3:字节经 attachments/upload 直传,attachments/commit 发消息(说明由服务端接在信封后面);没提交的上传不用清(过期回收)。
const { uploadMock, commitMock, getByIdMock } = vi.hoisted(() => ({
  uploadMock: vi.fn(),
  commitMock: vi.fn(),
  getByIdMock: vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: { getMessageById: getByIdMock } }))
vi.mock('../../../../apps/desktop/src/lib/attachmentsEndpoint', async importOriginal => ({ ...await importOriginal<typeof import('../../../../apps/desktop/src/lib/attachmentsEndpoint')>(), attachmentsEndpoint: async () => ({ supabaseUrl: 'https://db.test', anonKey: 'anon', token: 't' }) }))
vi.mock('@gugu/core/cloud/attachmentsApi', async original => ({ ...await original<typeof import('@gugu/core/cloud/attachmentsApi')>(), uploadAttachmentBytes: uploadMock, commitAttachment: commitMock }))
const threadGate = vi.hoisted(() => vi.fn(async (_chatId: string, operation: string) => { if (_chatId.startsWith('dm-')) throw new Error(`${operation}: private chats do not support threads`) }))
vi.mock('../../../../apps/desktop/src/lib/chatThreadGate', () => ({ requireThreadCapableChat: threadGate }))
const file = (name: string) => new File([name], name, { type: 'text/plain' })
const row = (id: string, args: Record<string, unknown> = {}) => ({ ...args, id, seq: 1, content_type: 'attachment', content: '[File] file', created_at: new Date(0).toISOString() }) as unknown as MessageItem
type Commit = { staging_key: string; message_id: string; file_name: string; content_type: string; caption?: string }
const commits = () => commitMock.mock.calls.map((call) => call[1] as Commit)
function arrange() {
  uploadMock.mockReset().mockImplementation(async (_e: unknown, f: { name: string }) => `staging/u/${f.name}`)
  commitMock.mockReset().mockImplementation(async (_e: unknown, args: Commit) => row(args.message_id, args))
  getByIdMock.mockReset().mockImplementation(async (id: string) => row(id, commitMock.mock.calls.map(call => call[1]).find(args => args.message_id === id)))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const onSent = vi.fn()
  const appendMessage = vi.fn()
  const run = (files: File[]) =>
    sendAttachmentBatch({ files, chatId: 'chat-1', senderId: 'user-1', toUserIds: null, onSent, appendMessage })
  return { onSent, appendMessage, run }
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
describe('sendAttachmentBatch', () => {
  it('sends an annotated PNG and numbered caption as a reply while preserving private recipients', async () => {
    const { appendMessage } = arrange()
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:annotation-preview', revokeObjectURL: vi.fn() })
    const annotation = new File(['png'], 'annotated.png', { type: 'image/png' })
    await sendAttachmentBatch({ files: [annotation], chatId: 'group-1', senderId: 'user-1', toUserIds: ['agent-1'],
      isWhisper: true, replyToMessageId: 'original-image', caption: '① Move this', appendMessage, removePlaceholder: vi.fn() })
    expect(appendMessage.mock.calls[0][0]).toMatchObject({ reply_to_message_id: 'original-image', is_whisper: true, to_user_ids: ['agent-1'] })
    expect(commitMock.mock.calls[0][1]).toMatchObject({ reply_to_message_id: 'original-image', caption: '① Move this',
      is_whisper: true, to_user_ids: ['agent-1'], content_type: 'image/png' })
    expect(uploadMock).toHaveBeenCalledOnce()
    expect(commitMock).toHaveBeenCalledOnce()
  })
  it('happy path: per-file onSent after verified insert, returns first inserted id', async () => {
    const { onSent, appendMessage, run } = arrange()
    const [a, b] = [file('a.txt'), file('b.txt')]
    const first = await run([a, b])
    expect(first).toBe(commits()[0].message_id)
    expect(onSent.mock.calls.map((c) => c[0])).toEqual([a, b])
    expect(onSent.mock.calls.map((c) => c[1]), 'onSent 带批内序号(同一 File 可能排进队两次)').toEqual([0, 1])
    expect(appendMessage).toHaveBeenCalledTimes(2)
    expect(uploadMock.mock.calls.map(call=>call[2])).toEqual([{chat_id:'chat-1',as:'user-1',request_id:expect.any(String)},{chat_id:'chat-1',as:'user-1',request_id:expect.any(String)}])
    expect(commits().map((c) => c.staging_key), 'each file commits its own upload').toEqual(['staging/u/a.txt', 'staging/u/b.txt'])
    expect(commitMock.mock.calls[0]![1]).toMatchObject({ chat_id: 'chat-1', sender_user_id: 'user-1', to_user_ids: [], is_whisper: false })
  })
  it('a failed first local commit never publishes later prepared files', async () => {
    const { run, onSent, appendMessage } = arrange()
    const invoke = vi.fn(async (_channel: string, request: { file?: unknown }) => { if (request.file) throw new Error('message denied'); return true })
    vi.stubGlobal('window', { electronAPI: { invoke, getPathForFile: (selected: File) => `/project/${selected.name}` } })
    await expect(run([file('a.txt'), file('b.txt'), file('c.txt')])).rejects.toThrow(i18n.t('attachmentView.fileUnavailable', { ns: 'messaging' }))
    expect(invoke.mock.calls.filter(([, request]) => !request.file)).toHaveLength(3)
    expect(invoke.mock.calls.filter(([, request]) => request.file)).toEqual([['files:publish', expect.objectContaining({ file: expect.objectContaining({ name: 'a.txt' }) })]])
    expect(uploadMock).not.toHaveBeenCalled(); expect(commitMock).not.toHaveBeenCalled()
    expect(onSent).not.toHaveBeenCalled(); expect(appendMessage).not.toHaveBeenCalled()
  })
  it('a thread write in a private chat is refused before a byte goes (the gate sendMessage has; the server does not check it)', async () => {
    arrange()
    await expect(sendAttachmentBatch({ files: [file('a.txt')], chatId: 'dm-1', senderId: 'user-1', toUserIds: null, threadRootId: 'root-1', appendMessage: vi.fn() }))
      .rejects.toThrow(/private chats do not support threads/)
    expect(uploadMock).not.toHaveBeenCalled()
    expect(commitMock).not.toHaveBeenCalled()
    // Control: a group thread goes through, the root on the commit.
    await sendAttachmentBatch({ files: [file('b.txt')], chatId: 'group-1', senderId: 'user-1', toUserIds: null, threadRootId: 'root-1', appendMessage: vi.fn() })
    expect(commits()[0]).toMatchObject({ thread_root_id: 'root-1' })
  })
  it('stores text as the attachment caption instead of a second message', async () => {
    arrange()
    await sendAttachmentBatch({
      files: [new File(['x'], 'photo.jpg', { type: 'image/jpeg' })], chatId: 'chat-1', senderId: 'user-1', toUserIds: null,
      caption: 'hello', appendMessage: vi.fn(),
    })
    expect(commits()[0]).toMatchObject({ caption: 'hello' })
  })
  it('caption rides the last IMAGE, not a trailing document card that never renders it', async () => {
    arrange()
    const png = new File(['x'], 'shot.png', { type: 'image/png' })
    const pdf = new File(['x'], 'spec.pdf', { type: 'application/pdf' })
    await sendAttachmentBatch({
      files: [png, pdf], chatId: 'chat-1', senderId: 'user-1', toUserIds: null,
      caption: 'look', appendMessage: vi.fn(),
    })
    expect(commits().map((c) => c.caption)).toEqual(['look', undefined])
  })
  it('a nameless-type .png is still sent as image/png', async () => {
    arrange()
    await sendAttachmentBatch({
      files: [new File(['x'], 'Shot.PNG', { type: '' })], chatId: 'chat-1', senderId: 'user-1', toUserIds: null, appendMessage: vi.fn(),
    })
    expect(commits()[0]!.content_type).toBe('image/png')
    expect(uploadMock.mock.calls[0]![1]).toMatchObject({ contentType: 'image/png' })
  })
  it('uploads run concurrently while messages are inserted in the original order', async () => {
    const { run } = arrange()
    const gates = new Map<string, () => void>()
    uploadMock.mockImplementation((_e: unknown, f: { name: string }) => new Promise((resolve) => {
      gates.set(f.name, () => resolve(`staging/u/${f.name}`))
    }))
    const done = run([file('a.txt'), file('b.txt'), file('c.txt')])
    await vi.waitFor(() => expect([...gates.keys()], 'all three uploads start before any finishes').toEqual(['a.txt', 'b.txt', 'c.txt']))
    gates.get('c.txt')?.(); gates.get('b.txt')?.(); gates.get('a.txt')?.()
    await done
    expect(commits().map((c) => c.file_name)).toEqual(['a.txt', 'b.txt', 'c.txt'])
  })
  it('every file shows a sending placeholder immediately, replaced in place by its confirmed row', async () => {
    arrange()
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const appended: MessageItem[] = []
    let releaseUpload: () => void = () => {}
    uploadMock.mockImplementation((_e: unknown, f: { name: string }) => new Promise((resolve) => {
      releaseUpload = () => resolve(`staging/u/${f.name}`)
    }))
    commitMock.mockImplementation(async (_e: unknown, args: Commit) => ({ id: args.message_id }))
    const done = sendAttachmentBatch({
      files: [new File(['x'], 'shot.png', { type: 'image/png' })], chatId: 'chat-1', senderId: 'user-1', toUserIds: null,
      appendMessage: (m) => { appended.push(m) }, removePlaceholder: vi.fn(),
    })
    await vi.waitFor(() => expect(appended, 'placeholder is on screen before the upload finishes').toHaveLength(1))
    expect(appended[0]).toMatchObject({ seq: -1, local_send_state: 'sending', content_type: 'attachment' })
    expect(appended[0].content).toContain('[URL] blob:preview')
    await vi.waitFor(() => expect(uploadMock).toHaveBeenCalledOnce())
    releaseUpload()
    await done
    expect(commits()[0]!.message_id, 'the commit reuses the placeholder id').toBe(appended[0].id)
    expect(getByIdMock).toHaveBeenCalledWith(appended[0].id, 'user-1')
  })
  it('a failed batch takes down the placeholders of the unsent files', async () => {
    arrange()
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const appended: MessageItem[] = []
    const removePlaceholder = vi.fn()
    getByIdMock.mockImplementation(async (id: string) => {
      const args = commitMock.mock.calls.map(call => call[1]).find(args => args.message_id === id)
      return args?.file_name === 'b.txt' ? null : row(id, args)
    })
    commitMock.mockImplementation(async (_e: unknown, args: Commit) => {
      if (args.file_name === 'b.txt') throw new Error('denied')
      return { id: args.message_id }
    })
    await expect(sendAttachmentBatch({
      files: [file('a.txt'), file('b.txt'), file('c.txt')], chatId: 'chat-1', senderId: 'user-1', toUserIds: null,
      appendMessage: (m) => { appended.push(m) }, removePlaceholder,
    })).rejects.toThrow('denied')
    expect(removePlaceholder.mock.calls.map((c) => c[0])).toEqual([appended[1].id, appended[2].id])
    expect(commits().map((c) => c.file_name), 'nothing after the failed one is committed (its upload just expires)').toEqual(['a.txt', 'b.txt'])
  })
  it('#2188 verification null mid-batch: throws, aborts the rest — committed stays reported', async () => {
    const { onSent, run } = arrange()
    const [a, b, c] = [file('a.txt'), file('b.txt'), file('c.txt')]
    commitMock.mockImplementation(async (_endpoint, args: Commit) => ({ id: args.message_id }))
    getByIdMock.mockImplementation(async (id: string) => {
      const args = commitMock.mock.calls.map(call => call[1]).find(args => args.message_id === id)
      return args?.file_name === 'b.txt' ? null : row(id, args)
    })
    await expect(run([a, b, c])).rejects.toThrow(i18n.t('composer.attachmentPersistenceFailed', { ns: 'messaging', fileName: 'b.txt' }))
    expect(onSent.mock.calls.map((cl) => cl[0]), 'only the verified first file is reported committed').toEqual([a])
    expect(commits().map((c) => c.file_name), 'the batch aborts before committing the third file').toEqual(['a.txt', 'b.txt'])
  })

})
