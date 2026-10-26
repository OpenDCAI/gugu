import { z } from 'zod'

/** Host metadata carried through local/remote routing; never model-authored task content. */
export const assistantWorkIntentSchema = z.object({
  version: z.literal(1),assistant_id: z.uuid(),work_id: z.uuid(),operation_id: z.uuid(),message_id: z.uuid(),
  child_session_id: z.uuid(),coordinator: z.object({session_id:z.string().min(1),device_id:z.string().min(1)}),
  title:z.string().min(1).max(500),source_link:z.string().optional(),continuation:z.boolean(),
}).strict()
export type AssistantWorkIntent = z.infer<typeof assistantWorkIntentSchema>
export type AssistantWorkTarget = { sessionId:string;deviceId:string;agentId?:string }
