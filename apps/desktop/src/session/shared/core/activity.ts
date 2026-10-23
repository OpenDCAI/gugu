import { z } from 'zod';
import { AGENT_STATUSES, AGENT_STATUS_DETAILS } from '@gugu/core/shared/agentStatus';
import { parseConversationLink } from '@gugu/core/shared/ui/conversationLink';
import { sessionLifecycleSchema } from '@gugu/session-core/acp/client';

// Deliberately closed: no generic payload, title, message body or tool arguments in this index.
const id = z.string().min(1).max(512);
export const activityEventSchema = z.object({
  event_id: id,
  kind: z.enum(['session.created', 'session.renamed', 'session.archived', 'session.deleted',
    'session.input_submitted', 'agent.status', 'session.message_delivered',
    'question.pending', 'question.resolved', 'question.cancelled', 'automation.run',
    // The session's stored history gained a turn / dropped its turns from turn_seq on (a revert). Only these name a
    // turn, by the stored history's own sequence: the one turn identity on this machine that survives restarts.
    'session.turn_recorded', 'session.history_reverted',
    'project.created', 'project.deleted', 'project.folder_attached', 'project.folder_detached',
    'project.group_bound', 'project.group_unbound', 'app.source_created', 'app.source_updated',
    'app.installed', 'app.replaced', 'session.model_changed', 'session.lifecycle']),
  occurred_at: z.number().int().nonnegative().nullable(),
  observed_at: z.number().int().nonnegative(),
  session_id: id.optional(),
  project_id: id.optional(),
  related_session_id: id.optional(),
  parent_session_id: id.optional(),
  spawned_by_session_id: id.optional(),
  object_id: id.optional(),
  related_object_id: id.optional(),
  /** Position in the session's stored history (session_turns.seq): the turn a turn event is about. */
  turn_seq: z.number().int().nonnegative().optional(),
  app_version: id.optional(),
  model_id: id.optional(),
  previous_model_id: id.optional(),
  lifecycle: sessionLifecycleSchema.optional(),
  source_ref: z.string().max(2048).refine(value => parseConversationLink(value) !== null, 'source_ref must be a conversation locator').optional(),
  status: z.enum([...AGENT_STATUSES, 'scheduled', 'queued',
    'creating_session', 'launching_session', 'starting_agent', 'done', 'failed', 'skipped']).optional(),
  detail: z.enum(AGENT_STATUS_DETAILS).nullable().optional(),
}).strict();
export type ActivityEvent = z.infer<typeof activityEventSchema>;
/**
 * What a producer reports. It never names a project: the journal derives `project_id` from the event's subject (its
 * session, or the automation of its run), in one place, so no producer can omit or contradict it.
 */
export const activityObservationSchema = activityEventSchema.omit({ project_id: true }).superRefine((event, ctx) => {
  if (event.kind.startsWith('project.') && !event.object_id) {
    ctx.addIssue({ code: 'custom', path: ['object_id'], message: 'Project events must name their subject project' });
  }
});
export type ActivityObservation = z.infer<typeof activityObservationSchema>;

export const activityQuerySchema = z.object({
  since: z.string().datetime({ offset: true }),
  until: z.string().datetime({ offset: true }),
  session_id: id.optional(),
  project_id: id.optional(),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().max(4096).optional(),
}).strict().refine(q => Date.parse(q.since) < Date.parse(q.until), 'until must be later than since');
export type ActivityQuery = z.input<typeof activityQuerySchema>;
