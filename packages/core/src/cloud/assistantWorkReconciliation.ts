import { enqueueAssistantWorkDelivery, type AssistantWorkRpcClient } from './assistantWorkOutbox'

export type ReconciledWork = {
  work_id:string;assistant_user_id:string;title:string;coordinator_session_id:string;coordinator_device_id:string;
  executors:Array<{session_id:string;device_id:string}>;outcome:string;executor_outcomes:Record<string,{status:string;origin?:string}>
}
export type WorkReconciliationEvent = {
  message_id:string;kind:string;work_id?:string;assistant_user_id?:string;from_session_id?:string;from_device_id?:string;
  to_session_id?:string;to_device_id?:string;platform_received_at?:string;executor_admitted_at?:string|null;
  assistant_admitted_at?:string|null;owner_delivered_at?:string|null;terminal_origin?:string|null;reason_code?:string|null;
  executor_session_id?:string|null;
  abandonment_notified_at?:string|null;abandoned_reason_code?:string|null
}
export type WorkOwnerReceiptProof = {eventId:string;chatId:string;messageId:string}
export type WorkReconciliationContext = {ownerId:string;runtimeInstanceId:string;deviceId:string;assistantId:string;client:AssistantWorkRpcClient}
export type ExecutorDeliveryProof = {preview?:{running?:boolean;ended?:{kind?:string;reason?:string}|null;entries?:Array<{kind:string;messageId?:string|null}>;error?:unknown}}
const RECONCILIATION_GRACE_MS=120_000
const failureReason = (code:string|undefined|null) => {
  if(code==='EXECUTOR_ENDED_WITHOUT_REPORT') return '执行已经结束，但没有交回结果'
  if(code==='LEGACY_REPORT_MISSING') return '这件事一直没有交回结果'
  if(code==='EXECUTOR_FAILED') return '执行时出了错，结果没有交回'
  if(code==='HOST_FAILURE') return '执行中断了，结果没有交回'
  if(code==='EXECUTOR_CANCELLED_WITHOUT_REPORT') return '执行被中断，结果没有交回'
  if(code==='SOURCE_UNAVAILABLE') return '原来的内容已无法读取'
  if(code==='DELIVERY_HOST_OUTDATED'||code==='UNKNOWN_METHOD') return '接收设备的版本不兼容'
  if(code==='DEVICE_UNREACHABLE'||code==='DEVICE_OFFLINE') return '一直无法联系到接收设备'
  if(code?.includes('TIMEOUT')||code==='DELIVERY_EXPIRED') return '接收设备一直没有应答'
  if(code?.includes('AUTH')||code?.includes('PERMISSION')) return '没有取得接收权限'
  return '交付没有成功，具体原因尚未确认'
}

/** Only definite native endings justify an inference; idle, long silence and missing records do not. */
export function createAssistantWorkReconciler(deps:{
  context():Promise<WorkReconciliationContext|null>
  works(ctx:WorkReconciliationContext):Promise<ReconciledWork[]>
  history(ctx:WorkReconciliationContext,work:ReconciledWork):Promise<WorkReconciliationEvent[]>
  abandoned(ctx:WorkReconciliationContext):Promise<WorkReconciliationEvent[]>
  inspect(ctx:WorkReconciliationContext,work:ReconciledWork,target:{session_id:string;device_id:string}):Promise<ExecutorDeliveryProof|null>
  ownerReceipts?(ctx:WorkReconciliationContext,work:ReconciledWork,events:WorkReconciliationEvent[]):Promise<WorkOwnerReceiptProof[]>
  notify(ctx:WorkReconciliationContext,key:string,text:string):Promise<{chatId:string;messageId:string}>
  clean(work:ReconciledWork):void
  stableId(key:string):Promise<string>
  warn(detail:{code:string}):void
  now?:()=>number
}) {
  let flight:Promise<void>|null=null
  let stopped=false
  const now=deps.now??Date.now
  const current=async(ctx:WorkReconciliationContext)=>{
    const next=await deps.context()
    return !stopped&&next?.ownerId===ctx.ownerId&&next.runtimeInstanceId===ctx.runtimeInstanceId
  }
  const receipt=async(ctx:WorkReconciliationContext,event:WorkReconciliationEvent,kind:'result'|'abandonment_notice',posted:{chatId:string;messageId:string})=>{
    if(!await current(ctx)) return
    const {error}=await ctx.client.rpc('assistant_work_owner_delivered',{p_assistant:ctx.assistantId,p_runtime_instance_id:ctx.runtimeInstanceId,
      p_message_id:event.message_id,p_owner_chat_id:posted.chatId,p_owner_message_id:posted.messageId,p_receipt_kind:kind})
    if(error) throw error
  }
  const notify=async(ctx:WorkReconciliationContext,event:WorkReconciliationEvent,work:ReconciledWork,kind:'result'|'abandonment_notice')=>{
    const key=await deps.stableId(`work-notice:${event.message_id}:${kind}`)
    if(!await current(ctx)) return
    const text=`「${work.title}」这件没能交回：${failureReason(kind==='result'?event.reason_code:event.abandoned_reason_code)}。`
    // The committed idempotent owner message is the proof. Losing its RPC reply cannot produce another notice.
    const posted=await deps.notify(ctx,key,text)
    await receipt(ctx,event,kind,posted)
  }
  const reconcileWork=async(ctx:WorkReconciliationContext,work:ReconciledWork)=>{
    if(work.assistant_user_id!==ctx.assistantId||work.coordinator_device_id!==ctx.deviceId) return
    const events=await deps.history(ctx,work)
    const delivered=new Set(events.filter(event=>event.owner_delivered_at).map(event=>event.message_id))
    // Only a committed post from the same native report turn can prove owner delivery.
    // Native history is durable, so a lost receipt RPC is retried without a second outbox.
    if(deps.ownerReceipts) {
      const proofs=await deps.ownerReceipts(ctx,work,events)
      for(const proof of proofs) {
        const event=events.find(e=>e.message_id===proof.eventId&&e.assistant_admitted_at&&!e.owner_delivered_at)
        if(!event) continue
        await receipt(ctx,event,'result',proof)
        delivered.add(event.message_id)
      }
    }
    for(const event of events) {
      const inferredFailure=event.kind==='failed'&&event.terminal_origin==='coordinator'
      const hostFailure=event.kind==='progress'&&event.reason_code==='HOST_FAILURE'
      const targetId=inferredFailure?event.executor_session_id:event.from_session_id
      const nativeTerminal=targetId?work.executor_outcomes[targetId]:undefined
      const superseded=['completed','cancelled'].includes(work.outcome)
        || (nativeTerminal?.origin==='executor'&&['completed','cancelled','failed'].includes(nativeTerminal.status))
      if((inferredFailure||hostFailure)&&!superseded&&event.assistant_admitted_at&&!delivered.has(event.message_id)) await notify(ctx,event,work,'result')
    }
    if(work.outcome!=='active') { deps.clean(work); return }
    for(const target of work.executors) {
      if(work.executor_outcomes[target.session_id]) continue
      const dispatchIndex=events.findLastIndex(e=>e.kind==='dispatch'&&e.to_session_id===target.session_id)
      const dispatch=events[dispatchIndex]
      if(!dispatch?.executor_admitted_at||!dispatch.platform_received_at) continue
      // A durable report already received by the platform must be delivered, never replaced by a failure.
      const reports=events.slice(dispatchIndex+1).filter(e=>e.from_session_id===target.session_id&&e.kind!=='dispatch')
      if(reports.some(e=>['completed','cancelled','failed','question','blocked'].includes(e.kind)||e.reason_code==='HOST_FAILURE')) continue
      const lastAt=Math.max(Date.parse(dispatch.platform_received_at),...reports.map(e=>Date.parse(e.platform_received_at??'')))
      if(!Number.isFinite(lastAt)||now()-lastAt<RECONCILIATION_GRACE_MS) continue
      const proof=await deps.inspect(ctx,work,target)
      const preview=proof?.preview
      if(preview?.running!==false||!['done','error','cancelled'].includes(preview.ended?.kind??'')||preview.error) continue
      const latestPrompt=preview.entries?.filter(e=>e.kind==='prompt').at(-1)
      if(latestPrompt?.messageId?.replace(/^msg:/,'')!==dispatch.message_id.replace(/^msg:/,'')) continue
      const reason=preview.ended!.kind==='error'?'EXECUTOR_FAILED'
        : preview.ended!.kind==='cancelled'?'EXECUTOR_CANCELLED_WITHOUT_REPORT':'EXECUTOR_ENDED_WITHOUT_REPORT'
      if(!await current(ctx)) return
      const key=await deps.stableId(`missing-report:${work.work_id}:${target.session_id}:${dispatch.message_id}`)
      await enqueueAssistantWorkDelivery(ctx.client,{assistantId:ctx.assistantId,runtimeInstanceId:ctx.runtimeInstanceId,operationId:key,workId:work.work_id,task:null,
        events:[{message_id:key,kind:'failed',from_session_id:work.coordinator_session_id,from_device_id:ctx.deviceId,
          to_session_id:work.coordinator_session_id,to_device_id:ctx.deviceId,executor_session_id:target.session_id,reason_code:reason,
          content:`任务没有交回结果：${failureReason(reason)}。这是平台对账记录，平台会直接给主人一次失败说明，请勿重复通知；执行者迟到的真实结果仍需正常交付。`}]})
    }
  }
  const run=async()=>{
    const ctx=await deps.context()
    if(stopped||!ctx) return
    const works=await deps.works(ctx)
    for(const work of works) {
      try { if(!await current(ctx)) return;await reconcileWork(ctx,work) }
      catch { deps.warn({code:'WORK_RECONCILIATION_FAILED'}) }
    }
    for(const event of await deps.abandoned(ctx)) {
      const home=event.kind==='dispatch'?event.from_device_id:event.to_device_id
      if(event.assistant_user_id!==ctx.assistantId||home!==ctx.deviceId||event.abandonment_notified_at) continue
      const work=works.find(w=>w.work_id===event.work_id)
      if(!work) continue
      try { await notify(ctx,event,work,'abandonment_notice') }
      catch { deps.warn({code:'WORK_NOTICE_NOT_COMMITTED'}) }
    }
  }
  return {kick():Promise<void>{
    if(stopped) return Promise.resolve()
    if(!flight) flight=run().catch(()=>deps.warn({code:'WORK_RECONCILIATION_UNAVAILABLE'})).finally(()=>{flight=null})
    return flight
  },stop(){stopped=true}}
}
