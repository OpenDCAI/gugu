// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { electronPlatform } from '@/platform/electron'
import { webPlatform } from '@/platform/web'

afterEach(() => vi.unstubAllGlobals())

it('reads the local device claim result through the desktop platform boundary', async () => {
  const invoke = vi.fn(async () => 'device_full')
  vi.stubGlobal('window', { electronAPI: { invoke } })
  await expect(electronPlatform.readDeviceFreeCreditsStatus!()).resolves.toBe('device_full')
  expect(invoke).toHaveBeenCalledExactlyOnceWith('device:free-credits-status')
  expect(webPlatform.readDeviceFreeCreditsStatus).toBeUndefined()
})

it('does not invent a device status when its bridge is absent', async () => {
  vi.stubGlobal('window', {})
  await expect(electronPlatform.readDeviceFreeCreditsStatus!()).rejects.toThrow('Device free credits status')
})

it('rejects an unrecognized host reply instead of making it a known claim result', async () => {
  vi.stubGlobal('window', { electronAPI: { invoke: async () => 'unknown-claim' } })
  await expect(electronPlatform.readDeviceFreeCreditsStatus!()).rejects.toThrow('Unexpected device free credits status')
})
