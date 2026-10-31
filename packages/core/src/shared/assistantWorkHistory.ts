import {z} from 'zod'
import {readDeliveryEnvelope} from '../local/agent/deliveryEnvelope'
import {withSessionAttachments,type SessionAttachmentRef} from '../cloud/sessionAttachments'

const uuid=z.uuid()
const workBlock=z.object({work_id:uuid,coordinator:z.string(),report:z.string()})
const report=z.object({work_id:uuid,status:z.enum(['progress','question','completed','cancelled'])})
type Caller={sessionId:string;deviceId:string;agentUserId?:string}
type LegacyJob={id:string;prompt:string;createdAt:string;finishedAt?:string;sent?:string[];route?:{kind?:string;caller?:Caller|null;sourceMessageId?:string}}
type Agent={sessionId:string;agentUserId:string;displayName:string;caller?:Caller;assistantWork?:{assistant_id:string;coordinator:{session_id:string;device_id:string}}}
export type HistoricalWorkEvent={message_id:string;kind:string;from_session_id:string;from_device_id:string;to_session_id:string;to_device_id:string;content:string;occurred_at:string;receipt_kind:'received'|'sent_admitted'}
export type HistoricalWork={assistantId:string;workId:string;task:{title:string;coordinator_session_id:string;coordinator_device_id:string;executors:Array<{session_id:string;device_id:string;agent_user_id:string}>};event:HistoricalWorkEvent}
const time=(raw:unknown)=>typeof raw==='number'||typeof raw==='string' ? Number.isFinite(new Date(raw).getTime()) ? new Date(raw).toISOString() : null : null

/** Read only host envelopes with an original correlation and durable local admission. */
export function legacyAssistantDispatch({agent,job,deviceId}:{agent:Agent;job:LegacyJob;deviceId:string}):HistoricalWork|null {
  const routeCaller=job.route?.caller
  const parent=agent.caller?.sessionId===routeCaller?.sessionId && agent.caller?.deviceId===routeCaller?.deviceId ? agent.caller : null
  const intent=agent.assistantWork
  const assistantId=routeCaller?.agentUserId ?? parent?.agentUserId ?? (intent && routeCaller && intent.coordinator.session_id===routeCaller.sessionId && intent.coordinator.device_id===routeCaller.deviceId ? intent.assistant_id : undefined)
  const caller=routeCaller ? {...routeCaller,agentUserId:assistantId} : null
  if(job.route?.kind!=='session-direct' || !caller?.agentUserId || !uuid.safeParse(caller.agentUserId).success) return null
  const reading=readDeliveryEnvelope(job.prompt)
  if(reading?.segments.length!==1) return null
  const {facts,body}=reading.segments[0]!
  if(facts?.route!=='session-direct' || facts.fromId!==`session:${caller.sessionId}`) return null
  const blocks=[...body.matchAll(/(?:^|\n)<gugu_work>\s*\n?([^]*?)\n?<\/gugu_work>/g)]
  let parsed:unknown
  try {parsed=JSON.parse(blocks.at(-1)?.[1]??'')} catch {return null}
  const work=workBlock.safeParse(parsed),id=uuid.safeParse(facts.messageId?.replace(/^msg:/,''))
  const occurred=time(job.createdAt)
  if(!work.success || !id.success || !occurred || work.data.coordinator!==facts.fromId
    || job.route.sourceMessageId && job.route.sourceMessageId!==id.data) return null
  return {assistantId:caller.agentUserId,workId:work.data.work_id,
    task:{title:agent.displayName.slice(0,500),coordinator_session_id:caller.sessionId,coordinator_device_id:caller.deviceId,
      executors:[{session_id:agent.sessionId,device_id:deviceId,agent_user_id:agent.agentUserId}]},
    event:{message_id:id.data,kind:'dispatch',from_session_id:caller.sessionId,from_device_id:caller.deviceId,to_session_id:agent.sessionId,to_device_id:deviceId,
      content:body,occurred_at:occurred,receipt_kind:'received'}}
}
const object=(value:unknown):Record<string,unknown>|null=>value && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : null
/** Pi's real tool-call/result pairs plus the host's sent receipt, never a model's final prose. */
export function legacyAssistantReports(work:HistoricalWork,job:Pick<LegacyJob,'sent'|'finishedAt'>,entries:unknown[],files:(callId:string)=>SessionAttachmentRef[]=()=>[]):HistoricalWorkEvent[] {
  const calls=new Map<string,Record<string,unknown>>(),events:HistoricalWorkEvent[]=[]
  for(const entry of entries) {
    const row=object(entry),message=object(row?.message)
    if(row?.type!=='message'||!message) continue
    if(message.role==='assistant' && Array.isArray(message.content)) for(const value of message.content) {
      const call=object(value)
      if(call?.type==='toolCall' && call.name==='session_message' && typeof call.id==='string' && job.sent?.includes(call.id)) {
        const args=object(call.arguments)
        if(args) calls.set(call.id,args)
      }
    }
    if(message.role!=='toolResult' || message.isError===true || typeof message.toolCallId!=='string') continue
    const args=calls.get(message.toolCallId)
    if(!args || typeof args.text!=='string' || !args.text.trim()) continue
    const typed=args.work_result===undefined ? null : report.safeParse(args.work_result)
    if(typed && (!typed.success || typed.data.work_id!==work.workId)) continue
    let result=object(message.details)
    if(!result) try {result=object(JSON.parse(Array.isArray(message.content) ? message.content.map(part=>object(part)?.text??'').join('') : String(message.content)))} catch {continue}
    const receipt=Array.isArray(result?.recipients) ? result.recipients.map(object).find(r=>r?.status==='delivered'
      && (r.to===`session:${work.task.coordinator_session_id}` || r.to===`user:${work.assistantId}` || r.to===`aid:${work.assistantId}`
        || typeof r.session_id==='string' && r.session_id.replace(/^session:/,'')===work.task.coordinator_session_id)) : null
    const id=uuid.safeParse(typeof receipt?.message_id==='string' ? receipt.message_id.replace(/^msg:/,'') : null)
    const occurred=time(message.timestamp??row.timestamp??job.finishedAt)
    if(!id.success || !occurred) continue
    events.push({message_id:id.data,kind:typed?.success ? typed.data.status : 'progress',from_session_id:work.event.to_session_id,from_device_id:work.event.to_device_id,
      to_session_id:work.task.coordinator_session_id,to_device_id:work.task.coordinator_device_id,
      content:withSessionAttachments(args.text,files(message.toolCallId)),occurred_at:occurred,receipt_kind:'sent_admitted'})
  }
  return events
}
