import {parseConnectionEvidenceContext,parseConnectionEvidenceChallenge,type ConnectionEvidenceSigner,type ConnectionEvidenceProof} from '@gugu/core/cloud/connectionEvidence'
import {parseNativeConnectionAttempt} from '@gugu/core/cloud/connectionAttempts'
import {ConnectionError,type ConnectionClient} from '@gugu/core/cloud/connections'
import type {createNativeConnectionEvidence} from '../session/main/core/provider-accounts/connection-effect-evidence'

type Store=ReturnType<typeof createNativeConnectionEvidence>
/** Device evidence is obtained only from the real SQLite boundary. The service
 * asks the original device; renderer success flags and account lists are ignored. */
export function createConnectionNativeEvidence(input:{ownerId:string;deviceId:string;cloud:Pick<ConnectionClient,'prepareAttempt'|'inspectAttempt'>;
  instance():string;assertCurrent():Promise<void>;store():Promise<Store>;signer():Promise<ConnectionEvidenceSigner>}){
  async function inspect(operationId:string){
    await input.assertCurrent()
    const value=await input.cloud.inspectAttempt(input.instance(),operationId)
    if(!value||value.ownerId!==input.ownerId||value.deviceId!==input.deviceId||value.operationId!==operationId)
      throw new ConnectionError('42501','CONNECTION_ATTEMPT_UNAVAILABLE')
    await input.assertCurrent();return parseNativeConnectionAttempt(value)
  }
  async function begin(provider:string,operationId:string,epoch:string){
    const value=await input.cloud.prepareAttempt(input.instance(),operationId,epoch)
    if(value.ownerId!==input.ownerId||value.deviceId!==input.deviceId||value.providerId!==provider||value.authorityEpoch!==epoch)
      throw new ConnectionError('42501','CONNECTION_ATTEMPT_UNAVAILABLE')
    await input.assertCurrent();(await input.store()).begin(value);return value
  }
  async function readProof(raw:unknown,requestOwner:string,fence:boolean){
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length!==2||!Object.hasOwn(raw,'attempt')||!Object.hasOwn(raw,'challenge'))
      throw new ConnectionError('42501','CONNECTION_ATTEMPT_UNAVAILABLE')
    const payload=raw as {attempt:unknown;challenge:unknown}
    const supplied=parseConnectionEvidenceContext(payload.attempt)
    const challenge=parseConnectionEvidenceChallenge(supplied,fence?'fence':'read',payload.challenge)
    if(requestOwner!==input.ownerId||supplied.ownerId!==input.ownerId||supplied.deviceId!==input.deviceId)
      throw new ConnectionError('42501','CONNECTION_ATTEMPT_UNAVAILABLE')
    const original=await inspect(supplied.operationId)
    if(JSON.stringify(original)!==JSON.stringify(supplied))throw new ConnectionError('42501','CONNECTION_ATTEMPT_UNAVAILABLE')
    const signer=await input.signer()
    await signer.assertCurrentKey(challenge)
    const store=await input.store()
    await input.assertCurrent()
    parseConnectionEvidenceChallenge(original,fence?'fence':'read',challenge)
    // Fencing writes only an original-attempt tombstone, never the effect.
    const proof=fence?store.fence(original):store.read(original)
    const normalized:ConnectionEvidenceProof={version:1,attempt:original,state:proof.state,fenced:proof.fenced,
      ...(proof.digest?{digest:proof.digest}:{}),...(proof.fenceDigest?{fenceDigest:proof.fenceDigest}:{}),
      ...(proof.accountId?{accountId:proof.accountId}:{}),...(proof.publication?{publication:proof.publication}:{})}
    await input.assertCurrent()
    return signer.sign(challenge,normalized)
  }
  async function run<T>(provider:string,operationId:string,epoch:string,action:()=>Promise<T>):Promise<T>{
    const original=await inspect(operationId)
    if(original.providerId!==provider||original.authorityEpoch!==epoch)throw new ConnectionError('PT409','CONNECTION_AUTHORITY_CHANGED')
    return(await input.store()).run(original,action)
  }
  async function publication(operationId:string,provider:string,accountId:string){
    const original=await inspect(operationId),proof=(await input.store()).read(original)
    if(original.providerId!==provider||proof.accountId!==accountId||proof.state!=='applied'||!proof.publication)
      throw new ConnectionError('unknown-outcome','CONNECTION_OUTCOME_UNKNOWN')
    return JSON.parse(proof.publication) as {operationId:string;scopeKey:string;resourceKey:string|null;expectedRevision:string|null;
      operation:'save';data:Record<string,unknown>;document:string;deviceId:string;recreationId:string}
  }
  async function cancel(provider:string,operationId:string){
    await input.assertCurrent()
    const value=await input.cloud.inspectAttempt(input.instance(),operationId)
    if(value===null)return
    const original=parseNativeConnectionAttempt(value)
    if(original.ownerId!==input.ownerId||original.deviceId!==input.deviceId||original.providerId!==provider||original.operationId!==operationId)
      throw new ConnectionError('42501','CONNECTION_ATTEMPT_UNAVAILABLE')
    await input.assertCurrent();(await input.store()).fence(original)
  }
  return {begin,run,publication,cancel,read:(raw:unknown,owner:string)=>readProof(raw,owner,false),fence:(raw:unknown,owner:string)=>readProof(raw,owner,true)}
}
