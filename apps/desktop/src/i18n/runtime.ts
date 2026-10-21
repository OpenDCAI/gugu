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

// 桌面宿主经 preload 同步注入真实系统语言;web/移动端没有该注入,退回 navigator。
// `refresh` 用于宿主语言可能已经变了的时机(languagechange):首帧那份是 preload 时刻的快照,
// 不重新问宿主的话「跟随系统」在桌面上就只能靠重启才更新。
function hostLanguages(refresh = false): readonly string[] {
  const bridge = typeof window === 'undefined' ? null : window.guguHostLocale
  const injected = refresh && bridge?.readSystemLanguages
    ? bridge.readSystemLanguages()
    : bridge?.systemLanguages
  return preferHostLanguages(injected, navigatorLanguages())
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
let snapshot: LocaleSnapshot = {
  preference,
  resolvedLocale: resolveLocale(preference, hostLanguages()),
}

const resources: Resource = {
  'zh-CN': { common: zhCNCommon },
  'en-US': { common: enUSCommon },
}

export const i18n = createInstance()

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

const listeners = new Set<() => void>()

function applySnapshot(next: LocaleSnapshot, broadcast: boolean): void {
  if (
    snapshot.preference === next.preference
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

if (typeof document !== 'undefined') document.documentElement.lang = snapshot.resolvedLocale

if (typeof window !== 'undefined') {
  window.addEventListener('languagechange', () => {
    if (snapshot.preference !== 'system') return
    applySnapshot({
      preference: 'system',
      resolvedLocale: resolveLocale('system', hostLanguages(true)),
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
  for (const locale of ['zh-CN', 'en-US'] as const) {
    i18n.addResourceBundle(locale, namespace, catalog[locale], true, true)
  }
}
