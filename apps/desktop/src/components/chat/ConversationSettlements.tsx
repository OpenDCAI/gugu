import type { Settlement, SettlementResponse, SessionpageSessionRespondResult, SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { remoteSettlementGap } from '@gugu/session-core/session-record/contract'
import { AgentQuestionCard } from './AgentQuestionCard'
import { AgentPermissionBand } from './AgentPermissionBand'
import { SettlementCard } from '@/mobile/agent-watch/TimelineView'

/** Same question and permission controls as the project conversation, backed by the host's first-answer-wins result. */
export function ConversationSettlements({ sessionId, settlements, runtime, mobile, machine, busyItemId, respond }: {
  sessionId: string; settlements: Readonly<Record<string, Settlement>>; runtime: SessionpageSessionSummary['runtime']
  mobile?: boolean; machine?: string; busyItemId: string | null
  respond: (input: SettlementResponse) => Promise<SessionpageSessionRespondResult>
}) {
  const pending = Object.values(settlements).filter(item => item.state === 'pending')
  return <div data-conversation-settlements="" style={{ maxHeight: '45dvh', overflowY: 'auto' }}>
    {pending.map(item => remoteSettlementGap(runtime, item.kind ?? 'permission', item.questions, item.origin)
      ? <SettlementCard key={item.itemId} settlement={item} runtime={runtime} machine={machine} busy={busyItemId === item.itemId}
          onRespond={input => { void respond(input).catch(() => undefined) }} />
      : item.kind === 'question' && item.questions?.length
        ? <AgentQuestionCard key={item.itemId} scope={sessionId} settlement={item} mobile={mobile}
            respond={answers => respond({ itemId: item.itemId, kind: 'question', answers })} />
        : <AgentPermissionBand key={item.itemId} sessionId={sessionId} pending={{ ...item, title: item.title ?? '', options: (item.options ?? []).map(option => ({ ...option, kind: option.kind ?? '' })), queueCount: pending.length }}
            respond={(_id, optionId, extra) => respond({ ...extra, itemId: item.itemId, kind: item.kind ?? 'permission', optionId })} />)}
  </div>
}
