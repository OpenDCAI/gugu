import { z } from 'zod'
import {coreLogger} from '../log'

const log=coreLogger('assistant-work')

/** Cloud read contract shared by desktop and phone. Delivery writes belong to
 * assistantWorkOutbox; readers never attach to a device or maintain a queue. */
const sequence = z.string().regex(/^\d+$/)
const id = z.string().min(1)
const at = z.string().refine(value => Number.isFinite(Date.parse(value)))
const outcome = z.enum(['active','completed','cancelled','failed'])
const executorSchema = z.object({ session_id: id,device_id: id,agent_user_id: id.nullable().optional() })
const attachmentSchema = z.union([z.object({ item_id: z.uuid() }),z.object({
  attachment_id: z.uuid(),file_name: id,sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size_bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),content_type: id,
})])
const taskSchema = z.object({
  owner_user_id: id,assistant_user_id: id,work_id: z.uuid(),created_seq: sequence,
  title: z.string().min(1),coordinator_session_id: id,coordinator_device_id: id,
  executors: z.array(executorSchema).min(1),source_link: z.string().nullable(),outcome,
  executor_outcomes: z.record(z.string(),z.object({ status: z.enum(['completed','cancelled','failed']),
    origin: z.enum(['executor','coordinator']).optional(),message_id: z.uuid(),version: sequence })),
  terminal_version: sequence,created_at: at,updated_at: at,
})
const eventSchema = z.object({
  owner_user_id: id,work_id: z.uuid(),message_id: z.uuid(),seq: sequence,
  kind: z.enum(['dispatch','progress','question','completed','cancelled','failed','blocked']),
  from_session_id: id,from_device_id: id,to_session_id: id,to_device_id: id,executor_session_id: id,
  content: z.string().nullable(),attachment_refs: z.array(attachmentSchema),
  source_chat_id: z.string().nullable(),source_message_id: z.string().nullable(),source_available: z.boolean(),
  reason_code: z.string().nullable().optional(),terminal_origin: z.enum(['executor','coordinator']).nullable().optional(),
  terminal_version: sequence,platform_received_at: at,occurred_at: at.nullable().optional(),
  executor_admitted_at: at.nullable(),assistant_admitted_at: at.nullable(),owner_delivered_at: at.nullable(),
  owner_chat_id: z.string().nullable(),owner_message_id: z.string().nullable(),
  delivery_state: z.enum(['pending','claimed','admitted','abandoned']),
  abandoned_at: at.nullable().optional(),abandoned_reason_code: z.string().nullable().optional(),
  abandonment_notified_at: at.nullable().optional(),abandonment_notice_chat_id: z.string().nullable().optional(),
  abandonment_notice_message_id: z.string().nullable().optional(),
})
export type AssistantWorkTask = z.infer<typeof taskSchema>
export type AssistantWorkEvent = z.infer<typeof eventSchema>
export type AssistantWorkTransport = (name: string,args: Record<string, unknown>) => Promise<{
  data: unknown; error: { message: string; code?: string } | null
}>
export class AssistantWorkError extends Error {
  constructor(readonly code: string,message: string) { super(message); this.name = 'AssistantWorkError' }
}
const invalid = (): never => { throw new AssistantWorkError('invalid-response','Task records could not be read') }

export function createAssistantWorkClient(transport: AssistantWorkTransport,accountId: () => string | null) {
  async function request<T>(name: string,args: Record<string, unknown>,parse: (value: unknown,owner: string) => T) {
    const owner = accountId()
    if (!owner) throw new AssistantWorkError('signed-out','Not signed in')
    const answer = await transport(name,args)
    if (accountId() !== owner) throw new AssistantWorkError('account-changed','Task account changed')
    if (answer.error) throw new AssistantWorkError(answer.error.code ?? 'unavailable',answer.error.message)
    return parse(answer.data,owner)
  }
  async function list(assistantId: string,before: string | null = null,limit = 100) {
    return request('assistant_work_list',{ p_assistant: assistantId,p_before: before,p_limit: limit },(value,owner) => {
      const result = z.object({ items: z.array(z.unknown()),next_before: sequence.nullable() }).safeParse(value)
      if (!result.success) return invalid()
      const raw=result.data.items,items:AssistantWorkTask[]=[]
      for(const [index,row] of raw.entries()) {
        const scope=z.object({owner_user_id:id,assistant_user_id:id}).safeParse(row)
        if(scope.success&&(scope.data.owner_user_id!==owner||scope.data.assistant_user_id!==assistantId))return invalid()
        const parsed=taskSchema.safeParse(row)
        if(!parsed.success){log.warn({index,code:'invalid-row'},'Skipping malformed task row');continue}
        if(BigInt(parsed.data.created_seq)<=0n || before!==null&&BigInt(parsed.data.created_seq)>=BigInt(before))return invalid()
        items.push(parsed.data)
      }
      const next_before=result.data.next_before
      const last=z.object({created_seq:sequence}).safeParse(raw.at(-1))
      if(next_before!==null&&(raw.length===0||BigInt(next_before)<=0n||before!==null&&BigInt(next_before)>=BigInt(before)
        ||last.success&&next_before!==last.data.created_seq))return invalid()
      return {items,next_before}
    })
  }
  async function history(assistantId: string,workId: string,after = '0',limit = 100) {
    return request('assistant_work_history',{ p_assistant: assistantId,p_work_id: workId,p_after: after,p_limit: limit },(value,owner) => {
      const result = z.object({ events: z.array(z.unknown()),next_after: sequence.nullable(),work:z.unknown().optional() }).safeParse(value)
      if (!result.success) return invalid()
      let work:AssistantWorkTask|null=null
      if(result.data.work!=null){
        const parsed=taskSchema.safeParse(result.data.work)
        if(!parsed.success||parsed.data.owner_user_id!==owner||parsed.data.assistant_user_id!==assistantId||parsed.data.work_id!==workId)return invalid()
        work=parsed.data
      }
      const raw=result.data.events,events:AssistantWorkEvent[]=[]
      for(const [index,row] of raw.entries()) {
        const scope=z.object({owner_user_id:id,work_id:id}).safeParse(row)
        if(scope.success&&(scope.data.owner_user_id!==owner||scope.data.work_id!==workId))return invalid()
        const parsed=eventSchema.safeParse(row)
        if(!parsed.success){log.warn({index,code:'invalid-row'},'Skipping malformed history row');continue}
        if(BigInt(parsed.data.seq)<=BigInt(after))return invalid()
        events.push(parsed.data)
      }
      const next_after=result.data.next_after
      const last=z.object({seq:sequence}).safeParse(raw.at(-1))
      if(next_after!==null&&(raw.length===0||BigInt(next_after)<=BigInt(after)||last.success&&next_after!==last.data.seq))return invalid()
      return {events,next_after,work}
    })
  }
  return { list,history,
    async get(assistantId:string,workId:string):Promise<{work:AssistantWorkTask;events:AssistantWorkEvent[]}>{
      let page=await history(assistantId,workId)
      if(!page.work)throw new AssistantWorkError('not-found','Task record is unavailable')
      const work=page.work,events:AssistantWorkEvent[]=[],seen=new Set<string>()
      for(;;){
        for(const event of page.events){
          if(seen.has(event.message_id))return invalid()
          seen.add(event.message_id);events.push(event)
        }
        if(page.next_after===null)return {work,events}
        page=await history(assistantId,workId,page.next_after)
      }
    },
    async listAll(assistantId: string): Promise<AssistantWorkTask[]> {
      const items: AssistantWorkTask[] = [],seen = new Set<string>()
      let before: string | null = null
      do {
        const page = await list(assistantId,before)
        for (const row of page.items) {
          if (seen.has(row.work_id)) return invalid()
          seen.add(row.work_id); items.push(row)
        }
        before = page.next_before
      } while (before !== null)
      return items
    },
    async historyAll(assistantId: string,workId: string): Promise<AssistantWorkEvent[]> {
      const events: AssistantWorkEvent[] = [],seen = new Set<string>()
      let after = '0'
      for (;;) {
        const page = await history(assistantId,workId,after)
        for (const row of page.events) {
          if (seen.has(row.message_id)) return invalid()
          seen.add(row.message_id); events.push(row)
        }
        if (page.next_after === null) return events
        after = page.next_after
      }
    },
  }
}
export type AssistantWorkClient = ReturnType<typeof createAssistantWorkClient>
