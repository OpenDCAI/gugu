// @vitest-environment jsdom
import { act, createElement, StrictMode, useEffect, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness, typeInto } from '../../../support/testHarness'
import '../../../../apps/desktop/src/i18n/registerAssistantCatalog'
import { UI_EVENTS } from '@/lib/uiEvents'
import { clearAssistantOnboardingNavigation } from '@/lib/assistantOnboardingNavigation'
import { BODY_COLORS } from '@/components/agentAvatar/engine/identity'
import { ToastContext } from '@/components/toastContext'

const f = vi.hoisted(() => ({ list: vi.fn(), setup: vi.fn() }))
// The avatar renderer is a separate WebGL surface; identity editing and all setup steps are real.
vi.mock('@/components/agentAvatar/AgentAvatar', () => ({ AgentAvatar: () => null }))
vi.mock('@/components/agentAvatar/posters', () => ({ useAgentLookPostersVersion: () => 0, agentLookPoster: () => null }))
vi.mock('@/lib/assistantSetup', () => ({
  ASSISTANT_NAME_MAX: 30, draftAvatarUrl: () => '', pendingLocalAssistant: () => null,
  resumeLocalAssistant: vi.fn(), setUpAssistantOnThisComputer: vi.fn(), claimCloudAssistant: vi.fn(), AssistantSetupError: class extends Error {},
}))
vi.mock('@/lib/assistantServerSetup', () => ({
  listAssistantServerTargets: f.list, pendingServerAssistant: () => null,
  setUpAssistantOnServer: f.setup, resumeServerAssistant: vi.fn(), AssistantServerSetupError: class extends Error {},
}))
vi.mock('@/lib/firstRun', () => ({ takeAssistantStartAtHome: () => true, readOccupation: async () => ({ key: 'other', text: '研究者' }) }))
vi.mock('@/lib/assistantSetupState', () => ({ offerCustomizeCard: vi.fn(), writeSetupStep: vi.fn() }))
vi.mock('@/lib/myAssistant', () => ({ reloadMyAssistant: vi.fn() }))
vi.mock('@/lib/cloudComputerStore', () => ({ refreshCloudComputer: vi.fn() }))
vi.mock('@gugu/core/cloud/optionalServices', () => ({ cloudComputerEnabled: () => false }))
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ error: vi.fn() }) }))
import { AssistantOnboarding } from '@/components/assistant/AssistantOnboarding'

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear()
  clearAssistantOnboardingNavigation('owner'); clearAssistantOnboardingNavigation('other')
  f.list.mockResolvedValue([])
  f.setup.mockImplementation((_draft, _device, options) => {
    options.onInstalling()
    return new Promise(() => {})
  })
  harness = createReactHarness()
})
afterEach(() => harness.cleanup())
// This is the SettingsPanel section replacement boundary: switching to Devices
// removes Onboarding; returning creates a fresh instance (including StrictMode).
function SettingsNavigation({ returnOwner = 'owner' }: { returnOwner?: string }) {
  const [section, setSection] = useState('assistant')
  const [owner, setOwner] = useState('owner')
  useEffect(() => {
    const listener = (event: Event) => setSection((event as CustomEvent<{ section: string }>).detail.section)
    window.addEventListener(UI_EVENTS.openSettings, listener)
    return () => window.removeEventListener(UI_EVENTS.openSettings, listener)
  }, [])
  return section === 'assistant' ? createElement(AssistantOnboarding, {
    key: owner, ownerUserId: owner, ownerName: '主人', snapshot: null, device: null, cloudAvailable: false, localDeviceId: 'local',
  }) : createElement('button', { onClick: () => { setOwner(returnOwner); setSection('assistant') } }, '返回咕咕设置')
}
async function click(element: Element | null) {
  expect(element).not.toBeNull()
  await act(async () => (element as HTMLElement).click())
}
const query = (id: string) => harness.container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
async function openDevices(returnOwner = 'owner') {
  await harness.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
    createElement(ToastContext.Provider, { value: { toast: vi.fn() } }, createElement(StrictMode, null, createElement(SettingsNavigation, { returnOwner })))))
  await typeInto(harness.container.querySelector<HTMLInputElement>('input[data-testid="assistant-setup-name"]')!, '用户选定的名字')
  await click(harness.container.querySelector('.ta-onb-look'))
  const color = BODY_COLORS[9].en.toLowerCase()
  await click(document.querySelector(`[data-color="${color}"]`))
  await click(document.querySelector('.gg-look-save'))
  await click([...harness.container.querySelectorAll('button')].find(button => button.textContent === '继续') ?? null)
  await click(query('assistant-setup-choose-server'))
  await act(async () => { await vi.waitFor(() => expect(query('assistant-server-empty')).not.toBeNull()) })
  await click(query('assistant-server-add'))
  expect(query('assistant-setup-server')).toBeNull()
  expect(f.setup).not.toHaveBeenCalled()
}
const returnButton = () => [...harness.container.querySelectorAll('button')].find(button => button.textContent === '返回咕咕设置') ?? null

it('restores the server step, chosen name and look after Add Server unmounts settings onboarding', async () => {
  await openDevices()
  f.list.mockResolvedValue([{ deviceId: 'linux', label: '新服务器', selectable: true, reason: null }])
  await click(returnButton())
  expect(query('assistant-setup-server')).not.toBeNull()
  await act(async () => { await vi.waitFor(() => expect(query('assistant-server-target')).not.toBeNull()) })
  await click(query('assistant-server-target'))
  await click(query('assistant-server-install'))
  expect(f.setup).toHaveBeenCalledWith(expect.objectContaining({ name: '用户选定的名字', color: 9, rest: 'neutral' }), 'linux', expect.any(Object))
})

it('does not restore another account\'s navigation draft after returning from Devices', async () => {
  await openDevices('other')
  await click(returnButton())
  expect(query('assistant-setup-server')).toBeNull()
  expect(harness.container.querySelector<HTMLInputElement>('input[data-testid="assistant-setup-name"]')?.value).toBe('咕咕')
})
