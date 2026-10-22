import { z } from 'zod';
import { AGENT_STATUSES, AGENT_STATUS_DETAILS } from '@gugu/core/shared/agentStatus';
import { parseConversationLink } from '@gugu/core/shared/ui/conversationLink';

// Deliberately closed: no generic payload, title, message body or tool arguments in this index.
const id = z.string().min(1).max(512);
export const activityEventSchema = z.object({
  event_id: id,
  kind: z.enum(['session.created', 'session.renamed', 'session.archived', 'session.deleted',
    'session.input_submitted', 'agent.status', 'session.message_delivered',
    'question.pending', 'question.resolved', 'question.cancelled', 'automation.run']),
  occurred_at: z.number().int().nonnegative().nullable(),
  observed_at: z.number().int().nonnegative(),
  session_id: id.optional(),
  project_id: id.optional(),
  related_session_id: id.optional(),
  parent_session_id: id.optional(),
  spawned_by_session_id: id.optional(),
  object_id: id.optional(),
  turn_id: id.optional(),
  source_ref: z.string().max(2048).refine(value => parseConversationLink(value) !== null, 'source_ref must be a conversation locator').optional(),
  status: z.enum([...AGENT_STATUSES, 'scheduled', 'queued',
    'creating_session', 'launching_session', 'starting_agent', 'done', 'failed', 'skipped']).optional(),
  detail: z.enum(AGENT_STATUS_DETAILS).nullable().optional(),
}).strict();
export type ActivityEvent = z.infer<typeof activityEventSchema>;

export const activityQuerySchema = z.object({
  since: z.string().datetime({ offset: true }),
  until: z.string().datetime({ offset: true }),
  session_id: id.optional(),
  project_id: id.optional(),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().max(4096).optional(),
}).strict().refine(q => Date.parse(q.since) < Date.parse(q.until), 'until must be later than since');
export type ActivityQuery = z.input<typeof activityQuerySchema>;
