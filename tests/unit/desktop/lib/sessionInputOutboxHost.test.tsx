// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { SessionInputOutboxHost } from '../../../../apps/desktop/src/hooks/useSessionInputOutbox'
import { enqueueSessionInput } from '../../../../apps/desktop/src/lib/sessionInputOutboxBridge'
import { SessionInputQueue } from '../../../../apps/desktop/src/components/chat/SessionInputQueue'
import { updateDeviceSessions } from '../../../../apps/desktop/src/session/shared/remote-sessions/session-directory'
import { messageQuoteText, readMessageQuote } from '@gugu/core/shared/ui/messageQuote'
import { setLocalePreference } from '../../../../apps/desktop/src/i18n'
import { makeObservable, observable, runInAction } from 'mobx'
import { createChatContext, createChatState } from '@gugu/session-chat-ui'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { AcpSessionInputQueue } from '../../../../apps/desktop/src/session/renderer/features/sessions/acp/acp-session-input-queue'

const scope = vi.hoisted(() => ({ owner: 'account-a', devices: [{ device_id: 'host-a', is_online: false, capabilities: {} }], received: new Map<string, string>(), send: vi.fn(), phoneSend: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/sessionPublication', () => ({ getRendererSession: () => ({ user: { id: scope.owner } }) }))
vi.mock('../../../../apps/desktop/src/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: scope.devices, phones: [] }) }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { kind: 'electron' } }))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/ipc', () => ({ rpcOn: () => ({ sessionTimeline: { sessionSend: scope.send } }) }))
vi.mock('../../../../apps/desktop/src/mobile/local-agent/phoneHostRpc', () => ({ invokePhoneHost: scope.phoneSend }))
vi.mock('../../../../apps/desktop/src/session/renderer/localization/locale-store', () => ({ translateSessionMessage: () => 'Waiting for host; sends automatically' }))
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); setLocalePreference('en-US') })
afterEach(() => { harness.cleanup(); scope.owner = 'account-a'; scope.devices = [{ device_id: 'host-a', is_online: false, capabilities: {} }]; scope.received.clear(); scope.send.mockReset(); scope.phoneSend.mockReset() })

describe('native input shell lifecycle', () => {
  it('shows online cold-start inputs immediately and confirms them independently of send-reply ordering', async () => {
    scope.owner = 'account-online'
    scope.devices = [{ device_id: 'host-a', is_online: true, capabilities: {} }]
    let acknowledge!: (value: { ok: true; value: { accepted: string; clientMessageId: string } }) => void
    let currentId = ''
    scope.send.mockImplementation((request: { clientMessageId: string }) => {
      currentId = request.clientMessageId
      return new Promise(resolve => { acknowledge = resolve })
    })
    updateDeviceSessions('host-a', { cached: false, sessions: [{ conversationId: 'session-a', nativeInputVersion: 1 } as never] })
    await harness.render(<><SessionInputOutboxHost accountId={scope.owner} /><SessionInputQueue sessionId="session-a" /></>)
    await act(async () => {
      await enqueueSessionInput({ deviceId: 'host-a', sessionId: 'session-a', text: 'First inserted input' })
      await enqueueSessionInput({ deviceId: 'host-a', sessionId: 'session-a', text: 'Second inserted input' })
    })
    await vi.waitFor(() => expect(scope.send).toHaveBeenCalledTimes(1))
    expect(harness.container.querySelectorAll('[data-native-input-id]')).toHaveLength(2)
    expect(harness.container.textContent).toContain('Sending…')
    expect(harness.container.textContent).not.toContain('Waiting for host')
    const ids = [...harness.container.querySelectorAll('[data-native-input-id]')].map(row => row.getAttribute('data-native-input-id')!)
    // The recorded first row arrives while the RPC response is still in flight.
    await harness.render(<><SessionInputOutboxHost accountId={scope.owner} /><SessionInputQueue sessionId="session-a" confirmedClientMessageIds={[ids[0]]} /></>)
    expect(harness.container.querySelectorAll('[data-native-input-id]')).toHaveLength(1)
    await act(async () => { acknowledge({ ok: true, value: { accepted: 'queued', clientMessageId: currentId } }) })
    await vi.waitFor(() => expect(scope.send).toHaveBeenCalledTimes(2))
    await act(async () => { acknowledge({ ok: true, value: { accepted: 'queued', clientMessageId: currentId } }) })
    expect(harness.container.querySelectorAll('[data-native-input-id]')).toHaveLength(1)
    await harness.render(<><SessionInputOutboxHost accountId={scope.owner} /><SessionInputQueue sessionId="session-a" confirmedClientMessageIds={ids} /></>)
    await vi.waitFor(() => expect(harness.container.querySelector('[data-native-input-id]')).toBeNull())
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
    await harness.render(<><SessionInputOutboxHost accountId={scope.owner} /><SessionInputQueue sessionId="session-a" /></>)
    let input!: Awaited<ReturnType<typeof enqueueSessionInput>>
    await act(async () => { input = await enqueueSessionInput({ deviceId: 'host-a', sessionId: 'session-a', text }) })
    await vi.waitFor(() => expect(harness.container.querySelector('[data-native-input-id] > div')?.textContent).toBe('手机排队原话\ntri29-file.txt'))
    expect(harness.container.innerHTML).not.toContain('gugu-session://')
    expect(harness.container.innerHTML).not.toContain(source.sessionId)
    expect(harness.container.innerHTML).not.toContain(source.itemId)
    expect(harness.container.innerHTML).not.toContain('/Users/')
    expect(harness.container.textContent).not.toContain('Waiting for host')
    await vi.waitFor(() => expect(harness.container.querySelector('[role="alert"]')?.textContent).toBe('Session host is offline'))
    expect(scope.send).not.toHaveBeenCalled()
    scope.devices = [{ device_id: 'host-a', is_online: true, capabilities: {} }]
    await harness.render(<><SessionInputOutboxHost accountId={scope.owner} /><SessionInputQueue sessionId="session-a" /></>)
    await vi.waitFor(() => expect(scope.received.size).toBe(1))
    expect(scope.send).toHaveBeenCalledTimes(1)
    expect(scope.send).toHaveBeenCalledWith({ conversationId: 'session-a', text, clientMessageId: input.id })
    expect(readMessageQuote(scope.received.get(input.id)!)).toEqual(expect.objectContaining({ source, excerpt: '源消息原文', body }))
    expect(harness.container.querySelector('[data-native-input-id]')).not.toBeNull()
    await harness.render(<><SessionInputOutboxHost accountId={scope.owner} /><SessionInputQueue sessionId="session-a" confirmedClientMessageIds={[input.id]} /></>)
    await vi.waitFor(() => expect(harness.container.querySelector('[data-native-input-id]')).toBeNull())
  })

  it('keeps offline text visibly queued, then sends once when the host returns, without opening a chat envelope', async () => {
    scope.send.mockImplementation(async (request: { clientMessageId: string; text: string }) => {
      scope.received.set(request.clientMessageId, request.text)
      return { ok: true, value: { accepted: 'started', clientMessageId: request.clientMessageId } }
    })
    updateDeviceSessions('host-a', { cached: false, sessions: [{ conversationId: 'session-a', nativeInputVersion: 1 } as never] })
    await harness.render(<><SessionInputOutboxHost accountId={scope.owner} /><SessionInputQueue sessionId="session-a" /></>)
    let input!: Awaited<ReturnType<typeof enqueueSessionInput>>
    await act(async () => { input = await enqueueSessionInput({ deviceId: 'host-a', sessionId: 'session-a', text: 'offline original' }) })
    await vi.waitFor(() => expect(harness.container.textContent).toContain('offline original'))
    expect(scope.send).not.toHaveBeenCalled()
    scope.devices = [{ device_id: 'host-a', is_online: true, capabilities: {} }]
    await harness.render(<><SessionInputOutboxHost accountId={scope.owner} /><SessionInputQueue sessionId="session-a" /></>)
    await vi.waitFor(() => expect(scope.received.size, JSON.stringify((window as unknown as Record<string, { rows: unknown }>).__GUGU_NATIVE_INPUT_OUTBOX__?.rows)).toBe(1))
    expect([...scope.received]).toEqual([[input.id, 'offline original']])
    expect(scope.send).toHaveBeenCalledWith({ conversationId: 'session-a', text: 'offline original', clientMessageId: input.id })
    await harness.render(<><SessionInputOutboxHost accountId={scope.owner} /><SessionInputQueue sessionId="session-a" confirmedClientMessageIds={[input.id]} /></>)
    await vi.waitFor(() => expect(harness.container.textContent).not.toContain('offline original'))
  })

  it.each([null, 'host-a'])('keeps the real failure and retries the same input on device %s', async deviceId => {
    scope.owner = `retry-${deviceId ?? 'local'}`
    scope.devices = [{ device_id: 'host-a', is_online: true, capabilities: {} }]
    scope.send.mockRejectedValueOnce(new Error('Provider login expired')).mockImplementation(async request => ({
      ok: true, value: { accepted: 'started', clientMessageId: request.clientMessageId },
    }))
    updateDeviceSessions('host-a', { cached: false, sessions: [{ conversationId: 'session-a', nativeInputVersion: 1 } as never] })
    await harness.render(<><SessionInputOutboxHost accountId={scope.owner} /><SessionInputQueue sessionId="session-a" /></>)
    let input!: Awaited<ReturnType<typeof enqueueSessionInput>>
    const attachments = [
      { type: 'attachment' as const, id: 'image', mimeType: 'image/png' as const, name: 'image.png' },
      { type: 'local-file' as const, originalPath: '/tmp/local-image.png', mimeType: 'image/png' as const, name: 'local-image.png' },
    ]
    await act(async () => { input = await enqueueSessionInput({ deviceId, sessionId: 'session-a', text: 'same original body', attachments }) })
    await vi.waitFor(() => expect(harness.container.querySelector('[role="alert"]')?.textContent).toBe('Provider login expired'))
    expect(harness.container.textContent).toContain('image.png')
    expect(harness.container.textContent).toContain('local-image.png')
    await act(async () => { harness.container.querySelector<HTMLButtonElement>('button')!.click() })
    await vi.waitFor(() => expect(scope.send).toHaveBeenCalledTimes(2))
    expect(scope.send.mock.calls.map(([request]) => request)).toEqual([
      { conversationId: 'session-a', text: 'same original body', clientMessageId: input.id, attachments },
      { conversationId: 'session-a', text: 'same original body', clientMessageId: input.id, attachments },
    ])
    await vi.waitFor(() => expect(harness.container.textContent).toContain('Sending…'))
    expect(harness.container.querySelector('[role="alert"]')).toBeNull()
    await harness.render(<><SessionInputOutboxHost accountId={scope.owner} /><SessionInputQueue sessionId="session-a" confirmedClientMessageIds={[input.id]} /></>)
    await vi.waitFor(() => expect(harness.container.querySelector('[data-native-input-id]')).toBeNull())
  })

  it('confirms the phone-owned Pi input with its persisted-job receipt through the same outbox', async () => {
    scope.owner = 'phone-owner'
    scope.devices = [{ device_id: 'phone', is_online: true, capabilities: { host_kind: 'phone' } }]
    scope.phoneSend.mockResolvedValue({ accepted: true, messageId: 'persisted-job' })
    await harness.render(<><SessionInputOutboxHost accountId={scope.owner} /><SessionInputQueue sessionId="phone-session" /></>)
    let input!: Awaited<ReturnType<typeof enqueueSessionInput>>
    await act(async () => { input = await enqueueSessionInput({ deviceId: 'phone', sessionId: 'phone-session', text: 'phone task' }) })
    await vi.waitFor(() => expect(scope.phoneSend).toHaveBeenCalledExactlyOnceWith('phone', 'sessionTimeline.sessionSend',
      [{ conversationId: 'phone-session', text: 'phone task', clientRequestId: input.id }], input.id))
    await vi.waitFor(() => expect(harness.container.querySelector('[data-native-input-id]')).toBeNull())
    expect(scope.send).not.toHaveBeenCalled()
  })

  it('keeps identical text with another id pending when one user row is confirmed', async () => {
    scope.owner = 'same-text-owner'
    scope.send.mockImplementation(async request => ({ ok: true, value: { accepted: 'queued', clientMessageId: request.clientMessageId } }))
    await harness.render(<><SessionInputOutboxHost accountId={scope.owner} /><SessionInputQueue sessionId="session-a" /></>)
    const inputs: Awaited<ReturnType<typeof enqueueSessionInput>>[] = []
    await act(async () => {
      for (let i = 0; i < 2; i++) inputs.push(await enqueueSessionInput({ deviceId: null, sessionId: 'session-a', text: 'same text' }))
    })
    await vi.waitFor(() => expect(scope.send).toHaveBeenCalledTimes(2))
    await harness.render(<><SessionInputOutboxHost accountId={scope.owner} /><SessionInputQueue sessionId="session-a" confirmedClientMessageIds={[inputs[0].id]} /></>)
    await vi.waitFor(() => expect(harness.container.querySelectorAll('[data-native-input-id]')).toHaveLength(1))
    expect(harness.container.querySelector('[data-native-input-id]')?.getAttribute('data-native-input-id')).toBe(inputs[1].id)
    expect(harness.container.textContent).toContain('same text')
  })

  it.each([false, undefined])('retains a phone input without a persisted-job acceptance (%s)', async accepted => {
    scope.owner = `phone-unconfirmed-${String(accepted)}`
    scope.devices = [{ device_id: 'phone', is_online: true, capabilities: { host_kind: 'phone' } }]
    scope.phoneSend.mockResolvedValue({ accepted })
    await harness.render(<><SessionInputOutboxHost accountId={scope.owner} /><SessionInputQueue sessionId="phone-session" /></>)
    await act(async () => { await enqueueSessionInput({ deviceId: 'phone', sessionId: 'phone-session', text: 'not yet accepted' }) })
    await vi.waitFor(() => expect(harness.container.querySelector('[role="alert"]')?.textContent).toBe('Phone host has not acknowledged the input'))
    expect(harness.container.querySelector('[data-native-input-id]')).not.toBeNull()
  })

  it('does not rescan unchanged history on streaming revisions, and still confirms a replaced old row', async () => {
    scope.owner = 'history-confirmation-owner'
    const context = createChatContext()
    const chatState = createChatState(context)
    const store = { runtimeSessionId: 'session-a', chatState, transcriptRevision: 0 }
    makeObservable(store, { transcriptRevision: observable })
    let historicalReads = 0
    const old: TranscriptTurn = { id: 'old', seq: 0, initiator: 'user',
      get items(): TranscriptTurn['items'] { historicalReads++; return [{ kind: 'message', id: 'old-user', seq: 0, role: 'user', text: 'same text' }] } }
    try {
      chatState.transcript.history.seed([old])
      await harness.render(<><SessionInputOutboxHost accountId={scope.owner} /><AcpSessionInputQueue store={store} /></>)
      historicalReads = 0
      let input!: Awaited<ReturnType<typeof enqueueSessionInput>>
      await act(async () => { input = await enqueueSessionInput({ deviceId: 'host-a', sessionId: 'session-a', text: 'same text' }) })
      await vi.waitFor(() => expect(harness.container.querySelector('[data-native-input-id]')).not.toBeNull())
      const afterPending = historicalReads
      expect(afterPending).toBeGreaterThan(0)
      await act(async () => {
        chatState.transcript.activeTurn.set({ id: 'active', seq: 1, initiator: 'agent', items: [
          { kind: 'message', id: 'assistant', seq: 0, role: 'assistant', text: 'still streaming' },
        ] })
        runInAction(() => { store.transcriptRevision++ })
      })
      expect(historicalReads).toBe(afterPending)
      expect(harness.container.querySelector('[data-native-input-id]')).not.toBeNull()
      await act(async () => {
        // No startedAt is required; an older committed row can receive a late confirmation.
        chatState.transcript.history.seed([{ ...old, items: [{ kind: 'message', id: 'old-user', seq: 0, role: 'user',
          text: 'same text', _meta: { clientMessageId: input.id } }] }])
        runInAction(() => { store.transcriptRevision++ })
      })
      await vi.waitFor(() => expect(harness.container.querySelector('[data-native-input-id]')).toBeNull())
    } finally { await harness.render(null); chatState.dispose(); context.dispose() }
  })
})
