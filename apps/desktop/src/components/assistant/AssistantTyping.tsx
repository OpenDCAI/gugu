import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { buildBubbleStyle } from '../chat/messageBubbleStyle'
import type { AgentReplyPending } from '../../lib/agentReplyPending'
import { ChevronDown } from '@/lib/icons'
import { Button } from '../ui/Button'
import { Collapse } from '../ui/Collapse'
import type { AssistantReplyActivity } from './assistantReplyActivity'
import './assistant-typing.css'
import { AssistantStreamingReply } from './AssistantStreamingReply'

function ThinkingElapsed({ startedAt }: { startedAt: number }) {
  const { t } = useTranslation('assistant')
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])
  return <span aria-hidden className="ast-typing-elapsed">{t('chat.elapsed', { seconds: Math.max(0, Math.floor((now - startedAt) / 1_000)) })}</span>
}

/** A real reply stage, with ordinary waiting as the fallback; thoughts never become chat messages. */
export function AssistantTyping({ pending, name, activity = null }: {
  pending: Exclude<AgentReplyPending, null>; name: string; activity?: AssistantReplyActivity | null
}) {
  const { t } = useTranslation('assistant')
  const detailsId = useId()
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const thinking = activity?.phase === 'thinking' ? activity : null
  const label = thinking ? t('chat.thinking') : activity?.phase === 'replying' ? t('chat.replying') : activity?.phase === 'tools' ? t('chat.toolCount', { count: activity.count }) : t('chat.processing')
  const expanded = Boolean(thinking?.text && expandedId === thinking.id)
  if (activity?.phase === 'draft') return <AssistantStreamingReply activity={activity} />
  return (
    <div className="ast-typing" data-testid="assistant-typing" data-pending={pending} data-phase={activity?.phase ?? 'processing'}>
      <div style={buildBubbleStyle(false, false, false)}>
        <div className="ast-typing-body">
          <span className="ast-typing-dots" aria-hidden><span /><span /><span /></span>
          <span role="status" aria-live="polite" aria-label={`${name} · ${label}`} className="ast-typing-label">{label}</span>
          {thinking && <ThinkingElapsed key={thinking.id} startedAt={thinking.startedAt} />}
          {thinking?.text && <Button variant="ghost" size="sm" className="ast-typing-toggle" aria-label={t('chat.thinkingDetails')}
            aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpandedId(expanded ? null : thinking.id)}>
            <ChevronDown size={14} className={expanded ? 'rotate-180' : undefined} />
          </Button>}
        </div>
        {thinking?.text && <Collapse id={detailsId} open={expanded}>
          <div className="ast-typing-thought" data-testid="assistant-thinking-text">{thinking.text}</div>
        </Collapse>}
      </div>
    </div>
  )
}
