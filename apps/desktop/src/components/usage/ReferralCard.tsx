import { toast } from '@renderer/lib/hooks/use-toast';
import { messageForUser } from '@/lib/userFacingError';
// 邀请返利。原在「会员与额度」页,#6334 该页并入「用量」后搬到这里,版式是图标徽章 + 标题头的卡片。
// 一次性赠送只进不过期积分、只发一次,不构成第二套周期额度(behavior)。
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatNumber } from '@/i18n'
import { Copy, UserPlus } from '@/lib/icons'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import { getReferralStats, type ReferralStats } from '../../lib/billing'
import { buildReferralShareUrl } from '../../lib/referral'
import { useAuth } from '../../store/auth'
import { Button } from '../ui/Button'
import { IconBadge } from './UsageParts'

export function ReferralCard() {
  const { t } = useTranslation('settings')
  const { user } = useAuth()
  const inviteUrl = buildReferralShareUrl(user?.gugu_number ?? null)
  const [copied, setCopied] = useState(false)

  const handleCopyInvite = useCallback(async () => {
    if (!inviteUrl) return
    try {
      await navigator.clipboard.writeText(inviteUrl)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch (error) {
      console.error(error)
      toast({ title: messageForUser(error), tier: 'error' })
    }
  }, [inviteUrl])

  // 取不到(未登录/网络)→ null,界面回落 '—'(不造假)。
  const [referral, setReferral] = useState<ReferralStats | null>(null)
  useEffect(() => {
    let alive = true
    getReferralStats()
      .then((s) => { if (alive) setReferral(s) })
      .catch(() => { if (alive) setReferral(null) })
    return () => { alive = false }
  }, [])

  return (
    <div className="na-card" data-testid="membership-referral">
      <div className="na-card-head">
        <div className="na-card-title">
          <IconBadge icon={<UserPlus />} tone="chart-2" />
          <b>{t('referral.inviteTitle')}</b>
          <span>{t('referral.inviteDescription')}</span>
        </div>
      </div>
      <div className="na-referral">
        <div className="na-referral-stats">
          <span data-testid="settings-quota-invited-count">
            {t('referral.invited', { count: referral ? formatNumber(referral.invitedCount) : '—' })}
          </span>
          <span data-testid="settings-quota-credits-earned">
            {t('referral.earned', { credits: referral ? t('referral.amountCredits', { credits: formatNumber(referral.creditsEarned) }) : '—' })}
          </span>
        </div>
        <div className="na-referral-link">
          <input
            data-testid="settings-quota-invite-input"
            className="na-input"
            value={inviteUrl ?? ''}
            readOnly
            placeholder={t('referral.invitePlaceholder')}
          />
          <Button
            variant="secondary"
            size="md"
            data-testid={AUTOMATION_TEST_IDS.settingsQuotaInviteCopyButton}
            disabled={!inviteUrl}
            onClick={handleCopyInvite}
            title={inviteUrl ? undefined : t('referral.inviteLoading')}
          >
            <Copy size={14} />
            {copied ? t('referral.copied') : t('referral.copyInvite')}
          </Button>
        </div>
      </div>
    </div>
  )
}
