import { AsyncResource } from 'node:async_hooks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  emdashPlatformReleaseIntent,
  releaseEmdashPlatformSession,
  setEmdashPlatformRelease,
  withEmdashPlatformSessionRestart,
} from '../../../../apps/desktop/electron/session/main/core/acp/emdash-platform-injector'

describe('platform session release ownership', () => {
  afterEach(() => setEmdashPlatformRelease(null))

  it('distinguishes the controlled restart, its old close event, and an unrelated final stop', async () => {
    let finish!: () => void
    const gate = new Promise<void>((resolve) => { finish = resolve })
    const release = vi.fn(async () => undefined)
    setEmdashPlatformRelease(release)
    const restarting = withEmdashPlatformSessionRestart('conversation', 'old-generation', async () => {
      await releaseEmdashPlatformSession('conversation')
      await gate
    })
    expect(release).toHaveBeenCalledWith('conversation', undefined, 'restart')
    expect(emdashPlatformReleaseIntent('conversation', 'old-generation')).toBe('restart')
    expect(emdashPlatformReleaseIntent('conversation', 'new-generation')).toBe('end')
    expect(emdashPlatformReleaseIntent(null)).toBe('end')
    await releaseEmdashPlatformSession('conversation', 'old-generation')
    expect(release).toHaveBeenLastCalledWith('conversation', 'old-generation', 'restart')
    await releaseEmdashPlatformSession('conversation')
    expect(release).toHaveBeenLastCalledWith('conversation', undefined, 'end')
    finish()
    await restarting
    expect(emdashPlatformReleaseIntent('conversation', 'old-generation')).toBe('end')
  })

  it('drops the restart scope after failure', async () => {
    await expect(withEmdashPlatformSessionRestart('conversation', 'old-generation', async () => {
      throw new Error('restart failed')
    })).rejects.toThrow('restart failed')
    expect(emdashPlatformReleaseIntent('conversation', 'old-generation')).toBe('end')
  })

  it('does not leave asynchronous resources permanently exempt from final release', async () => {
    const resource = await withEmdashPlatformSessionRestart('conversation', 'old-generation', async () => {
      const child = new AsyncResource('restarted-provider')
      expect(child.runInAsyncScope(() => emdashPlatformReleaseIntent('conversation'))).toBe('restart')
      return child
    })
    expect(resource.runInAsyncScope(() => emdashPlatformReleaseIntent('conversation'))).toBe('end')
    resource.emitDestroy()
  })
})
