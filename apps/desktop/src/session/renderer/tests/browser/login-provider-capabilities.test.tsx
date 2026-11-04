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
    if (innerWidth >= 720) {
      expect(before).toEqual({ x: 0, y: 0, width: innerWidth, height: innerHeight })
      const brand = rect(host.querySelector('.gugu-auth-brand')!)
      expect(brand.x).toBe(0)
      expect(brand.y).toBe(0)
      expect(brand.height).toBe(innerHeight)
      expect(rect(host.querySelector('.gugu-auth-motion')!)).toEqual(brand)
    }
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

for (const theme of ['light', 'dark']) it(`keeps the real login controls mounted across the single-column breakpoint, ${theme}`, async () => {
  document.documentElement.setAttribute('data-theme', theme)
  vi.stubGlobal('fetch', function (this: unknown) {
    expect(this).toBe(globalThis)
    return Promise.resolve(Response.json({ external: { google: true } }))
  })
  await page.viewport(719, 800)
  host = document.createElement('div'); document.body.append(host)
  root = createRoot(host); root.render(<LoginPage />)
  await until('email is available at the breakpoint', () => host.querySelector('input[type=email]') !== null)
  const email = host.querySelector('input[type=email]')
  for (const width of [719, 720, 719]) {
    await page.viewport(width, 800)
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    expect(host.querySelector('input[type=email]')).toBe(email)
    expect(host.querySelectorAll('.gugu-auth-google, .gugu-auth-divider')).toHaveLength(2)
    expect(getComputedStyle(host.querySelector('.gugu-auth-brand')!).display === 'none').toBe(width < 720)
    const button = rect(host.querySelector('.gugu-auth-google')!)
    expect(button.x).toBeGreaterThanOrEqual(0)
    expect(button.x + button.width).toBeLessThanOrEqual(width)
    expect(document.documentElement.scrollWidth).toBe(width)
  }
})
