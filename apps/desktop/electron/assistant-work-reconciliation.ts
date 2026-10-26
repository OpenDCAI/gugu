import { createHash } from 'node:crypto'
import { createAssistantWorkReconciler, type ExecutorDeliveryProof, type ReconciledWork, type WorkReconciliationContext, type WorkReconciliationEvent, type WorkOwnerReceiptProof } from '@gugu/core/cloud/assistantWorkReconciliation'
import type { AssistantWorkHostContext } from './assistant-work-outbox'

const stableId=async(key:string)=>{
  const hex=createHash('sha256').update(key).digest('hex')
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`
}
async function rpc(ctx:WorkReconciliationContext,name:string,args:Record<string,unknown>) {
  const {data,error}=await ctx.client.rpc(name,args)
  if(error) throw error
  if(!data||typeof data!=='object') throw new Error('Invalid reconciliation response')
  return data as Record<string,unknown>
}

/** Account projection reads stay outside model tools and reuse the host's existing lease cadence. */
export function createDesktopAssistantWorkReconciler(deps:{
  context():Promise<AssistantWorkHostContext|null>
  assistant(ctx:AssistantWorkHostContext):Promise<{agentId:string;deviceId:string;sessionId:string}|null>
  inspect(ctx:WorkReconciliationContext,work:ReconciledWork,target:{session_id:string;device_id:string}):Promise<ExecutorDeliveryProof|null>
  ownerReceipts?(ctx:WorkReconciliationContext,work:ReconciledWork,events:WorkReconciliationEvent[]):Promise<WorkOwnerReceiptProof[]>
  notify(ctx:WorkReconciliationContext,key:string,text:string):Promise<{chatId:string;messageId:string}>
  verifyOwnerPost(ctx:WorkReconciliationContext,posted:{chatId:string;messageId:string}):Promise<boolean>
  clean(work:ReconciledWork):void
  warn(detail:{code:string}):void
}) {
  let cursor:{ownerId:string;assistantId:string;before:string|null}|null=null
  return createAssistantWorkReconciler({
    context:async()=>{
      const ctx=await deps.context()
      if(!ctx) return null
      const assistant=await deps.assistant(ctx)
      if(assistant?.deviceId!==ctx.deviceId||!assistant.sessionId) return null
      return {...ctx,assistantId:assistant.agentId}
    },
    works:async(ctx)=>{
      // A first bind may see no rows. Reconcile newly imported historical work
      // on every pass; the server performs no UPDATE when its address is unchanged.
      const assistant=await deps.assistant(ctx)
      if(assistant?.agentId!==ctx.assistantId||assistant.deviceId!==ctx.deviceId||!assistant.sessionId) throw new Error('Assistant home changed')
      const {error}=await ctx.client.rpc('assistant_work_coordinator_bind',{
        p_assistant:ctx.assistantId,p_runtime_instance_id:ctx.runtimeInstanceId,p_session_id:assistant.sessionId,
      })
      if(error) throw error
      const current=await deps.context()
      if(current?.ownerId!==ctx.ownerId||current.runtimeInstanceId!==ctx.runtimeInstanceId||current.deviceId!==ctx.deviceId) throw new Error('Runtime changed')
      const before=cursor?.ownerId===ctx.ownerId&&cursor.assistantId===ctx.assistantId?cursor.before:null
      const result=await rpc(ctx,'assistant_work_list',{p_assistant:ctx.assistantId,p_before:before,p_limit:100,p_reconcile_only:true})
      if(!Array.isArray(result.items)) throw new Error('Invalid work list')
      cursor={ownerId:ctx.ownerId,assistantId:ctx.assistantId,before:result.next_before?String(result.next_before):null}
      return result.items as ReconciledWork[]
    },
    history:async(ctx,work)=>{
      const events:WorkReconciliationEvent[]=[]
      let after='0'
      for(let page=0;page<20;page++) {
        const result=await rpc(ctx,'assistant_work_history',{p_assistant:ctx.assistantId,p_work_id:work.work_id,p_after:after,p_limit:200})
        if(!Array.isArray(result.events)) throw new Error('Invalid work history')
        events.push(...result.events as WorkReconciliationEvent[])
        if(!result.next_after) return events
        after=String(result.next_after)
      }
      throw new Error('Work history page limit exceeded')
    },
    abandoned:async(ctx)=>{
      const result=await rpc(ctx,'assistant_work_abandoned',{p_runtime_instance_id:ctx.runtimeInstanceId,p_limit:100})
      if(!Array.isArray(result.events)) throw new Error('Invalid abandoned work list')
      return result.events as WorkReconciliationEvent[]
    },
    inspect:deps.inspect,ownerReceipts:deps.ownerReceipts,notify:deps.notify,verifyOwnerPost:deps.verifyOwnerPost,clean:deps.clean,warn:deps.warn,stableId,
  })
}
