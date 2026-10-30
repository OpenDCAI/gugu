import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { publicAssetPath } from '@gugu/core/shared/ui/publicAssets';
import { ArrowUpRight } from '@/lib/icons';
import { useAuth } from '@/store/auth';
import { formatCredits, getMembership, quotaWindowViews, useSpendingPower } from '@/lib/billing';
import { platform } from '@/platform';
import { GUGU_BILLING_URL } from '@/lib/appLinks';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { Button } from '@/components/ui/Button';
import { queryClient } from '@renderer/lib/query-client';
import { SubscriptionServiceRow } from './SubscriptionServiceRow';
import { errorText } from './subscription-queries';
import './subscriptions.css';

const APP_ICON_URL = publicAssetPath('/assets/app/gugu-icon-512.png');

export function GuguSubscriptionRow() {
  const { translate, locale } = useSessionMessages();
  const { t } = useTranslation('settings');
  const { user } = useAuth();
  const [deviceFull, setDeviceFull] = useState(false);
  useEffect(() => {
    let alive = true;
    setDeviceFull(false);
    void platform.readDeviceFreeCreditsStatus?.()
      .then(status => { if (alive) setDeviceFull(status === 'device_full'); }, () => undefined);
    return () => { alive = false; };
  }, [user?.id]);
  const { power, windows, balanceError, windowsError, activityRevision } = useSpendingPower(user);
  const membership = useQuery({
    queryKey: ['subscriptions', 'gugu', user?.id, activityRevision],
    queryFn: getMembership,
    enabled: !!user,
    retry: false,
    staleTime: 30_000,
    gcTime: 30_000,
  }, queryClient);
  const plan = membership.data;
  const date = (value: Date) =>
    new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }).format(value);
  const period = windows ? quotaWindowViews(windows).period : null;
  const badge = plan ? plan.tier[0].toUpperCase() + plan.tier.slice(1) : undefined;
  const identity = !user
    ? translate('subscriptions.gugu.signIn')
    : membership.error
      ? translate('subscriptions.unavailable.error', { message: errorText(membership.error) })
      : membership.isPending
        ? translate('subscriptions.checking')
        : plan
          ? plan.expiresAt
            ? translate('subscriptions.gugu.expires', { date: date(plan.expiresAt) })
            : translate('subscriptions.gugu.noExpiry')
          : translate('subscriptions.payer.unknown');
  return (
    <SubscriptionServiceRow
      name={translate('subscriptions.gugu.name')}
      logo={<img className="subscription-gugu-icon" src={APP_ICON_URL} alt="" width={24} height={24} />}
      badge={badge}
      identity={identity}
      scope={<span className="subscription-credit-scope">{translate('subscriptions.gugu.shared')}</span>}
      testId="subscription-row-gugu"
      action={
        <Button variant="ghost" size="sm" nativeButton={false} render={<a href={GUGU_BILLING_URL} target="_blank" rel="noreferrer" />}>
          {translate('subscriptions.gugu.manage')}
          <ArrowUpRight className="ml-1 size-3" />
        </Button>
      }
    >
      <div className="subscription-credit-summary">
        <span className="subscription-credit-label">{translate('subscriptions.gugu.available')}</span>
        <strong className="subscription-credit-value" data-testid="subscription-credits-balance">
          {power ? formatCredits(power.spendable) : '—'}
        </strong>
        {!power && !balanceError && !windowsError && (
          <p className="subscription-note" data-testid="subscription-credits-loading">{t('credits.loading')}</p>
        )}
        {power && power.held > 0 && <p className="subscription-note">{translate('subscriptions.gugu.reserved', { credits: formatCredits(power.held) })}</p>}
      </div>
      <div className="subscription-quota-grid">
        <div className="subscription-quota" data-testid="subscription-period">
          <div className="subscription-quota-label">
            <span>{translate('subscriptions.gugu.period')}</span>
            <strong>
              <span data-testid="subscription-period-credits">{period ? formatCredits(period.remaining) : '—'}</span>
              {period && <small> / {formatCredits(period.limit)}</small>}
            </strong>
          </div>
          {period && (
            <>
              <div
                className="subscription-meter"
                role="meter"
                aria-label={translate('subscriptions.gugu.period')}
                aria-valuemin={0}
                aria-valuemax={period.limit}
                aria-valuenow={period.remaining}
              >
                <i style={{ width: `${period.limit > 0 ? (period.remaining / period.limit) * 100 : 0}%` }} />
              </div>
              <p>{translate('subscriptions.gugu.resets', { date: date(period.freesAt) })}</p>
            </>
          )}
        </div>
        <div className="subscription-quota" data-testid="subscription-wallet">
          <div className="subscription-quota-label">
            <span>{translate('subscriptions.gugu.wallet')}</span>
            <strong data-testid="subscription-wallet-credits">{power ? formatCredits(power.walletCredits) : '—'}</strong>
          </div>
        </div>
      </div>
      {(balanceError || windowsError) && (
        <p className="subscription-error" role="status">
          {translate('subscriptions.unavailable.error', { message: balanceError || windowsError || '' })}
        </p>
      )}
      {deviceFull && membership.isSuccess && !membership.isFetching && plan?.tier === 'free' && (
        <p className="subscription-note">{t('usage.na.deviceFull')}</p>
      )}
      <div className="subscription-credit-actions">
        <Button variant="secondary" size="sm" nativeButton={false}
          render={<a href={GUGU_BILLING_URL} target="_blank" rel="noreferrer" />}
          data-testid="membership-open-web">
          {t('usage.na.openWebBilling')}
          <ArrowUpRight className="ml-1 size-3" />
        </Button>
      </div>
    </SubscriptionServiceRow>
  );
}
