import { describe, expect, it } from 'vitest'
import { updateInstallFlags } from '../../../../apps/desktop/electron/update-quit'

describe('update installation flags', () => {
  it('installs Windows updates silently and restarts afterward', () => {
    expect(updateInstallFlags('win32')).toEqual({ isSilent: true, isForceRunAfter: true })
  })

  it.each(['darwin', 'linux'] as const)('preserves the existing %s update behavior', (platform) => {
    expect(updateInstallFlags(platform)).toEqual({ isSilent: false, isForceRunAfter: false })
  })

  it('never leaves a silent update without automatic restart', () => {
    for (const platform of ['win32', 'darwin', 'linux', 'freebsd', 'aix'] as NodeJS.Platform[]) {
      const flags = updateInstallFlags(platform)
      expect(flags.isSilent, platform).toBe(flags.isForceRunAfter)
    }
  })

  it('defaults to the current process platform', () => {
    expect(updateInstallFlags()).toEqual(updateInstallFlags(process.platform))
  })
})
