import type { ReactNode } from 'react';

export function SubscriptionServiceRow({
  name,
  logo,
  badge,
  identity,
  action,
  scope,
  children,
  testId,
}: {
  name: string;
  logo: ReactNode;
  badge?: string;
  identity: ReactNode;
  action?: ReactNode;
  scope: ReactNode;
  children: ReactNode;
  testId: string;
}) {
  return (
    <article className="subscription-service" data-testid={testId}>
      <div className="subscription-service-logo" aria-hidden="true">
        {logo}
      </div>
      <div className="subscription-service-heading">
        <div className="subscription-service-title">
          <h3>{name}</h3>
          {badge && <span className="subscription-plan-badge">{badge}</span>}
        </div>
        <div className="subscription-service-identity">{identity}</div>
      </div>
      <div className="subscription-service-actions">
        {action}
        <span className="subscription-scope">{scope}</span>
      </div>
      <div className="subscription-service-details">{children}</div>
    </article>
  );
}
