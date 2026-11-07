import {createDeviceRpcRequester} from './deviceRpcRequester'
import {openAttachedDeviceRpcPipe,type JoinDeviceTopic} from './deviceRpcAttach'
import {parseNativeConnectionAttempt,type NativeConnectionAttempt} from './connectionAttempts'
/** Purpose-specific service verifier. Reuse the canonical device handshake and
 * request IDs; no provider/auth/CLI/effect verb is available through this API. */
export function createConnectionEvidenceRequester(input:{ownerId:string;join:JoinDeviceTopic;asker?:string}){
  const requester=createDeviceRpcRequester({userId:async()=>input.ownerId,openPipe:(deviceId,handlers)=>openAttachedDeviceRpcPipe({
    ...handlers,deviceId,asker:input.asker??crypto.randomUUID(),userId:async()=>input.ownerId,join:input.join,attachTimeoutMs:5000,
  })})
  async function query(value:NativeConnectionAttempt,fence:boolean){
    const original=parseNativeConnectionAttempt(value)
    if(original.ownerId!==input.ownerId)throw Error('CONNECTION_ATTEMPT_UNAVAILABLE')
    const reply=await requester.call(original.deviceId,fence?'connections.evidence.fence':'connections.evidence.read',original,{timeoutMs:5000})
    if(reply.error)throw Error('CONNECTION_DEVICE_VERIFICATION_UNAVAILABLE')
    return reply.result
  }
  return {read:(attempt:NativeConnectionAttempt)=>query(attempt,false),fence:(attempt:NativeConnectionAttempt)=>query(attempt,true),close:()=>requester.closeAll()}
}
