// @vitest-environment jsdom
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
const world = vi.hoisted(() => ({ home: null as object | null, loading: false }))
vi.mock('react-i18next',async original => ({ ...await original<object>(),useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/lib/useAssistantHome', () => ({ useAssistantHome: () => ({ home: world.home, identityLoading: world.loading, contact: null, cloudDeviceId: null }) }))
vi.mock('@/components/assistant/assistant-panel-files', () => ({ ASSISTANT_PANEL_CHANGED: 'panel-change',useCloudAssistantFiles: (_assistant: string,chat: string,device: string) => chat && device ? {} : undefined }))
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: {} }))
vi.mock('@renderer/lib/ipc', () => ({ rpc: {} }))
vi.mock('@/session/renderer/features/assistant/assistant-home-sessions', () => ({ homeSessions: vi.fn() }))
vi.mock('@/components/devices/AssistantDeviceConnectors', () => ({ ThisDeviceConnectors: () => null, OtherDeviceConnectors: () => null }))
vi.mock('@/components/sessionpage/SessionSettingsSection', () => ({ SessionSettingsSection: () => null }))
import { useAssistantMachine } from '../../../../apps/desktop/src/session/renderer/features/assistant/assistant-data'
import { ConnectorsSection } from '../../../../apps/desktop/src/components/settings/ConnectorsSection'
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); world.home = null; world.loading = false })
afterEach(() => harness.cleanup())
function State({ chat,failed = false }: { chat: string | null; failed?: boolean }) {
  const value = useAssistantMachine('assistant',chat,{ kind: 'cloud',deviceId: 'home' },failed)
  return createElement('div',{ 'data-testid': 'state' },value.isLoading ? 'loading' : value.error ? 'error' : 'ready')
}
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
it('waits for the private chat identity before showing an error, then resolves to the cloud reader', async () => {
  const query = client()
  const render = (chat: string | null,failed = false) => harness.render(createElement(QueryClientProvider,{ client: query },createElement(State,{ chat,failed })))
  await render(null); expect(harness.container.textContent).toBe('loading')
  await render('chat'); expect(harness.container.textContent).toBe('ready')
  await render(null,true); expect(harness.container.textContent).toBe('error')
})
it('ends connector loading when identity lookup has finished without a home', async () => {
  world.loading = true
  await harness.render(createElement(ConnectorsSection))
  expect(harness.container.querySelector('[data-testid="loading-indicator"]')).not.toBeNull()
  world.loading = false
  await harness.render(createElement(ConnectorsSection))
  expect(harness.container.textContent).toContain('machine.identityFailed')
  expect(harness.container.querySelector('[data-testid="loading-indicator"]')).toBeNull()
})
