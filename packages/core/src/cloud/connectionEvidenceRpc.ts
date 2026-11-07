import {createDeviceRpcRequester} from './deviceRpcRequester'
import {openAttachedDeviceRpcPipe,type JoinDeviceTopic} from './deviceRpcAttach'
import type {NativeConnectionAttempt} from './connectionAttempts'
import {parseConnectionEvidenceContext,parseConnectionEvidenceChallenge,connectionEvidencePublicKeyBytes,verifyConnectionEvidenceReply,
  type ConnectionEvidenceAction,type ConnectionEvidenceChallenge} from './connectionEvidence'
export {verifyConnectionEvidenceReply,parseConnectionEvidenceChallenge,connectionEvidenceSigningBytes} from './connectionEvidence'
export type {ConnectionEvidenceAction,ConnectionEvidenceChallenge,ConnectionEvidenceProof,ConnectionEvidenceReply,ConnectionEvidenceSigner} from './connectionEvidence'
/** The private topic authenticates an account, not its devices. Only a challenge
 * and public key obtained from the closed authority can establish device proof. */
export function createConnectionEvidenceRequester(input:{ownerId:string;join:JoinDeviceTopic;asker?:string;
  challenge(context:NativeConnectionAttempt,action:ConnectionEvidenceAction):Promise<{challenge:ConnectionEvidenceChallenge;publicKey:string}>}){
  if(typeof input.challenge!=='function')throw Error('CONNECTION_EVIDENCE_TRUST_REQUIRED')
  const requester=createDeviceRpcRequester({userId:async()=>input.ownerId,openPipe:(deviceId,handlers)=>openAttachedDeviceRpcPipe({
    ...handlers,deviceId,asker:input.asker??crypto.randomUUID(),userId:async()=>input.ownerId,join:input.join,attachTimeoutMs:5000,
  })})
  const accepted=new Map<string,number>()
  async function query(value:NativeConnectionAttempt,action:ConnectionEvidenceAction){
    const original=parseConnectionEvidenceContext(value)
    if(original.ownerId!==input.ownerId)throw Error('CONNECTION_ATTEMPT_UNAVAILABLE')
    const trusted=await input.challenge(structuredClone(original),action)
    const challenge=parseConnectionEvidenceChallenge(original,action,trusted.challenge)
    const publicKey=trusted.publicKey
    connectionEvidencePublicKeyBytes(publicKey)
    const reply=await requester.call(original.deviceId,action==='fence'?'connections.evidence.fence':'connections.evidence.read',
      {attempt:original,challenge},{timeoutMs:5000})
    if(reply.error)throw Error('CONNECTION_DEVICE_VERIFICATION_UNAVAILABLE')
    const verified=await verifyConnectionEvidenceReply(original,action,challenge,publicKey,reply.result)
    for(const [id,expires] of accepted)if(expires<=Date.now())accepted.delete(id)
    if(accepted.has(challenge.challengeId))throw Error('CONNECTION_EVIDENCE_REPLAY')
    if(accepted.size>=4096)throw Error('CONNECTION_EVIDENCE_CAPACITY')
    accepted.set(challenge.challengeId,Date.parse(challenge.expiresAt))
    return verified
  }
  return {read:(attempt:NativeConnectionAttempt)=>query(attempt,'read'),fence:(attempt:NativeConnectionAttempt)=>query(attempt,'fence'),close:()=>requester.closeAll()}
}
