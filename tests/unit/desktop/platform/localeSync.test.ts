import { describe, expect, it, vi } from 'vitest'
import type { LocaleSnapshot } from '../../../../apps/desktop/src/i18n'
import { installPlatformLocaleSync } from '../../../../apps/desktop/src/platform/locale-sync'

describe('platform locale sync', () => {
  it('syncs the initial runtime snapshot and every subsequent resolved locale', async () => {
    let snapshot: LocaleSnapshot = { preference: 'system', resolvedLocale: 'zh-CN' }
    let notify: (() => void) | undefined
    const syncResolvedLocale = vi.fn(async () => {})
    const handle = installPlatformLocaleSync(
      { syncResolvedLocale },
      {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          notify = listener
          return vi.fn()
        },
      },
    )

    expect(syncResolvedLocale).toHaveBeenCalledTimes(1)
    expect(syncResolvedLocale).toHaveBeenLastCalledWith('zh-CN')

    snapshot = { preference: 'system', resolvedLocale: 'en-US' }
    notify?.()
    await handle.whenSettled()

    expect(syncResolvedLocale.mock.calls).toEqual([['zh-CN'], ['en-US']])
  })

  it('reports sync failures instead of swallowing them', async () => {
    const error = new Error('host locale IPC unavailable')
    const reportFailure = vi.fn()
    const handle = installPlatformLocaleSync(
      { syncResolvedLocale: vi.fn().mockRejectedValue(error) },
      {
        getSnapshot: () => ({ preference: 'en-US', resolvedLocale: 'en-US' }),
        subscribe: () => () => {},
      },
      reportFailure,
    )

    await handle.whenSettled()

    expect(reportFailure).toHaveBeenCalledWith(error)
  })
})
