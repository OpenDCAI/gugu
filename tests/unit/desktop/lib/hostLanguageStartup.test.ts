// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('@renderer/lib/ipc', () => ({ rpc: { extensions: {} } }))
vi.mock('@renderer/utils/logger', () => ({ log: { warn: vi.fn(), error: vi.fn() } }))

// The locale module must not publish Chromium's language while the actual host
// seed is pending; languagechange must still refresh that same host source.
afterEach(() => {
  delete window.guguHostLocale
  vi.restoreAllMocks()
  localStorage.clear()
})

it('awaits the real host seed before the first locale and refreshes it on languagechange', async () => {
  vi.resetModules()
  localStorage.clear()
  document.documentElement.lang = 'en-US'
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en-US', 'zh-Hans-CN'])
  let answer!: (languages: readonly string[]) => void
  const seed = new Promise<readonly string[]>((resolve) => { answer = resolve })
  let seedRead = false
  const refresh = vi.fn(async () => ['en-US'])
  window.guguHostLocale = {
    get systemLanguages() { seedRead = true; return seed },
    readSystemLanguages: refresh,
  }
  const loading = import('../../../../apps/desktop/src/i18n/runtime')
  await vi.waitFor(() => expect(seedRead).toBe(true))
  const runtime = await loading
  expect(() => runtime.getLocaleSnapshot()).toThrow('Host locale is not initialized')
  runtime.registerLocaleNamespace('startup-test', {
    'zh-CN': { ready: '已就绪' },
    'en-US': { ready: 'Ready' },
  })
  // The App catalog is constructed during module evaluation, before a root
  // mounts. It must wait for the same seed instead of publishing guessed names.
  const { InstalledExtensionsStore } = await import('../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store')
  const list = vi.fn(async () => ({ success: true, data: {
    extensions: [{ id: 'calendar', name: '日历', localized: { en: { name: 'Calendar' } }, contributes: { tabs: [{ name: 'main', title: '日历' }] } }],
    invalid: [],
  } }))
  const store = new InstalledExtensionsStore({ list } as unknown as ConstructorParameters<typeof InstalledExtensionsStore>[0])
  const loadingApps = store.load()
  expect(list).not.toHaveBeenCalled()
  expect(store.isLoaded).toBe(false)
  answer(['zh-Hans-CN'])
  await runtime.localeReady
  await loadingApps
  expect(store.isLoaded).toBe(true)
  expect(store.tabTitle('calendar.main')).toBe('日历')
  expect(runtime.getLocaleSnapshot()).toEqual({ preference: 'system', resolvedLocale: 'zh-CN' })
  expect(document.documentElement.lang).toBe('zh-CN')
  expect(runtime.i18n.t('ready', { ns: 'startup-test' })).toBe('已就绪')
  window.dispatchEvent(new Event('languagechange'))
  await vi.waitFor(() => expect(runtime.getLocaleSnapshot().resolvedLocale).toBe('en-US'))
  expect(refresh).toHaveBeenCalledOnce()
})
