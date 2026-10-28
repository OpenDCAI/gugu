import { afterEach, expect, it, vi } from 'vitest'
import { buildReferralShareUrl } from '../../../../apps/desktop/src/lib/referral'

afterEach(() => vi.unstubAllEnvs())
it('does not replace a missing invitation landing page with an installer download', () => {
  vi.stubEnv('VITE_GUGU_WEB_URL', '')
  expect(buildReferralShareUrl(1001)).toBeNull()
})
it('adds the referral number only to the configured web landing page', () => {
  vi.stubEnv('VITE_GUGU_WEB_URL', 'https://invites.example.test/')
  expect(buildReferralShareUrl(1001)).toBe('https://invites.example.test/invite?ref=1001')
  expect(buildReferralShareUrl(null)).toBeNull()
})
