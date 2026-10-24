import type { ReactNode } from 'react';

export function SubscriptionServiceRow({
  name,
  logo,
  badge,
  identity,
  action,
  notice,
  scope,
  children,
  testId,
}: {
  name: string;
  logo: ReactNode;
  badge?: string;
  identity: ReactNode;
  action?: ReactNode;
  /** 整行宽度的提示(如切换被拒的原因)。❌ 塞进 `action`:那一列宽度是 auto,长句会把它撑开、把账号列挤没。 */
  notice?: ReactNode;
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
      {notice && <div className="subscription-service-notice">{notice}</div>}
      <div className="subscription-service-details">{children}</div>
    </article>
  );
}
