import { useState, useEffect, useSyncExternalStore } from 'react'
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
import './login/login.css'

const APP_LOGO_URL = publicAssetPath('/assets/app/gugu-icon-512.png')
type Step = 'email' | 'otp'
function stepMotion(reduceMotion: boolean, enterFrom: number) {
  if (reduceMotion) return { initial: false as const, animate: { opacity: 1, x: 0 }, transition: { duration: 0 } }
  return { initial: { opacity: 0, x: enterFrom }, animate: { opacity: 1, x: 0 }, exit: { opacity: 0, x: -enterFrom },
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
  const [resendCountdown, setResendCountdown] = useState(0)
  const reduceMotion = usePrefersReducedMotion()
  const google = useSyncExternalStore(googleLogin.subscribe, googleLogin.getSnapshot)

  useEffect(() => {
    if (!googleLogin.available) { setGoogleEnabled(false); return }
    const controller = new AbortController()
    void readGoogleProviderEnabled(getSupabaseUrl(), getSupabaseAnonKey(), undefined, controller.signal)
      .then(enabled => { if (!controller.signal.aborted) setGoogleEnabled(enabled) })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (resendCountdown <= 0) return
    const timer = setTimeout(() => setResendCountdown((v) => v - 1), 1000)
    return () => clearTimeout(timer)
  }, [resendCountdown])

  const handleRequestOtp = async (e: React.FormEvent) => {
    e.preventDefault()
    if (google.busy) return
    if (!email) { setError(t('auth.emailRequired')); return }
    setLoading(true)
    setSubmitFailed(false)
    const result = await authService.requestLoginOtp(email).finally(() => setLoading(false))
    if (!result.success) {
      setError(result.error ?? t('auth.sendFailed'))
      setSubmitFailed(true)
    } else {
      setStep('otp')
      setError('')
      setResendCountdown(60)
    }
  }

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault()
    if (google.busy) return
    setLoading(true)
    setSubmitFailed(false)
    const attempt = sessionCoordinator.beginInteractiveLogin()
    const result = await authService.verifyLoginOtp(email, otpCode)
    if (result.success && result.session) await sessionCoordinator.acceptInteractiveSession(attempt, result.session)
    setLoading(false)
    if (!result.success) {
      setError(result.error ?? t('auth.verifyFailed'))
      setSubmitFailed(true)
    }
  }

  const handleChangeEmail = () => {
    setStep('email')
    setOtpCode('')
    setError('')
    setSubmitFailed(false)
  }

  const handleResendOtp = async () => {
    if (loading || resendCountdown > 0) return
    setLoading(true)
    const result = await authService.requestLoginOtp(email).finally(() => setLoading(false))
    if (!result.success) {
      setError(result.error ?? t('auth.sendFailed'))
      return
    }
    setError('')
    setResendCountdown(60)
  }

  return <main className="gugu-auth-page">
    <section className="gugu-auth-shell" aria-labelledby={googleEnabled === null ? undefined : "gugu-auth-title"} aria-busy={googleEnabled === null}>
      <aside className="gugu-auth-brand" aria-label={t('brand.name')}>
        <AuthBrandMotion />
        <div>
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
        <AnimatePresence mode="wait" initial={false}>
          {step === 'email' && <motion.form key="email" {...stepMotion(reduceMotion, -10)} onSubmit={handleRequestOtp} className="gugu-auth-form">
            {googleLogin.available && googleEnabled && <Button type="button" variant="secondary" size="xl" className="gugu-auth-google"
                disabled={loading || google.phase === 'restoring' || google.phase === 'accepting' || (google.busy && google.phase === 'failed')}
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
            <p className="gugu-auth-instructions">{t('auth.otpSent', { email })}</p>
            <label htmlFor="gugu-auth-otp" className="gugu-auth-label">{t('auth.otpLabel')}</label>
            <input id="gugu-auth-otp" className="gugu-auth-input gugu-auth-otp" type="text" inputMode="numeric" maxLength={6}
              value={otpCode} autoComplete="one-time-code" placeholder={t('auth.otpPlaceholder')}
              onChange={(event) => { setOtpCode(event.target.value.replace(/\D/g, '').slice(0, 6)); setError(''); setSubmitFailed(false) }} />
            {error && <p role="alert" className="gugu-auth-error">{error}</p>}
            <PrimaryButton disabled={otpCode.length !== 6 || loading || google.busy} loading={loading} label={t(submitFailed ? 'auth.retry' : 'auth.login')} />
            <div className="gugu-auth-actions">
              <Button type="button" variant="ghost" size="md" disabled={loading} onClick={handleChangeEmail}>{t('auth.changeEmail')}</Button>
              <Button type="button" variant="ghost" size="md" disabled={loading || resendCountdown > 0} onClick={handleResendOtp}>
                {resendCountdown > 0 ? t('auth.resendCountdown', { seconds: resendCountdown }) : t('auth.resend')}
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
  </main>
}
