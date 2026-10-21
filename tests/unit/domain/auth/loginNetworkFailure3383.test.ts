import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  signInWithOtp: vi.fn(),
  verifyOtp: vi.fn(),
}))

vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  supabase: { auth: mocks },
  identityDb: {},
  syncSchemaClientSession: vi.fn(async () => undefined),
}))

vi.mock('../../../../apps/desktop/src/lib/referral', () => ({
  clearPendingReferrer: vi.fn(),
  consumePendingReferrer: vi.fn(() => null),
}))

import { authService } from '../../../../apps/desktop/src/lib/auth'

describe('OTP login network failure (#3383)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('turns a thrown request failure into a visible network result', async () => {
    const failure = new TypeError('Failed to fetch')
    mocks.signInWithOtp.mockRejectedValue(failure)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(authService.requestLoginOtp('owner@example.test')).resolves.toEqual({
      success: false,
      error: '网络连接失败，请检查网络后重试。',
    })
    expect(consoleError).toHaveBeenCalledWith('[auth/otp] request login OTP failed', {
      error: failure.message,
    })
  })

  it('keeps a thrown verification failure distinct from an invalid code', async () => {
    const failure = new TypeError('Failed to fetch')
    mocks.verifyOtp.mockRejectedValue(failure)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(authService.verifyLoginOtp('owner@example.test', '123456')).resolves.toEqual({
      success: false,
      error: '网络连接失败，请检查网络后重试。',
    })
    expect(consoleError).toHaveBeenCalledWith('[auth/otp] verify login OTP failed', {
      error: failure.message,
    })
  })
})
