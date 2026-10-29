// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendAttachmentBatch } from '../../../../apps/desktop/src/components/chat/sendAttachmentBatch'
import { observeAttachmentMessage } from '../../../../apps/desktop/src/lib/attachmentSendRecovery'
import type { AccountRevisionListener } from '../../../../apps/desktop/src/lib/accountRevisionCoordinator'
import { AttachmentsError } from '@gugu/core/cloud/attachmentsApi'
import type { MessageItem } from '@gugu/core/shared/types/chat'
const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => logger }))
vi.mock('../../../../apps/desktop/src/lib/attachmentUploadTransport', () => ({ xhrAttachmentUpload: (url: string, init: RequestInit) => fetch(url, init) }))
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
    await vi.advanceTimersByTimeAsync(15_600)
    await done
    expect(mocks.upload).toHaveBeenCalledTimes(2)
    expect(mocks.commit).toHaveBeenCalledOnce(); expect(onSent).toHaveBeenCalledOnce()
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ stage: 'upload', elapsedMs: 15_000, outcome: 'timeout' }), 'attachment send stage timing')
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
  await vi.advanceTimersByTimeAsync(120_100)
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

it('allows a large slow upload beyond two minutes instead of restarting its bytes', async () => {
  const { args, onSent } = arrange()
  const large = new File(['x'], 'large.png', { type: 'image/png' })
  Object.defineProperty(large, 'size', { value: 50 * 1024 * 1024 })
  mocks.upload.mockImplementation((_endpoint, _file, _scope, options) => new Promise(resolve => {
    let loaded = 0
    const progress = setInterval(() => options.onProgress({ loaded: ++loaded * 1024, total: large.size }), 10_000)
    setTimeout(() => { clearInterval(progress); resolve('staging/large') }, 180_000)
  }))
  const result = sendAttachmentBatch({ ...args, files: [large] }).catch(error => error)
  await vi.advanceTimersByTimeAsync(180_100)
  expect(mocks.upload).toHaveBeenCalledOnce()
  expect(onSent).toHaveBeenCalledOnce()
  expect(await result).not.toBeInstanceOf(Error)
})

it('keeps a native publication pending after twenty seconds and never publishes a second file', async () => {
  const { args, onSent, removePlaceholder } = arrange()
  let finish: () => void = () => {}
  const invoke = vi.fn((_channel, request) => !request.file ? Promise.resolve(true) : new Promise(resolve => {
    finish = () => resolve({ id: 'file-item', version: 1, message: { ...serverRow(request.message.message_id), file_item_id: 'file-item', file_version: 1 } })
  }))
  vi.stubGlobal('window', { electronAPI: { invoke, getPathForFile: () => '/project/large.txt' } })
  mocks.read.mockResolvedValue(null)
  let finished = false
  const done = sendAttachmentBatch({ ...args, files: [new File(['x'], 'large.txt', { type: 'text/plain' })] }).catch(error => error).finally(() => { finished = true })
  await vi.advanceTimersByTimeAsync(30_000)
  expect(finished).toBe(false)
  expect(removePlaceholder).not.toHaveBeenCalled()
  expect(invoke.mock.calls.filter(call => call[1].file)).toHaveLength(1)
  finish()
  await vi.advanceTimersByTimeAsync(10)
  expect(await done).not.toBeInstanceOf(Error)
  expect(onSent).toHaveBeenCalledOnce()
  expect(invoke.mock.calls.filter(call => call[1].file)).toHaveLength(1)
})

it('reuses the same reservation request ID when uploading again after a transient failure', async () => {
  const { args, rows } = arrange()
  mocks.upload.mockRejectedValueOnce(new TypeError('offline'))
  const done = sendAttachmentBatch(args)
  await vi.advanceTimersByTimeAsync(600)
  await done
  expect(mocks.upload.mock.calls.map(call => call[2].request_id)).toEqual([rows[0].id, rows[0].id])
})

it.each(['readback', 'realtime'])('confirms a native publication through %s while its IPC is still pending', async confirmation => {
  const { args, onSent, removePlaceholder } = arrange()
  const invoke = vi.fn((_channel, request) => !request.file ? Promise.resolve(true) : new Promise(() => {}))
  vi.stubGlobal('window', { electronAPI: { invoke, getPathForFile: () => '/project/large.txt' } })
  let receive: (row: MessageItem) => void = () => {}
  mocks.read.mockImplementation(async id => Date.now() - started >= 25_000 && confirmation === 'readback' ? serverRow(id) : null)
  const started = Date.now()
  const done = sendAttachmentBatch({ ...args, files: [new File(['x'], 'large.txt', { type: 'text/plain' })], observeMessage: (_id, callback) => { receive = callback; return vi.fn() } })
  await vi.advanceTimersByTimeAsync(25_000)
  expect(removePlaceholder).not.toHaveBeenCalled()
  if (confirmation === 'realtime') receive(serverRow(invoke.mock.calls.find(call => call[1].file)![1].message.message_id) as MessageItem)
  await vi.advanceTimersByTimeAsync(6_100)
  await done
  expect(onSent).toHaveBeenCalledOnce()
  expect(invoke.mock.calls.filter(call => call[1].file)).toHaveLength(1)
})

it('caps the size allowance at the signed upload plan expiry', async () => {
  const { args } = arrange()
  mocks.upload.mockImplementationOnce((_endpoint, _file, _scope, options) => {
    options.onPlan({ expires_at: new Date(Date.now() + 30_000).toISOString() })
    setTimeout(() => options.onProgress({ loaded: 1, total: 3 }), 10_000)
    setTimeout(() => options.onProgress({ loaded: 2, total: 3 }), 20_000)
    return new Promise(() => {})
  })
  const done = sendAttachmentBatch(args)
  await vi.advanceTimersByTimeAsync(30_600)
  await done
  expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ stage: 'upload', outcome: 'timeout', elapsedMs: 30_000 }), 'attachment send stage timing')
  expect(mocks.upload).toHaveBeenCalledTimes(2)
})

it('works when an older WebView has no AbortSignal.any', async () => {
  const { args } = arrange()
  const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any')!
  Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined })
  try {
    let receive: (row: MessageItem) => void = () => {}
    mocks.commit.mockImplementation(() => new Promise(() => {}))
    const done = sendAttachmentBatch({ ...args, observeMessage: (_id, callback) => { receive = callback; return vi.fn() } })
    await vi.advanceTimersByTimeAsync(10)
    const messageId = mocks.commit.mock.calls[0][1].message_id
    receive(serverRow(messageId) as MessageItem)
    await done
  } finally { Object.defineProperty(AbortSignal, 'any', descriptor) }
})

it('stops polling an ambiguous native publication, keeps an unknown bubble and accepts its late receipt', async () => {
  const { args, rows, onSent, removePlaceholder } = arrange()
  let finish: () => void = () => {}
  const invoke = vi.fn((_channel, request) => !request.file ? Promise.resolve(true) : new Promise(resolve => {
    finish = () => resolve({ id: 'file-item', version: 1, message: { ...serverRow(request.message.message_id), file_item_id: 'file-item', file_version: 1 } })
  }))
  vi.stubGlobal('window', { electronAPI: { invoke, getPathForFile: () => '/project/large.txt' } })
  mocks.read.mockResolvedValue(null)
  const done = sendAttachmentBatch({ ...args, files: [new File(['x'], 'large.txt', { type: 'text/plain' })] })
  await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
  expect(rows.at(-1)).toMatchObject({ id: rows[0].id, local_send_state: 'unknown' })
  expect(removePlaceholder).not.toHaveBeenCalled()
  expect(mocks.read.mock.calls.length).toBeLessThan(20)
  expect(logger.info.mock.calls.filter(([fields]) => fields.stage === 'readback')).toHaveLength(0)
  const reads = mocks.read.mock.calls.length
  await vi.advanceTimersByTimeAsync(60_000)
  expect(mocks.read.mock.calls.length).toBe(reads)
  await done
  expect(onSent).toHaveBeenCalledOnce()
  finish()
  await vi.advanceTimersByTimeAsync(10)
  expect(rows.at(-1)).toMatchObject({ id: rows[0].id, seq: 42, local_send_state: null })
  expect(invoke.mock.calls.filter(call => call[1].file)).toHaveLength(1)
})

it('commits the original upload after a lost storage response is followed by a retry conflict', async () => {
  const { args, onSent } = arrange()
  const actual = await vi.importActual<typeof import('@gugu/core/cloud/attachmentsApi')>('@gugu/core/cloud/attachmentsApi')
  mocks.upload.mockImplementation(actual.uploadAttachmentBytes)
  mocks.commit.mockImplementation(actual.commitAttachment)
  const reservations: string[] = []
  let uploads = 0, commits = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/upload')) {
      reservations.push(JSON.parse(init.body as string).request_id)
      return new Response(JSON.stringify({ staging_key: 'staging/photo', url: 'https://oss.test/uploaded', method: 'PUT', fields: {}, max_bytes: 1000 }))
    }
    if (url === 'https://oss.test/uploaded') {
      if (++uploads === 1) throw new TypeError('response lost after storage accepted the bytes')
      return new Response(null, { status: 409 })
    }
    commits++
    return new Response(JSON.stringify({ message: serverRow(JSON.parse(init.body as string).message_id) }))
  }))
  const done = sendAttachmentBatch(args).catch(error => error)
  await vi.advanceTimersByTimeAsync(600)
  expect(await done).not.toBeInstanceOf(Error)
  expect(new Set(reservations).size).toBe(1)
  expect(uploads).toBe(2); expect(commits).toBe(1); expect(onSent).toHaveBeenCalledOnce()
})
