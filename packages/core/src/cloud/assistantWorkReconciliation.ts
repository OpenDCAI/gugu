import { assistantWorkNoticeReason } from './assistantWorkNoticeReason'
import { enqueueAssistantWorkDelivery, type AssistantWorkRpcClient } from './assistantWorkOutbox'
import { assistantWorkCoordinator, type AssistantWorkAddress } from './assistantWorkRouting'

export type ReconciledWork = {
  coordinator_current?: AssistantWorkAddress | null
  work_id:string;assistant_user_id:string;title:string;coordinator_session_id:string;coordinator_device_id:string;
  executors:Array<{session_id:string;device_id:string}>;outcome:string;executor_outcomes:Record<string,{status:string;origin?:string}>
}
export type WorkReconciliationEvent = {
  message_id:string;kind:string;work_id?:string;assistant_user_id?:string;from_session_id?:string;from_device_id?:string;
  to_session_id?:string;to_device_id?:string;to_device_label?:string|null;platform_received_at?:string;executor_admitted_at?:string|null;
  assistant_admitted_at?:string|null;owner_delivered_at?:string|null;terminal_origin?:string|null;reason_code?:string|null;
  executor_session_id?:string|null;
  abandonment_notified_at?:string|null;abandoned_reason_code?:string|null
}
export type WorkOwnerReceiptProof = {eventId:string;chatId:string;messageId:string}
export type WorkReconciliationContext = {ownerId:string;runtimeInstanceId:string;deviceId:string;assistantId:string;client:AssistantWorkRpcClient}
export type ExecutorDeliveryProof = {preview?:{running?:boolean;ended?:{kind?:string;reason?:string}|null;entries?:Array<{kind:string;messageId?:string|null}>;error?:unknown}}
const RECONCILIATION_GRACE_MS=120_000
export const isOwnerReceiptEvent=(event:WorkReconciliationEvent)=>['completed','failed','cancelled','question'].includes(event.kind)
const isAbandonmentNoticeEvent=(event:WorkReconciliationEvent)=>event.kind==='dispatch'||isOwnerReceiptEvent(event)
const failureReason = (code:string|undefined|null) => ({
  REPORT_MISSING:'这件事没有交回结果',EXECUTION_FAILED:'执行时出了错，结果没有交回',INTERRUPTED:'执行中断了，结果没有交回',
  SOURCE_UNAVAILABLE:'原来的内容已无法读取',INCOMPATIBLE:'接收设备的版本不兼容',UNREACHABLE:'一直无法联系到接收设备',
  NO_RESPONSE:'接收设备一直没有应答',PERMISSION:'没有取得接收权限',DELIVERY_FAILED:'交付没有成功，具体原因尚未确认',
}[assistantWorkNoticeReason(code)]!)

/** Only definite native endings justify an inference; idle, long silence and missing records do not. */
export function createAssistantWorkReconciler(deps:{
  context():Promise<WorkReconciliationContext|null>
  works(ctx:WorkReconciliationContext):Promise<ReconciledWork[]>
  history(ctx:WorkReconciliationContext,work:ReconciledWork):Promise<WorkReconciliationEvent[]>
  abandoned(ctx:WorkReconciliationContext):Promise<WorkReconciliationEvent[]>
  inspect(ctx:WorkReconciliationContext,work:ReconciledWork,target:{session_id:string;device_id:string}):Promise<ExecutorDeliveryProof|null>
  ownerReceipts?(ctx:WorkReconciliationContext,work:ReconciledWork,events:WorkReconciliationEvent[]):Promise<WorkOwnerReceiptProof[]>
  notify(ctx:WorkReconciliationContext,key:string,text:string):Promise<{chatId:string;messageId:string}>
  verifyOwnerPost(ctx:WorkReconciliationContext,posted:{chatId:string;messageId:string}):Promise<boolean>
  clean(work:ReconciledWork):void
  stableId(key:string):Promise<string>
  warn(detail:{code:string}):void
  now?:()=>number
}) {
  let flight:Promise<void>|null=null
  let stopped=false
  const now=deps.now??Date.now
  const postedNotices=new Map<string,{chatId:string;messageId:string}>()
  const current=async(ctx:WorkReconciliationContext)=>{
    const next=await deps.context()
    return !stopped&&next?.ownerId===ctx.ownerId&&next.runtimeInstanceId===ctx.runtimeInstanceId
  }
  const receipt=async(ctx:WorkReconciliationContext,event:WorkReconciliationEvent,kind:'result'|'abandonment_notice',posted:{chatId:string;messageId:string})=>{
    if(!await current(ctx)||!await deps.verifyOwnerPost(ctx,posted)) return false
    const {error}=await ctx.client.rpc('assistant_work_owner_delivered',{p_assistant:ctx.assistantId,p_runtime_instance_id:ctx.runtimeInstanceId,
      p_message_id:event.message_id,p_owner_chat_id:posted.chatId,p_owner_message_id:posted.messageId,p_receipt_kind:kind})
    if(error) throw error
    return true
  }
  const notify=async(ctx:WorkReconciliationContext,event:WorkReconciliationEvent,work:ReconciledWork,kind:'result'|'abandonment_notice')=>{
    const reason=failureReason(kind==='result'?event.reason_code:event.abandoned_reason_code)
    const category=assistantWorkNoticeReason(kind==='result'?event.reason_code:event.abandoned_reason_code)
    const noticeKind=event.kind==='completed'?'completed':'handoff'
    const key=await deps.stableId(`work-notice:${ctx.assistantId}:${work.work_id}:${noticeKind}:${category}`)
    if(!await current(ctx)) return
    const label=event.to_device_label?.trim()
    const text=kind==='abandonment_notice'&&event.abandoned_reason_code==='DELIVERY_EXPIRED'
      ? `「${work.title}」发给${label?`「${label}」`:'目标'}设备的${event.kind==='dispatch'?'活':'回报'}没送到：已超过 24 小时。`
      : `「${work.title}」有消息没能送到：${reason}。`
    // The committed idempotent owner message is the proof. Losing its RPC reply cannot produce another notice.
    let posted=postedNotices.get(key)
    if(!posted) {
      posted=await deps.notify(ctx,key,text)
      if(!await deps.verifyOwnerPost(ctx,posted)) return false
      if(postedNotices.size>=1024) postedNotices.delete(postedNotices.keys().next().value!)
      postedNotices.set(key,posted)
    }
    return receipt(ctx,event,kind,posted)
  }
  const reconcileWork=async(ctx:WorkReconciliationContext,work:ReconciledWork)=>{
    const coordinator=assistantWorkCoordinator(work)
    if(work.assistant_user_id!==ctx.assistantId||coordinator?.device_id!==ctx.deviceId) return
    const events=await deps.history(ctx,work)
    const delivered=new Set(events.filter(event=>event.owner_delivered_at).map(event=>event.message_id))
    // Only a committed post from the same native report turn can prove owner delivery.
    // Native history is durable, so a lost receipt RPC is retried without a second outbox.
    if(deps.ownerReceipts) {
      const eligible=events.filter(isOwnerReceiptEvent)
      const proofs=eligible.length?await deps.ownerReceipts(ctx,work,eligible):[]
      for(const proof of proofs) {
        const event=events.find(e=>e.message_id===proof.eventId&&e.assistant_admitted_at&&!e.owner_delivered_at)
        if(!event) continue
        try { if(await receipt(ctx,event,'result',proof)) delivered.add(event.message_id) }
        catch { deps.warn({code:'WORK_OWNER_RECEIPT_UNAVAILABLE'}) }
      }
    }
    for(const event of events) {
      const inferredFailure=event.kind==='failed'&&event.terminal_origin==='coordinator'
      const hostFailure=event.kind==='progress'&&event.reason_code==='HOST_FAILURE'
      const targetId=inferredFailure?event.executor_session_id:event.from_session_id
      const nativeTerminal=targetId?work.executor_outcomes[targetId]:undefined
      const superseded=['completed','cancelled'].includes(work.outcome)
        || (nativeTerminal?.origin==='executor'&&['completed','cancelled','failed'].includes(nativeTerminal.status))
      if(superseded) continue
      if(hostFailure&&targetId&&!events.some(e=>e.kind==='failed'&&e.terminal_origin==='coordinator'&&e.executor_session_id===targetId&&e.reason_code==='HOST_FAILURE')) {
        const key=await deps.stableId(`host-failure:${work.work_id}:${event.message_id}`)
        await enqueueAssistantWorkDelivery(ctx.client,{assistantId:ctx.assistantId,runtimeInstanceId:ctx.runtimeInstanceId,operationId:key,workId:work.work_id,task:null,
          events:[{message_id:key,kind:'failed',from_session_id:coordinator.session_id,from_device_id:coordinator.device_id,to_session_id:work.coordinator_session_id,to_device_id:work.coordinator_device_id,executor_session_id:targetId,reason_code:'HOST_FAILURE',
            content:'任务运行已中断。这是平台推断的失败，平台会直接通知你，请勿重复通知；迟到的真实结果仍需正常交付。'}]})
      }
      if(inferredFailure&&event.assistant_admitted_at&&!delivered.has(event.message_id)) {
        try { if(await notify(ctx,event,work,'result')) delivered.add(event.message_id) }
        catch { deps.warn({code:'WORK_NOTICE_NOT_COMMITTED'}) }
      }
    }
    if(work.outcome!=='active') {
      if(!events.some(e=>isOwnerReceiptEvent(e)&&e.assistant_admitted_at&&!delivered.has(e.message_id))) deps.clean(work)
      return
    }
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
        events:[{message_id:key,kind:'failed',from_session_id:coordinator.session_id,from_device_id:coordinator.device_id,
          to_session_id:work.coordinator_session_id,to_device_id:work.coordinator_device_id,executor_session_id:target.session_id,reason_code:reason,
          content:`任务没有交回结果：${failureReason(reason)}。平台已单独发出失败说明，不用再转告；迟到的真实结果仍照常交付。`}]})
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
      if(event.assistant_user_id!==ctx.assistantId||event.abandonment_notified_at||!isAbandonmentNoticeEvent(event)) continue
      const work=works.find(w=>w.work_id===event.work_id)
      if(!work||event.owner_delivered_at) continue
      const coordinator=assistantWorkCoordinator(work)
      if(coordinator?.device_id!==ctx.deviceId) continue
      const targetId=event.executor_session_id??(event.kind==='dispatch'?event.to_session_id:event.from_session_id)
      const actual=targetId?work.executor_outcomes[targetId]:undefined
      if((event.terminal_origin==='coordinator'||event.kind==='question'||event.kind==='dispatch')
        && (['completed','cancelled'].includes(work.outcome)||actual?.origin==='executor')) continue
      try {
        if(event.kind==='dispatch'&&targetId&&await current(ctx)) {
          const key=await deps.stableId(`dispatch-failure:${work.work_id}:${event.message_id}`)
          await enqueueAssistantWorkDelivery(ctx.client,{assistantId:ctx.assistantId,runtimeInstanceId:ctx.runtimeInstanceId,operationId:key,workId:work.work_id,task:null,
            events:[{message_id:key,kind:'failed',from_session_id:coordinator.session_id,from_device_id:coordinator.device_id,to_session_id:work.coordinator_session_id,to_device_id:work.coordinator_device_id,executor_session_id:targetId,reason_code:event.abandoned_reason_code??'DELIVERY_FAILED',
              content:'任务派发未取得受理回执。这是协调者推断，平台会直接发送一条失败说明给账号本人，请勿重复通知；迟到的真实结果仍需正常交付。'}]})
        }
        await notify(ctx,event,work,'abandonment_notice')
      }
      catch { deps.warn({code:'WORK_NOTICE_NOT_COMMITTED'}) }
    }
  }
  return {kick():Promise<void>{
    if(stopped) return Promise.resolve()
    if(!flight) flight=run().catch(()=>deps.warn({code:'WORK_RECONCILIATION_UNAVAILABLE'})).finally(()=>{flight=null})
    return flight
  },stop(){stopped=true}}
}
