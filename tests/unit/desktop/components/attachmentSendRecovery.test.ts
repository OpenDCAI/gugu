// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendAttachmentBatch } from '../../../../apps/desktop/src/components/chat/sendAttachmentBatch'
import { observeAttachmentMessage } from '../../../../apps/desktop/src/lib/attachmentSendRecovery'
import type { AccountRevisionListener } from '../../../../apps/desktop/src/lib/accountRevisionCoordinator'
import { AttachmentsError } from '@gugu/core/cloud/attachmentsApi'
import type { MessageItem } from '@gugu/core/shared/types/chat'
const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => logger }))
const mocks = vi.hoisted(() => ({ upload: vi.fn(), commit: vi.fn(), read: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: { getMessageById: mocks.read } }))
vi.mock('../../../../apps/desktop/src/lib/attachmentsEndpoint', async original => ({ ...await original<typeof import('../../../../apps/desktop/src/lib/attachmentsEndpoint')>(), attachmentsEndpoint: async () => ({ supabaseUrl: 'https://db.test', anonKey: 'anon', token: 't' }) }))
vi.mock('@gugu/core/cloud/attachmentsApi', async original => ({ ...await original<typeof import('@gugu/core/cloud/attachmentsApi')>(), uploadAttachmentBytes: mocks.upload, commitAttachment: mocks.commit }))
vi.mock('../../../../apps/desktop/src/lib/chatThreadGate', () => ({ requireThreadCapableChat: vi.fn() }))
const serverRow = (id: string) => ({ id, chat_id: 'chat-1', sender_user_id: 'user-1', seq: 42, content: '[File] photo.png', content_type: 'attachment', created_at: new Date(0).toISOString() })
function arrange() {
  vi.useFakeTimers()
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  mocks.upload.mockReset().mockResolvedValue('staging/photo')
  mocks.commit.mockReset().mockImplementation(async (_endpoint, args) => serverRow(args.message_id))
  mocks.read.mockReset().mockImplementation(() => new Promise(() => {}))
  const onSent = vi.fn(), rows: MessageItem[] = [], removePlaceholder = vi.fn()
  return { onSent, rows, removePlaceholder, args: {
    files: [new File(['x'], 'photo.png', { type: 'image/png' })], chatId: 'chat-1', senderId: 'user-1', toUserIds: null,
    caption: 'caption', appendMessage: (row: MessageItem) => rows.push(row), onSent, removePlaceholder,
  } }
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
describe('attachment send recovery', () => {
  it('settles the placeholder from the accepted commit even when read-back never resolves', async () => {
    const { args, rows, onSent } = arrange()
    let finished = false
    const done = sendAttachmentBatch(args).then(() => { finished = true })
    await vi.advanceTimersByTimeAsync(100)
    expect(finished, 'the accepted message must not wait for a second read').toBe(true)
    expect(rows.at(-1)).toMatchObject({ id: rows[0].id, seq: 42, local_send_state: null })
    expect(onSent).toHaveBeenCalledOnce()
    await done
  })
  it('a matching realtime row settles a stalled commit without another upload or duplicate commit', async () => {
    const { args, rows, onSent } = arrange()
    mocks.commit.mockImplementation(() => new Promise(() => {}))
    let receive: ((row: MessageItem) => void) | undefined
    const stop = vi.fn()
    const observedArgs = { ...args, observeMessage: (_id: string, callback: (row: MessageItem) => void) => { receive = callback; return stop } }
    let finished = false
    const done = sendAttachmentBatch(observedArgs).then(() => { finished = true })
    await vi.advanceTimersByTimeAsync(10)
    expect(receive, 'register for the message before submitting the commit').toBeTypeOf('function')
    receive?.(serverRow(rows[0].id) as MessageItem)
    await vi.advanceTimersByTimeAsync(10)
    expect(finished).toBe(true)
    expect(rows.at(-1)).toMatchObject({ id: rows[0].id, seq: 42, local_send_state: null })
    expect(onSent).toHaveBeenCalledOnce()
    expect(mocks.upload).toHaveBeenCalledOnce(); expect(mocks.commit).toHaveBeenCalledOnce(); expect(stop).toHaveBeenCalledOnce()
    await done
  })
  it('retries a hung upload within its deadline and then completes normally', async () => {
    const { args, onSent } = arrange()
    mocks.upload.mockImplementationOnce(() => new Promise(() => {}))
    const done = sendAttachmentBatch(args)
    await vi.advanceTimersByTimeAsync(120_600)
    await done
    expect(mocks.upload).toHaveBeenCalledTimes(2)
    expect(mocks.commit).toHaveBeenCalledOnce(); expect(onSent).toHaveBeenCalledOnce()
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ stage: 'upload', elapsedMs: 120_000, outcome: 'timeout' }), 'attachment send stage timing')
  })
  it('recovers a lost commit response by its original ID without committing it twice', async () => {
    const { args, rows } = arrange()
    mocks.commit.mockImplementation(() => new Promise(() => {}))
    mocks.read.mockImplementation(async id => serverRow(id))
    const done = sendAttachmentBatch(args)
    await vi.advanceTimersByTimeAsync(20_100)
    await done
    expect(mocks.commit).toHaveBeenCalledOnce()
    expect(mocks.read).toHaveBeenCalledWith(rows[0].id, 'user-1')
    expect(rows.at(-1)).toMatchObject({ seq: 42, local_send_state: null })
  })
  it('retries a transient commit even when recovery read-back hangs, reusing the upload and message ID', async () => {
    const { args, rows } = arrange()
    mocks.commit.mockRejectedValueOnce(new TypeError('Network unavailable'))
    const done = sendAttachmentBatch(args)
    await vi.advanceTimersByTimeAsync(5_600)
    await done
    expect(mocks.upload).toHaveBeenCalledOnce()
    expect(mocks.commit).toHaveBeenCalledTimes(2)
    expect(mocks.commit.mock.calls.map(call => call[1])).toEqual([expect.objectContaining({ message_id: rows[0].id, staging_key: 'staging/photo' }), expect.objectContaining({ message_id: rows[0].id, staging_key: 'staging/photo' })])
  })
  it('an incomplete acknowledgement and hung read-back terminate without leaving a sending placeholder', async () => {
    const { args, rows, onSent, removePlaceholder } = arrange()
    mocks.commit.mockImplementation(async (_endpoint, commit) => ({ id: commit.message_id }))
    const result = sendAttachmentBatch(args).catch(error => error)
    await vi.advanceTimersByTimeAsync(5_100)
    expect(await result).toBeInstanceOf(Error)
    expect(removePlaceholder).toHaveBeenCalledWith(rows[0].id)
    expect(onSent).not.toHaveBeenCalled()
  })
  it('does not retry an explicit permission refusal', async () => {
    const { args } = arrange()
    mocks.commit.mockRejectedValue(new AttachmentsError('commit', 403, 'denied', 'denied'))
    mocks.read.mockResolvedValue(null)
    await expect(sendAttachmentBatch(args)).rejects.toThrow('denied')
    expect(mocks.commit).toHaveBeenCalledOnce()
  })
  it('ignores unrelated realtime rows and never logs the caption or credentials', async () => {
    const { args, rows, onSent } = arrange()
    mocks.commit.mockImplementation(() => new Promise(() => {}))
    let receive: (row: MessageItem) => void = () => {}
    const done = sendAttachmentBatch({ ...args, observeMessage: (_id, callback) => { receive = callback; return vi.fn() } })
    await vi.advanceTimersByTimeAsync(10)
    for (const patch of [{ id: 'different' }, { chat_id: 'other-chat' }, { sender_user_id: 'other-user' }, { seq: -1 }]) receive({ ...serverRow(rows[0].id), ...patch } as MessageItem)
    await vi.advanceTimersByTimeAsync(10)
    expect(onSent).not.toHaveBeenCalled()
    receive(serverRow(rows[0].id) as MessageItem)
    await done
    const logs = JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls])
    expect(logs).not.toContain('caption'); expect(logs).not.toContain('https://db.test'); expect(logs).not.toContain('photo.png')
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ stage: 'commit', outcome: 'cancelled' }), 'attachment send stage timing')
  })
})

it('the attachment fetch receives a signal that is aborted at the upload deadline', async () => {
  const { args } = arrange()
  let signal: AbortSignal | undefined
  mocks.upload.mockImplementation((endpoint) => {
    void endpoint.fetch('https://upload.test', {}).catch(() => {})
    return new Promise(() => {})
  })
  vi.stubGlobal('fetch', vi.fn((_url, init) => {
    signal = init.signal
    return new Promise(() => {})
  }))
  const result = sendAttachmentBatch(args).catch(error => error)
  await vi.advanceTimersByTimeAsync(1)
  const firstSignal = signal!
  expect(firstSignal.aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(120_000)
  expect(firstSignal.aborted).toBe(true)
  // Finish remaining retries without leaving real two-minute timers alive.
  await vi.advanceTimersByTimeAsync(250_000)
  expect(await result).toBeInstanceOf(Error)
  vi.unstubAllGlobals()
})


it('consumes the same-ID revision directly, including after the sender leaves the current chat', async () => {
  arrange()
  let deliver: AccountRevisionListener = () => {}
  const stop = vi.fn(), received = vi.fn()
  const observe = observeAttachmentMessage((_event, listener) => { deliver = listener; return stop }, 'user-1', 'chat-1')
  const cleanup = observe('message-1', received)
  const send = (message: Record<string, unknown>) => deliver([{ revision: '1', event: 'message_created', payload: { chat_id: 'chat-1', entity_id: message.id, message } }])
  await send(serverRow('different'))
  await send({ ...serverRow('message-1'), deleted_for_user_ids: ['user-1'] })
  expect(received).not.toHaveBeenCalled()
  await send(serverRow('message-1'))
  expect(received).toHaveBeenCalledWith(expect.objectContaining({ id: 'message-1', seq: 42, is_mine: true }))
  cleanup(); expect(stop).toHaveBeenCalledOnce()
})
