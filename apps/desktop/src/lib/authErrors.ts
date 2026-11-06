import { messageForUser } from '@/lib/userFacingError';
type AuthErrorLike = {
  message?: string
  code?: string
  name?: string
  status?: number
}
import { i18n } from '@/i18n'
import { isAuthRetryableFetchError } from '@supabase/supabase-js'

type AuthCopyKey = 'invalidEmail' | 'networkFailed' | 'otpInvalid' | 'rateLimited'

function authCopy(key: AuthCopyKey): string {
  switch (key) {
    case 'invalidEmail': return i18n.t('auth.invalidEmail', { ns: 'main' })
    case 'networkFailed': return i18n.t('auth.networkFailed', { ns: 'main' })
    case 'otpInvalid': return i18n.t('auth.otpInvalid', { ns: 'main' })
    case 'rateLimited': return i18n.t('auth.rateLimited', { ns: 'main' })
  }
}

function authErrorLike(error: unknown): AuthErrorLike {
  if (typeof error === 'string') return { message: error }
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return {}
  return error as AuthErrorLike
}

export function userVisibleAuthError(
  error: unknown,
  operation?: 'sendOtp',
): string {
  const detail = authErrorLike(error)
  const code = detail.code?.trim().toLowerCase() ?? ''
  const message = detail.message?.trim() ?? ''
  const normalized = message.toLowerCase()

  if (operation === 'sendOtp') {
    if (detail.name === 'TimeoutError' || /timed?\s*out|timeout/i.test(message)) return i18n.t('auth.sendTimeout', { ns: 'main' })
    if (detail.status === 429 || code === 'over_email_send_rate_limit' || /rate limit|too many requests|only request this after/i.test(message)) return authCopy('rateLimited')
    if (detail.status && detail.status >= 500) return i18n.t('auth.sendServerFailed', { ns: 'main' })
  }

  if (
    isAuthRetryableFetchError(error) ||
    (detail.name === 'TypeError' && normalized === 'failed to fetch') ||
    /failed to fetch|network request failed|net::err_|econnrefused|econnreset|enotfound|eai_again|timed?\s*out|socket hang up/i.test(message)
  ) {
    return authCopy('networkFailed')
  }

  if (
    code === 'otp_expired' ||
    /token.*(expired|invalid)/i.test(message) ||
    /(?:expired|invalid).*token/i.test(message)
  ) {
    return authCopy('otpInvalid')
  }

  if (code === 'over_email_send_rate_limit' || /rate limit|too many requests/i.test(message)) {
    return authCopy('rateLimited')
  }

  if ((code === 'validation_failed' && normalized.includes('email')) || code === 'email_address_invalid') {
    return authCopy('invalidEmail')
  }
  if (/invalid email|email address.*invalid/i.test(message)) {
    return authCopy('invalidEmail')
  }

  return messageForUser(error)
}
