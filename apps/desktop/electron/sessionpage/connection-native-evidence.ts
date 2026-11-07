import {parseNativeConnectionAttempt} from '@gugu/core/cloud/connectionAttempts'
import {ConnectionError,type ConnectionClient} from '@gugu/core/cloud/connections'
import type {createNativeConnectionEvidence} from '../session/main/core/provider-accounts/connection-effect-evidence'

type Store=ReturnType<typeof createNativeConnectionEvidence>
/** Device evidence is obtained only from the real SQLite boundary. The service
 * asks the original device; renderer success flags and account lists are ignored. */
export function createConnectionNativeEvidence(input:{ownerId:string;deviceId:string;cloud:Pick<ConnectionClient,'prepareAttempt'|'inspectAttempt'>;
  instance():string;assertCurrent():Promise<void>;store():Promise<Store>}){
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
    const supplied=parseNativeConnectionAttempt(raw)
    if(requestOwner!==input.ownerId||supplied.ownerId!==input.ownerId||supplied.deviceId!==input.deviceId)
      throw new ConnectionError('42501','CONNECTION_ATTEMPT_UNAVAILABLE')
    const original=await inspect(supplied.operationId)
    if(JSON.stringify(original)!==JSON.stringify(supplied))throw new ConnectionError('42501','CONNECTION_ATTEMPT_UNAVAILABLE')
    const store=await input.store()
    // Fencing writes only an original-attempt tombstone, never the effect.
    const proof=fence?store.fence(original):store.read(original)
    return {version:1,attempt:original,state:proof.state,fenced:proof.fenced,
      ...(proof.digest?{digest:proof.digest}:{}),...(proof.fenceDigest?{fenceDigest:proof.fenceDigest}:{}),
      ...(proof.accountId?{accountId:proof.accountId}:{}),...(proof.publication?{publication:proof.publication}:{})}
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
  return {begin,run,publication,read:(raw:unknown,owner:string)=>readProof(raw,owner,false),fence:(raw:unknown,owner:string)=>readProof(raw,owner,true)}
}
