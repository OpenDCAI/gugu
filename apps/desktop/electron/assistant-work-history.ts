import {z} from 'zod'
import {readDeliveryEnvelope} from '@gugu/core/local/agent/deliveryEnvelope'
import {legacyAssistantDispatch,type HistoricalWorkEvent} from '@gugu/core/shared/assistantWorkHistory'
import type {AssistantWorkHostContext} from './assistant-work-outbox'

type Receipt={id:string;position:number;sessionId:string;content:string;timestamp:string;title:string;spawnedBySessionId:string|null;spawnedByRemote:{sessionId:string;deviceId:string;agentUserId?:string}|null}
const resultSchema=z.object({work_id:z.uuid(),status:z.enum(['progress','question','completed','cancelled'])})
const workSchema=z.object({work_id:z.uuid(),assistant_user_id:z.string(),title:z.string(),coordinator_session_id:z.string(),coordinator_device_id:z.string(),
  executors:z.array(z.object({session_id:z.string(),device_id:z.string(),agent_user_id:z.string().optional().nullable()}))})
const date=(raw:string)=>new Date(/(?:Z|[+-]\d\d:\d\d)$/.test(raw)?raw:`${raw.replace(' ','T')}Z`).toISOString()
/** Awake desktop/server hosts migrate their own accepted inbox; panels only read the account. */
export function createDesktopAssistantWorkHistory(deps:{
  context():Promise<AssistantWorkHostContext|null>
  receipts(after:number):Promise<{entries:Receipt[];cursor:number;hasMore:boolean}>
  agentId(session:string,owner:string):Promise<string|null>
  assistant(ctx:AssistantWorkHostContext):Promise<string|null>
  warn(detail:{code:string}):void
}) {
  let flight:Promise<void>|null=null,stopped=false
  const acknowledged=new Set<string>()
  const run=async()=>{
    const ctx=await deps.context()
    if(!ctx||stopped)return
    const current=async()=>{const next=await deps.context();return !stopped&&next?.ownerId===ctx.ownerId&&next.runtimeInstanceId===ctx.runtimeInstanceId}
    const read=async(assistant:string,work:string)=>{
      const {data,error}=await ctx.client.rpc('assistant_work_history',{p_assistant:assistant,p_work_id:work,p_after:'0',p_limit:1})
      if(error){if(error.code==='42501'&&/Work is not available/.test(error.message))return null;throw error}
      return workSchema.parse((data as {work?:unknown}|null)?.work)
    }
    let after=0
    do {
      const page=await deps.receipts(after)
      for(const row of page.entries) {
        if(!await current())return
        const key=`${ctx.ownerId}:${row.id}`
        if(acknowledged.has(key))continue
        try {
          const agentId=await deps.agentId(row.sessionId,ctx.ownerId)
          if(!agentId)continue
          const segment=readDeliveryEnvelope(row.content)?.segments
          if(segment?.length!==1||segment[0]?.facts?.route!=='session-direct')continue
          const sender=segment[0].facts.fromId?.replace(/^session:/,'')
          if(!sender||segment[0].facts.messageId?.replace(/^msg:/,'')!==row.id)continue
          const remote=row.spawnedByRemote?.sessionId===sender?row.spawnedByRemote:null
          const senderAgent=remote?.agentUserId??await deps.agentId(sender,ctx.ownerId)
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
            if(!work||!executor?.agent_user_id||work.coordinator_session_id!==row.sessionId||work.coordinator_device_id!==ctx.deviceId)continue
            workId=work.work_id
            task={title:work.title,coordinator_session_id:work.coordinator_session_id,coordinator_device_id:work.coordinator_device_id,
              executors:work.executors.filter((target):target is {session_id:string;device_id:string;agent_user_id:string}=>Boolean(target.agent_user_id))}
            event={message_id:row.id,kind:report.status,from_session_id:sender,from_device_id:executor.device_id,to_session_id:row.sessionId,to_device_id:ctx.deviceId,
              content:segment[0].body,occurred_at:date(row.timestamp),receipt_kind:'received'}
          }
          if(!assistantId||!workId||!event||!await current())return
          const {data,error}=await ctx.client.rpc('assistant_work_import',{p_assistant:assistantId,p_runtime_instance_id:ctx.runtimeInstanceId,p_work_id:workId,p_task:task,p_events:[event]})
          if(error)throw error
          if(!(data as {event_ids?:string[]}|null)?.event_ids?.includes(row.id))throw new Error('Incomplete historical admission')
          acknowledged.add(key)
        }catch(error){deps.warn({code:typeof (error as {code?:unknown})?.code==='string'?(error as {code:string}).code:'WORK_HISTORY_UNAVAILABLE'})}
      }
      if(!page.hasMore)return
      if(page.cursor<=after)throw new Error('Historical receipt cursor did not advance')
      after=page.cursor
    }while(await current())
  }
  return {kick():Promise<void>{
    if(stopped)return Promise.resolve()
    if(!flight)flight=run().catch(()=>deps.warn({code:'WORK_HISTORY_UNAVAILABLE'})).finally(()=>{flight=null})
    return flight
  },stop(){stopped=true}}
}
