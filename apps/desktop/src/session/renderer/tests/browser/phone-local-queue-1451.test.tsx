import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { SessionConversation } from '@/mobile/agent-watch/SessionConversation'
import { emptyAgentWatchTimeline } from '@/mobile/agent-watch/agent-watch-store'
import { state, changed, EMPTY } from '@/lib/sessionInputOutboxBridge'
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import { SessionInputQueue } from '@/components/chat/SessionInputQueue'
import type { SessionInputOutbox } from '@/lib/sessionInputOutbox'
import { PhoneViewportShell } from '@/mobile/PhoneViewportShell'
import '@/styles/tokens.css'
import '@renderer/index.css'
import type { LifeView } from '@shared/core/sessions/session-life'

const life = vi.hoisted(() => ({ view: null as LifeView | null }))
const release = vi.hoisted(() => vi.fn(async () => null))
vi.mock('@/lib/sessionInputOutboxBridge', async original => ({ ...(await original<object>()), releaseQueuedSessionInput: release }))

vi.mock('@gugu/core/cloud/config', async original => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }))
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({ useAppSettingsKey: () => ({ value: { chatView: 'double' } }) }))
vi.mock('@/mobile/agent-watch/sessionpage-rpc', async original => ({
  ...(await original<object>()), fetchSessionOptions: vi.fn(() => new Promise(() => {})),
  machineRpc: vi.fn(() => ({})), fetchBackgroundTasks: vi.fn(async () => []),
}))
vi.mock('@/mobile/agent-watch/useSessionLifeView', () => ({ useSessionLifeView: () => ({ view: life.view, error: null }) }))

let harness: ReturnType<typeof createReactHarness>
afterEach(() => {
  harness?.cleanup()
  const own = state()
  own.accountId = null; own.queue = null; own.rows = EMPTY; own.valid = () => false; changed()
  life.view = null; release.mockClear()
})

it('holds an opened queue until the authoritative life view arrives after history, including a late user stop', async () => {
  await page.viewport(390, 844)
  const timeline = emptyAgentWatchTimeline()
  timeline.turns = [{ id: 'completed-history', seq: 1, initiator: 'user', items: [], outcome: { kind: 'done' } }]
  Object.assign(state(), { accountId: 'owner', valid: () => true, rows: [
    { id: 'held', accountId: 'owner', deviceId: 'host', sessionId: 'session', text: 'stay held', createdAt: 1, queued: true, sendQueue: { order: 1 } },
  ] })
  harness = createReactHarness()
  harness.container.style.cssText = 'height:800px;width:390px;display:flex;flex-direction:column'
  const render = () => renderWithAppProviders(harness, <SessionConversation timeline={timeline} deviceId="host" sessionId="session" agentName="Agent" nativeRecord
    queueReady sessionRuntime="acp" respondingItemId={null} onRespond={vi.fn()} onSend={vi.fn()} pendingSends={[]} sending={false} agentWorking={false}
    onStop={vi.fn()} stopping={false} onLoadOlder={vi.fn()} />, { contacts: {} })
  await render()
  await until('held row is rendered while life is loading', () => !!harness.container.querySelector('[data-queued-prompt-id="held"]'))
  expect(release).not.toHaveBeenCalled()
  life.view = { sessionId: 'session', version: 1, kind: 'ready', stage: null, hold: 'user-stop', failure: null, lastExit: null, nativeSession: null,
    pending: { count: 0, items: [] } }
  await render()
  expect(release).not.toHaveBeenCalled()
  life.view = { ...life.view, hold: null }
  await render()
  await until('a confirmed ready foreground permits release', () => release.mock.calls.length === 1)
})

it('shows a running input after durable commit without waiting for a host queue response, then hands off its id', async () => {
  await page.viewport(390, 844)
  const timeline = emptyAgentWatchTimeline()
  const own = state()
  own.accountId = 'owner'; own.rows = EMPTY; own.valid = () => true
  let commit!: () => void
  const durable = new Promise<void>(resolve => { commit = resolve })
  const send = vi.fn(async (text: string) => {
    await durable
    own.rows = [{ id: 'local', accountId: 'owner', deviceId: 'host', sessionId: 'session', text, createdAt: 1, queued: true }]
    changed()
  })
  harness = createReactHarness()
  harness.container.style.cssText = 'height:800px;width:390px;display:flex;flex-direction:column'
  const render = () => renderWithAppProviders(harness, <SessionConversation timeline={timeline} deviceId="host" sessionId="session" agentName="Agent" nativeRecord
    sessionRuntime="acp" respondingItemId={null} onRespond={vi.fn()} onSend={send} pendingSends={[]} sending={false} agentWorking
    onStop={vi.fn()} stopping={false} onLoadOlder={vi.fn()} footerNotice={<SessionInputQueue sessionId="session" waitingForConnection />} />, { contacts: {} })
  await render()
  await page.getByTestId('prompt-editor').fill('local queue appears now')
  const stop = harness.container.querySelector('[data-composer-action="stop"]')
  expect(stop).toBeNull()
  await page.getByRole('button', { name: translateSessionMessage('composer.sendMessage'), exact: true }).click()
  await until('submission has started', () => send.mock.calls.length === 1)
  expect(harness.container.querySelector('[data-queued-prompt-id="local"]')).toBeNull()
  await act(async () => { commit(); await durable })
  await until('durable local queue is visible before the host responds', () => !!harness.container.querySelector('[data-queued-prompt-id="local"]'))
  expect(harness.container.querySelector('[data-queued-prompt-id="local"]')?.textContent).toContain('local queue appears now')
  expect(harness.container.querySelector('[data-native-input-id="local"]')).toBeNull()
  expect(harness.container.querySelector('[data-queued-prompt-id="local"] [data-locked="true"]')).not.toBeNull()
  await act(async () => { own.rows = EMPTY; changed() })
  expect(harness.container.querySelectorAll('[data-queued-prompt-id="local"]')).toHaveLength(1)
  timeline.queuedPrompts = [{ id: 'runtime-local', clientMessageId: 'local', text: 'local queue appears now' }]
  await render()
  expect(harness.container.querySelector('[data-queued-prompt-id="local"]')).toBeNull()
  expect(harness.container.querySelectorAll('[data-queued-prompt-id="runtime-local"]')).toHaveLength(1)
  expect(harness.container.querySelector('[data-queued-prompt-id="runtime-local"] [data-locked="true"]')).toBeNull()
  timeline.queuedPrompts = []
  timeline.turns = [{ id: 'provider-turn', seq: 1, initiator: 'user', outcome: { kind: 'done' }, items: [
    { kind: 'message', role: 'user', id: 'provider-local', seq: 0, text: 'local queue appears now', _meta: { guguClientMessageId: 'local' } },
  ] }]
  await render()
  expect(harness.container.querySelector('[data-queued-prompt-id]')).toBeNull()
})

it('shows and retries an online host refusal outside the normal locked queue', async () => {
  await page.viewport(390, 844)
  const own = state()
  const flush = vi.fn(async () => {})
  own.accountId = 'owner'; own.valid = () => true
  own.queue = Promise.resolve({ flush } as unknown as SessionInputOutbox)
  const input = { id: 'refused-local', accountId: 'owner', deviceId: 'host', sessionId: 'session', text: 'local refused input', createdAt: 1,
    queued: true, failure: { code: 'send-failed' as const, message: 'Provider login expired' } }
  own.rows = [input]
  harness = createReactHarness()
  harness.container.style.cssText = 'height:800px;width:390px;display:flex;flex-direction:column'
  await renderWithAppProviders(harness, <SessionConversation timeline={emptyAgentWatchTimeline()} deviceId="host" sessionId="session" agentName="Agent" nativeRecord
    sessionRuntime="acp" respondingItemId={null} onRespond={vi.fn()} onSend={vi.fn()} pendingSends={[]} sending={false} agentWorking
    onStop={vi.fn()} stopping={false} onLoadOlder={vi.fn()} footerNotice={<SessionInputQueue sessionId="session" waitingForConnection={false} />} />, { contacts: {} })
  await until('the connected host refusal is visible', () => !!harness.container.querySelector('[data-native-input-id="refused-local"] [data-send-state="failed"]'))
  const status = harness.container.querySelector('[data-native-input-id="refused-local"] [data-send-state="failed"]')!
  expect(status.textContent).toContain('Provider login expired')
  expect(harness.container.querySelector('[data-queued-prompt-id="refused-local"]')).toBeNull()
  expect(own.rows).toEqual([input])
  await page.getByRole('button', { name: translateSessionMessage('transcript.retrySend'), exact: true }).click()
  expect(flush).toHaveBeenCalledWith(true)
})

it('applies viewport geometry through CSS without rerendering the retained page', async () => {
  await page.viewport(390, 844)
  let renders = 0
  function RetainedPage() { renders++; return <div>Existing conversation</div> }
  harness = createReactHarness()
  await renderWithAppProviders(harness, <PhoneViewportShell mobile><RetainedPage /></PhoneViewportShell>, { contacts: {} })
  const shell = harness.container.querySelector('.gg-phone-viewport-shell')!
  await until('shell follows the initial native viewport', () => shell.getBoundingClientRect().height === 844)
  const initialRenders = renders
  await page.viewport(390, 500)
  await until('CSS receives the smaller native viewport', () => shell.getBoundingClientRect().height === 500)
  expect(renders).toBe(initialRenders)
  await page.viewport(390, 844)
  await until('CSS restores the full viewport', () => shell.getBoundingClientRect().height === 844)
  expect(renders).toBe(initialRenders)
})
