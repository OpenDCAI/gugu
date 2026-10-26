import type { ReactNode } from 'react'
import { Button } from '../ui/Button'
import './app-connection-hero.css'

/** A detail keeps the same icon, two-line description and action slots while metadata arrives. */
export function AppConnectionHero({ icon, description, loading = false, label, onConnect, disabled = false, actionNote, testId = 'assistant-connector-connect' }: {
  icon?: ReactNode; description?: string; loading?: boolean; label: string; onConnect: () => void; disabled?: boolean; actionNote?: ReactNode; testId?: string
}) {
  return <div className="ta-card ta-app-connection-hero" aria-busy={loading} data-testid="app-connection-hero">
    <div className="ta-app-connection-icon">{icon ?? <span className="ta-connection-placeholder ta-connection-placeholder-icon" aria-hidden="true" />}</div>
    <div className="ta-app-connection-description">{description || <span className="ta-connection-placeholder ta-connection-placeholder-description" aria-hidden="true" />}</div>
    <div className="ta-app-connection-action">{loading
      ? <span className="ta-connection-placeholder ta-connection-placeholder-action" aria-hidden="true" data-testid="app-connection-action-pending" />
      : actionNote ?? <Button variant="primary" size="xl" className="ta-app-connection-button" disabled={disabled} onClick={onConnect} data-testid={testId}>{label}</Button>}</div>
  </div>
}

/** Used only when this account has never cached the catalog on this device. */
export function AppConnectionListPlaceholder() {
  return <div className="ta-connection-list-placeholder" aria-busy="true" data-testid="application-list-pending">
    {[0,1,2].map(index => <div className="ta-connection-list-placeholder-row" key={index} aria-hidden="true">
      <span className="ta-connection-placeholder ta-connection-list-placeholder-icon" />
      <span className="ta-connection-list-placeholder-copy"><span className="ta-connection-placeholder" /><span className="ta-connection-placeholder" /></span>
    </div>)}
  </div>
}
