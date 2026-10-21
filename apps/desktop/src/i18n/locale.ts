export const SUPPORTED_LOCALES = ['zh-CN', 'en-US'] as const

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]
export type LocalePreference = 'system' | SupportedLocale

export const FALLBACK_LOCALE: SupportedLocale = 'zh-CN'
export const LOCALE_STORAGE_KEY = 'gugu.locale.preference.v1'
export const LOCALE_CHANGED_EVENT = 'gugu:locale-changed'

export interface LocaleSnapshot {
  preference: LocalePreference
  resolvedLocale: SupportedLocale
}

export function isLocalePreference(value: unknown): value is LocalePreference {
  return value === 'system' || SUPPORTED_LOCALES.includes(value as SupportedLocale)
}

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return SUPPORTED_LOCALES.includes(value as SupportedLocale)
}

export function matchSupportedLocale(language: string | null | undefined): SupportedLocale | null {
  if (!language) return null
  const normalized = language.trim().replaceAll('_', '-').toLowerCase()
  if (normalized === 'zh' || normalized.startsWith('zh-')) return 'zh-CN'
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en-US'
  return null
}

// @@@host-system-languages — 「宿主语言」的取值来源优先级。Electron renderer 的 navigator.languages
// **首项是 Chromium 的界面语言**,不是宿主系统语言:在系统语言为 zh-Hans-CN 的 macOS 上实测得到
// ['en-US', 'zh-Hans-CN'],于是 resolveSystemLocale 取到第一个可匹配项 en-US,把中文系统解析成英文。
// 所以桌面宿主注入的真实语言列表(app.getPreferredSystemLanguages())优先,navigator 只留给 web/移动端
// WebView —— 那里 navigator.languages 本身就是系统语言。
export function preferHostLanguages(
  hostLanguages: readonly unknown[] | null | undefined,
  navigatorLanguages: readonly string[],
): readonly string[] {
  const host = (hostLanguages ?? []).filter(
    (language): language is string => typeof language === 'string' && language.trim().length > 0,
  )
  return host.length > 0 ? host : navigatorLanguages
}

export function resolveSystemLocale(languages: readonly string[]): SupportedLocale {
  for (const language of languages) {
    const matched = matchSupportedLocale(language)
    if (matched) return matched
  }
  return FALLBACK_LOCALE
}

export function resolveLocale(
  preference: LocalePreference,
  languages: readonly string[],
): SupportedLocale {
  return preference === 'system' ? resolveSystemLocale(languages) : preference
}

export function readLocalePreference(storage: Pick<Storage, 'getItem'>): LocalePreference {
  const stored = storage.getItem(LOCALE_STORAGE_KEY)
  return isLocalePreference(stored) ? stored : 'system'
}
