import type { AssistantWorkOutboxContext, AssistantWorkRpcClient } from './assistantWorkOutbox'

type NoticeClaim={anchor_message_id:string;coordinator_device_id:string;lease_token:string;lease_remaining_ms:number;wake_attempts?:number}
/** Wake credits, leases and backoff live on the original cloud event, including across restarts. */
export function createAssistantWorkNoticeWakePump(deps:{
  context():Promise<AssistantWorkOutboxContext|null>
  rpc(name:string,args:Record<string,unknown>,ctx:AssistantWorkOutboxContext):ReturnType<AssistantWorkRpcClient['rpc']>
  wake(home:string,signal:AbortSignal):Promise<unknown>
  request(home:string,signal:AbortSignal):Promise<unknown>
  warn(detail:{code:string}):void
  /** A claimed notice is claimable again in `ms` (the claim already set its backoff; no event announces it). */
  retryIn?(ms:number):void
}) {
  let flight:Promise<void>|null=null
  let stopped=false
  const active=new Set<AbortController>()
  const rpc=async(ctx:AssistantWorkOutboxContext,name:string,args:Record<string,unknown>)=>{
    let timer:ReturnType<typeof setTimeout>|undefined
    try {
      const result=await Promise.race([Promise.resolve(deps.rpc(name,args,ctx)),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Notice RPC timeout')),8000)})])
      if(result.error) throw result.error
      return result.data
    } finally {if(timer) clearTimeout(timer)}
  }
  const run=async()=>{
    const ctx=await deps.context()
    if(stopped||!ctx) return
    const started=performance.now()
    const response=await rpc(ctx,'assistant_work_notice_wake_claim',{p_runtime_instance_id:ctx.runtimeInstanceId,p_limit:20,p_lease_seconds:60}) as {items?:NoticeClaim[]}|null
    if(!Array.isArray(response?.items)) throw new Error('Invalid notice claims')
    const groups=new Map<string,NoticeClaim[]>()
    for(const item of response.items) {
      if(!item.anchor_message_id||!item.lease_token||!item.coordinator_device_id||!Number.isFinite(item.lease_remaining_ms)) throw new Error('Invalid notice claim')
      const group=groups.get(item.coordinator_device_id)??[];group.push(item);groups.set(item.coordinator_device_id,group)
      // The claim set available_at = now + 30 s × 2^(attempts before it), at most 900 s (assistant_work_notice_wake_claim).
      if(Number.isInteger(item.wake_attempts)&&item.wake_attempts!>0) deps.retryIn?.(Math.min(900,30*2**(item.wake_attempts!-1))*1000)
    }
    const homes=[...groups.entries()]
    await Promise.all([0,1].map(async()=>{
      while(!stopped&&homes.length) {
        const [home,claims]=homes.shift()!
        let timer:ReturnType<typeof setTimeout>|undefined
        const controller=new AbortController();active.add(controller)
        try {
          const current=await deps.context()
          if(stopped||current?.ownerId!==ctx.ownerId||current.runtimeInstanceId!==ctx.runtimeInstanceId) return
          const budget=Math.min(45000,...claims.map(item=>item.lease_remaining_ms))-Math.max(0,performance.now()-started)-5000
          if(budget<=0||home===ctx.deviceId) continue
          await Promise.race([
            (async()=>{await deps.wake(home,controller.signal);controller.signal.throwIfAborted();await deps.request(home,controller.signal)})(),
            new Promise<never>((_,reject)=>{
              timer=setTimeout(()=>{controller.abort(new Error('Notice home deadline exceeded'));reject(controller.signal.reason)},budget)
              controller.signal.addEventListener('abort',()=>reject(controller.signal.reason),{once:true})
            }),
          ])
        } catch {deps.warn({code:'WORK_NOTICE_HOME_UNAVAILABLE'})}
        finally {
          if(timer) clearTimeout(timer);active.delete(controller)
          for(const claim of claims) {
            try {await rpc(ctx,'assistant_work_notice_wake_release',{p_runtime_instance_id:ctx.runtimeInstanceId,p_anchor_message_id:claim.anchor_message_id,p_lease_token:claim.lease_token})}
            catch {deps.warn({code:'WORK_NOTICE_LEASE_RELEASE_FAILED'})}
          }
        }
      }
    }))
  }
  return {kick():Promise<void>{
    if(stopped) return Promise.resolve()
    if(!flight) flight=run().catch(()=>deps.warn({code:'WORK_NOTICE_RECONCILIATION_UNAVAILABLE'})).finally(()=>{flight=null})
    return flight
  },stop(){stopped=true;for(const controller of active)controller.abort(new Error('Notice wake stopped'))}}
}
