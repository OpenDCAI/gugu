import { describe, expect, it, vi } from 'vitest'
import { announceLocalDeviceIdentity } from '../../../../apps/desktop/electron/local-device-identity'

describe('announceLocalDeviceIdentity', () => {
  it('announces when this computer becomes identified, once per identification', async () => {
    const answers: Array<string | null> = [null, 'mac-a', 'mac-a', null, 'mac-a', 'mac-b']
    const announce = vi.fn()
    const localDeviceId = announceLocalDeviceIdentity(async () => answers.shift() ?? null, announce)

    // before the sign-in arrives: nothing to say
    expect(await localDeviceId()).toBeNull()
    expect(announce).not.toHaveBeenCalled()
    // identified, then asked again: one announcement
    expect(await localDeviceId()).toBe('mac-a')
    expect(await localDeviceId()).toBe('mac-a')
    expect(announce.mock.calls).toEqual([['mac-a']])
    // signed out and back in: identified again
    await localDeviceId()
    await localDeviceId()
    // another account on the same computer is another device row
    await localDeviceId()
    expect(announce.mock.calls).toEqual([['mac-a'], ['mac-a'], ['mac-b']])
  })
})
