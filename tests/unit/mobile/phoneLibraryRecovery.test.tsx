// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../apps/desktop/src/i18n/registerAssistantCatalog'
import { PhoneLibraryVolume } from '../../../apps/desktop/src/mobile/assistant/PhoneLibraryVolume'
import { PhoneHomeContext } from '../../../apps/desktop/src/mobile/assistant/phoneHome'
import { assistantPaths } from '../../../apps/desktop/src/session/renderer/features/assistant/assistant-files'
import type { AssistantMachine } from '../../../apps/desktop/src/session/renderer/features/assistant/assistant-machine-core'
import { createReactHarness, renderWithAppProviders } from '../../support/testHarness'

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
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup(); vi.useRealTimers() })

describe('phone library recovery', () => {
  it.each(['capabilities', 'devices'] as const)('waits for cloud identity for %s without exposing the execution device state', async (kind) => {
    await renderWithAppProviders(harness, <PhoneHomeContext.Provider value={home}>
      <PhoneLibraryVolume {...base} kind={kind} readiness="unreachable" machine={{ state: 'opening' }} />
    </PhoneHomeContext.Provider>)
    expect(harness.container.querySelector('[data-testid="file-book-reader"]')).toBeNull()
    expect(harness.container.textContent).not.toContain('Home computer')
    expect(harness.container.querySelector('[data-testid="loading-indicator"]')).not.toBeNull()
    expect(harness.container.querySelector('[data-testid="assistant-connecting"]')).toBeNull()
  })

  it('recovers a cloud read automatically without exposing diagnostics or a retry button', async () => {
    vi.useFakeTimers()
    const retry = vi.fn()
    await renderWithAppProviders(harness, <PhoneLibraryVolume {...base} kind="capabilities" readiness="ready" machine={{ state: 'error', error: new Error('workspace unavailable'), retry }} />)
    expect(harness.container.querySelector('[role="alert"]')?.textContent).not.toContain('workspace unavailable')
    expect(harness.container.querySelector('[data-testid="assistant-read-retry"]')).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    expect(retry).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
    await renderWithAppProviders(harness, <PhoneLibraryVolume {...base} kind="capabilities" readiness="ready" machine={{ state: 'ready', machine }} />)
    expect(harness.container.querySelector('[data-testid="file-book-reader"]')?.getAttribute('data-machine')).toBe('home')
    expect(harness.container.querySelector('[role="alert"]')).toBeNull()
  })

  it('keeps the account project directory accessible when the assistant workspace is unavailable', async () => {
    await renderWithAppProviders(harness, <PhoneLibraryVolume {...base} kind="workspace" readiness="unreachable" machine={{ state: 'opening' }} />)
    expect(harness.container.querySelector('[data-testid="file-book-reader"]')?.getAttribute('data-kind')).toBe('workspace')
  })

})
