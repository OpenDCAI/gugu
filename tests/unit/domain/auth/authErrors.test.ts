import { describe, expect, it } from 'vitest'
import { userVisibleAuthError } from '../../../../apps/desktop/src/lib/authErrors'

describe('userVisibleAuthError', () => {
  it('maps GoTrue invalid or expired OTP token errors to Chinese', () => {
    expect(userVisibleAuthError({ message: 'Token has expired or is invalid' })).toBe(
      '验证码已过期或无效，请重新获取验证码'
    )
    expect(userVisibleAuthError({ code: 'otp_expired', message: 'anything from GoTrue' })).toBe(
      '验证码已过期或无效，请重新获取验证码'
    )
  })

  it('keeps unknown authentication causes while redacting secrets', () => {
    expect(
      userVisibleAuthError({ message: 'Unexpected auth backend failure' })
    ).toBe('Unexpected auth backend failure')
  })

  it('keeps common request errors readable', () => {
    expect(userVisibleAuthError({ message: 'Email rate limit exceeded' })).toBe(
      '操作过于频繁，请稍后再试'
    )
    expect(userVisibleAuthError({ message: 'Invalid email address' })).toBe('邮箱地址格式不正确')
  })

  it('distinguishes an unreachable network from OTP validation failures', () => {
    expect(userVisibleAuthError(new TypeError('Failed to fetch'))).toBe(
      '网络连接失败，请检查网络后重试。'
    )
    expect(userVisibleAuthError({ message: 'connect ECONNREFUSED 127.0.0.1:9' })).toBe(
      '网络连接失败，请检查网络后重试。'
    )
  })
})


describe('OTP send errors use the existing auth outlet', () => {
  it.each([
    [{ status: 429, message: 'For security purposes, you can only request this after 30 seconds.' }, '操作过于频繁，请稍后再试'],
    [{ status: 503, name: 'AuthRetryableFetchError', message: 'unavailable' }, '验证码服务暂时不可用，请稍后重试'],
    [{ name: 'TimeoutError', message: 'Auth request timed out' }, '发送验证码超时，请重试'],
    [{ code: 'email_address_invalid', message: 'bad address' }, '邮箱地址格式不正确'],
  ])('classifies %j before generic fetch errors', (error, copy) => {
    expect(userVisibleAuthError(error, 'sendOtp')).toBe(copy)
  })
})
