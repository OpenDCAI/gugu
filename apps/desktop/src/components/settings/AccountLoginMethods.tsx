import { useEffect, useRef, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import { useTranslation } from 'react-i18next'
import { AccountLinking, AccountLinkingError, loginMethodNotice, loginMethods } from '../../lib/accountLinking'
import { accountGoogleAvailable, cancelAccountGoogle, createAccountLinking } from '../../lib/accountLinkingAdapter'
import { userVisibleAuthError } from '../../lib/authErrors'
import { Button } from '../ui/Button'
import { SettingsGroup, SettingsNote, SettingsRow } from './SettingsPrimitives'

type Action = 'email' | 'link' | 'unlink'
type Stage = 'idle' | 'verify' | 'email' | 'email-code' | 'unlink' | 'signout'

export function AccountLoginMethods({ userId, onEmailChanged }: { userId: string; onEmailChanged(email: string): void }) {
  const { t } = useTranslation('settings')
  const service = useRef<AccountLinking | null>(null)
  const [user, setUser] = useState<User | null>(null)
  const [stage, setStage] = useState<Stage>('idle')
  const [action, setAction] = useState<Action>('email')
  const [method, setMethod] = useState<'email' | 'google'>('email')
  const [code, setCode] = useState('')
  const [email, setEmail] = useState('')
  const [confirmation, setConfirmation] = useState<'new' | 'current'>('new')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [googlePending, setGooglePending] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => {
    const controller = createAccountLinking(userId)
    service.current = controller
    setStage(controller.hasPendingUnlink() ? 'signout' : 'idle')
    let alive = true
    void controller.read().then(value => {
      if (!alive) return
      setUser(value)
      const available = loginMethods(value)
      setMethod(available.google && (!available.emailIdentity || value.app_metadata.provider === 'google') ? 'google' : 'email')
    }).catch((reason: unknown) => { if (alive) setError(reason instanceof AccountLinkingError ? t(`loginMethods.errors.${reason.code}`) : userVisibleAuthError(reason)) })
    return () => { alive = false; controller.dispose(); service.current = null; void cancelAccountGoogle() }
  }, [userId, t])

  async function run(work: (controller: AccountLinking) => Promise<void>) {
    const controller = service.current
    if (!controller || busy) return
    setBusy(true); setError(''); setMessage('')
    try { await work(controller) }
    catch (reason) {
      setError(reason instanceof AccountLinkingError ? t(`loginMethods.errors.${reason.code}`) : userVisibleAuthError(reason))
      if (reason instanceof AccountLinkingError && reason.code === 'verifyRequired') { setStage('verify'); setSent(false); setCode('') }
      // A successful server mutation followed by a failed notice/sign-out must remain visible.
      try { setUser(await controller.read()) } catch { /* Preserve the operation's actionable error. */ }
    } finally { setBusy(false) }
  }
  async function refreshed(controller: AccountLinking, noticeSaved = true) {
    const latest = await controller.read()
    setUser(latest); onEmailChanged(latest.email ?? '')
    setStage('idle'); setCode('')
    setMessage(t(noticeSaved ? 'loginMethods.saved' : 'loginMethods.noticeFailed'))
  }
  function begin(next: Action) { setAction(next); setStage('verify'); setSent(false); setCode(''); setError(''); setMessage('') }
  async function verified(controller: AccountLinking) {
    setCode('')
    if (action === 'link') {
      setGooglePending(true)
      try { await refreshed(controller, await controller.linkGoogle()) } finally { setGooglePending(false) }
    }
    else setStage(action === 'email' ? 'email' : 'unlink')
  }
  const methods = user ? loginMethods(user) : null
  const verificationMethod = methods?.google && (method === 'google' || !methods.emailIdentity) ? 'google' : 'email'
  const sameEmail = methods && methods.googleEmail && methods.email.toLowerCase() === methods.googleEmail.toLowerCase()
  const cannotUnlink = !methods?.emailIdentity || !methods.email || !methods.googleEmail || Boolean(sameEmail)
  const notice = user ? loginMethodNotice(user) : null
  const button = (label: string, onClick: () => void, disabled = false) => <Button type="button" variant="ghost" size="sm" disabled={busy || disabled} onClick={onClick}>{label}</Button>

  return <SettingsGroup className="gg-account-login-methods" title={t('loginMethods.title')} note={t('loginMethods.intro')}
    footer={<>
      {error && <SettingsNote role="alert" tone="danger">{error}</SettingsNote>}
      {message && <SettingsNote role="status">{message}</SettingsNote>}
      {notice && <SettingsNote>{t(`loginMethods.notices.${notice.kind}`)}</SettingsNote>}
      {busy && <SettingsNote role="status">{t('loginMethods.working')}</SettingsNote>}
    </>}>
    {!methods ? <SettingsRow title={t('loginMethods.loading')} control={error ? button(t('loginMethods.retry'), () => { void run(refreshed) }) : undefined} /> : <>
      <SettingsRow title={t('loginMethods.email')} description={methods.email} control={button(t('loginMethods.changeEmail'), () => begin('email'), stage !== 'idle')} />
      <SettingsRow title="Google" description={methods.google ? methods.googleEmail || t('loginMethods.errors.googleEmailUnavailable') : t('loginMethods.unlinked')}
        control={methods.google ? button(t('loginMethods.unlinkGoogle'), () => begin('unlink'), cannotUnlink || stage !== 'idle')
          : accountGoogleAvailable() ? button(t('loginMethods.linkGoogle'), () => begin('link'), stage !== 'idle') : undefined} />
      {methods.google && sameEmail && <SettingsRow description={t('loginMethods.sameEmailNote')} />}
      {stage === 'verify' && <SettingsRow layout="field" title={t('loginMethods.verifyTitle')} description={t('loginMethods.verifyNote')} control={<div className="flex w-full flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          {methods.emailIdentity && button(t('loginMethods.byEmail'), () => { setMethod('email'); setSent(false); setCode('') }, verificationMethod === 'email')}
          {methods.google && accountGoogleAvailable() && button(t('loginMethods.byGoogle'), () => { setMethod('google'); setCode('') }, verificationMethod === 'google')}
        </div>
        {verificationMethod === 'email' ? <>
          {button(t(sent ? 'loginMethods.resend' : 'loginMethods.sendCode'), () => { void run(async controller => { await controller.requestVerification(); setSent(true) }) })}
          {sent && <>
            <label htmlFor="account-verify-code">{t('loginMethods.code')}</label>
            <input id="account-verify-code" className="gg-settings-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={event => setCode(event.target.value.replace(/\D/g, ''))} />
            {button(t('loginMethods.verify'), () => { void run(async controller => { await controller.verifyEmail(code); await verified(controller) }) }, code.length !== 6)}
          </>}
        </> : button(t('loginMethods.byGoogle'), () => { void run(async controller => {
          setGooglePending(true)
          try { await controller.verifyGoogle(); await verified(controller) } finally { setGooglePending(false) }
        }) })}
      </div>} />}
      {stage === 'email' && <SettingsRow layout="field" title={<label htmlFor="account-new-email">{t('loginMethods.newEmail')}</label>} control={<div className="flex w-full flex-col gap-2">
        <input id="account-new-email" type="email" autoComplete="email" className="gg-settings-input" value={email} onChange={event => setEmail(event.target.value)} />
        {button(t('loginMethods.sendCode'), () => { void run(async controller => {
          const result = await controller.changeEmail(email)
          setEmail(result.email)
          if (result.complete) await refreshed(controller, result.noticeSaved)
          else { setStage('email-code'); setCode(''); setConfirmation('new') }
        }) }, !email.trim())}
      </div>} />}
      {stage === 'email-code' && <SettingsRow layout="field" title={<label htmlFor="account-email-code">{t('loginMethods.code')}</label>} description={t('loginMethods.confirmEmailNote', { email })} control={<div className="flex w-full flex-col gap-2">
        <label htmlFor="account-code-source">{t('loginMethods.codeSource')}</label>
        <select id="account-code-source" className="gg-settings-select" value={confirmation} onChange={event => { setConfirmation(event.target.value as 'new' | 'current'); setCode('') }}>
          <option value="new">{t('loginMethods.newEmailSource', { email })}</option>
          <option value="current">{t('loginMethods.currentEmailSource', { email: methods.email })}</option>
        </select>
        <input id="account-email-code" className="gg-settings-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={event => setCode(event.target.value.replace(/\D/g, ''))} />
        {button(t('loginMethods.confirmEmail'), () => { void run(async controller => {
          const result = await controller.confirmEmail(email, code, confirmation === 'new' ? email : methods.email)
          if (result.complete) await refreshed(controller, result.noticeSaved)
          else { setCode(''); setConfirmation(confirmation === 'new' ? 'current' : 'new'); setMessage(t('loginMethods.secondCode')) }
        }) }, code.length !== 6)}
      </div>} />}
      {stage === 'unlink' && <SettingsRow title={t('loginMethods.unlinkGoogle')} description={t('loginMethods.unlinkNote')}
        control={button(t('loginMethods.confirmUnlink'), () => { void run(async controller => {
          try { await controller.unlinkGoogle() }
          catch (reason) {
            setStage(controller.hasPendingUnlink() ? 'signout' : 'unlink')
            throw reason
          }
        }) })} />}
      {stage !== 'idle' && stage !== 'signout' && <SettingsRow control={button(t('loginMethods.cancel'), () => { setStage('idle'); setCode(''); setError('') })} />}
      {googlePending && <Button type="button" variant="ghost" size="sm" onClick={() => { void cancelAccountGoogle() }}>{t('loginMethods.cancelGoogle')}</Button>}
    </>}
    {stage === 'signout' && <SettingsRow description={t('loginMethods.unlinkNote')} control={button(t('loginMethods.retrySignOut'), () => { void run(controller => controller.finishUnlink()) })} />}
  </SettingsGroup>
}
