import { useQuery } from '@tanstack/react-query';
import { publicAssetPath } from '@gugu/core/shared/ui/publicAssets';
import { ArrowUpRight } from '@/lib/icons';
import { useAuth } from '@/store/auth';
import { formatCredits, getMembership, quotaWindowViews, useSpendingPower } from '@/lib/billing';
import { GUGU_BILLING_URL } from '@/lib/appLinks';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { Button } from '@renderer/lib/ui/button';
import { rpc } from '@renderer/lib/ipc';
import { SubscriptionServiceRow } from './SubscriptionServiceRow';
import { errorText } from './subscription-queries';

const APP_ICON_URL = publicAssetPath('/assets/app/gugu-icon-512.png');

export function GuguSubscriptionRow() {
  const { translate, locale } = useSessionMessages();
  const { user } = useAuth();
  const { power, windows, balanceError, windowsError, activityRevision } = useSpendingPower(user);
  const membership = useQuery({
    queryKey: ['subscriptions', 'gugu', user?.id, activityRevision],
    queryFn: getMembership,
    enabled: !!user,
    retry: false,
    staleTime: 30_000,
    gcTime: 30_000,
  });
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
      scope={translate('subscriptions.gugu.shared')}
      testId="subscription-row-gugu"
      action={
        <Button variant="ghost" size="xs" onClick={() => void rpc.app.openExternal(GUGU_BILLING_URL)}>
          {translate('subscriptions.gugu.manage')}
          <ArrowUpRight className="ml-1 size-3" />
        </Button>
      }
    >
      <div className="subscription-quota-grid">
        <div className="subscription-quota">
          <div className="subscription-quota-label">
            <span>{translate('subscriptions.gugu.available')}</span>
            <strong>{power ? formatCredits(power.spendable) : '—'}</strong>
          </div>
          {power && (
            <p>
              {translate('subscriptions.gugu.breakdown', {
                period: formatCredits(power.periodCredits),
                wallet: formatCredits(power.walletCredits),
              })}
              {power.held > 0 && <> {translate('subscriptions.gugu.reserved', { credits: formatCredits(power.held) })}</>}
            </p>
          )}
        </div>
        <div className="subscription-quota">
          <div className="subscription-quota-label">
            <span>{translate('subscriptions.gugu.period')}</span>
            <strong>
              {period ? formatCredits(period.remaining) : '—'}
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
      </div>
      {(balanceError || windowsError) && (
        <p className="subscription-error" role="status">
          {translate('subscriptions.unavailable.error', { message: balanceError || windowsError || '' })}
        </p>
      )}
    </SubscriptionServiceRow>
  );
}
