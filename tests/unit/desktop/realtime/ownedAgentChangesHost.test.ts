import { describe, expect, test, vi } from 'vitest'
import { createDeviceRuntimeHostLoop, type RuntimeAuth } from '@gugu/core'
import { isolatedGuguEnv, pollOnlyRuntimeIdentityClient } from '../../../support/deviceRuntimeHarness'
import { awaitPending } from '../../../support/awaitFact'

describe('owned-agent events follow the runtime owner', () => {
  test('keeps token refresh, but revokes callbacks on owner change, logout and stop', async () => {
    const env = await isolatedGuguEnv('owned-agents-owner-')
    let auth: RuntimeAuth | null = { userId: 'owner-a', accessToken: 'token-a' }
    const subscriptions: Array<{ ownerUserId: string; onChanged: () => Promise<void>; stop: ReturnType<typeof vi.fn> }> = []
    const changed = vi.fn(async () => undefined)
    const host = createDeviceRuntimeHostLoop({
      env,
      authProvider: { getAuth: async () => auth },
      machineIdentifier: () => 'owned-agents-machine',
      makeIdentityClient: () => pollOnlyRuntimeIdentityClient([], 'owned agents owner'),
      subscribeOwnedAgentChanges: ({ ownerUserId, onChanged }) => {
        const stop = vi.fn()
        subscriptions.push({ ownerUserId, onChanged, stop })
        return stop
      },
      onOwnedAgentsChanged: changed,
    })
    try {
      await host.tickOnce()
      expect(subscriptions.map(row => row.ownerUserId)).toEqual(['owner-a'])
      await subscriptions[0].onChanged()
      expect(changed).toHaveBeenLastCalledWith('owner-a')
      auth = { userId: 'owner-a', accessToken: 'rotated-token' }
      await host.tickOnce()
      expect(subscriptions).toHaveLength(1)
      expect(subscriptions[0].stop).not.toHaveBeenCalled()

      auth = { userId: 'owner-b', accessToken: 'token-b' }
      await host.tickOnce()
      expect(subscriptions.map(row => row.ownerUserId)).toEqual(['owner-a', 'owner-b'])
      expect(subscriptions[0].stop).toHaveBeenCalledOnce()
      await subscriptions[0].onChanged()
      expect(changed).toHaveBeenCalledTimes(1)
      await subscriptions[1].onChanged()
      expect(changed).toHaveBeenLastCalledWith('owner-b')

      auth = null
      await host.tickOnce()
      expect(subscriptions[1].stop).toHaveBeenCalledOnce()
      await subscriptions[1].onChanged()
      expect(changed).toHaveBeenCalledTimes(2)
      auth = { userId: 'owner-b', accessToken: 'signed-in-again' }
      await host.tickOnce()
      expect(subscriptions).toHaveLength(3)
      await host.stop()
      expect(subscriptions[2].stop).toHaveBeenCalledOnce()
      await subscriptions[2].onChanged()
      expect(changed).toHaveBeenCalledTimes(2)
    } finally { await host.stop() }
  })

  test('disposes a subscription that finishes after stop and ignores its late callbacks', async () => {
    const env = await isolatedGuguEnv('owned-agents-stop-')
    let entered!: () => void
    const subscribing = new Promise<void>(resolve => { entered = resolve })
    let release!: (stop: () => void) => void
    const pending = new Promise<() => void>(resolve => { release = resolve })
    const callback: { current?: () => Promise<void> } = {}
    const changed = vi.fn(async () => undefined)
    const stop = vi.fn()
    const host = createDeviceRuntimeHostLoop({
      env,
      authProvider: { getAuth: async () => ({ userId: 'owner-a', accessToken: 'token-a' }) },
      machineIdentifier: () => 'owned-agents-stop',
      makeIdentityClient: () => pollOnlyRuntimeIdentityClient([], 'owned agents stop'),
      subscribeOwnedAgentChanges: ({ onChanged }) => {
        callback.current = onChanged
        entered()
        return pending
      },
      onOwnedAgentsChanged: changed,
    })
    const tick = host.tickOnce()
    try {
      await awaitPending('owned-agent subscription entered', subscribing)
      const stopping = host.stop()
      await callback.current!()
      expect(changed).not.toHaveBeenCalled()
      release(stop)
      await tick.catch(() => undefined)
      await stopping
      expect(stop).toHaveBeenCalledOnce()
      await callback.current!()
      expect(changed).not.toHaveBeenCalled()
    } finally { release(stop); await host.stop() }
  })
})
