import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { ReferralCard } from '@/components/usage/ReferralCard'
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { i18n } from '@/i18n'
import '@/i18n/registerSettingsCatalog'
import '@/components/usage/usage.css'
import '@/styles/tokens.css'

const rig = vi.hoisted(() => ({ identities: vi.fn(), stats: vi.fn() }))
vi.mock('@/lib/identityReadAdapter', async original => ({ ...(await original<object>()), readDisplayIdentities: rig.identities }))
vi.mock('@/lib/billing', async (original) => ({ ...(await original<object>()), getReferralStats: rig.stats }))
let h: ReturnType<typeof createReactHarness>
beforeEach(() => { h = createReactHarness(); vi.stubEnv('VITE_GUGU_WEB_URL', 'https://invites.example.test'); rig.identities.mockReset(); rig.stats.mockReset() })
afterEach(() => { h.cleanup(); vi.unstubAllEnvs() })

for (const mobile of [false, true]) for (const theme of ['light', 'dark']) {
  it(`keeps invitation layout stable through loading, failure and retry (${mobile ? 'phone' : 'desktop'}, ${theme})`, async () => {
    await page.viewport(mobile ? 390 : 1100, mobile ? 844 : 800)
    await i18n.changeLanguage(theme === 'light' ? 'zh-CN' : 'en-US')
    document.documentElement.dataset.theme = theme
    h.container.style.cssText = 'padding:24px;max-width:720px;margin:auto'
    const identity = Promise.withResolvers<{ id: string; gugu_number: number }[]>()
    const stats = Promise.withResolvers<{ invitedCount: number; creditsEarned: number }>()
    rig.identities.mockReturnValueOnce(identity.promise).mockResolvedValue([{ id: 'u1', gugu_number: 1001 }])
    rig.stats.mockReturnValueOnce(stats.promise).mockResolvedValue({ invitedCount: 2, creditsEarned: 10 })
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
