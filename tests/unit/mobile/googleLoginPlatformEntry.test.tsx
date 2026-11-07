// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import type { AppPlatform } from '../../../apps/desktop/src/platform/types'

const selected = vi.hoisted(() => ({ platform: null as AppPlatform | null }))
vi.mock('../../../apps/desktop/src/platform', () => ({ get platform() { return selected.platform } }))
vi.mock('../../../apps/desktop/src/lib/auth', () => ({ authService: {} }))
vi.mock('../../../apps/desktop/src/lib/authCallbacks', () => ({ authCallbacks: {} }))
vi.mock('../../../apps/desktop/src/lib/sessionCoordinator', () => ({ sessionCoordinator: {} }))
vi.mock('../../../apps/desktop/src/lib/supabase', () => ({ mainAuthTemporaryStorage: {}, supabase: { auth: {} } }))
vi.mock('../../../apps/desktop/src/lib/referral', () => ({ clearPendingReferrer: vi.fn() }))
vi.mock('@gugu/core/cloud/config', () => ({ getSupabaseUrl: () => 'https://auth.example.test', getSupabaseAnonKey: () => 'public-test-key' }))
vi.mock('../../../apps/desktop/src/pages/login/AuthBrandMotion', () => ({ AuthBrandMotion: () => null }))
vi.mock('../../../apps/desktop/src/hooks/usePrefersReducedMotion', () => ({ usePrefersReducedMotion: () => true }))
afterEach(() => { vi.unstubAllGlobals() })

it.each(['capacitor', 'electron'] as const)('uses the actual %s platform to decide the Google entry without changing email login', async (kind) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.resetModules()
  selected.platform = kind === 'capacitor'
    ? (await import('../../../apps/desktop/src/platform/capacitor')).capacitorPlatform
    : (await import('../../../apps/desktop/src/platform/electron')).electronPlatform
  const enabled = kind === 'electron'
  const request = vi.fn(async function (this: unknown) {
    expect(this).toBe(globalThis)
    return Response.json({ external: { google: true } })
  })
  vi.stubGlobal('fetch', request)
  const { googleLogin } = await import('../../../apps/desktop/src/lib/googleLogin')
  expect(googleLogin.available).toBe(enabled)
  // Authenticated account management does not enable the anonymous provider entry.
  const accountBrowser = selected.platform.accountOAuthBrowser ?? selected.platform.oauthBrowser
  expect(accountBrowser?.openLinkBrowser).toBeTypeOf('function')
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { LoginPage } = await import('../../../apps/desktop/src/pages/LoginPage')
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => { root.render(<LoginPage />) })
    expect(host.querySelectorAll('.gugu-auth-google')).toHaveLength(enabled ? 1 : 0)
    expect(host.querySelectorAll('.gugu-auth-divider')).toHaveLength(enabled ? 1 : 0)
    expect(host.querySelector('input[type="email"]')).not.toBeNull()
    expect(request).toHaveBeenCalledTimes(enabled ? 1 : 0)
  } finally { await act(async () => { root.unmount() }); host.remove() }
})
