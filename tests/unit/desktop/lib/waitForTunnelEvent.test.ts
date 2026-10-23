import { afterEach, describe, expect, it, vi } from 'vitest'

async function fixture() {
  vi.resetModules()
  const listeners = new Map<string, (value: unknown) => void>()
  vi.stubGlobal('window', { electronAPI: {
    eventOn: (name: string, cb: (value: unknown) => void) => { listeners.set(name, cb); return () => { listeners.delete(name) } },
    invoke: async (name: string) => name === 'server-ssh-machines:list' ? [] : { ready: [], problems: {} },
  } })
  const channel = await import('@/lib/sshLinkChannel')
  return { channel, emit: (state: unknown) => listeners.get('tunnel-machines:changed')!(state) }
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('task-host tunnel event wait', () => {
  it('waits beyond the old cap without any timer, then resolves on ready', async () => {
    vi.useFakeTimers()
    const { channel, emit } = await fixture()
    channel.wantTunnels([{ deviceId: 'tunnel', label: 'Tunnel' }])
    let settled = false
    const pending = channel.waitForTunnel('tunnel').then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(settled).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    emit({ ready: ['tunnel'], problems: {} })
    await pending
    expect(settled).toBe(true)
  })

  it('resolves on an explicit failure event', async () => {
    const { channel, emit } = await fixture()
    channel.wantTunnels([{ deviceId: 'tunnel', label: 'Tunnel' }])
    const pending = channel.waitForTunnel('tunnel')
    await channel.sshMachinesReady()
    emit({ ready: [], problems: { tunnel: 'sshFailed' } })
    await pending
  })

  it('does not wait for an ordinary device that was not selected by wantsTunnel', async () => {
    const { channel } = await fixture()
    channel.wantTunnels([{ deviceId: 'other', label: 'Other' }])
    await channel.waitForTunnel('ordinary')
  })

  it('does not wait for an existing SSH mapping or an already reported failure', async () => {
    const { channel, emit } = await fixture()
    channel.wantTunnels([{ deviceId: 'direct', label: 'Direct' }, { deviceId: 'failed', label: 'Failed' }])
    await channel.sshMachinesReady()
    channel._setSshMachineIdsForTesting(['direct'])
    emit({ ready: [], problems: { failed: 'visitorFailed' } })
    await channel.waitForTunnel('direct')
    await channel.waitForTunnel('failed')
  })

  it('releases an abandoned wait when the device leaves the wanted list', async () => {
    const { channel } = await fixture()
    channel.wantTunnels([{ deviceId: 'tunnel', label: 'Tunnel' }])
    const pending = channel.waitForTunnel('tunnel')
    await channel.sshMachinesReady()
    channel.wantTunnels([])
    await pending
  })
})
