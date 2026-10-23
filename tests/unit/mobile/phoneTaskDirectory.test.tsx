// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../apps/desktop/src/i18n/registerAssistantCatalog'
import { PhoneTasks } from '../../../apps/desktop/src/mobile/assistant/PhoneTasks'
import { PhoneRoutineDetail } from '../../../apps/desktop/src/mobile/assistant/PhoneRoutineDetail'
import { usePhoneRoutines } from '../../../apps/desktop/src/mobile/assistant/usePhoneRoutines'
import type { PhonePageProps } from '../../../apps/desktop/src/mobile/assistant/MobileAssistantApp'
import type { DeviceSessions } from '../../../apps/desktop/src/session/shared/remote-sessions/session-directory'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { createReactHarness, device, renderWithAppProviders } from '../../support/testHarness'

const mocks = vi.hoisted(() => ({
  devices: [] as ReturnType<typeof device>[], live: {} as Record<string, DeviceSessions>, automations: vi.fn(),
}))
vi.mock('../../../apps/desktop/src/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: mocks.devices, loading: false, error: null }) }))
vi.mock('../../../apps/desktop/src/session/shared/remote-sessions/session-directory', async original => ({
  ...await original<object>(), useLiveDeviceSessions: () => mocks.live,
}))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({
  machineRpc: () => ({ automations: { listAutomations: mocks.automations } }),
}))

function props(): PhonePageProps {
  return {
    assistant: { id: 'assistant', display_name: '咕咕', avatar: null, created_at: null },
    chatId: 'dm', ownerName: 'Owner', home: { kind: 'computer', deviceId: 'home', thisDevice: false, label: 'Home', online: true, known: true },
    homeDeviceId: 'home', cloudDeviceId: null, readiness: 'ready', machine: { state: 'opening' },
    askInChat: vi.fn(), sub: null, go: vi.fn(), open: vi.fn(),
  }
}

describe('phone task directory states', () => {
  let harness: ReturnType<typeof createReactHarness>
  beforeEach(() => {
    harness = createReactHarness()
    mocks.devices = [device('home', [])]
    mocks.live = { home: { projects: [], sessions: [], cached: false, loading: false, error: null } }
    mocks.automations.mockReset().mockResolvedValue([])
  })
  afterEach(() => harness.cleanup())

  it('separates a loading or failed directory from an actually empty task list', async () => {
    const page = props()
    mocks.live.home!.loading = true
    await renderWithAppProviders(harness, <PhoneTasks {...page} />)
    expect(harness.container.querySelector('[role="status"]')).not.toBeNull()
    expect(harness.container.textContent).not.toContain('还没有任务')
    mocks.live = { home: { ...mocks.live.home!, loading: false, error: 'directory unavailable' } }
    await renderWithAppProviders(harness, <PhoneTasks {...page} />)
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toContain('directory unavailable')
    expect(harness.container.textContent).not.toContain('还没有任务')
    mocks.live = { home: { ...mocks.live.home!, error: null } }
    await renderWithAppProviders(harness, <PhoneTasks {...page} />)
    expect(harness.container.textContent).toContain('还没有任务')
  })

  it('uses the existing keyboard-enabled tabs for tasks and schedules', async () => {
    await renderWithAppProviders(harness, <PhoneTasks {...props()} />)
    const first = harness.container.querySelector<HTMLElement>('[data-testid="assistant-seg-tasks"]')!
    const scheduled = harness.container.querySelector<HTMLElement>('[data-testid="assistant-seg-scheduled"]')!
    await act(async () => { first.focus(); first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
    expect(scheduled.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(scheduled)
    expect(first.tabIndex).toBe(-1)
  })

  it('does not attribute unknown computer automations to the personal assistant', async () => {
    const own = { conversationId: 'own', projectId: 'p', title: 'own', harness: 'pi', runtime: 'acp', supported: true, agent: { userId: 'assistant' }, lastInteractedAt: '2026-10-21T00:00:00Z', agentStatus: 'idle' } as SessionpageSessionSummary
    mocks.live.home!.sessions = [own]
    mocks.automations.mockResolvedValue([
      { id: 'own-routine', name: 'Own', agentSessionId: 'own', createdAt: 1, updatedAt: 1, enabled: true },
      { id: 'unknown-routine', name: 'Unknown', agentSessionId: 'other', createdAt: 2, updatedAt: 2, enabled: true },
    ])
    let ids: string[] = []
    function Probe({ page }: { page: PhonePageProps }) {
      ids = usePhoneRoutines(page).routines.map(routine => routine.id)
      return null
    }
    await renderWithAppProviders(harness, <Probe page={props()} />)
    expect(ids).toEqual(['own-routine'])
    await renderWithAppProviders(harness, <Probe page={{ ...props(), home: { kind: 'cloud', deviceId: 'home' } }} />)
    expect(ids).toEqual(['unknown-routine', 'own-routine'])
  })

  it.each(['list', 'detail'])('does not call unread computer schedules empty or gone in %s', async (surface) => {
    const page = props()
    const render = () => renderWithAppProviders(harness, surface === 'detail'
      ? <PhoneRoutineDetail {...page} id="routine" />
      : <PhoneTasks {...page} />)
    mocks.live.home!.loading = true
    await render()
    if (surface === 'list') {
      const tab = harness.container.querySelector<HTMLElement>('[data-testid="assistant-seg-scheduled"]')!
      await act(async () => { tab.click() })
    }
    expect(harness.container.querySelector('[role="status"]')).not.toBeNull()
    expect(harness.container.textContent).not.toMatch(/暂无定时任务|此定时任务不可用/)
    mocks.live = { home: { ...mocks.live.home!, loading: false, error: 'schedule ownership unavailable' } }
    await render()
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toContain('schedule ownership unavailable')
    expect(harness.container.textContent).not.toMatch(/暂无定时任务|此定时任务不可用/)
  })

  it('shows a schedule request failure while the ownership directory is still pending', async () => {
    mocks.live.home!.loading = true
    mocks.automations.mockRejectedValue(new Error('schedule RPC unavailable'))
    await renderWithAppProviders(harness, <PhoneTasks {...props()} />)
    await act(async () => { harness.container.querySelector<HTMLElement>('[data-testid="assistant-seg-scheduled"]')!.click() })
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toContain('schedule RPC unavailable')
    expect(harness.container.querySelector('[role="status"]')).toBeNull()
  })
})
