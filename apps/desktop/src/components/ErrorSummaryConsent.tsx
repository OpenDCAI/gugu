import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { setErrorSummaryConsent, useErrorSummaryConsent } from '@/lib/errorSummaryConsent'
import { cn } from '@/lib/cn'
import { Dialog } from './ui/Dialog'
import { Sheet } from './ui/Sheet'
import { Button } from './ui/Button'
import { Switch } from './ui/Switch'
import { SettingsGroup, SettingsNote, SettingsRow } from './settings/SettingsPrimitives'

export function ErrorSummaryConsentDialog() {
  const { t, i18n } = useTranslation('settings')
  const state = useErrorSummaryConsent()
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  async function choose(allowed: boolean) {
    setSaving(true)
    setFailed(false)
    try { await setErrorSummaryConsent(allowed ? 'allowed' : 'denied') } catch { setFailed(true) } finally { setSaving(false) }
  }
  return (
    <Sheet
      open={state.eligible && state.encountered && state.decision === 'unknown'}
      onClose={() => { if (!saving) void choose(false) }}
      closeOnBackdrop={false}
      desktopWidth="min(440px, 100%)"
      titleId="error-summary-consent-title"
      testId="error-summary-consent"
    >
      <div className="p-6" aria-busy={saving}>
        <div className="flex flex-col gap-[var(--spacing-md)]">
          <Dialog.Title id="error-summary-consent-title" className={cn('text-[length:var(--font-title)] leading-[var(--lh-title)] font-semibold', i18n.resolvedLanguage?.startsWith('zh') && '[font-variant-east-asian:full-width]')}>{t('errorSummary.title')}</Dialog.Title>
          <Dialog.Description className="text-[length:var(--font-body)] leading-[var(--lh-body)] text-[var(--text-secondary)]">{t('errorSummary.body')}</Dialog.Description>
          <p className="text-[length:var(--font-body)] leading-[var(--lh-body)] text-[var(--text-secondary)]">{t('errorSummary.details')}</p>
        </div>
        {failed && <p role="alert" className="mt-3 text-[var(--danger-fg)]">{t('errorSummary.saveFailed')}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" disabled={saving} onClick={() => { void choose(false) }}>{t('errorSummary.deny')}</Button>
          <Button variant="secondary" disabled={saving} onClick={() => { void choose(true) }}>{t('errorSummary.allow')}</Button>
        </div>
      </div>
    </Sheet>
  )
}

export function ErrorSummaryPrivacySetting() {
  const { t } = useTranslation('settings')
  const state = useErrorSummaryConsent()
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  if (!state.eligible) return null
  return (
    <SettingsGroup title={t('errorSummary.privacy')} footer={failed ? <SettingsNote role="alert">{t('errorSummary.saveFailed')}</SettingsNote> : undefined}>
      <SettingsRow title={t('errorSummary.setting')} description={t('errorSummary.settingDescription')} control={
        <Switch checked={state.decision === 'allowed'} disabled={saving} aria-label={t('errorSummary.setting')} onCheckedChange={async allowed => {
          setSaving(true)
          setFailed(false)
          try { await setErrorSummaryConsent(allowed ? 'allowed' : 'denied') } catch { setFailed(true) } finally { setSaving(false) }
        }} />
      } />
    </SettingsGroup>
  )
}
