// @vitest-environment jsdom
// 远程隧道用到了才连:每台中转机器一个 frpc + 一条 ssh,设备列表一出来就全连 = 随机器数线性涨的常驻进程。
// 有人用着(holdTunnel)才交给主进程;最后一处放手后留 TUNNEL_IDLE_MS 再收。
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'

const relay = (id: string) => ({
  device_id: id,
  label: id,
  machine_id: id,
  is_online: true,
  is_current_device: false,
  platform: 'linux',
  last_seen_at: null,
  capabilities: { terminals: [], runtimes: [], tunnel_relay: 'frp', host_kind: 'server' },
})
const devices = vi.hoisted(() => ({ list: [] as unknown[] }))
vi.mock('../../../../apps/desktop/src/store/devicesContext', () => ({
  useDevicesStore: () => ({ devices: devices.list, cloudComputer: null }),
}))
vi.mock('../../../../apps/desktop/src/hooks/useSshSignInStates', () => ({ useSshSignInStates: () => new Map() }))
vi.mock('../../../../apps/desktop/src/hooks/useSshLinkProblems', () => ({ useSshLinkProblems: () => new Map() }))
vi.mock('../../../../apps/desktop/src/hooks/useAssistantHomeLabel', () => ({ useAssistantName: () => 'Assistant' }))
vi.mock('../../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => ({ warn: () => {}, info: () => {}, error: () => {} }) }))

const wants: string[][] = []
Object.assign(window, {
  electronAPI: {
    eventOn: () => () => undefined,
    invoke: async (channel: string, payload: unknown) => {
      if (channel === 'tunnel-machines:want') wants.push((payload as { deviceId: string }[]).map((w) => w.deviceId).sort())
      if (channel === 'server-ssh-machines:list') return []
      return { ready: [], problems: {} }
    },
  },
})

const { useRemoteHostsBridge } = await import('../../../../apps/desktop/src/hooks/useRemoteHostsBridge')
const channel = await import('../../../../apps/desktop/src/lib/sshLinkChannel')

function Probe() {
  useRemoteHostsBridge(false, async () => null)
  return null
}

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  vi.useFakeTimers()
  harness = createReactHarness()
  wants.length = 0
  devices.list = [relay('d1'), relay('d2')]
})
afterEach(() => {
  harness.cleanup()
  vi.useRealTimers()
})

const lastWant = () => wants.at(-1) ?? []

describe('remote tunnels start on use', () => {
  it('opens no tunnel for online relay machines nobody is using', async () => {
    await harness.render(createElement(Probe))
    await act(async () => {})
    expect(lastWant()).toEqual([])
  })

  it('opens only the held machine, keeps it for the idle window after release, then drops it', async () => {
    await harness.render(createElement(Probe))
    let release = () => {}
    await act(async () => {
      release = channel.holdTunnel('d1')
    })
    expect(lastWant()).toEqual(['d1'])

    await act(async () => release())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(channel.TUNNEL_IDLE_MS - 1)
    })
    expect(lastWant()).toEqual(['d1'])

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(lastWant()).toEqual([])
  })

  it('a second use within the idle window keeps the same tunnel', async () => {
    await harness.render(createElement(Probe))
    await act(async () => channel.holdTunnel('d2')())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(channel.TUNNEL_IDLE_MS / 2)
    })
    let again = () => {}
    await act(async () => {
      again = channel.holdTunnel('d2')
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(channel.TUNNEL_IDLE_MS)
    })
    expect(lastWant()).toEqual(['d2'])
    await act(async () => again())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(channel.TUNNEL_IDLE_MS)
    })
    expect(lastWant()).toEqual([])
  })
})
