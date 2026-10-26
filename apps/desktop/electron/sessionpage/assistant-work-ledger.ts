import { createHash } from 'node:crypto'
import { enqueueAssistantWorkDelivery,type AssistantWorkRpcClient } from '@gugu/core/cloud/assistantWorkOutbox'
import type { SessionAttachmentRef } from '@gugu/core/cloud/sessionAttachments'
import { assistantWorkIntentSchema,type AssistantWorkIntent,type AssistantWorkTarget } from '@gugu/core/shared/assistantWorkIntent'

type Context = { client:AssistantWorkRpcClient;ownerId:string;runtimeInstanceId:string;deviceId:string }
type Host = { context:()=>Promise<Context|null>;kick:()=>unknown }
let installed: Host | null = null
export function installAssistantWorkLedgerHost(host:Host):()=>void {
  installed=host
  return ()=>{ if(installed===host) installed=null }
}
export async function assistantWorkLedgerContext():Promise<Context> {
  const context=await installed?.context()
  if(!context) throw new Error('Assistant work account runtime is unavailable')
  return context
}
const messageFor = (base:string,session:string) => {
  const hex=createHash('sha256').update(`${base}:${session}`).digest('hex')
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`
}

/** Resolving targets is read-only. The single queue owns every subsequent delivery. */
export async function enqueueAssistantWorkMessage(raw:AssistantWorkIntent,text:string,attachments:SessionAttachmentRef[],targets:AssistantWorkTarget[]) {
  const intent=assistantWorkIntentSchema.parse(raw)
  const context=await assistantWorkLedgerContext()
  if(context.deviceId!==intent.coordinator.device_id || !targets.length || targets.some(t=>!t.sessionId || !t.deviceId)) throw new Error('Assistant work dispatch endpoints changed')
  const events=targets.map(target=>({
    message_id:target.sessionId===intent.child_session_id ? intent.message_id : messageFor(intent.message_id,target.sessionId),
    kind:'dispatch' as const,from_session_id:intent.coordinator.session_id,from_device_id:context.deviceId,
    to_session_id:target.sessionId,to_device_id:target.deviceId,content:text,attachment_refs:attachments,
  }))
  const accepted=await enqueueAssistantWorkDelivery(context.client,{
    assistantId:intent.assistant_id,runtimeInstanceId:context.runtimeInstanceId,operationId:intent.operation_id,workId:intent.work_id,
    task:intent.continuation ? null : { title:intent.title,coordinator_session_id:intent.coordinator.session_id,
      // Identity is bound from the receiver's admission receipt; retrying after provisioning
      // must retain exactly the same immutable dispatch request.
      executors:targets.map(t=>({session_id:t.sessionId,device_id:t.deviceId})),
      ...(intent.source_link ? {source_link:intent.source_link} : {}) },events,
  })
  // A local kick failure cannot undo or obscure an already committed cloud acceptance.
  try { void Promise.resolve(installed?.kick()).catch(()=>undefined) } catch { /* The runtime pump also observes the account event. */ }
  return { ...accepted,route:'session-direct' as const,recipients:targets.map((target,index)=>({
    to:`session:${target.sessionId}`,session_id:target.sessionId,status:'accepted' as const,message_id:events[index]!.message_id,
  })) }
}
