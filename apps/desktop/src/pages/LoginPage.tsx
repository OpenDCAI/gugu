import { useState, useEffect, useLayoutEffect, useSyncExternalStore, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { publicAssetPath } from '@gugu/core/shared/ui/publicAssets'
import { Trans, useTranslation } from 'react-i18next'
import { authService } from '../lib/auth'
import { sessionCoordinator } from '../lib/sessionCoordinator'
import { googleLogin } from '../lib/googleLogin'
import { getSupabaseAnonKey, getSupabaseUrl } from '@gugu/core/cloud/config'
import { readGoogleProviderEnabled } from '../lib/authProviderSettings'
import { Button } from '@/components/ui/Button'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'
import { AuthBrandMotion } from './login/AuthBrandMotion'
import { GoogleMark } from './login/GoogleMark'
import { retainStartupMotion } from '../lib/startup-motion'
import { loginOtpRequestPending, subscribeLoginOtpRequests } from '../lib/loginOtpTransport'
import { useLoginOtpSend } from './login/useLoginOtpSend'
import './login/login.css'

const APP_LOGO_URL = publicAssetPath('/assets/app/gugu-icon-512.png')
type Step = 'email' | 'otp'
function stepMotion(reduceMotion: boolean, enterFrom: number) {
  if (reduceMotion) return { initial: false as const, animate: { opacity: 1, x: 0 }, transition: { duration: 0 } }
  return { initial: { opacity: 0, x: enterFrom }, animate: { opacity: 1, x: 0 },
    transition: { duration: 0.15, ease: 'easeOut' as const } }
}
function PrimaryButton({ disabled, loading, label }: { disabled: boolean; loading: boolean; label: string }) {
  return <Button type="submit" variant="primary" size="xl" disabled={disabled} className="gugu-auth-submit">
    {loading ? <LoadingIndicator size="inline" ariaLabel={label} /> : label}
  </Button>
}

export function LoginPage() {
  const { t } = useTranslation('main')
  const [googleEnabled, setGoogleEnabled] = useState<boolean | null>(null)
  const [step, setStep] = useState<Step>('email')
  const [email, setEmail] = useState('')
  const [otpCode, setOtpCode] = useState('')
  const [error, setError] = useState('')
  const [submitFailed, setSubmitFailed] = useState(false)
  const [loading, setLoading] = useState(false)
  const otpSend = useLoginOtpSend()
  const otpRequestPending = useSyncExternalStore(subscribeLoginOtpRequests, loginOtpRequestPending)
  const verifying = useRef(false)
  const reduceMotion = usePrefersReducedMotion()
  const google = useSyncExternalStore(googleLogin.subscribe, googleLogin.getSnapshot)
  useLayoutEffect(() => googleEnabled === null ? retainStartupMotion() : undefined, [googleEnabled])

  useEffect(() => {
    if (!googleLogin.available) { setGoogleEnabled(false); return }
    const controller = new AbortController()
    void readGoogleProviderEnabled(getSupabaseUrl(), getSupabaseAnonKey(), undefined, controller.signal)
      .then(enabled => { if (!controller.signal.aborted) setGoogleEnabled(enabled) })
    return () => controller.abort()
  }, [])

  const handleRequestOtp = (e: React.FormEvent) => {
    e.preventDefault()
    if (google.busy || loading) return
    const address = email.trim()
    if (!address) { setError(t('auth.emailRequired')); return }
    const input = (e.currentTarget as HTMLFormElement).querySelector<HTMLInputElement>('input[type="email"]')
    if (!input?.checkValidity()) { setError(t('auth.invalidEmail')); return }
    setEmail(address)
    setStep('otp')
    setError('')
    setSubmitFailed(false)
    void otpSend.send(address)
  }

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault()
    if (google.busy || otpSend.phase !== 'sent' || otpCode.length !== 6 || verifying.current) return
    verifying.current = true
    setLoading(true)
    setSubmitFailed(false)
    const attempt = sessionCoordinator.beginInteractiveLogin()
    const result = await authService.verifyLoginOtp(email, otpCode)
    if (result.success && result.session) await sessionCoordinator.acceptInteractiveSession(attempt, result.session)
    verifying.current = false
    setLoading(false)
    if (!result.success) {
      setError(result.error ?? t('auth.verifyFailed'))
      setSubmitFailed(true)
    }
  }

  const handleChangeEmail = () => {
    otpSend.reset()
    setStep('email')
    setOtpCode('')
    setError('')
    setSubmitFailed(false)
  }

  const handleResendOtp = () => {
    if (loading || google.busy || otpSend.phase === 'sending' || otpSend.countdown > 0) return
    setError('')
    setSubmitFailed(false)
    void otpSend.send(email)
  }

  return <main className="gugu-auth-page">
    <section className="gugu-auth-shell" aria-labelledby={googleEnabled === null ? undefined : "gugu-auth-title"} aria-busy={googleEnabled === null}>
      <aside className="gugu-auth-brand" aria-label={t('brand.name')}>
        <AuthBrandMotion />
        <div className="gugu-auth-brand-copy">
          <p className="gugu-auth-brand-line"><Trans i18nKey="auth.headline" ns="main" components={{ break: <br /> }} /></p>
          <p className="gugu-auth-brand-sub">{t('auth.brandSubtitle')}</p>
        </div>
      </aside>
      <div className="gugu-auth-pane">{googleEnabled === null ? <div className="gugu-auth-placeholder" role="status" aria-label={t('auth.loadingMethods')} /> : <div className="gugu-auth-login">
        <header className="gugu-auth-heading">
          <img className="gugu-auth-logo" src={APP_LOGO_URL} alt={t('brand.name')} draggable={false} />
          <h1 id="gugu-auth-title">{t('auth.welcome')}</h1>
          <p>{t('auth.subtitle')}</p>
        </header>
        <AnimatePresence initial={false}>
          {step === 'email' && <motion.form key="email" {...stepMotion(reduceMotion, -10)} onSubmit={handleRequestOtp} className="gugu-auth-form">
            {googleLogin.available && (googleEnabled || (google.busy && google.phase !== 'failed')) && <Button type="button" variant="secondary" size="xl" className="gugu-auth-google"
                disabled={loading || otpRequestPending || google.phase === 'restoring' || google.phase === 'accepting' || (google.busy && google.phase === 'failed')}
                onClick={() => { setError(''); void (google.busy ? googleLogin.cancel() : googleLogin.start()) }}>
                <GoogleMark />{t(google.busy && google.phase !== 'failed' ? 'auth.google.cancel' : 'auth.google.signIn')}
            </Button>}
            {google.busy && google.phase !== 'failed' && <p role="status" className="gugu-auth-status">{t(google.phase === 'authorizing' ? 'auth.google.waiting' : 'auth.google.exchanging')}</p>}
            {google.failure && <p role="alert" className="gugu-auth-error">{t(`auth.google.${google.failure}`)}</p>}
            {google.notice && <p role="alert" className="gugu-auth-error">{t('auth.google.staleCallback')}</p>}
            {googleLogin.available && googleEnabled && <div className="gugu-auth-divider">{t('auth.or')}</div>}
            <label htmlFor="gugu-auth-email" className="gugu-auth-label">{t('auth.emailLabel')}</label>
            <input id="gugu-auth-email" className="gugu-auth-input" type="email" inputMode="email" autoComplete="email"
              value={email} placeholder={t('auth.emailPlaceholder')}
              onChange={(event) => { setEmail(event.target.value); setError(''); setSubmitFailed(false) }} />
            {error && <p role="alert" className="gugu-auth-error">{error}</p>}
            <PrimaryButton disabled={loading || google.busy || !email} loading={loading} label={t(submitFailed ? 'auth.retry' : 'auth.continue')} />
          </motion.form>}
          {step === 'otp' && <motion.form key="otp" {...stepMotion(reduceMotion, 10)} onSubmit={handleVerifyOtp} className="gugu-auth-form">
            <p role="status" aria-live="polite" className="gugu-auth-instructions">
              {t(otpSend.phase === 'sending' ? 'auth.otpSending' : otpSend.phase === 'sent' ? 'auth.otpSent' : 'auth.otpNotSent', { email: otpSend.email })}
            </p>
            <label htmlFor="gugu-auth-otp" className="gugu-auth-label">{t('auth.otpLabel')}</label>
            <input id="gugu-auth-otp" className="gugu-auth-input gugu-auth-otp" type="text" inputMode="numeric" maxLength={6}
              value={otpCode} autoComplete="one-time-code" placeholder={t('auth.otpPlaceholder')}
              onChange={(event) => { setOtpCode(event.target.value.replace(/\D/g, '').slice(0, 6)); setError(''); setSubmitFailed(false) }} />
            {(otpSend.error || error) && <p role="alert" className="gugu-auth-error">{otpSend.error || error}</p>}
            <PrimaryButton disabled={otpSend.phase !== 'sent' || otpCode.length !== 6 || loading || google.busy} loading={loading} label={t(submitFailed ? 'auth.retry' : 'auth.login')} />
            <div className="gugu-auth-actions">
              <Button type="button" variant="ghost" size="md" disabled={loading} onClick={handleChangeEmail}>{t('auth.changeEmail')}</Button>
              <Button type="button" variant="ghost" size="md" disabled={loading || google.busy || otpSend.phase === 'sending' || otpSend.countdown > 0} onClick={handleResendOtp}>
                {otpSend.countdown > 0 ? t('auth.resendCountdown', { seconds: otpSend.countdown }) : t('auth.resend')}
              </Button>
            </div>
          </motion.form>}
        </AnimatePresence>
        <p className="gugu-auth-legal"><Trans i18nKey="auth.legal" ns="main" components={{
          terms: <a href="https://gugu.nextmind.space/zh/terms.html" target="_blank" rel="noreferrer" />,
          privacy: <a href="https://gugu.nextmind.space/zh/privacy.html" target="_blank" rel="noreferrer" />,
        }} /></p>
      </div>}</div>
    </section>
    <div className="gugu-auth-window-drag" aria-hidden="true" />
  </main>
}
