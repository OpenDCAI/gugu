// @vitest-environment jsdom
import { act, createElement, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { REMOTE_PROTOCOL_VERSION } from '@gugu/core/cloud/serverMachineHealth'
import { createReactHarness } from '../../../support/testHarness'
import '../../../../apps/desktop/src/i18n/registerAssistantCatalog'

const f = vi.hoisted(() => ({
  online: true, ownerReads: 0, disconnectBeforeRpc: false,
  start: vi.fn(), status: vi.fn(), cancel: vi.fn(), preflight: vi.fn(),
  computer: vi.fn(), cloud: vi.fn(),
}))
vi.mock('@/mobile/agent-watch/sessionpage-rpc', () => ({ machineRpc: () => ({ assistantHome: f }) }))
vi.mock('@/platform/desktopIpc', () => ({ desktopIpc: () => ({}) }))
vi.mock('@/lib/supabase', () => ({ getCurrentAuthUserId: async () => {
  if (++f.ownerReads === 2 && f.disconnectBeforeRpc) f.online = false
  return 'owner'
} }))
vi.mock('@/lib/listDevicesOnceIdentified', () => ({ listDevicesOnceIdentified: async () => [{
  device_id: 'server', label: 'Linux', is_online: f.online, platform: 'linux',
  capabilities: { host_kind: 'server', arch: 'x64', remote_protocol: REMOTE_PROTOCOL_VERSION, assistant_home_setup: 1 },
}] }))
vi.mock('@/lib/assistantSetup', () => ({
  cleanAssistantSetupDraft: () => ({ name: '小满', avatar: '', ownerProfile: 'Owner' }),
  assistantResumeStore: { list: () => [] }, completedAssistantSetup: (value: unknown) => value,
}))
vi.mock('@/lib/agentProvision', () => ({ provisionSingleAgent: vi.fn(), resumeSingleAgent: vi.fn() }))
vi.mock('@/lib/agentModelSelection', () => ({ fetchAgentHarnessModels: vi.fn() }))
vi.mock('@/lib/assistantSetupState', () => ({ offerCustomizeCard: vi.fn(), writeSetupStep: vi.fn() }))
vi.mock('@/lib/myAssistant', () => ({ reloadMyAssistant: vi.fn() }))
vi.mock('@/lib/cloudComputerStore', () => ({ refreshCloudComputer: vi.fn() }))
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ error: vi.fn() }) }))
vi.mock('@/components/agentAvatar/AgentAvatar', () => ({ AgentAvatar: () => null }))

import { AssistantServerSetup } from '@/components/assistant/AssistantServerSetup'
import { AssistantHomeChoice } from '@/components/assistant/AssistantHomeChoice'
import { pendingServerAssistant } from '@/lib/assistantServerSetup'
const draft = { name: '小满', color: 0, rest: 'neutral' as const, owner: { preferredName: '主人', about: '' } }
function HomeFlow() {
  const [server, setServer] = useState(true)
  return server ? createElement(AssistantServerSetup, {
    ownerUserId: 'owner', name: draft.name, createDraft: async () => draft, onBack: () => setServer(false),
  }) : createElement(AssistantHomeChoice, {
    name: draft.name, member: true, cloudEnabled: true, cloudAvailable: true, canHostHere: true,
    busy: false, error: null, cloudFailure: null, draftAvatar: '',
    onCloud: f.cloud, onComputer: f.computer, onServer: () => setServer(true), onBack: vi.fn(), onUpgrade: vi.fn(),
  })
}
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear()
  f.online = true; f.ownerReads = 0; f.disconnectBeforeRpc = false
  f.start.mockReset(); f.cancel.mockReset()
  f.preflight.mockResolvedValue({ ok: true, value: { version: 1, modelSource: 'platform', defaultModel: 'model' } })
  harness = createReactHarness()
})
afterEach(() => harness.cleanup())
const query = (id: string) => harness.container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const back = () => [...harness.container.querySelectorAll('button')].find(button => button.textContent === '返回') ?? null
async function click(element: Element | null) {
  expect(element).not.toBeNull()
  await act(async () => (element as HTMLElement).click())
}
async function selectServer() {
  await harness.render(createElement(QueryClientProvider, {
    client: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  }, createElement(HomeFlow)))
  await act(async () => { await vi.waitFor(() => expect(query('assistant-server-target')).not.toBeNull()) })
  await click(query('assistant-server-target'))
  await click(query('assistant-server-install'))
}

it('returns to both home choices after a target disconnects before any target RPC', async () => {
  f.disconnectBeforeRpc = true
  await selectServer()
  expect(pendingServerAssistant('owner')).toMatchObject({ installationStarted: false, preparationStarted: false })
  expect(query('assistant-server-error')?.textContent).toContain('服务器离线')
  await click(back())
  expect(pendingServerAssistant('owner')).toBeNull()
  await click(query('assistant-setup-install-here'))
  await click(query('assistant-setup-claim-cloud'))
  expect(f.computer).toHaveBeenCalledOnce()
  expect(f.cloud).toHaveBeenCalledOnce()
  expect(f.preflight).not.toHaveBeenCalled()
  expect(f.start).not.toHaveBeenCalled()
  expect(f.cancel).not.toHaveBeenCalled()
})

it('retains a submitted operation while offline and returns only after remote cancellation', async () => {
  f.start.mockRejectedValueOnce(new Error('Start acknowledgement lost'))
  await selectServer()
  const record = pendingServerAssistant('owner')!
  expect(record).toMatchObject({ preparationStarted: true, installationStarted: false })
  f.online = false
  await click(back())
  expect(pendingServerAssistant('owner')?.operationId).toBe(record.operationId)
  expect(query('assistant-setup-install-here')).toBeNull()
  expect(f.cancel).not.toHaveBeenCalled()
  f.online = true
  f.cancel.mockResolvedValueOnce({ ok: true, value: { cancelled: true } })
  await click(back())
  expect(f.cancel).toHaveBeenCalledWith({ ownerUserId: 'owner', deviceId: 'server', operationId: record.operationId })
  expect(pendingServerAssistant('owner')).toBeNull()
  expect(query('assistant-setup-install-here')).not.toBeNull()
  expect(f.start).toHaveBeenCalledOnce()
})
