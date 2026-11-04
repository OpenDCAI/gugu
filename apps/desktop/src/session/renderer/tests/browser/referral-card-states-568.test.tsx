import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { createClient } from '@supabase/supabase-js'
import { ReferralCard } from '@/components/usage/ReferralCard'
import { createCreditV2Reader } from '@/lib/billing/v2/readers'
import { createActiveCreditV2Reader } from '@/lib/billing/v2/active'
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import liveAccount from '../../../../../../../tests/fixtures/billing/credit-v2-account.json'
import { i18n } from '@/i18n'
import '@/i18n/registerSettingsCatalog'
import '@/components/usage/usage.css'
import '@/styles/tokens.css'

const rig = vi.hoisted(() => ({ identities: vi.fn(), stats: vi.fn(), account: vi.fn() }))
vi.mock('@/lib/identityReadAdapter', async original => ({ ...(await original<object>()), readDisplayIdentities: rig.identities }))
vi.mock('@/lib/billing', async (original) => ({ ...(await original<object>()), getReferralStats: rig.stats }))
vi.mock('@/lib/billing/v2/runtime', async original => ({ ...(await original<object>()), readCreditV2Account: rig.account }))
// Keep the real v2 parser, activation gate and shared store. Only HTTP is replaced
// with captured response bodies, so account confirmation cannot fail on an unrelated
// network read or consume the identity/stats promises this layout suite controls.
const client = createClient('http://credit-fixture.test', 'fixture-key', {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const headers = new Headers(init?.headers)
    if (headers.get('x-gugu-credit-unit-version') !== '2' || headers.get('Content-Profile') !== 'billing') throw Error('Expected the v2 billing request')
    const rows = url.pathname === '/rest/v1/rpc/current_membership_v2' ? liveAccount.membership
      : url.pathname === '/rest/v1/rpc/current_quota_windows_v2' ? liveAccount.quota : null
    if (rows === null) throw Error(`Unexpected account fixture request: ${url.pathname}`)
    return new Response(JSON.stringify(rows), { status: 200, headers: { 'Content-Type': 'application/json' } })
  } },
})
const account = createActiveCreditV2Reader(createCreditV2Reader(client, async () => 'u1'), async () => 'u1')
let h: ReturnType<typeof createReactHarness>
beforeEach(() => { h = createReactHarness(); vi.stubEnv('VITE_GUGU_WEB_URL', 'https://invites.example.test'); rig.identities.mockReset(); rig.stats.mockReset(); rig.account.mockReset().mockImplementation(() => account.account()) })
afterEach(() => { h.cleanup(); vi.unstubAllEnvs() })

for (const mobile of [false, true]) for (const theme of ['light', 'dark']) {
  it(`keeps invitation layout stable through loading, failure and retry (${mobile ? 'phone' : 'desktop'}, ${theme})`, async () => {
    await page.viewport(mobile ? 390 : 1100, mobile ? 844 : 800)
    await i18n.changeLanguage(theme === 'light' ? 'zh-CN' : 'en-US')
    document.documentElement.dataset.theme = theme
    h.container.style.cssText = 'padding:24px;max-width:720px;margin:auto'
    const identity = Promise.withResolvers<{ id: string; gugu_number: number }[]>()
    const stats = Promise.withResolvers<{ invitedCount: number; creditsEarned: number }>()
    // Confirmation invalidates the first read generation. Every loading read must
    // remain pending until this case releases it, rather than succeeding by queue fallthrough.
    rig.identities.mockReturnValue(identity.promise)
    rig.stats.mockReturnValue(stats.promise)
    await renderWithAppProviders(h, <ReferralCard />, { auth: { id: 'u1', gugu_number: null } })
    const rect = (selector: string) => {
      const box = h.container.querySelector(selector)!.getBoundingClientRect()
      return [box.x, box.y, box.width, box.height]
    }
    const card = rect('[data-testid="membership-referral"]')
    const field = rect('.na-referral-field-skeleton')
    const copy = rect('.na-referral-copy-skeleton')
    expect(h.container.querySelector('button')).toBeNull()
    await act(async () => {
      identity.reject(Error('identity unavailable'))
      stats.reject(Error('stats unavailable'))
    })
    await until('one read error with a retry', () => h.container.querySelectorAll('[role="alert"]').length === 1)
    expect(h.container.querySelectorAll('button')).toHaveLength(1)
    expect(rect('[data-testid="membership-referral"]')).toEqual(card)
    const region = h.container.querySelector('.na-referral')!.getBoundingClientRect()
    const errorText = h.container.querySelector('[role="alert"] > span')!.getBoundingClientRect()
    expect(Math.abs(errorText.y + errorText.height / 2 - (region.y + region.height / 2))).toBeLessThanOrEqual(1)
    rig.identities.mockResolvedValue([{ id: 'u1', gugu_number: 1001 }])
    rig.stats.mockResolvedValue({ invitedCount: 2, creditsEarned: 10 })
    await page.getByRole('button', { name: theme === 'light' ? '重试' : 'Retry', exact: true }).click()
    await until('invitation URL loads', () => !!h.container.querySelector('input'))
    expect(h.container.querySelector('[role="alert"]')).toBeNull()
    expect(rect('[data-testid="membership-referral"]')).toEqual(card)
    expect(rect('input')).toEqual(field)
    if (mobile) expect(rect('.na-referral-link button')[2]).toBe(h.container.querySelector('.na-referral-link')!.getBoundingClientRect().width)
    expect(rect('.na-referral-link button')).toEqual(copy)
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth)
  })
}
