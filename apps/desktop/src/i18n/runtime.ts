import { createInstance, type Resource, type ResourceKey } from 'i18next'
import { initReactI18next } from 'react-i18next'
import enUSCommon from './locales/en-US/common'
import zhCNCommon from './locales/zh-CN/common'
import {
  FALLBACK_LOCALE,
  LOCALE_CHANGED_EVENT,
  LOCALE_STORAGE_KEY,
  isLocalePreference,
  isSupportedLocale,
  preferHostLanguages,
  readLocalePreference,
  resolveLocale,
  type LocalePreference,
  type LocaleSnapshot,
  type SupportedLocale,
} from './locale'

type LocaleCatalog = Record<SupportedLocale, ResourceKey>
type LocaleChangeDetail = LocaleSnapshot

function navigatorLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return []
  return navigator.languages?.length ? navigator.languages : [navigator.language]
}

// Keep the existing host-language seed, awaiting its IPC before the first locale.
// Web/mobile have no bridge and use their navigator languages as before.
let systemLanguages: readonly string[] | undefined

function hostLanguages(): readonly string[] {
  return preferHostLanguages(systemLanguages, navigatorLanguages())
}

function initialPreference(): LocalePreference {
  if (typeof window === 'undefined') return 'system'
  try {
    return readLocalePreference(window.localStorage)
  } catch (error) {
    console.error('[localization] failed to read locale preference', error)
    return 'system'
  }
}

const preference = initialPreference()
let snapshot: LocaleSnapshot | undefined

const resources: Resource = {
  'zh-CN': { common: zhCNCommon },
  'en-US': { common: enUSCommon },
}

export const i18n = createInstance()

const listeners = new Set<() => void>()

function initializeLocale(languages?: readonly string[]): void {
  systemLanguages = languages
  snapshot = { preference, resolvedLocale: resolveLocale(preference, hostLanguages()) }
  void i18n.use(initReactI18next).init({
    resources,
    lng: snapshot.resolvedLocale,
    fallbackLng: FALLBACK_LOCALE,
    supportedLngs: ['zh-CN', 'en-US'],
    defaultNS: 'common',
    ns: ['common'],
    interpolation: { escapeValue: false },
    returnNull: false,
    initAsync: false,
    react: { useSuspense: false },
  })
  if (typeof document !== 'undefined') document.documentElement.lang = snapshot.resolvedLocale
}

// Both renderer entry points await this existing preload seed before mounting.
const bridge = typeof window === 'undefined' ? undefined : window.guguHostLocale
export const localeReady: Promise<void> = bridge
  ? bridge.systemLanguages.then(initializeLocale)
  : Promise.resolve(initializeLocale())

function applySnapshot(next: LocaleSnapshot, broadcast: boolean): void {
  if (
    snapshot?.preference === next.preference
    && snapshot.resolvedLocale === next.resolvedLocale
  ) return

  snapshot = next
  void i18n.changeLanguage(next.resolvedLocale)
  if (typeof document !== 'undefined') document.documentElement.lang = next.resolvedLocale
  for (const listener of listeners) listener()

  if (broadcast && typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
    window.dispatchEvent(new CustomEvent<LocaleChangeDetail>(LOCALE_CHANGED_EVENT, { detail: next }))
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('languagechange', async () => {
    if (snapshot?.preference !== 'system') return
    if (window.guguHostLocale) systemLanguages = await window.guguHostLocale.readSystemLanguages()
    if (snapshot?.preference !== 'system') return
    applySnapshot({
      preference: 'system',
      resolvedLocale: resolveLocale('system', hostLanguages()),
    }, true)
  })

  window.addEventListener('storage', (event) => {
    if (event.key !== LOCALE_STORAGE_KEY || !isLocalePreference(event.newValue)) return
    applySnapshot({
      preference: event.newValue,
      resolvedLocale: resolveLocale(event.newValue, hostLanguages()),
    }, false)
  })

  window.addEventListener(LOCALE_CHANGED_EVENT, (event) => {
    const detail = (event as CustomEvent<LocaleChangeDetail>).detail
    if (!detail || !isLocalePreference(detail.preference)) return
    // 采用发起方已经解析好的 locale。❌ 别按本地快照重算:languagechange 会向宿主重新问语言,
    // 而这里的重算只看首帧快照 —— 于是自己广播的新语言被自己用旧快照盖回旧值(实测过)。
    applySnapshot({
      preference: detail.preference,
      resolvedLocale: isSupportedLocale(detail.resolvedLocale)
        ? detail.resolvedLocale
        : resolveLocale(detail.preference, hostLanguages()),
    }, false)
  })
}

export function getLocaleSnapshot(): LocaleSnapshot {
  if (!snapshot) throw new Error('Host locale is not initialized')
  return snapshot
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setLocalePreference(next: LocalePreference): void {
  if (!isLocalePreference(next)) throw new Error(`Unsupported locale preference: ${String(next)}`)
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, next)
    } catch (error) {
      console.error('[localization] failed to persist locale preference', error)
    }
  }
  applySnapshot({
    preference: next,
    resolvedLocale: resolveLocale(next, hostLanguages()),
  }, true)
}

export function registerLocaleNamespace(namespace: string, catalog: LocaleCatalog): void {
  if (!snapshot) {
    void localeReady.then(() => registerLocaleNamespace(namespace, catalog))
    return
  }
  for (const locale of ['zh-CN', 'en-US'] as const) {
    i18n.addResourceBundle(locale, namespace, catalog[locale], true, true)
  }
}
