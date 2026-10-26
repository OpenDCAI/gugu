import { z } from 'zod'
import { decodeIdentityAddress, decodeTypedId } from '../shared/typedId.mjs'
import { enqueueAssistantWorkDelivery, type AssistantWorkRpcClient } from './assistantWorkOutbox'
import type { SessionAttachmentRef, SessionFileInput } from './sessionAttachments'

const reportSchema = z.object({work_id:z.uuid(),status:z.enum(['progress','question','completed','cancelled'])}).strict()
const workSchema = z.object({
  work_id:z.string(),assistant_user_id:z.string(),coordinator_session_id:z.string(),coordinator_device_id:z.string(),
  executors:z.array(z.object({session_id:z.string(),device_id:z.string()})),
})
const fail = (code:string) => Object.assign(new Error(code),{code})

/** The sender writes one durable report; it never needs a live coordinator to accept the result. */
export async function enqueueAssistantWorkReport(deps:{
  rpc:AssistantWorkRpcClient['rpc']
  prepare(files:SessionFileInput[],target:{sessionId:string;deviceId:string;agentId:string}):Promise<SessionAttachmentRef[]>
  resolveNumbers(numbers:number[]):Promise<Map<number,string>>
  id():string
}, input:{assistantId:string;runtimeInstanceId:string;sessionId:string;deviceId:string;reasonCode?:'HOST_FAILURE';record:Record<string,unknown>}) {
  const report=reportSchema.parse(input.record.work_result)
  const messageId=deps.id(),operationId=deps.id()
  const {data,error}=await deps.rpc('assistant_work_history',{p_assistant:input.assistantId,p_work_id:report.work_id,p_after:'0',p_limit:100})
  if(error) throw Object.assign(new Error(error.message),{code:error.code})
  const checked=workSchema.safeParse((data as {work?:unknown}|null)?.work)
  if(!checked.success) throw fail('WORK_ROUTING_UNAVAILABLE')
  const work=checked.data
  if(work.work_id!==report.work_id || work.assistant_user_id!==input.assistantId) throw fail('WORK_ROUTING_UNAVAILABLE')
  if(!work.executors.some(row=>row.session_id===input.sessionId && row.device_id===input.deviceId)) throw fail('WORK_EXECUTOR_MISMATCH')
  const to=input.record.to
  if(!Array.isArray(to)||to.length!==1||typeof to[0]!=='string') throw fail('WORK_COORDINATOR_MISMATCH')
  const address=to[0]
  let matches=false
  if(address.startsWith('session:')) matches=decodeTypedId('session',address,'to')===work.coordinator_session_id
  else {
    const identity=decodeIdentityAddress(address,'to')
    matches=identity.kind==='user' ? identity.id===input.assistantId : (await deps.resolveNumbers([identity.number])).get(identity.number)===input.assistantId
  }
  if(!matches || work.coordinator_session_id===input.sessionId) throw fail('WORK_COORDINATOR_MISMATCH')
  const text=input.record.text
  if(typeof text!=='string'||!text.trim()) throw new Error('message text is required')
  // A commit can succeed before its acknowledgement times out. Recover its original file references;
  // uploading again would change the operation hash even when the report IDs are stable.
  let page=data as {events?:Record<string,unknown>[];next_after?:string|null}|null
  let previous:Record<string,unknown>|undefined
  const cursors=new Set<string>(['0'])
  while(page) {
    previous=page.events?.find(row=>row.message_id===messageId)
    if(previous || !page.next_after) break
    if(cursors.has(page.next_after)) throw fail('WORK_HISTORY_CURSOR_INVALID')
    cursors.add(page.next_after)
    const next=await deps.rpc('assistant_work_history',{p_assistant:input.assistantId,p_work_id:report.work_id,p_after:page.next_after,p_limit:100})
    if(next.error) throw Object.assign(new Error(next.error.message),{code:next.error.code})
    page=next.data as typeof page
  }
  if(previous && (previous.kind!==report.status || previous.from_session_id!==input.sessionId || previous.from_device_id!==input.deviceId
    || previous.to_session_id!==work.coordinator_session_id || previous.to_device_id!==work.coordinator_device_id || previous.content!==text
    || (previous.reason_code??null)!==(input.reasonCode??null))) throw fail('WORK_REPORT_ID_CONFLICT')
  if(previous?.source_available===false) throw fail('SOURCE_UNAVAILABLE')
  let attachments:SessionAttachmentRef[]=[]
  if(previous) {
    if(!Array.isArray(previous.attachment_refs)) throw fail('WORK_REPORT_ATTACHMENTS_UNAVAILABLE')
    attachments=previous.attachment_refs as SessionAttachmentRef[]
  } else if(input.record.files!==undefined) {
    const files=z.array(z.object({file_path:z.string().min(1),file_name:z.string().optional(),mime_type:z.string().optional()})).min(1).max(8).parse(input.record.files)
    attachments=await deps.prepare(files,{sessionId:work.coordinator_session_id,deviceId:work.coordinator_device_id,agentId:input.assistantId})
  }
  const accepted=await enqueueAssistantWorkDelivery({rpc:deps.rpc},{
    assistantId:input.assistantId,runtimeInstanceId:input.runtimeInstanceId,operationId,workId:work.work_id,task:null,
    events:[{message_id:messageId,kind:report.status,from_session_id:input.sessionId,from_device_id:input.deviceId,
      to_session_id:work.coordinator_session_id,to_device_id:work.coordinator_device_id,content:text,attachment_refs:attachments,...(input.reasonCode ? {reason_code:input.reasonCode} : {})}],
  })
  return {...accepted,route:'session-direct' as const,recipients:[{to:address,session_id:work.coordinator_session_id,status:'accepted' as const,message_id:messageId}]}
}
