// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../apps/desktop/src/i18n/registerAssistantCatalog'
import { PhoneLibraryVolume } from '../../../apps/desktop/src/mobile/assistant/PhoneLibraryVolume'
import { PhoneProjectDirectoryRetry } from '../../../apps/desktop/src/mobile/assistant/PhoneProjectDirectoryRetry'
import { AssistantProjectsLibrary } from '../../../apps/desktop/src/components/assistant/AssistantProjectsLibrary'
import { PhoneHomeContext } from '../../../apps/desktop/src/mobile/assistant/phoneHome'
import { DevicesContext, type DevicesContextValue } from '../../../apps/desktop/src/store/devicesContext'
import { registerDeviceSessionsRetry, retainDeviceSessions, updateDeviceSessions } from '../../../apps/desktop/src/session/shared/remote-sessions/session-directory'
import { assistantPaths } from '../../../apps/desktop/src/session/renderer/features/assistant/assistant-files'
import type { AssistantMachine } from '../../../apps/desktop/src/session/renderer/features/assistant/assistant-machine-core'
import { clickElement, createReactHarness, deferred, device, renderWithAppProviders } from '../../support/testHarness'

vi.mock('@/platform', () => ({ platform: { capabilities: { agentRuntime: false } } }))
vi.mock('../../../apps/desktop/src/session/renderer/lib/stores/app-state', () => ({ appState: {} }))
vi.mock('../../../apps/desktop/src/hooks/useSessionpageReveal', () => ({ revealSessionpage: vi.fn() }))
// The wrapper must never mount this file reader until it has a real workspace.
vi.mock('../../../apps/desktop/src/components/assistant/AssistantLibraryVolume', () => ({
  AssistantLibraryVolume: ({ kind, machine }: { kind: string; machine: AssistantMachine | null }) => <div data-testid="file-book-reader" data-kind={kind} data-machine={machine?.deviceId ?? ''} />,
}))

const machine: AssistantMachine = { deviceId: 'home', projectId: 'project', workspaceId: 'workspace', home: '/home/owner',
  paths: assistantPaths('/home/owner', '/home/owner/project'), rpc: {} as AssistantMachine['rpc'] }
const assistant = { id: 'assistant', display_name: '咕咕', avatar: null, created_at: null }
const home = { kind: 'computer' as const, deviceId: 'home', thisDevice: false, label: 'Home computer', online: false, known: true }
const base = { assistant, askInChat: vi.fn() }
const store = (overrides: Partial<DevicesContextValue> = {}): DevicesContextValue => ({ devices: [device('a', []), device('b', [])], loading: false, error: null,
  refresh: vi.fn(async () => {}), rename: vi.fn(), remove: vi.fn(), listBoundAgents: vi.fn(), ...overrides })
const stops: Array<() => void> = []
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); retainDeviceSessions([]) })
afterEach(() => { harness.cleanup(); for (const stop of stops.splice(0)) stop(); retainDeviceSessions([]) })

describe('phone library recovery', () => {
  it.each(['capabilities', 'devices'] as const)('shows the actual disconnected state for %s instead of a file reader that can never load', async (kind) => {
    await renderWithAppProviders(harness, <PhoneHomeContext.Provider value={home}>
      <PhoneLibraryVolume {...base} kind={kind} readiness="unreachable" machine={{ state: 'opening' }} />
    </PhoneHomeContext.Provider>)
    expect(harness.container.querySelector('[data-testid="file-book-reader"]')).toBeNull()
    expect(harness.container.textContent).toContain('Home computer')
    expect(harness.container.querySelector('[data-testid="assistant-connecting"]')).toBeNull()
  })

  it('offers the existing workspace retry after an open failure, then passes the recovered workspace to the file book', async () => {
    const retry = vi.fn()
    await renderWithAppProviders(harness, <PhoneLibraryVolume {...base} kind="capabilities" readiness="ready" machine={{ state: 'error', error: new Error('workspace unavailable'), retry }} />)
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toContain('workspace unavailable')
    await clickElement(harness.container.querySelector<HTMLElement>('[data-testid="assistant-read-retry"]')!)
    expect(retry).toHaveBeenCalledTimes(1)
    await renderWithAppProviders(harness, <PhoneLibraryVolume {...base} kind="capabilities" readiness="ready" machine={{ state: 'ready', machine }} />)
    expect(harness.container.querySelector('[data-testid="file-book-reader"]')?.getAttribute('data-machine')).toBe('home')
    expect(harness.container.querySelector('[role="alert"]')).toBeNull()
  })

  it('keeps the account project directory accessible when the assistant workspace is unavailable', async () => {
    await renderWithAppProviders(harness, <PhoneLibraryVolume {...base} kind="workspace" readiness="unreachable" machine={{ state: 'opening' }} />)
    expect(harness.container.querySelector('[data-testid="file-book-reader"]')?.getAttribute('data-kind')).toBe('workspace')
  })

  it('retries only the failed device writer from the real project error page', async () => {
    const a = vi.fn(() => updateDeviceSessions('a', { error: null, loading: false }))
    const b = vi.fn()
    stops.push(registerDeviceSessionsRetry('user-1', 'a', a), registerDeviceSessionsRetry('user-1', 'b', b))
    updateDeviceSessions('a', { projects: [], sessions: [], loading: false, error: 'directory timed out' })
    updateDeviceSessions('b', { projects: [], sessions: [], loading: false, error: null })
    const devices = store()
    await renderWithAppProviders(harness, <DevicesContext.Provider value={devices}><AssistantProjectsLibrary machine={null} /></DevicesContext.Provider>)
    expect(harness.container.querySelector('[role="alert"]')).not.toBeNull()
    await clickElement(harness.container.querySelector<HTMLElement>('[data-testid="phone-project-directory-retry"]')!)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).not.toHaveBeenCalled()
    expect(devices.refresh).not.toHaveBeenCalled()
    expect(harness.container.querySelector('[role="alert"]')).toBeNull()
  })

  it('retries the device-list read when the list itself failed and keeps a real refresh error visible', async () => {
    const devices = store({ error: 'device-list failed', refresh: vi.fn().mockRejectedValue(new Error('network offline')) })
    await renderWithAppProviders(harness, <DevicesContext.Provider value={devices}><AssistantProjectsLibrary machine={null} /></DevicesContext.Provider>)
    await clickElement(harness.container.querySelector<HTMLElement>('[data-testid="phone-project-directory-retry"]')!)
    expect(devices.refresh).toHaveBeenCalledTimes(1)
    expect(harness.container.textContent).toContain('network offline')
    expect(harness.container.querySelector<HTMLButtonElement>('button[data-testid="phone-project-directory-retry"]')?.disabled).toBe(false)
  })

  it('re-enables retry after an account switch and never dispatches the old account’s remaining devices or shows its late error', async () => {
    const first = deferred<void>()
    const a = vi.fn(() => first.promise)
    const b = vi.fn()
    const other = vi.fn()
    stops.push(registerDeviceSessionsRetry('owner-a', 'a', a), registerDeviceSessionsRetry('owner-a', 'b', b), registerDeviceSessionsRetry('owner-b', 'other', other))
    const render = (owner: string, ids: string[], devices = store()) => renderWithAppProviders(harness,
      <DevicesContext.Provider value={devices}><PhoneProjectDirectoryRetry deviceIds={ids} /></DevicesContext.Provider>, { auth: { id: owner } })
    await render('owner-a', ['a', 'b'])
    await clickElement(harness.container.querySelector<HTMLElement>('button')!)
    expect(harness.container.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true)
    await render('owner-b', ['other'], store({ devices: [device('other', [])] }))
    expect(harness.container.querySelector<HTMLButtonElement>('button')?.disabled).toBe(false)
    await clickElement(harness.container.querySelector<HTMLElement>('button')!)
    expect(other).toHaveBeenCalledTimes(1)
    await act(async () => { first.resolve() })
    expect(b).not.toHaveBeenCalled()
    expect(harness.container.querySelector('[role="alert"]')).toBeNull()
    // A → B → A must not revive the original pending request.
    await render('owner-a', ['a'])
    expect(harness.container.querySelector<HTMLButtonElement>('button')?.disabled).toBe(false)
    const late = deferred<void>()
    stops.push(registerDeviceSessionsRetry('owner-a', 'a', () => late.promise))
    await clickElement(harness.container.querySelector<HTMLElement>('button')!)
    await render('owner-b', ['other'], store({ devices: [device('other', [])] }))
    await act(async () => { late.reject(new Error('old owner secret error')) })
    expect(harness.container.textContent).not.toContain('old owner secret error')
    expect(harness.container.querySelector<HTMLButtonElement>('button')?.disabled).toBe(false)
  })

  it('rejects an offline target before invoking its registered writer', async () => {
    const run = vi.fn()
    stops.push(registerDeviceSessionsRetry('user-1', 'a', run))
    await renderWithAppProviders(harness, <DevicesContext.Provider value={store({ devices: [device('a', [], { is_online: false })] })}>
      <PhoneProjectDirectoryRetry deviceIds={['a']} />
    </DevicesContext.Provider>)
    await clickElement(harness.container.querySelector<HTMLElement>('button')!)
    expect(run).not.toHaveBeenCalled()
    expect(harness.container.querySelector('[role="alert"]')).not.toBeNull()
  })
})
