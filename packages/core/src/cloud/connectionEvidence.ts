import {parseNativeConnectionAttempt,type NativeConnectionAttempt} from './connectionAttempts.ts'

export type ConnectionEvidenceAction = 'read' | 'fence'
export type ConnectionEvidenceChallenge = {
  version:1; challengeId:string; nonce:string; keyId:string; ownerId:string; deviceId:string;
  operationId:string; attemptId:string; action:ConnectionEvidenceAction; expiresAt:string
}
export type ConnectionEvidenceProof = {
  version:1; attempt:NativeConnectionAttempt; state:'prepared'|'started'|'applied'; fenced:boolean;
  digest?:string; fenceDigest?:string; accountId?:string; publication?:string
}
export type ConnectionEvidenceReply = {version:1;challenge:ConnectionEvidenceChallenge;proof:ConnectionEvidenceProof;signature:string}
/** Only the native journal adapter calls this, after current-owner and original
 * server-context checks and the actual SQLite read/fence. Never an RPC signer. */
export type ConnectionEvidenceSigner = {
  assertCurrentKey(challenge:ConnectionEvidenceChallenge):Promise<void>
  sign(challenge:ConnectionEvidenceChallenge,proof:ConnectionEvidenceProof):Promise<ConnectionEvidenceReply>
}
export const CONNECTION_EVIDENCE_DOMAIN = 'gugu.connection-evidence.v1\n'
const encoder = new TextEncoder()
const uuid = (v:unknown):v is string => typeof v==='string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v)
const hex = (v:unknown):v is string => typeof v==='string' && /^[0-9a-f]{64}$/.test(v)
const fail = ():never => {throw Error('CONNECTION_EVIDENCE_INVALID')}
function record(value:unknown,required:readonly string[],optional:readonly string[]=[]):Record<string,unknown> {
  if(!value || typeof value!=='object' || Array.isArray(value)
    || ![Object.prototype,null].includes(Object.getPrototypeOf(value)))return fail()
  const keys=Object.keys(value)
  if(keys.length>required.length+optional.length || required.some(k=>!Object.hasOwn(value,k))
    || keys.some(k=>!required.includes(k)&&!optional.includes(k)))return fail()
  return value as Record<string,unknown>
}
/** No projection may hide unknown fields in a signed message. */
export function parseConnectionEvidenceContext(value:unknown):NativeConnectionAttempt {
  const parsed=parseNativeConnectionAttempt(value,fail)
  record(value,Object.keys(parsed))
  return parsed
}
function canonical(value:unknown):string {
  return JSON.stringify(value,(_key,item)=>item && typeof item==='object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)) : item)
}
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b)
export function parseConnectionEvidenceChallenge(context:NativeConnectionAttempt,action:ConnectionEvidenceAction,value:unknown,now=Date.now()):ConnectionEvidenceChallenge {
  const original=parseConnectionEvidenceContext(context)
  const v=record(value,['version','challengeId','nonce','keyId','ownerId','deviceId','operationId','attemptId','action','expiresAt'])
  if(v.version!==1 || !uuid(v.challengeId) || !uuid(v.keyId) || !hex(v.nonce)
    || v.ownerId!==original.ownerId || v.deviceId!==original.deviceId || v.operationId!==original.operationId
    || v.attemptId!==original.attemptId || !['read','fence'].includes(action) || v.action!==action
    || typeof v.expiresAt!=='string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(v.expiresAt)
    || !Number.isSafeInteger(now))return fail()
  const expires=Date.parse(v.expiresAt)
  if(!Number.isFinite(expires) || expires<=now)throw Error('CONNECTION_EVIDENCE_CHALLENGE_EXPIRED')
  if(expires-now>60_000)return fail()
  return {...v} as ConnectionEvidenceChallenge
}
export function parseConnectionEvidenceProof(context:NativeConnectionAttempt,value:unknown):ConnectionEvidenceProof {
  const original=parseConnectionEvidenceContext(context)
  const v=record(value,['version','attempt','state','fenced'],['digest','fenceDigest','accountId','publication'])
  const attempt=parseConnectionEvidenceContext(v.attempt)
  if(!same(attempt,original) || v.version!==1 || !['prepared','started','applied'].includes(v.state as string)
    || typeof v.fenced!=='boolean')return fail()
  if(v.state==='applied') {
    if(!hex(v.digest) || typeof v.accountId!=='string' || !v.accountId || v.accountId.length>512
      || original.accountId!==null && original.accountId!==v.accountId)return fail()
  }else if(Object.hasOwn(v,'digest') || Object.hasOwn(v,'accountId') || Object.hasOwn(v,'publication'))return fail()
  if(v.fenced ? !hex(v.fenceDigest) : Object.hasOwn(v,'fenceDigest'))return fail()
  if(Object.hasOwn(v,'publication') && (typeof v.publication!=='string' || !v.publication
    || v.publication.length>1_572_864 || encoder.encode(v.publication).length>1_572_864 || original.effectKind!=='authorize'))return fail()
  return {version:1,attempt,state:v.state as ConnectionEvidenceProof['state'],fenced:v.fenced,
    ...(v.digest!==undefined?{digest:v.digest as string}:{}),...(v.fenceDigest!==undefined?{fenceDigest:v.fenceDigest as string}:{}),
    ...(v.accountId!==undefined?{accountId:v.accountId as string}:{}),...(v.publication!==undefined?{publication:v.publication as string}:{})}
}
/** Canonical UTF-8 bytes are shared by Node's native Ed25519 signer and WebCrypto
 * verification (including Deno). There are no Node dependencies in this module. */
export function connectionEvidenceSigningBytes(challenge:ConnectionEvidenceChallenge,proof:ConnectionEvidenceProof):Uint8Array<ArrayBuffer> {
  // Expiration is enforced at both endpoints; serialization itself stays stable.
  const checked=parseConnectionEvidenceProof(proof.attempt,proof)
  parseConnectionEvidenceChallenge(checked.attempt,challenge.action,challenge,Date.parse(challenge.expiresAt)-1)
  if(challenge.action==='fence'&&!checked.fenced)return fail()
  const bytes=encoder.encode(CONNECTION_EVIDENCE_DOMAIN+canonical({version:1,challenge,proof:checked}))
  if(bytes.length>2_097_152)return fail()
  return bytes
}
function base64url(value:unknown,length:number):Uint8Array<ArrayBuffer> {
  if(typeof value!=='string' || value.length!==Math.ceil(length*4/3) || !/^[A-Za-z0-9_-]+$/.test(value))return fail()
  let raw:string
  try{raw=atob(value.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-value.length%4)%4))}catch{return fail()}
  const bytes=Uint8Array.from(raw,c=>c.charCodeAt(0))
  if(bytes.length!==length || btoa(raw).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_')!==value)return fail()
  return bytes
}
export function connectionEvidencePublicKeyBytes(publicKey:string):Uint8Array<ArrayBuffer> {
  const bytes=base64url(publicKey,44)
  // RFC 8410 SubjectPublicKeyInfo: Ed25519 OID, absent parameters, 32-byte key.
  const prefix=[0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x03,0x21,0x00]
  if(prefix.some((byte,i)=>bytes[i]!==byte))return fail()
  return bytes
}
// Pure verification permits the privileged wrapper to recheck the transport's
// envelope. Only the authority transaction can durably consume a challenge.
export async function verifyConnectionEvidenceReply(context:NativeConnectionAttempt,action:ConnectionEvidenceAction,
  challenge:ConnectionEvidenceChallenge,publicKey:string,reply:unknown,now?:number):Promise<ConnectionEvidenceReply> {
  const clock=()=>now??Date.now()
  const trusted=parseConnectionEvidenceChallenge(context,action,challenge,clock())
  const v=record(reply,['version','challenge','proof','signature'])
  if(v.version!==1)return fail()
  const returned=parseConnectionEvidenceChallenge(context,action,v.challenge,clock())
  if(!same(trusted,returned))return fail()
  const proof=parseConnectionEvidenceProof(context,v.proof)
  const bytes=connectionEvidenceSigningBytes(trusted,proof)
  const signature=v.signature
  const signatureBytes=base64url(signature,64)
  const key=await crypto.subtle.importKey('spki',connectionEvidencePublicKeyBytes(publicKey),'Ed25519',false,['verify'])
  if(!await crypto.subtle.verify('Ed25519',key,signatureBytes,bytes))throw Error('CONNECTION_EVIDENCE_SIGNATURE_INVALID')
  parseConnectionEvidenceChallenge(context,action,trusted,clock())
  return {version:1,challenge:trusted,proof,signature:signature as string}
}
