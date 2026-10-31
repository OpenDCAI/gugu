import type { TranscriptTurn } from '@gugu/session-core/acp'
import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope'
import type { WorkOwnerReceiptProof, WorkReconciliationEvent } from '@gugu/core/cloud/assistantWorkReconciliation'
import { recordHistoryPage } from '../session-timeline/service'
import { successfulGuguSendMessageId } from '@gugu/session-core/session-record/reply-process'

function object(text:string|undefined):Record<string,unknown>|null {
  try { const value=JSON.parse(text??'');return value&&typeof value==='object'&&!Array.isArray(value)?value:null } catch {return null}
}
const bare=(id:string)=>id.replace(/^msg:/,'')

/** Fail closed on merged inputs: a nearby post is not evidence that a particular work result was delivered. */
export function projectAssistantWorkOwnerReceipts(turns:TranscriptTurn[],events:WorkReconciliationEvent[],owner:{chatId:string;ownerId:string}):WorkOwnerReceiptProof[] {
  const result=new Map<string,WorkOwnerReceiptProof>()
  const pending=new Map(events.filter(e=>e.kind!=='dispatch'&&e.assistant_admitted_at&&!e.owner_delivered_at).map(e=>[bare(e.message_id),e]))
  for(const turn of turns) {
    const inputs=turn.items.filter(item=>item.kind==='message'&&item.role==='user')
    if(inputs.length!==1||inputs[0].kind!=='message') continue
    const input=inputs[0]
    const reading=readDeliveryEnvelope(input.text)
    if(reading?.segments.length!==1) continue
    const facts=reading.segments[0].facts
    const event=facts?.messageId?pending.get(bare(facts.messageId)):undefined
    if(!event||facts?.route!=='session-direct'||facts.fromId!==`session:${event.from_session_id}`) continue
    for(const item of turn.items) {
      if(item.kind!=='mcp-tool-call'||item.status!=='done'||item.seq<=input.seq||item.parentToolCallId) continue
      const messageId=successfulGuguSendMessageId(item)
      if(!messageId) continue
      const args=object(item.rawInput)
      if(![owner.chatId,owner.ownerId,`user:${owner.ownerId}`].includes(String(args?.chat_id??''))) continue
      result.set(event.message_id,{eventId:event.message_id,chatId:owner.chatId,messageId:bare(messageId)})
      break
    }
  }
  return [...result.values()]
}

/** Same native timeline used by the session page; no native-file edits or additional durable queue. */
export async function readAssistantWorkOwnerReceipts(sessionId:string,events:WorkReconciliationEvent[],owner:{chatId:string;ownerId:string}):Promise<WorkOwnerReceiptProof[]> {
  const proofs=new Map<string,WorkOwnerReceiptProof>()
  let beforeSeq:number|undefined
  // Bound each reconciliation pass; unresolved/ambiguous inputs remain unconfirmed.
  for(let page=0;page<10;page++) {
    const read=await recordHistoryPage({conversationId:sessionId,limit:100,...(beforeSeq===undefined?{}:{beforeSeq})})
    if(!read.ok||typeof read.value==='string') return [...proofs.values()]
    for(const proof of projectAssistantWorkOwnerReceipts(read.value.turns,events,owner)) proofs.set(proof.eventId,proof)
    if(!read.value.hasOlder||!read.value.turns.length) break
    beforeSeq=read.value.turns[0].seq
  }
  return [...proofs.values()]
}
