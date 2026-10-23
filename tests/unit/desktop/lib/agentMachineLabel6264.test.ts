/** #6264 「这个 agent 在哪台机器上」各面同一个判据、同一个叫法。 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/i18n')>()
  const words: Record<string, string> = { 'chatArea.agentLocation.local': '本机', 'chatArea.agentLocation.cloud': '咕咕云' }
  return { ...actual, i18n: { ...actual.i18n, t: (key: string) => words[key] ?? key } }
})

import type { Device } from '@gugu/core/shared/types/chat'
import { agentLocationText, resolveAgentLocation } from '../../../../apps/desktop/src/lib/agentRunningStatusModels'
import { agentDeviceTag, chatRowTag } from '../../../../apps/desktop/src/lib/chatRowTag'
import { chat } from '../../../support/testHarness'

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
  it('omits group tags while preserving agent device tags', () => {
    const agent = { type: 'agent' as const, device_id: 'linux2' }
    expect(chatRowTag(chat({ kind: 'group' }), agent, devices)).toBeNull()
    expect(chatRowTag(chat({ kind: 'ai' }), agent, devices)).toBe('Linux 2')
    expect(chatRowTag(chat({ kind: 'dm' }), undefined, devices)).toBeNull()
  })

  it('本机、同一台电脑的另一条设备行、别的机器、咕咕云', () => {
    expect(agentLocationText(resolveAgentLocation('mbp', devices), words)).toBe('本机')
    expect(agentLocationText(resolveAgentLocation('mbp-beta', devices), words)).toBe('本机')
    expect(agentLocationText(resolveAgentLocation('linux2', devices), words)).toBe('Linux 2')
    expect(agentLocationText(resolveAgentLocation('cloud:u', devices), words)).toBe('咕咕云')
    expect(agentLocationText(resolveAgentLocation('gone', devices), words)).toBeNull()
  })

  it('会话列表标签与聊天标题栏说同一个词', () => {
    for (const id of ['mbp', 'mbp-beta', 'linux2', 'cloud:u']) {
      expect(agentDeviceTag(id, devices)).toBe(agentLocationText(resolveAgentLocation(id, devices), words))
    }
  })
})
