import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { SessionConversation } from '@/mobile/agent-watch/SessionConversation'
import { emptyAgentWatchTimeline } from '@/mobile/agent-watch/agent-watch-store'
import { state, changed, EMPTY } from '@/lib/sessionInputOutboxBridge'
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import '@/styles/tokens.css'
import '@renderer/index.css'

vi.mock('@gugu/core/cloud/config', async original => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }))
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({ useAppSettingsKey: () => ({ value: { chatView: 'double' } }) }))
vi.mock('@/mobile/agent-watch/sessionpage-rpc', async original => ({
  ...(await original<object>()), fetchSessionOptions: vi.fn(() => new Promise(() => {})),
  machineRpc: vi.fn(() => ({})), fetchBackgroundTasks: vi.fn(async () => []),
}))
vi.mock('@/mobile/agent-watch/useSessionLifeView', () => ({ useSessionLifeView: () => ({ view: null, error: null }) }))

let harness: ReturnType<typeof createReactHarness>
afterEach(() => {
  harness?.cleanup()
  const own = state()
  own.accountId = null; own.rows = EMPTY; own.valid = () => false; changed()
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
    onStop={vi.fn()} stopping={false} onLoadOlder={vi.fn()} />, { contacts: {} })
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
  expect(harness.container.querySelector('[data-queued-prompt-id="local"] [data-locked="true"]')).not.toBeNull()
  await act(async () => { own.rows = EMPTY; changed() })
  expect(harness.container.querySelectorAll('[data-queued-prompt-id="local"]')).toHaveLength(1)
  timeline.queuedPrompts = [{ id: 'local', text: 'local queue appears now' }]
  await render()
  expect(harness.container.querySelectorAll('[data-queued-prompt-id="local"]')).toHaveLength(1)
  expect(harness.container.querySelector('[data-queued-prompt-id="local"] [data-locked="true"]')).toBeNull()
})
