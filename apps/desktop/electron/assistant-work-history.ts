import {z} from 'zod'
import {readDeliveryEnvelope} from '@gugu/core/local/agent/deliveryEnvelope'
import {legacyAssistantDispatch,type HistoricalWorkEvent} from '@gugu/core/shared/assistantWorkHistory'
import type {AssistantWorkHostContext} from './assistant-work-outbox'

export type WorkHistoryPosition={after:number;retry:number[]}
type Receipt={id:string;position:number;sessionId:string;content:string;timestamp:string;title:string;spawnedBySessionId:string|null;spawnedByRemote:{sessionId:string;deviceId:string;agentUserId?:string}|null}
const resultSchema=z.object({work_id:z.uuid(),status:z.enum(['progress','question','completed','cancelled'])})
const workSchema=z.object({work_id:z.uuid(),assistant_user_id:z.string(),title:z.string(),coordinator_session_id:z.string(),coordinator_device_id:z.string(),
  executors:z.array(z.object({session_id:z.string(),device_id:z.string(),agent_user_id:z.string().optional().nullable()}))})
const date=(raw:string)=>new Date(/(?:Z|[+-]\d\d:\d\d)$/.test(raw)?raw:`${raw.replace(' ','T')}Z`).toISOString()
/** Awake desktop/server hosts migrate their own accepted inbox; panels only read the account. */
export function createDesktopAssistantWorkHistory(deps:{
  context():Promise<AssistantWorkHostContext|null>
  receipts(after:number,retry?:number[]):Promise<{entries:Receipt[];cursor:number;hasMore:boolean;pending?:number[]}>
  checkpoint?:{read(owner:string):Promise<WorkHistoryPosition>;write(owner:string,value:WorkHistoryPosition):Promise<void>}
  identity(session:string,owner:string):Promise<{id:string;createdAt:number}|null>
  assistant(ctx:AssistantWorkHostContext):Promise<string|null>
  warn(detail:{code:string}):void
}) {
  let flight:Promise<void>|null=null,stopped=false
  const acknowledged=new Set<string>(),positions=new Map<string,WorkHistoryPosition>()
  const run=async()=>{
    const ctx=await deps.context()
    if(!ctx||stopped)return
    const current=async()=>{const next=await deps.context();return !stopped&&next?.ownerId===ctx.ownerId&&next.runtimeInstanceId===ctx.runtimeInstanceId}
    const knownMessages=new Map<string,Set<string>>()
    const knownWork=new Map<string,z.infer<typeof workSchema>>()
    const read=async(assistant:string,work:string)=>{
      const key=`${assistant}:${work}`,prior=knownWork.get(key)
      if(prior)return prior
      let cursor='0',row:z.infer<typeof workSchema>|null=null
      const ids=new Set<string>()
      for(;;){
        if(!await current())return null
        const {data,error}=await ctx.client.rpc('assistant_work_history',{p_assistant:assistant,p_work_id:work,p_after:cursor,p_limit:200})
        if(error){if(error.code==='42501'&&/Work is not available/.test(error.message))return null;throw error}
        const page=data as {work?:unknown;events?:Array<{message_id:string}>;next_after?:string|null}|null
        row=workSchema.parse(page?.work)
        if(!Array.isArray(page?.events))throw new Error('Invalid historical work events')
        for(const event of page.events)ids.add(event.message_id)
        if(!page.next_after)break
        if(BigInt(page.next_after)<=BigInt(cursor))throw new Error('Historical work cursor did not advance')
        cursor=page.next_after
      }
      knownWork.set(key,row!);knownMessages.set(key,ids)
      return row
    }
    const saved=await deps.checkpoint?.read(ctx.ownerId)??positions.get(ctx.ownerId)??{after:0,retry:[]}
    let after=saved.after,first=true
    const retry=new Set(saved.retry)
    do {
      const selected=first?[...retry].slice(0,32):[];first=false
      const page=await deps.receipts(after,selected)
      for(const position of selected)retry.delete(position)
      for(const position of page.pending??[])retry.add(position)
      for(const row of page.entries) {
        if(!await current())return
        const key=`${ctx.ownerId}:${row.id}`
        if(acknowledged.has(key))continue
        try {
          const identity=await deps.identity(row.sessionId,ctx.ownerId)
          const occurred=date(row.timestamp)
          if(!identity){retry.add(row.position);continue}
          if(!Number.isFinite(identity.createdAt) || Date.parse(occurred)<Math.floor(identity.createdAt/1000)*1000)continue
          const agentId=identity.id
          const segment=readDeliveryEnvelope(row.content)?.segments
          if(segment?.length!==1||segment[0]?.facts?.route!=='session-direct')continue
          const sender=segment[0].facts.fromId?.replace(/^session:/,'')
          if(!sender||segment[0].facts.messageId?.replace(/^msg:/,'')!==row.id)continue
          const remote=row.spawnedByRemote?.sessionId===sender?row.spawnedByRemote:null
          const senderIdentity=remote ? null : await deps.identity(sender,ctx.ownerId)
          const senderAgent=remote?.agentUserId??(senderIdentity && Date.parse(occurred)>=Math.floor(senderIdentity.createdAt/1000)*1000 ? senderIdentity.id : null)
          const caller=senderAgent?{sessionId:sender,deviceId:remote?.deviceId??ctx.deviceId,agentUserId:senderAgent}:null
          const dispatch=caller?legacyAssistantDispatch({deviceId:ctx.deviceId,agent:{sessionId:row.sessionId,agentUserId:agentId,displayName:row.title,caller},
            job:{id:row.id,prompt:row.content,createdAt:date(row.timestamp),route:{kind:'session-direct',caller,sourceMessageId:row.id}}}):null
          let assistantId=dispatch?.assistantId,workId=dispatch?.workId,task=dispatch?.task,event:HistoricalWorkEvent|undefined=dispatch?.event
          if(!dispatch) {
            const block=[...segment[0].body.matchAll(/(?:^|\n)<gugu_work_result>\s*\n?([^]*?)\n?<\/gugu_work_result>/g)].at(-1)?.[1]
            if(!block)continue
            const report=resultSchema.parse(JSON.parse(block))
            assistantId=await deps.assistant(ctx)??undefined
            if(!assistantId||agentId!==assistantId)continue
            const work=await read(assistantId,report.work_id)
            const executor=work?.executors.find(target=>target.session_id===sender)
            if(!work){retry.add(row.position);continue}
            if(!executor?.agent_user_id||work.coordinator_session_id!==row.sessionId||work.coordinator_device_id!==ctx.deviceId)continue
            workId=work.work_id
            task={title:work.title,coordinator_session_id:work.coordinator_session_id,coordinator_device_id:work.coordinator_device_id,
              executors:work.executors.filter((target):target is {session_id:string;device_id:string;agent_user_id:string}=>Boolean(target.agent_user_id))}
            event={message_id:row.id,kind:report.status,from_session_id:sender,from_device_id:executor.device_id,to_session_id:row.sessionId,to_device_id:ctx.deviceId,
              content:segment[0].body,occurred_at:date(row.timestamp),receipt_kind:'received'}
          }
          if(!assistantId||!workId||!event||!await current())return
          await read(assistantId,workId)
          if(knownMessages.get(`${assistantId}:${workId}`)?.has(row.id)) {acknowledged.add(key);continue}
          if(!await current())return
          const {data,error}=await ctx.client.rpc('assistant_work_import',{p_assistant:assistantId,p_runtime_instance_id:ctx.runtimeInstanceId,p_work_id:workId,p_task:task,p_events:[event]})
          if(error)throw error
          if(!(data as {event_ids?:string[]}|null)?.event_ids?.includes(row.id))throw new Error('Incomplete historical admission')
          acknowledged.add(key)
          knownWork.delete(`${assistantId}:${workId}`)
        }catch(error){retry.add(row.position);deps.warn({code:typeof (error as {code?:unknown})?.code==='string'?(error as {code:string}).code:'WORK_HISTORY_UNAVAILABLE'})}
      }
      if(page.cursor<after||page.hasMore&&page.cursor===after)throw new Error('Historical receipt cursor did not advance')
      after=page.cursor
      if(!await current())return
      const checkpoint={after,retry:[...retry]}
      await deps.checkpoint?.write(ctx.ownerId,checkpoint)
      positions.set(ctx.ownerId,checkpoint)
      if(!page.hasMore)return
    }while(await current())
  }
  return {kick():Promise<void>{
    if(stopped)return Promise.resolve()
    if(!flight)flight=run().catch(()=>deps.warn({code:'WORK_HISTORY_UNAVAILABLE'})).finally(()=>{flight=null})
    return flight
  },stop(){stopped=true}}
}
