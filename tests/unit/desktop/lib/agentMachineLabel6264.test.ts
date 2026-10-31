/** #6264 「这个 agent 在哪台机器上」各面同一个判据、同一个叫法。 */
import { describe, expect, it } from 'vitest'

import type { Device } from '@gugu/core/shared/types/chat'
import { agentLocationText, resolveAgentLocation } from '../../../../apps/desktop/src/lib/agentRunningStatusModels'

const row = (over: Partial<Device>): Device => ({
  device_id: 'x', label: 'x', hostname: 'x', platform: 'linux', status: 'online', last_seen_at: '', capabilities: null,
  machine_id: null, session_digest: null, is_online: true, ...over,
} as Device)

const devices = [
  row({ device_id: 'mbp', label: '192', machine_id: 'M', is_current_device: true, platform: 'darwin' }),
  row({ device_id: 'mbp-beta', label: 'Yang 的 MacBook Pro gugu', machine_id: 'M', platform: 'darwin' }),
  row({ device_id: 'linux2', label: 'Linux 2', machine_id: 'L' }),
]
const words = (key: string) => (key === 'chatArea.agentLocation.local' ? '本机' : '咕咕云')

describe('agent 所在机器', () => {
  it('本机、同一台电脑的另一条设备行、别的机器、咕咕云', () => {
    expect(agentLocationText(resolveAgentLocation('mbp', devices), words)).toBe('本机')
    expect(agentLocationText(resolveAgentLocation('mbp-beta', devices), words)).toBe('本机')
    expect(agentLocationText(resolveAgentLocation('linux2', devices), words)).toBe('Linux 2')
    expect(agentLocationText(resolveAgentLocation('cloud:u', devices), words)).toBe('咕咕云')
    expect(agentLocationText(resolveAgentLocation('gone', devices), words)).toBeNull()
  })
})
