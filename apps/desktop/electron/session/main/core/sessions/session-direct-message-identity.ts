import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';

/** Display names and local timestamp rendering may change between retries; business facts may not. */
export function sessionDirectMessageIdentity(text:string,messageId:string):string {
  const reading=readDeliveryEnvelope(text);
  const segment=reading?.segments.length===1?reading.segments[0]:null;
  const facts=segment?.facts;
  if(!segment||facts?.route!=='session-direct'||!facts.fromId?.startsWith('session:')
    ||facts.messageId?.replace(/^msg:/,'')!==messageId.replace(/^msg:/,'')) return JSON.stringify(['bytes',text]);
  return JSON.stringify(['session-direct',segment.body,{
    ...facts,from:null,at:null,messageId:messageId.replace(/^msg:/,''),
    ...(facts.replyTo?{replyTo:{...facts.replyTo,from:null}}:{}),
  }]);
}
