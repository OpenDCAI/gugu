// @vitest-environment jsdom
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CloudComputerError } from '@gugu/core/cloud/cloudComputer'
import type { Device } from '@gugu/core/shared/types/chat'
import { createReactHarness, clickElement, renderWithAppProviders, typeInto } from '../../../support/testHarness'
import { until } from '../../../support/awaitCondition'
import { UI_EVENTS } from '@/lib/uiEvents'
import { i18n } from '@/i18n'
import '@/i18n/registerAssistantCatalog'
import '@/i18n/registerSettingsCatalog'

const state = vi.hoisted(() => ({ kind: 'electron' as 'electron' | 'capacitor', wake: vi.fn() }))
vi.mock('@/platform', async original => {
  const actual = await original<typeof import('@/platform')>()
  return { ...actual, platform: { ...actual.platform, get kind() { return state.kind } } }
})
vi.mock('@gugu/core/cloud/optionalServices', async original => ({ ...await original<object>(), cloudComputerEnabled: () => true }))
vi.mock('@/lib/billing/membership', () => ({ getMembership: async () => ({ tier: 'free', expiresAt: null }) }))
vi.mock('@/lib/firstRun', async original => ({ ...await original<object>(), takeAssistantStartAtHome: () => true, readOccupation: async () => null }))
vi.mock('@/lib/cloudComputerStore', async original => ({ ...await original<object>(), wakeCloudComputer: state.wake }))

const { AssistantOnboarding } = await import('@/components/assistant/AssistantOnboarding')
const { AssistantMoveGroup } = await import('@/components/assistant/AssistantMoveGroup')
const { AssistantStatusGroups } = await import('@/components/assistant/AssistantShellHost')
const { SettingsPanel } = await import('@/components/SettingsPanel')
let harness: ReturnType<typeof createReactHarness>
let client: QueryClient
let destinations: string[]
const onSettings = (event: Event) => destinations.push((event as CustomEvent<{ section: string }>).detail.section)
const button = (id: string) => {
  const element = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  expect(element, `real action ${id} is rendered`).not.toBeNull()
  return element!
}
async function render(node: React.ReactNode) {
  await renderWithAppProviders(harness, <QueryClientProvider client={client}>{node}</QueryClientProvider>, { auth: { id: 'purchase-986' }, contacts: {} })
}
beforeEach(async () => {
  harness = createReactHarness()
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  destinations = []
  window.addEventListener(UI_EVENTS.openSettings, onSettings)
  await i18n.changeLanguage('zh-CN')
  state.wake.mockRejectedValue(new CloudComputerError(403, 'credits_exhausted', 'credits exhausted'))
})
afterEach(() => {
  harness.cleanup()
  client.clear()
  window.removeEventListener(UI_EVENTS.openSettings, onSettings)
  delete (window as Window & { electronAPI?: unknown }).electronAPI
  vi.clearAllMocks()
})

it.each(['electron', 'capacitor'] as const)('onboarding membership action reaches the credit card on %s', async kind => {
  state.kind = kind
  await render(<AssistantOnboarding ownerUserId="purchase-986" ownerName="Tester" snapshot={null} device={null} cloudAvailable localDeviceId={null} />)
  const next = [...harness.container.querySelectorAll<HTMLButtonElement>('button')].find(el => el.textContent === i18n.t('setup.continue', { ns: 'assistant' }))!
  expect(next).toBeDefined()
  await clickElement(next)
  await until('Free membership action is ready', () => !!document.querySelector('[data-testid="assistant-setup-member"]'))
  await clickElement(button('assistant-setup-member'))
  expect(destinations).toEqual([kind === 'capacitor' ? 'account' : 'subscriptions'])
})

it.each(['electron', 'capacitor'] as const)('expired assistant membership renewal reaches the credit card on %s', async kind => {
  state.kind = kind
  await render(<AssistantMoveGroup ownerUserId="purchase-986" assistantId="assistant" assistantName="Gugu" home={{ kind: 'cloud', deviceId: 'cloud' }} localDeviceId={null} cloudAvailable />)
  await until('renew action is ready', () => !!document.querySelector('[data-testid="assistant-move-renew"]'))
  await clickElement(button('assistant-move-renew'))
  expect(destinations).toEqual([kind === 'capacitor' ? 'account' : 'subscriptions'])
})

it.each(['electron', 'capacitor'] as const)('assistant insufficient-credit top-up reaches the credit card on %s', async kind => {
  state.kind = kind
  await render(<AssistantStatusGroups assistantName="Gugu" device={{ device_id: 'cloud', is_online: false } as Device} snapshot={{ state: 'error', deviceId: 'cloud', error: 'failed', since: null }} />)
  await clickElement(button('settings-cloud-computer-wake-retry'))
  const topUp = [...harness.container.querySelectorAll<HTMLElement>('button')].find(el => el.textContent === i18n.t('devices.cloud.topUp', { ns: 'settings' }))!
  expect(topUp).toBeDefined()
  await clickElement(topUp)
  expect(destinations).toEqual([kind === 'capacitor' ? 'account' : 'subscriptions'])
})

it('keeps the assistant usage statistics action on Usage', async () => {
  state.kind = 'electron'
  await render(<AssistantStatusGroups assistantName="Gugu" device={null} snapshot={{ state: 'awake', deviceId: 'cloud', error: null, since: null }} />)
  const usage = [...harness.container.querySelectorAll<HTMLElement>('button')].find(el => el.textContent === i18n.t('settings.usage', { ns: 'assistant' }))!
  await clickElement(usage)
  expect(destinations).toEqual(['usage'])
})

it.each([false, true])('device limit upgrade selects the credit card with mobile=%s', async mobile => {
  state.kind = mobile ? 'capacitor' : 'electron'
  let push: ((value: unknown) => void) | undefined
  const steps = ['connect', 'detect', 'download', 'service', 'login'].map(id => ({ id, status: 'pending' }))
  const install = { runId: 'purchase-run', target: 'test-host', steps, machine: null, prompt: null, warnings: [], failure: null, result: null, finished: false, log: [] }
  Object.assign(window, { electronAPI: {
    invoke: async (channel: string) => channel === 'server-ssh-install:start' ? { runId: install.runId, state: install } : channel === 'server-ssh-install:list-hosts' ? [] : null,
    eventOn: (channel: string, callback: (value: unknown) => void) => { if (channel === 'server-ssh-install:state') push = callback; return () => {} },
  } })
  const onSectionChange = vi.fn()
  await render(<SettingsPanel mobile={mobile} inline pane="detail" section="devices" onSectionChange={onSectionChange} />)
  await clickElement(button('settings-add-server-button'))
  const ssh = document.querySelector<HTMLElement>('[data-testid="settings-add-server-ssh"]')
  if (ssh) await clickElement(ssh)
  await typeInto(button('add-server-target') as HTMLInputElement, 'test-host')
  const connect = [...harness.container.querySelectorAll<HTMLButtonElement>('button')].find(el => el.textContent === i18n.t('devices.addServer.connect', { ns: 'settings' }))!
  expect(connect).toBeDefined()
  await clickElement(connect)
  await act(async () => push?.({ ...install, finished: true, failure: { step: 'login', reason: 'machineLimit', machineLimit: { limit: 'total', used: 10, max: 10 } } }))
  await clickElement(button('add-server-machine-limit-upgrade'))
  expect(onSectionChange).toHaveBeenCalledExactlyOnceWith(mobile ? 'account' : 'subscriptions')
})
