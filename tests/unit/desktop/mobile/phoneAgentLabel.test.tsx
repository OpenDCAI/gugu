// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHarnessIcon } from '../../../../apps/desktop/src/components/AgentHarnessIdentity'
import { DevicesContext, type DevicesContextValue } from '../../../../apps/desktop/src/store/devicesContext'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { createReactHarness, device, renderWithAppProviders } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/hooks/useAgentHarnessIdentity', () => ({
  useAgentHarnessIdentity: (id: string) => id === 'removed' ? 'removed' : 'pi',
}))

const contact = (id: string, deviceId: string): ContactUser => ({ id, display_name: id, type: 'agent', avatar: null, bio: null, agent_type: 'pi', device_id: deviceId })
const phone = device('phone', [], { platform: 'android', is_online: false, capabilities: { host_kind: 'phone', host_runtime_capability: 0, terminals: [], runtimes: [] } })
const devices: DevicesContextValue = { devices: [device('desktop', [])], phones: [phone], loading: false, error: null, refresh: vi.fn(), rename: vi.fn(), remove: vi.fn(), listBoundAgents: vi.fn() }
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => harness.cleanup())

async function show(id: string, deviceId: string) {
  await renderWithAppProviders(harness, <DevicesContext.Provider value={devices}>
    <AgentHarnessIcon agentId={id} />
  </DevicesContext.Provider>, { contacts: { contacts: [contact(id, deviceId)] } })
}

describe('phone agent identity presentation', () => {
  it('renders outside account/device/contact providers without inventing a phone host', async () => {
    await harness.render(<AgentHarnessIcon agentId={undefined} />)
    expect(harness.container.textContent).not.toMatch(/手机 Agent|Phone Agent/)
  })

  it('keeps the known phone label without a generic glyph even after that host stops', async () => {
    await show('phone-agent', 'phone')
    const icon = harness.container.querySelector('[role="img"]')!
    expect(icon.getAttribute('aria-label')).toMatch(/手机 Agent|Phone Agent/)
    expect(icon.querySelector('svg')).toBeNull()
    expect(harness.container.textContent).not.toMatch(/\bpi\b/i)
  })

  it.each(['desktop', 'unknown-external-device'])('preserves the Pi brand for %s rather than guessing its host is a phone', async (deviceId) => {
    await show('other-agent', deviceId)
    expect(harness.container.querySelector('[role="img"]')?.getAttribute('aria-label')).toMatch(/pi/i)
    expect(harness.container.textContent).not.toMatch(/手机 Agent|Phone Agent/)
  })

  it('keeps an account tombstone visible instead of presenting the removed phone agent as available', async () => {
    await show('removed', 'phone')
    expect(harness.container.querySelector('[role="img"]')?.getAttribute('aria-label')).toMatch(/已移除|Removed/)
    expect(harness.container.textContent).not.toMatch(/手机 Agent|Phone Agent/)
  })
})
