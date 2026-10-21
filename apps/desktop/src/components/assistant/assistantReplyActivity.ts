import type { SessionLiveReply } from '@gugu/session-core/session-record/contract'

export type AssistantReplyActivity = SessionLiveReply['activity']

/** The live host binds a stage to its actual input; cached transcript text cannot claim the current message. */
export function assistantReplyActivity(reply: SessionLiveReply | null, messageId: string): AssistantReplyActivity | null {
  return reply?.sourceMessageId === `msg:${messageId}` ? reply.activity : null
}
