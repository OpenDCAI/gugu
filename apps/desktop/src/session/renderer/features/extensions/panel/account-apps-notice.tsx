import type { AccountAppState } from '@shared/extensions/account-apps';
import { Button } from '@renderer/lib/ui/button';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

const COPY = {
  installing: 'extensions.accountAppInstalling',
  'needs-consent': 'extensions.accountAppNeedsConsent',
  unavailable: 'extensions.accountAppUnavailable',
  failed: 'extensions.accountAppFailed',
} as const;

/** A local opt-out stays quiet; an installed App already has its normal inventory row. */
export function AccountAppsNotice({ apps, onReview, onRetry }: {
  apps: readonly AccountAppState[];
  onReview: (id: string) => void;
  onRetry: () => void;
}) {
  const { translate } = useSessionMessages();
  const pending = apps.filter(app => app.id === 'browser-use' && app.state !== 'installed' && app.state !== 'excluded');
  if (!pending.length) return null;
  return <div className="mk-sec" role="status">
    {pending.map(app => {
      if (app.state === 'installed' || app.state === 'excluded') return null;
      return <div className="mk-status" key={app.id} data-testid="account-app-notice" data-state={app.state}>
        <span>{translate(COPY[app.state], { name: 'Browser Use' })}</span>
        {app.state === 'needs-consent' && <Button type="button" variant="ghost" size="sm" onClick={() => onReview(app.id)}>
          {translate('extensions.accountAppReview')}
        </Button>}
        {app.state === 'failed' && <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
          {translate('extensions.retry')}
        </Button>}
      </div>;
    })}
  </div>;
}
