import { z } from 'zod'

export const workReportSchema = z.object({ work_id: z.string().uuid(), status: z.enum(['progress', 'question', 'completed', 'cancelled']) }).strict()
export type WorkReport = z.infer<typeof workReportSchema>
export const pendingAssistantWorkRowSchema = z.object({
  id: z.string(), kind: z.enum(['executor', 'question']), source_link: z.string().optional(),
  source_message_id: z.string().optional(), source_summary: z.string().max(401).optional(),
  blocked_reason: z.literal('device_no_task_runtime').optional(),
  device: z.string().optional(), recipients: z.array(z.string()), state: z.enum(['dispatching', 'waiting', 'uncertain', 'blocked', 'needs_source']),
  created_at: z.string(), receipt_ids: z.array(z.string()),
  early: z.array(z.object({ sender: z.string(), report: workReportSchema, receipt: z.string() })).optional(),
})
export type PendingAssistantWork = z.infer<typeof pendingAssistantWorkRowSchema>
export const pendingAssistantWorkSchema = z.object({ version: z.literal(1), items: z.array(pendingAssistantWorkRowSchema) })
