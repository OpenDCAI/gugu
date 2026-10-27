import {z} from 'zod'
import {readDeliveryEnvelope} from '../local/agent/deliveryEnvelope'
import {decodeIdentityAddress} from './typedId.mjs'

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

/** No prose classification: an inquiry is complete on reply, a task must declare its actual state.
 * `gugu:<number>` is the same coordinator only when it resolves to this work's assistant. */
export async function withAssistantWorkReply(record:Record<string,unknown>,prompt:string|undefined,
  resolveNumber?:(number:number)=>Promise<string|undefined>):Promise<Record<string,unknown>> {
  const context=assistantWorkReplyContext(prompt)
  if(!context)return record
  const to=record.to
  if(!Array.isArray(to)||to.length!==1||typeof to[0]!=='string')return record
  const address=to[0]
  let coordinator=address===context.coordinator
    ||!!context.assistant_id&&[`aid:${context.assistant_id}`,`user:${context.assistant_id}`].includes(address)
  if(!coordinator&&context.assistant_id&&address.startsWith('gugu:')&&resolveNumber) {
    const identity=decodeIdentityAddress(address,'to')
    coordinator=identity.kind==='gugu'&&await resolveNumber(identity.number)===context.assistant_id
  }
  if(!coordinator)return record
  // An explicit state is the executor's own report (progress/question/cancelled); only a missing one is filled.
  if(record.work_result)return record
  if(context.purpose==='reply')return {...record,work_result:{work_id:context.work_id,status:'completed'}}
  throw Object.assign(new Error(`This task reply has not been sent. Keep its text/files and retry with work_result={work_id:"${context.work_id}",status:"progress"|"question"|"completed"|"cancelled"}; an acknowledgement is progress, not completed.`),{code:'WORK_REPORT_STATUS_REQUIRED'})
}
