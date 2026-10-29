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

const scope = vi.hoisted(() => ({ owner: 'account-a', devices: [{ device_id: 'host-a', is_online: false, capabilities: {} }], received: new Map<string, string>(), send: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/sessionPublication', () => ({ getRendererSession: () => ({ user: { id: scope.owner } }) }))
vi.mock('../../../../apps/desktop/src/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: scope.devices, phones: [] }) }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { kind: 'electron' } }))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/ipc', () => ({ rpcOn: () => ({ sessionTimeline: { sessionSend: scope.send } }) }))
vi.mock('../../../../apps/desktop/src/session/renderer/localization/locale-store', () => ({ translateSessionMessage: () => 'Waiting for host; sends automatically' }))
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup(); scope.owner = 'account-a'; scope.devices = [{ device_id: 'host-a', is_online: false, capabilities: {} }]; scope.received.clear(); scope.send.mockReset() })

describe('native input shell lifecycle', () => {
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
    await vi.waitFor(() => expect(harness.container.querySelector('[data-native-input-id]')?.textContent).toBe('手机排队原话\ntri29-file.txt'))
    expect(harness.container.innerHTML).not.toContain('gugu-session://')
    expect(harness.container.innerHTML).not.toContain(source.sessionId)
    expect(harness.container.innerHTML).not.toContain(source.itemId)
    expect(harness.container.innerHTML).not.toContain('/Users/')
    expect(scope.send).not.toHaveBeenCalled()
    scope.devices = [{ device_id: 'host-a', is_online: true, capabilities: {} }]
    await harness.render(<><SessionInputOutboxHost accountId={scope.owner} /><SessionInputQueue sessionId="session-a" /></>)
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
    await vi.waitFor(() => expect(harness.container.textContent).not.toContain('offline original'))
  })
})
