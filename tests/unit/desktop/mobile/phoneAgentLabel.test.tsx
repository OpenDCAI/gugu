// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHarnessIcon } from '../../../../apps/desktop/src/components/AgentHarnessIdentity'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { installIdentityDirectoryBridge, publishIdentityDirectory } from '../../../../apps/desktop/src/lib/identityDirectoryBridge'
import type { DisplayIdentity } from '../../../../apps/desktop/src/lib/displayIdentity'
import { publishDirectoryDevices } from '../../../../apps/desktop/src/session/shared/remote-sessions/session-directory'
import { createReactHarness, device, renderWithAppProviders } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/hooks/useAgentHarnessIdentity', () => ({
  useAgentHarnessIdentity: (id: string) => id === 'removed' ? 'removed' : 'pi',
}))

const contact = (id: string, deviceId: string): ContactUser => ({ id, display_name: id, type: 'agent', avatar: null, bio: null, agent_type: 'pi', device_id: deviceId })
const phone = device('phone', [], { platform: 'android', is_online: false, capabilities: { host_kind: 'phone', host_runtime_capability: 0, terminals: [], runtimes: [] } })
// 角标读两个外部目录(身份目录给「它住哪台」、设备目录给「那台是不是手机」),壳在这里发布。
installIdentityDirectoryBridge()
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => {
  harness.cleanup()
  publishIdentityDirectory(null, null)
  publishDirectoryDevices([])
})

async function show(id: string, deviceId: string) {
  act(() => {
    publishIdentityDirectory({ [id]: contact(id, deviceId) as unknown as DisplayIdentity }, null)
    publishDirectoryDevices([device('desktop', []), phone])
  })
  await renderWithAppProviders(harness, <AgentHarnessIcon agentId={id} />)
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
