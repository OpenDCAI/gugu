/**
 * #7199 owner 10-15「云电脑对用户完全不可见」+「连接要分清在哪」:
 * - 聊天头 / 会话列表标签不说个人助理住在哪。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/i18n')>()
  return { ...actual, i18n: { ...actual.i18n, t: (key: string) => key } }
})

import type { Device } from '@gugu/core/shared/types/chat'
import { agentLocationText, resolveAgentLocation } from '../../../../apps/desktop/src/lib/agentRunningStatusModels'

function device(id: string, over: Omit<Partial<Device>, 'capabilities'> & { capabilities?: Record<string, unknown> } = {}): Device {
  const { capabilities, ...rest } = over
  return {
    device_id: id,
    label: id,
    hostname: id,
    platform: 'darwin',
    is_online: true,
    last_seen_at: '2026-10-15T07:00:00Z',
    is_current_device: false,
    machine_id: null,
    session_digest: null,
    ...rest,
    capabilities: {
      host_kind: 'desktop',
      ...capabilities,
    },
  } as unknown as Device
}

describe('聊天头 / 会话列表:不说个人助理住在哪', () => {
  const words = (key: string) => key
  it('它住的那台 = 不写位置;对照:别的机器照旧写机器名', () => {
    const devices = [device('home', { label: '云电脑', cloud_computer: 'awake' }), device('linux2', { label: 'Linux 2' })]
    expect(resolveAgentLocation('home', devices)).toBeNull()
    expect(agentLocationText(resolveAgentLocation('linux2', devices), words)).toBe('Linux 2')
  })

  it('管家说醒了、它还没上线(设备行上没有 cloud_computer)那一阵:靠它自己报的标记,照样不读机器名', () => {
    const waking = [device('home', { label: 'iZbp1c7suao1xpu5otqmh9Z', is_online: false, capabilities: { host_kind: 'server', assistant_home: true } })]
    expect(resolveAgentLocation('home', waking)).toBeNull()
  })
})
