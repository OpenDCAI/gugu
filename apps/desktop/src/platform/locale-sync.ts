import type { LocaleSnapshot } from '@/i18n'
import type { AppPlatform } from './types'

interface LocaleSource {
  getSnapshot: () => LocaleSnapshot
  subscribe: (listener: () => void) => () => void
}

export interface PlatformLocaleSyncHandle {
  dispose: () => void
  whenSettled: () => Promise<void>
}

function failLoud(error: unknown): void {
  const normalized = error instanceof Error ? error : new Error(String(error))
  queueMicrotask(() => {
    throw normalized
  })
}

function invokeSync(
  platform: Pick<AppPlatform, 'syncResolvedLocale'>,
  snapshot: LocaleSnapshot,
): Promise<void> {
  try {
    return Promise.resolve(platform.syncResolvedLocale(snapshot.resolvedLocale))
  } catch (error) {
    return Promise.reject(error)
  }
}

export function installPlatformLocaleSync(
  platform: Pick<AppPlatform, 'syncResolvedLocale'>,
  source: LocaleSource,
  reportFailure: (error: unknown) => void = failLoud,
): PlatformLocaleSyncHandle {
  let tail = invokeSync(platform, source.getSnapshot()).catch(reportFailure)

  const unsubscribe = source.subscribe(() => {
    const snapshot = source.getSnapshot()
    tail = tail
      .then(() => invokeSync(platform, snapshot))
      .catch(reportFailure)
  })

  return {
    dispose: unsubscribe,
    whenSettled: () => tail,
  }
}
