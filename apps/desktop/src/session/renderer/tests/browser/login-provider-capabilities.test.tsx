import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { i18n } from '@/i18n'
import '@/i18n/registerMainCatalog'
import '@/styles/tokens.css'

vi.mock('@/lib/auth', () => ({ authService: {} }))
vi.mock('@/lib/sessionCoordinator', () => ({ sessionCoordinator: {} }))
vi.mock('@gugu/core/cloud/config', () => ({ getSupabaseUrl: () => 'https://auth.fixture.invalid', getSupabaseAnonKey: () => 'public-fixture-key' }))
vi.mock('@/lib/googleLogin', () => ({ googleLogin: {
  available: true, subscribe: () => () => {}, getSnapshot: () => idle,
} }))
const idle = { phase: 'idle', busy: false }
const { LoginPage } = await import('@/pages/LoginPage')
let host: HTMLDivElement, root: Root
const rect = (node: Element) => {
  const value = node.getBoundingClientRect()
  return { x: value.x, y: value.y, width: value.width, height: value.height }
}

beforeAll(async () => { await i18n.changeLanguage('zh-CN') })
afterEach(() => { root?.unmount(); host?.remove(); vi.unstubAllGlobals(); document.documentElement.removeAttribute('data-theme') })

for (const mode of ['on', 'off', 'timeout', 'error'] as const) for (const theme of (mode === 'on' || mode === 'off' ? ['light', 'dark'] : ['light'])) {
  it(`keeps the App login card stable for backend ${mode}, ${theme}`, async () => {
    await page.viewport(theme === 'light' ? 1080 : 412, theme === 'light' ? 760 : 800)
    document.documentElement.setAttribute('data-theme', theme)
    let release!: (response: Response) => void
    const response = new Promise<Response>(resolve => { release = resolve })
    vi.stubGlobal('fetch', function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      expect(this).toBe(globalThis)
      expect(input).toBe('https://auth.fixture.invalid/auth/v1/settings')
      expect(new Headers(init?.headers).get('apikey')).toBe('public-fixture-key')
      return response
    })
    host = document.createElement('div'); document.body.append(host)
    root = createRoot(host); root.render(<LoginPage />)
    await until('neutral capability card is present', () => host.querySelector('.gugu-auth-placeholder') !== null)
    const card = host.querySelector('.gugu-auth-shell')!
    const before = rect(card)
    expect(host.querySelectorAll('button, .gugu-auth-divider')).toHaveLength(0)
    if (mode !== 'timeout') release(Response.json({ external: { google: mode === 'on' } }, { status: mode === 'error' ? 503 : 200 }))
    await until('the final email form appears', () => host.querySelector('input[type=email]') !== null)
    expect(rect(card)).toEqual(before)
    expect(host.querySelectorAll('.gugu-auth-google')).toHaveLength(mode === 'on' ? 1 : 0)
    expect(host.querySelectorAll('.gugu-auth-divider')).toHaveLength(mode === 'on' ? 1 : 0)
    release(Response.json({ external: { google: true } }))
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    expect(host.querySelectorAll('.gugu-auth-google')).toHaveLength(mode === 'on' ? 1 : 0)
    if (mode === 'on' || mode === 'off') await page.screenshot({ element: host, path: `__screenshots__/google-provider-${mode}-${theme}.png` })
  }, 15_000)
}
