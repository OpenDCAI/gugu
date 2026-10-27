import {z} from 'zod'
import {readDeliveryEnvelope} from '../local/agent/deliveryEnvelope'

const work=z.object({work_id:z.uuid(),coordinator:z.string(),report:z.string(),assistant_id:z.uuid().optional(),purpose:z.enum(['reply','task']).optional()})
/** Only the host's single active delivery can bind a reply; quoted or merged inputs cannot. */
export function assistantWorkReplyContext(prompt:string|undefined) {
  const envelope=prompt?readDeliveryEnvelope(prompt):null
  if(envelope?.segments.length!==1)return null
  const {facts,body}=envelope.segments[0]!
  if(facts?.route!=='session-direct'||!facts.messageId)return null
  const blocks=[...body.matchAll(/(?:^|\n)<gugu_work>\s*\n?([^]*?)\n?<\/gugu_work>/g)]
  if(blocks.length!==1)return null
  try {
    const value=work.parse(JSON.parse(blocks[0]![1]!))
    return value.coordinator===facts.fromId?value:null
  } catch {return null}
}

/** No prose classification: an inquiry is complete on reply, a task must declare its actual state. */
export function withAssistantWorkReply(record:Record<string,unknown>,prompt:string|undefined):Record<string,unknown> {
  const context=assistantWorkReplyContext(prompt)
  if(!context)return record
  const to=record.to
  if(!Array.isArray(to)||to.length!==1||!(to[0]===context.coordinator
    ||context.assistant_id&&[`aid:${context.assistant_id}`,`user:${context.assistant_id}`].includes(String(to[0]))))return record
  if(context.purpose==='reply') {
    if(record.work_result&&(record.work_result as {work_id?:unknown}).work_id!==context.work_id)return record
    return {...record,work_result:{work_id:context.work_id,status:'completed'}}
  }
  if(record.work_result)return record
  throw Object.assign(new Error(`This task reply has not been sent. Keep its text/files and retry with work_result={work_id:"${context.work_id}",status:"progress"|"question"|"completed"|"cancelled"}; an acknowledgement is progress, not completed.`),{code:'WORK_REPORT_STATUS_REQUIRED'})
}
