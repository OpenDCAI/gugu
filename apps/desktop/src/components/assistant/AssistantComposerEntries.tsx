import type { ComponentProps } from 'react'
import { IdeasEntry } from '@/session/renderer/features/assistant/assistant-ideas'
import { AssistantCustomizeCard } from './AssistantCustomizeCard'
import './assistant-onboarding.css'

/** One in-flow row, measured with the composer on both desktop and phone. */
export function AssistantComposerEntries({ customize, ...ideas }: ComponentProps<typeof IdeasEntry> & { customize?: ComponentProps<typeof AssistantCustomizeCard> }) {
  return (
    <div className="ta-composer-entries" data-testid="assistant-composer-entries">
      {customize && <AssistantCustomizeCard {...customize} />}
      <IdeasEntry {...ideas} />
    </div>
  )
}
