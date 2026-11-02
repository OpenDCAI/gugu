// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { SessionInputOutboxHost } from '../../../../apps/desktop/src/hooks/useSessionInputOutbox'
import { enqueueSessionInput, state } from '../../../../apps/desktop/src/lib/sessionInputOutboxBridge'
import { SessionInputQueue } from '../../../../apps/desktop/src/components/chat/SessionInputQueue'
import { updateDeviceSessions } from '../../../../apps/desktop/src/session/shared/remote-sessions/session-directory'
import { messageQuoteText, readMessageQuote } from '@gugu/core/shared/ui/messageQuote'
import { REMOTE_PROTOCOL_VERSION } from '@gugu/core/cloud/serverMachineHealth'

const toast = vi.hoisted(() => vi.fn())
vi.mock('../../../../apps/desktop/src/session/renderer/lib/hooks/use-toast', () => ({ toast }))
const scope = vi.hoisted(() => ({ owner: 'account-a', platform: 'electron', phones: [] as Array<{ device_id: string; is_online: boolean; capabilities: { host_kind: string; remote_protocol?: number } }>, devices: [{ device_id: 'host-a', is_online: false, capabilities: {} }], received: new Map<string, string>(), send: vi.fn(), machines: [] as (string | null)[] }))
vi.mock('../../../../apps/desktop/src/lib/sessionPublication', () => ({ getRendererSession: () => ({ user: { id: scope.owner } }) }))
vi.mock('../../../../apps/desktop/src/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: scope.devices, phones: scope.phones }) }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { get kind() { return scope.platform } } }))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/ipc', () => ({ rpcOn: (machine: string | null) => ({ sessionTimeline: { sessionSend: (request: unknown) => { scope.machines.push(machine); return scope.send(request) } } }) }))
vi.mock('../../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({ sendSessionText: async (_device: string, sessionId: string, text: string, clientMessageId: string, files?: unknown[]) => {
  const reply = await scope.send({ conversationId: sessionId, text, clientMessageId, ...(files?.length ? { files } : {}) })
  if (!reply.ok) throw new Error(reply.error.message)
  return reply.value
} }))
vi.mock('../../../../apps/desktop/src/mobile/local-agent/phoneHostRpc', () => ({ invokePhoneHost: async (_device: string, _channel: string, [request]: [{ conversationId: string; text: string; clientRequestId: string; files?: unknown[] }]) => {
  await scope.send(request)
  return { accepted: true }
} }))
// This computer's own session list sync is another subject; these cases read only what the outbox sends.
vi.mock('../../../../apps/desktop/src/hooks/useLocalSessionDirectory', () => ({ useLocalSessionDirectory: () => undefined }))
vi.mock('../../../../apps/desktop/src/session/renderer/localization/locale-store', () => ({ translateSessionMessage: (key: string, values?: { count: number }) => key === 'composer.attachmentHostUpdateRequired' ? 'Update the task host to send attachments' : key === 'composer.attachmentsNotSent' ? `(${values!.count} attachments could not be included after the upgrade. Please send them again.)` : 'Waiting for host; sends automatically' }))
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { toast.mockClear(); harness = createReactHarness() })
afterEach(() => { harness.cleanup(); scope.owner = 'account-a'; scope.platform = 'electron'; scope.phones = []; scope.devices = [{ device_id: 'host-a', is_online: false, capabilities: {} }]; scope.received.clear(); scope.send.mockReset(); scope.machines = [] })

describe('native input shell lifecycle', () => {
  it.each([[1, REMOTE_PROTOCOL_VERSION]])('refuses enqueue when the online host advertises input %s and protocol %s', async (version, protocol) => {
    scope.owner = `attachment-version-${version}-${protocol}`
    scope.devices = [{ device_id: 'host-a', is_online: true, capabilities: { remote_protocol: protocol } }]
    updateDeviceSessions('host-a', { cached: false, sessions: [{ conversationId: 'attachment-session', nativeInputVersion: version } as never] })
    await harness.render(<><SessionInputOutboxHost accountId={scope.owner} /><SessionInputQueue sessionId="attachment-session" waitingForConnection={false} /></>)
    await act(async () => { await expect(enqueueSessionInput({ deviceId: 'host-a', sessionId: 'attachment-session', text: 'read the file', files: [{ itemId: 'file', version: 1, name: 'brief.txt', mimeType: 'text/plain', sizeBytes: 3 }] })).rejects.toThrow('Update the task host to send attachments') })
    expect(await (await state().queue)!.list()).toEqual([])
    expect(scope.send).not.toHaveBeenCalled()
  })

  it.each(['electron', 'web'])('sends desktop files with explicit input v2 despite missing or stale heartbeat protocol (%s)', async platform => {
    scope.platform = platform
    scope.owner = `desktop-files-${platform}`
    scope.devices = [{ device_id: 'host-a', is_online: true, capabilities: {} }]
    scope.send.mockImplementation(async (request: { clientMessageId: string }) => ({ ok: true, value: { accepted: 'started', clientMessageId: request.clientMessageId } }))
    updateDeviceSessions('host-a', { cached: false, sessions: [{ conversationId: 'desktop-files', nativeInputVersion: 2 } as never] })
    await harness.render(<SessionInputOutboxHost accountId={scope.owner} />)
    const files = [{ itemId: 'file', version: 1, name: 'brief.txt', mimeType: 'text/plain', sizeBytes: 3 }]
    await act(async () => {
      await enqueueSessionInput({ deviceId: 'host-a', sessionId: 'desktop-files', text: 'caption', files })
      await enqueueSessionInput({ deviceId: 'host-a', sessionId: 'desktop-files', text: 'following text' })
      await (await state().queue)!.flush()
    })
    expect(scope.send.mock.calls.map(([request]) => request.text)).toEqual(['caption', 'following text'])
    expect(scope.send.mock.calls[0][0].files).toEqual(files)
    expect(await (await state().queue)!.list()).toEqual([])
    scope.devices = [{ device_id: 'host-a', is_online: true, capabilities: { remote_protocol: REMOTE_PROTOCOL_VERSION - 1 } }]
    await harness.render(<SessionInputOutboxHost accountId={scope.owner} />)
    await act(async () => { await enqueueSessionInput({ deviceId: 'host-a', sessionId: 'desktop-files', text: 'after host upgrade', files }); await (await state().queue)!.flush() })
    expect(scope.send.mock.calls[2][0].files).toEqual(files)
  })

  it('waits for the desktop input advertisement, then drains files and later text when v2 arrives', async () => {
    scope.owner = 'desktop-input-advertisement'
    scope.devices = [{ device_id: 'host-a', is_online: true, capabilities: {} }]
    scope.send.mockImplementation(async (request: { clientMessageId: string }) => ({ ok: true, value: { accepted: 'started', clientMessageId: request.clientMessageId } }))
    updateDeviceSessions('host-a', { cached: false, sessions: [] })
    await harness.render(<SessionInputOutboxHost accountId={scope.owner} />)
    const files = [{ itemId: 'file', version: 1, name: 'brief.txt', mimeType: 'text/plain', sizeBytes: 3 }]
    await act(async () => {
      await enqueueSessionInput({ deviceId: 'host-a', sessionId: 'unknown-input', text: 'caption', files })
      await enqueueSessionInput({ deviceId: 'host-a', sessionId: 'unknown-input', text: 'following text' })
      await (await state().queue)!.flush()
    })
    expect(scope.send).not.toHaveBeenCalled()
    updateDeviceSessions('host-a', { cached: false, sessions: [{ conversationId: 'unknown-input', nativeInputVersion: 2 } as never] })
    await act(async () => { await (await state().queue)!.flush() })
    expect(scope.send.mock.calls.map(([request]) => request.text)).toEqual(['caption', 'following text'])
    expect(scope.send.mock.calls[0][0].files).toEqual(files)
    expect(await (await state().queue)!.list()).toEqual([])
  })

  it.each([undefined, REMOTE_PROTOCOL_VERSION - 1])('drains queued files as caption plus count when a phone returns with protocol %s', async protocol => {
    scope.owner = `old-phone-${protocol}`
    scope.devices = []
    scope.phones = [{ device_id: 'phone', is_online: false, capabilities: { host_kind: 'phone' } }]
    scope.send.mockResolvedValue(undefined)
    await harness.render(<SessionInputOutboxHost accountId={scope.owner} />)
    await act(async () => {
      await enqueueSessionInput({ deviceId: 'phone', sessionId: 'phone-task', text: 'phone caption', files: [{ itemId: 'file', version: 1, name: 'brief.txt', mimeType: 'text/plain', sizeBytes: 3 }] })
      await enqueueSessionInput({ deviceId: 'phone', sessionId: 'phone-task', text: 'following text' })
    })
    scope.phones = [{ device_id: 'phone', is_online: true, capabilities: { host_kind: 'phone', ...(protocol !== undefined ? { remote_protocol: protocol } : {}) } }]
    await harness.render(<SessionInputOutboxHost accountId={scope.owner} />)
    await act(async () => { await (await state().queue)!.flush() })
    expect(scope.send.mock.calls[0][0].text).toMatch(/^phone caption\n\n.*1 attachments/)
    expect(scope.send.mock.calls[0][0]).not.toHaveProperty('files')
    expect(scope.send.mock.calls[1][0].text).toBe('following text')
    expect(await (await state().queue)!.list()).toEqual([])
  })

  it('hands files to the reconnecting host, preserving its caption and draining later text', async () => {
    scope.owner = 'expired-attachment-owner'
    scope.devices = [{ device_id: 'host-a', is_online: false, capabilities: {} }]
    scope.send.mockImplementation(async (request: { clientMessageId: string; text: string; files?: unknown[] }) => ({ ok: true, value: { accepted: 'started', clientMessageId: request.clientMessageId } }))
    await harness.render(<SessionInputOutboxHost accountId={scope.owner} />)
    await act(async () => {
      await enqueueSessionInput({ deviceId: 'host-a', sessionId: 'expired-task', text: 'original caption', files: [{ itemId: 'gone', version: 1, name: 'brief.txt', mimeType: 'text/plain', sizeBytes: 3 }] })
      await enqueueSessionInput({ deviceId: 'host-a', sessionId: 'expired-task', text: 'following text' })
    })
    scope.devices = [{ device_id: 'host-a', is_online: true, capabilities: { remote_protocol: REMOTE_PROTOCOL_VERSION } }]
    updateDeviceSessions('host-a', { cached: false, sessions: [{ conversationId: 'expired-task', nativeInputVersion: 2 } as never] })
    await act(async () => { await harness.render(<SessionInputOutboxHost accountId={scope.owner} />); await (await state().queue)!.flush() })
    expect(scope.send.mock.calls.map(([request]) => request.text)).toEqual(['original caption', 'following text'])
    expect(await (await state().queue)!.list()).toEqual([])
    expect(toast).not.toHaveBeenCalled()
  })

  it('sends the caption and omission count on reconnect to an old host, then drains following text', async () => {
    scope.owner = 'attachment-reconnect-owner'
    scope.devices = [{ device_id: 'host-a', is_online: false, capabilities: {} }]
    scope.send.mockImplementation(async (request: { clientMessageId: string; text: string }) => ({ ok: true, value: { accepted: 'started', clientMessageId: request.clientMessageId } }))
    await harness.render(<SessionInputOutboxHost accountId={scope.owner} />)
    await act(async () => {
      await enqueueSessionInput({ deviceId: 'host-a', sessionId: 'reconnected-task', text: 'read the file', files: [{ itemId: 'file', version: 1, name: 'brief.txt', mimeType: 'text/plain', sizeBytes: 3 }] })
      await enqueueSessionInput({ deviceId: 'host-a', sessionId: 'reconnected-task', text: 'following text' })
    })
    expect(scope.send).not.toHaveBeenCalled()
    scope.devices = [{ device_id: 'host-a', is_online: true, capabilities: {} }]
    updateDeviceSessions('host-a', { cached: false, sessions: [{ conversationId: 'reconnected-task', nativeInputVersion: 1 } as never] })
    await harness.render(<SessionInputOutboxHost accountId={scope.owner} />)
    await vi.waitFor(() => expect(scope.send).toHaveBeenCalledTimes(2))
    const sent = scope.send.mock.calls.map(call => call[0])
    expect(sent[0].text).toMatch(/^read the file\n\n.*1 attachments/)
    expect(sent[0]).not.toHaveProperty('files')
    expect(sent[1].text).toBe('following text')
    await vi.waitFor(async () => expect(await (await state().queue)!.list()).toEqual([]))
  })

  it('retains files and the typed host refusal while custody has not been acknowledged', async () => {
    scope.owner = 'attachment-failure-owner'
    scope.devices = [{ device_id: 'host-a', is_online: true, capabilities: { remote_protocol: REMOTE_PROTOCOL_VERSION } }]
    updateDeviceSessions('host-a', { cached: false, sessions: [{ conversationId: 'attachment-failure', nativeInputVersion: 2 } as never] })
    scope.send.mockResolvedValue({ ok: false, error: { message: '2 件附件没取到，请重试' } })
    await harness.render(<><SessionInputOutboxHost accountId={scope.owner} /><SessionInputQueue sessionId="attachment-failure" waitingForConnection={false} /></>)
    const files = ['a', 'b'].map(itemId => ({ itemId, version: 1, name: `${itemId}.txt`, mimeType: 'text/plain', sizeBytes: 3 }))
    await act(async () => { await enqueueSessionInput({ deviceId: 'host-a', sessionId: 'attachment-failure', text: 'read the files', files }) })
    await vi.waitFor(async () => expect((await (await state().queue)!.list())[0]).toMatchObject({ files, failure: { code: 'send-failed', message: '2 件附件没取到，请重试' } }))
    expect(scope.send).toHaveBeenCalledWith(expect.objectContaining({ files }))
    expect((await (await state().queue)!.list())[0]?.text).toBe('read the files')
  })
  // A session on this computer may be named by this computer's own device id (the assistant task pane does): its own
  // host answers over IPC, even while the cloud presence row says offline and without a remote input advertisement.
  it('sends to this computer over IPC when the input names its own device id', async () => {
    scope.owner = 'account-own-id'
    scope.devices = [{ device_id: 'this-computer', is_online: false, is_current_device: true, capabilities: {} } as never]
    scope.send.mockImplementation(async (request: { clientMessageId: string }) => ({ ok: true, value: { accepted: 'started', clientMessageId: request.clientMessageId } }))
    await harness.render(<SessionInputOutboxHost accountId={scope.owner} />)
    await act(async () => { await enqueueSessionInput({ deviceId: 'this-computer', sessionId: 'session-own', text: 'Only reply OK' }) })
    await vi.waitFor(() => expect(scope.send).toHaveBeenCalledTimes(1))
    expect(scope.machines).toEqual([null])
  })
  it('does not display another message box while online inputs wait for native acknowledgement', async () => {
    scope.owner = 'account-online'
    scope.devices = [{ device_id: 'host-a', is_online: true, capabilities: {} }]
    let acknowledge!: (value: { ok: true; value: { accepted: string; clientMessageId: string } }) => void
    let currentId = ''
    scope.send.mockImplementation((request: { clientMessageId: string }) => {
      currentId = request.clientMessageId
      return new Promise(resolve => { acknowledge = resolve })
    })
    updateDeviceSessions('host-a', { cached: false, sessions: [{ conversationId: 'session-a', nativeInputVersion: 1 } as never] })
    await harness.render(<><SessionInputOutboxHost accountId={scope.owner} /><SessionInputQueue sessionId="session-a" waitingForConnection={false} /></>)
    await act(async () => {
      await enqueueSessionInput({ deviceId: 'host-a', sessionId: 'session-a', text: 'First inserted input' })
      await enqueueSessionInput({ deviceId: 'host-a', sessionId: 'session-a', text: 'Second inserted input' })
    })
    await vi.waitFor(() => expect(scope.send).toHaveBeenCalledTimes(1))
    expect(harness.container.querySelector('[data-native-input-queue]')).toBeNull()
    expect(harness.container.textContent).not.toContain('Waiting for host')
    await act(async () => { acknowledge({ ok: true, value: { accepted: 'queued', clientMessageId: currentId } }) })
    await vi.waitFor(() => expect(scope.send).toHaveBeenCalledTimes(2))
    await act(async () => { acknowledge({ ok: true, value: { accepted: 'queued', clientMessageId: currentId } }) })
  })

  it('previews only the caption and file name while preserving the complete quote for one native delivery', async () => {
    scope.owner = 'account-quoted'
    const source = { kind: 'session' as const, sessionId: '135e6cc4-30a6-4ba3-9ffb-46719ba71dc0', itemId: 'turn:s34:message:4c3f357d-efcc-4000-8000-000000000001' }
    const body = '手机排队原话\n@[tri29-file.txt](/Users/test/Documents/tri29-file.txt)'
    const text = messageQuoteText(source, '源消息原文', 'Claude 3') + body
    scope.send.mockImplementation(async (request: { clientMessageId: string; text: string }) => {
      scope.received.set(request.clientMessageId, request.text)
      return { ok: true, value: { accepted: 'started', clientMessageId: request.clientMessageId } }
    })
    updateDeviceSessions('host-a', { cached: false, sessions: [{ conversationId: 'session-a', nativeInputVersion: 1 } as never] })
    await harness.render(<><SessionInputOutboxHost accountId={scope.owner} /><SessionInputQueue sessionId="session-a" waitingForConnection /></>)
    let input!: Awaited<ReturnType<typeof enqueueSessionInput>>
    await act(async () => { input = await enqueueSessionInput({ deviceId: 'host-a', sessionId: 'session-a', text }) })
    await vi.waitFor(() => expect(harness.container.querySelector('[data-native-input-id]')?.textContent).toBe('手机排队原话\ntri29-file.txt'))
    expect(harness.container.innerHTML).not.toContain('gugu-session://')
    expect(harness.container.innerHTML).not.toContain(source.sessionId)
    expect(harness.container.innerHTML).not.toContain(source.itemId)
    expect(harness.container.innerHTML).not.toContain('/Users/')
    expect(harness.container.textContent).not.toContain('Waiting for host')
    expect(harness.container.querySelector('[data-send-state="sending"]')).not.toBeNull()
    expect(scope.send).not.toHaveBeenCalled()
    scope.devices = [{ device_id: 'host-a', is_online: true, capabilities: {} }]
    await harness.render(<><SessionInputOutboxHost accountId={scope.owner} /><SessionInputQueue sessionId="session-a" waitingForConnection={false} /></>)
    await vi.waitFor(() => expect(scope.received.size).toBe(1))
    expect(scope.send).toHaveBeenCalledTimes(1)
    expect(scope.send).toHaveBeenCalledWith({ conversationId: 'session-a', text, clientMessageId: input.id })
    expect(readMessageQuote(scope.received.get(input.id)!)).toEqual(expect.objectContaining({ source, excerpt: '源消息原文', body }))
    await vi.waitFor(() => expect(harness.container.querySelector('[data-native-input-id]')).toBeNull())
  })

  it('keeps offline text visibly queued, then sends once when the host returns, without opening a chat envelope', async () => {
    scope.send.mockImplementation(async (request: { clientMessageId: string; text: string }) => {
      scope.received.set(request.clientMessageId, request.text)
      return { ok: true, value: { accepted: 'started', clientMessageId: request.clientMessageId } }
    })
    updateDeviceSessions('host-a', { cached: false, sessions: [{ conversationId: 'session-a', nativeInputVersion: 1 } as never] })
    await harness.render(<><SessionInputOutboxHost accountId={scope.owner} /><SessionInputQueue sessionId="session-a" waitingForConnection /></>)
    let input!: Awaited<ReturnType<typeof enqueueSessionInput>>
    await act(async () => { input = await enqueueSessionInput({ deviceId: 'host-a', sessionId: 'session-a', text: 'offline original' }) })
    await vi.waitFor(() => expect(harness.container.textContent).toContain('offline original'))
    expect(scope.send).not.toHaveBeenCalled()
    scope.devices = [{ device_id: 'host-a', is_online: true, capabilities: {} }]
    await harness.render(<><SessionInputOutboxHost accountId={scope.owner} /><SessionInputQueue sessionId="session-a" waitingForConnection={false} /></>)
    await vi.waitFor(() => expect(scope.received.size, JSON.stringify((window as unknown as Record<string, { rows: unknown }>).__GUGU_NATIVE_INPUT_OUTBOX__?.rows)).toBe(1))
    expect([...scope.received]).toEqual([[input.id, 'offline original']])
    expect(scope.send).toHaveBeenCalledWith({ conversationId: 'session-a', text: 'offline original', clientMessageId: input.id })
    await vi.waitFor(() => expect(harness.container.textContent).not.toContain('offline original'))
  })
})
