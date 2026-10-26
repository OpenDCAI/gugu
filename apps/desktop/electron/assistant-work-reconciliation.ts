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
  assistant(ctx:AssistantWorkHostContext):Promise<{agentId:string;deviceId:string}|null>
  inspect(ctx:WorkReconciliationContext,work:ReconciledWork,target:{session_id:string;device_id:string}):Promise<ExecutorDeliveryProof|null>
  ownerReceipts?(ctx:WorkReconciliationContext,work:ReconciledWork,events:WorkReconciliationEvent[]):Promise<WorkOwnerReceiptProof[]>
  notify(ctx:WorkReconciliationContext,key:string,text:string):Promise<{chatId:string;messageId:string}>
  clean(work:ReconciledWork):void
  warn(detail:{code:string}):void
}) {
  return createAssistantWorkReconciler({
    context:async()=>{
      const ctx=await deps.context()
      if(!ctx) return null
      const assistant=await deps.assistant(ctx)
      return assistant?.deviceId===ctx.deviceId?{...ctx,assistantId:assistant.agentId}:null
    },
    works:async(ctx)=>{
      const rows:ReconciledWork[]=[]
      let before:string|null=null
      for(let page=0;page<20;page++) {
        const result=await rpc(ctx,'assistant_work_list',{p_assistant:ctx.assistantId,p_before:before,p_limit:100})
        if(!Array.isArray(result.items)) throw new Error('Invalid work list')
        rows.push(...result.items as ReconciledWork[])
        if(!result.next_before) return rows
        before=String(result.next_before)
      }
      throw new Error('Work reconciliation page limit exceeded')
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
    inspect:deps.inspect,ownerReceipts:deps.ownerReceipts,notify:deps.notify,clean:deps.clean,warn:deps.warn,stableId,
  })
}
