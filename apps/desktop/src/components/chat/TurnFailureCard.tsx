import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { turnFailurePresentation, type TurnFailureReason } from '@gugu/core/shared/turnFailurePresentation'
import { AlertTriangle, X } from '@/lib/icons'
import { formatCalendarDayTime } from '@/lib/calendarTime'
import { Avatar } from '../Avatar'
import { Button } from '../ui/Button'
import { Sheet } from '../ui/Sheet'
import './turn-failure-card.css'

type TurnFailureCardProps = {
  reason: TurnFailureReason
  displayName: string
  agentId?: string | null
  avatar?: string | null
  createdAt?: string
  count?: number
  recovered?: boolean
  placement: 'stream' | 'composer'
  onRetry?: () => void
  retrying?: boolean
  onOpenSettings?: () => void
  onDismiss?: () => void
}

/** The same presentation for a persisted chat failure and a retryable device command. */
export function TurnFailureCard({ reason, displayName, agentId, avatar, createdAt, count = 1, recovered = false,
  placement, onRetry, retrying, onOpenSettings, onDismiss }: TurnFailureCardProps) {
  const { t } = useTranslation('messaging')
  const [expanded, setExpanded] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  const presentation = turnFailurePresentation(reason)
  const title = t(presentation.titleKey)
  const cause = t(presentation.bodyKey)
  const recoveredLabel = t(presentation.recoveredKey, { name: displayName, count })
  return (
    <div className="tfc-line" data-placement={placement}>
      {recovered ? (
        <Button variant="ghost" size="sm" className="tfc-recovered" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {recoveredLabel}
        </Button>
      ) : null}
      {!recovered || expanded ? (
        <div className="tfc" data-tone={presentation.tone} role="status" aria-live="polite" aria-label={cause}>
          <AlertTriangle size={16} className="tfc-icon" aria-hidden />
          <div className="tfc-head">
            {agentId ? <Avatar name={displayName} avatarUrl={avatar} seed={agentId} size="xs" isAgent harnessBadge={false} /> : null}
            <span className="tfc-name" title={displayName}>{displayName}</span>
            <span className="tfc-title">{title}</span>
            {count > 1 ? <span className="tfc-count">×{count}</span> : null}
            {createdAt ? <time className="tfc-time" dateTime={createdAt}>{formatCalendarDayTime(createdAt)}</time> : null}
          </div>
          <button type="button" className="tfc-reason" aria-label={cause} onClick={() => setDetailOpen(true)}>
            {cause}{placement === 'stream' ? ` · ${t(presentation.nextMessageKey)}` : ''}
          </button>
          {placement === 'composer' ? (
            <div className="tfc-actions">
              {presentation.actions.map(action => action === 'retry' ? onRetry && (
                <Button key={action} variant="ghost" size="sm" onClick={onRetry} disabled={retrying} data-testid="agent-turn-failure-retry">
                  {retrying ? t('agent.turnFailure.retrying') : t('agent.turnFailure.retry')}
                </Button>
              ) : onOpenSettings && (
                <Button key={action} variant="ghost" size="sm" onClick={onOpenSettings} data-testid="agent-turn-failure-model">
                  {t(action === 'model' ? 'agent.turnFailure.changeModel' : 'agent.turnFailure.card.settings')}
                </Button>
              ))}
            </div>
          ) : null}
          {onDismiss ? (
            <Button variant="ghost" size="icon" className="tfc-dismiss" onClick={onDismiss} aria-label={t('common.close')} data-testid="agent-turn-failure-dismiss">
              <X size={14} aria-hidden />
            </Button>
          ) : null}
        </div>
      ) : null}
      {detailOpen ? (
        <Sheet onClose={() => setDetailOpen(false)} ariaLabel={title} mobileFitContent>
          <div className="tfc-detail"><strong>{displayName} · {title}</strong><p>{cause}</p>
            {placement === 'stream' ? <p>{t(presentation.nextMessageKey)}</p> : null}
          </div>
        </Sheet>
      ) : null}
    </div>
  )
}
