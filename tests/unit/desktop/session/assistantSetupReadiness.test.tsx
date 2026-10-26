// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CloudComputerSnapshot } from '@gugu/core/cloud/cloudComputer'
import type { AssistantShellSnapshot } from '@/lib/assistantShellBridge'
import { createReactHarness } from '../../../support/testHarness'

const state = vi.hoisted(() => ({ shell: null as AssistantShellSnapshot | null, listeners: new Set<() => void>() }))
vi.mock('@/i18n/registerAssistantCatalog', () => ({}))
vi.mock('@/i18n/registerSettingsCatalog', () => ({}))
vi.mock('@/i18n/registerAgentsCatalog', () => ({}))
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({ remoteHostsStore: { start: () => () => {} } }))
vi.mock('@renderer/lib/layout/navigation-provider', () => ({ useParams: () => ({ params: {}, setParams: vi.fn() }) }))
vi.mock('@/lib/assistantShellBridge', () => ({ readAssistantShellBridge: () => null, assistantSlotKey: (key: string) => key }))
vi.mock('@/lib/assistantTaskChat', () => ({ useOpenedAssistantTaskChat: () => null, OPEN_ASSISTANT_TASK_CHAT: 'open-task', showAssistantTaskChat: vi.fn() }))
vi.mock('@/lib/assistantSetup', () => ({ refreshLocalAssistantHome: vi.fn(async () => {}) }))
vi.mock('@/components/Avatar', () => ({ Avatar: () => null }))
vi.mock('@renderer/lib/components/titlebar/shell-titlebar', () => ({ ShellTitlebar: () => null }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/assistant/assistant-shell', async () => {
  const { useSyncExternalStore } = await import('react')
  return {
    useAssistantShell: () => useSyncExternalStore((listener) => {
      state.listeners.add(listener)
      return () => { state.listeners.delete(listener) }
    }, () => state.shell),
    ShellSlot: ({ name }: { name: string }) => createElement('div', { 'data-slot': name }),
  }
})
vi.mock('../../../../apps/desktop/src/session/renderer/features/assistant/assistant-data', () => ({
  assistantWorkdir: () => null,
  homeReadiness: () => 'ready',
  useAssistantMachine: () => ({ data: null, isLoading: false, error: null }),
}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/assistant/assistant-home-sessions', () => ({ homeTarget: (home: { thisDevice?: boolean }) => home.thisDevice ? null : 'remote',localHomeSessions: { use: () => () => {} } }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/assistant/assistant-setup-finish', () => ({
  AssistantSetupFinish: () => createElement('div', { 'data-testid': 'connect-apps' }),
}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/assistant/assistant-pages', () => ({ ASSISTANT_PAGES: { today: () => null } }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/assistant/voice-notes/voice-recording-bar', () => ({ useVoiceNotesHost: () => {}, VoiceRecordingBar: () => null }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/assistant/assistant-ideas-layer', () => ({ AssistantIdeasLayer: () => null }))

const { AssistantMainPanel } = await import('../../../../apps/desktop/src/session/renderer/features/assistant/assistant-view')
let harness: ReturnType<typeof createReactHarness>
const cloud = (status: CloudComputerSnapshot['state'], error: string | null = null): CloudComputerSnapshot => ({
  state: status, deviceId: 'cloud', error, since: null,
})

beforeEach(() => {
  harness = createReactHarness()
  state.shell = {
    cloudAvailable: true, canHostHere: true, cloud: cloud('provisioning'), loadError: null,
    assistant: { id: 'same-agent', display_name: '咕咕', avatar: null, created_at: null },
    assistantState: 'found', ownerName: '主人', chatId: 'same-chat', home: { kind: 'cloud', deviceId: 'cloud' },
    setup: 'connect', member: true, preparing: false,
  }
})
afterEach(() => harness.cleanup())
const render = () => harness.render(createElement(AssistantMainPanel))
const publish = () => act(async () => { for (const listener of state.listeners) listener() })

it('keeps provisioning and failure on the retry surface even after the identity appears', async () => {
  await render()
  expect(harness.container.querySelector('[data-slot="onboarding"]')).not.toBeNull()
  expect(harness.container.querySelector('[data-testid="connect-apps"]')).toBeNull()
  state.shell = { ...state.shell!, cloud: cloud('error', 'setup failed') }
  await publish()
  expect(harness.container.querySelector('[data-slot="onboarding"]')).not.toBeNull()
  expect(harness.container.querySelector('[data-testid="connect-apps"]')).toBeNull()
})

it('advances after a retry becomes ready with the same identity and chat', async () => {
  await render()
  state.shell = { ...state.shell!, cloud: cloud('awake') }
  await publish()
  expect(harness.container.querySelector('[data-slot="onboarding"]')).toBeNull()
  expect(harness.container.querySelector('[data-testid="connect-apps"]')).not.toBeNull()
})

it('keeps an already-onboarded assistant in its usual view when cloud access fails', async () => {
  state.shell = { ...state.shell!, setup: null, cloud: cloud('error', 'connection failed') }
  await render()
  expect(harness.container.querySelector('[data-slot="onboarding"]')).toBeNull()
  expect(harness.container.querySelector('[data-testid="assistant-app"]')).not.toBeNull()
})

it('does not apply an unrelated cloud failure to local setup', async () => {
  state.shell = { ...state.shell!, cloud: cloud('error', 'old cloud failed'),
    home: { kind: 'computer', deviceId: 'local', thisDevice: false, label: '电脑', online: true, known: true } }
  await render()
  expect(harness.container.querySelector('[data-slot="onboarding"]')).toBeNull()
  expect(harness.container.querySelector('[data-testid="connect-apps"]')).not.toBeNull()
})

it('refreshes managed instructions only for a local assistant home', async () => {
  const { refreshLocalAssistantHome } = await import('@/lib/assistantSetup')
  vi.mocked(refreshLocalAssistantHome).mockClear()
  state.shell = { ...state.shell!,setup: null,home: { kind: 'computer',deviceId: 'local',thisDevice: true,label: 'Local',online: true,known: true } }
  await render()
  expect(refreshLocalAssistantHome).toHaveBeenCalledOnce()
})
