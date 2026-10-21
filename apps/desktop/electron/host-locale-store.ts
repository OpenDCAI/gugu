import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  isResolvedLocale,
} from '../shared/host-localization'
import { resolveSystemLocale, type SupportedLocale } from '@/i18n/locale'

export const HOST_LOCALE_STATE_FILE = 'host-locale-v1.json'

export class HostLocaleStoreError extends Error {
  readonly code: 'HOST_LOCALE_STATE_INVALID' | 'HOST_LOCALE_INVALID'

  constructor(code: HostLocaleStoreError['code'], cause?: unknown) {
    super(code, { cause })
    this.name = 'HostLocaleStoreError'
    this.code = code
  }
}

export class HostLocaleStore {
  private locale: SupportedLocale

  constructor(
    private readonly filePath: string,
    systemLanguages: readonly string[],
  ) {
    this.locale = this.readPersistedLocale() ?? resolveSystemLocale(systemLanguages)
  }

  current(): SupportedLocale {
    return this.locale
  }

  syncResolvedLocale(value: unknown): SupportedLocale {
    if (!isResolvedLocale(value)) throw new HostLocaleStoreError('HOST_LOCALE_INVALID')
    this.persist(value)
    this.locale = value
    return value
  }

  private readPersistedLocale(): SupportedLocale | null {
    if (!existsSync(this.filePath)) return null
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as {
        version?: unknown
        resolvedLocale?: unknown
      }
      if (parsed.version !== 1 || !isResolvedLocale(parsed.resolvedLocale)) {
        throw new HostLocaleStoreError('HOST_LOCALE_STATE_INVALID')
      }
      return parsed.resolvedLocale
    } catch (error) {
      if (error instanceof HostLocaleStoreError) throw error
      throw new HostLocaleStoreError('HOST_LOCALE_STATE_INVALID', error)
    }
  }

  private persist(locale: SupportedLocale): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`
    try {
      writeFileSync(temporaryPath, `${JSON.stringify({ version: 1, resolvedLocale: locale })}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
      renameSync(temporaryPath, this.filePath)
    } catch (error) {
      rmSync(temporaryPath, { force: true })
      throw error
    }
  }
}

