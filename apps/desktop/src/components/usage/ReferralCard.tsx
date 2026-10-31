import { platform } from '@/platform'
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { rendererLogger } from '@/lib/log';
import { toast } from '@renderer/lib/hooks/use-toast';
import { messageForUser } from '@/lib/userFacingError';
// 邀请返利。原在「会员与额度」页,#6334 该页并入「用量」后搬到这里,版式是图标徽章 + 标题头的卡片。
// 一次性赠送只进不过期积分、只发一次,不构成第二套周期额度(behavior)。
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatNumber } from '@/i18n'
import { creditCount } from '../../lib/billing'
import { Copy, UserPlus } from '@/lib/icons'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import { useAuth } from '../../store/auth'
import { Button } from '../ui/Button'
import { useReferralCardData } from './useReferralCardData'
import { IconBadge } from './UsageParts'

export function ReferralCard() {
  const { t } = useTranslation('settings')
  const { user, loading } = useAuth()
  const { inviteUrl, hasLandingPage, referral, pending, failed, retry } = useReferralCardData(user, loading)
  const [copied, setCopied] = useState(false)

  const handleCopyInvite = useCallback(async () => {
    if (!inviteUrl) return
    try {
      await platform.writeClipboardText(inviteUrl)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch (error) {
      rendererLogger('actions/ReferralCard').error({ error: error }, 'action failed')
      toast({ title: translateSessionMessage('task.copyFailed'), description: messageForUser(error), tier: 'error' })
    }
  }, [inviteUrl])

  if (!user && !loading) return null

  return (
    <div className="na-card" data-testid="membership-referral">
      <div className="na-card-head">
        <div className="na-card-title">
          <IconBadge icon={<UserPlus />} tone="chart-2" />
          <b>{t('referral.inviteTitle')}</b>
          <span className="na-referral-description">{t('referral.inviteDescription')}</span>
        </div>
      </div>
      <div className="na-referral" data-read-failed={failed.length > 0 && !inviteUrl || undefined}>
        <div className="na-referral-stats na-referral-stats-frame">
          {failed.length ? <div role="alert" className="na-referral-read-error">
            <span>{t('referral.readFailed')}</span>
            <Button variant="ghost" size="sm" onClick={retry}>{t('referral.retry')}</Button>
          </div> : <>

          <span data-testid="settings-quota-invited-count">
            {pending && !referral ? <span className="gg-usage-skeleton na-referral-stat-skeleton" aria-hidden /> : t('referral.invited', { count: referral ? formatNumber(referral.invitedCount) : '—' })}
          </span>
          <span data-testid="settings-quota-credits-earned">
            {pending && !referral ? <span className="gg-usage-skeleton na-referral-stat-skeleton" aria-hidden /> : t('referral.earned', { credits: referral ? t('referral.amountCredits', { credits: formatNumber(referral.creditsEarned), count: creditCount(referral.creditsEarned) }) : '—' })}
          </span>
          </>}
        </div>
        {hasLandingPage && <div className="na-referral-link na-referral-link-frame" aria-busy={pending && !inviteUrl}>
          {inviteUrl ? <>
          <input
            data-testid="settings-quota-invite-input"
            className="na-input na-referral-url"
            value={inviteUrl}
            readOnly
          />
          <Button
            variant="secondary"
            size="md"
            data-testid={AUTOMATION_TEST_IDS.settingsQuotaInviteCopyButton}
            onClick={handleCopyInvite}
          >
            <Copy size={14} />
            {copied ? t('referral.copied') : t('referral.copyInvite')}
          </Button>
          </> : pending ? <>
            <div className="na-input gg-usage-skeleton na-referral-field-skeleton" aria-label={t('referral.inviteLoading')} />
            <span className="gg-usage-skeleton na-referral-copy-skeleton" aria-hidden><Copy size={14} className="invisible" /><span className="invisible">{t('referral.copyInvite')}</span></span>
          </> : null}
        </div>}
      </div>
    </div>
  )
}
