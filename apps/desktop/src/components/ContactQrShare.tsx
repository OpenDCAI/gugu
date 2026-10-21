import { useEffect, useMemo, useState } from 'react'
import QRCode from 'qrcode'
import { createContactQrPayload, createGuguQrScanUrl } from '@gugu/core/shared/qrPayload'
import { GUGU_ANDROID_DOWNLOAD_URL } from '../lib/appLinks'
import { useTranslation } from 'react-i18next'

// @@@contact-qr (#537) - the current user's personal "add me" QR. Encodes their 咕咕号 (gugu_number) on the
export function ContactQrShare({ guguNumber }: { guguNumber: number | null | undefined }) {
  const { t } = useTranslation('contacts')
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [qrError, setQrError] = useState<string | null>(null)

  const payloadText = useMemo(() => {
    if (typeof guguNumber !== 'number' || !Number.isInteger(guguNumber) || guguNumber <= 0) return null
    return createGuguQrScanUrl(createContactQrPayload(guguNumber), { downloadUrl: GUGU_ANDROID_DOWNLOAD_URL })
  }, [guguNumber])

  useEffect(() => {
    if (!payloadText) {
      setQrDataUrl(null)
      setQrError(null)
      return
    }
    let cancelled = false
    QRCode.toDataURL(payloadText, { width: 132, margin: 1, color: { dark: '#1f2933', light: '#ffffff' } })
      .then((url) => {
        if (!cancelled) {
          setQrDataUrl(url)
          setQrError(null)
        }
      })
      .catch((error) => {
        console.error('[ContactQrShare] QR generation failed', error)
        if (!cancelled) {
          setQrDataUrl(null)
          setQrError(t('sharing.qrFailed'))
        }
      })
    return () => {
      cancelled = true
    }
  }, [payloadText, t])

  if (!payloadText) {
    return <div style={{ fontSize: 'var(--font-body)', color: 'var(--text-tertiary)' }}>{t('friendSearch.guguNumberUnassigned')}</div>
  }

  return (
    <div
      data-testid="contact-qr-share"
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}
    >
      <div
        style={{
          width: 132,
          height: 132,
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-control)',
          background: 'var(--color-white)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        {qrDataUrl ? (
          <img src={qrDataUrl} width={132} height={132} alt={t('sharing.myQr')} />
        ) : (
          <span style={{ fontSize: 'var(--font-caption)', color: 'var(--text-tertiary)' }}>{qrError ?? t('sharing.generatingQr')}</span>
        )}
      </div>
      <div style={{ fontSize: 'var(--font-caption)', color: 'var(--text-tertiary)', textAlign: 'center' }}>
        {t('sharing.addMeHint')}
      </div>
    </div>
  )
}
