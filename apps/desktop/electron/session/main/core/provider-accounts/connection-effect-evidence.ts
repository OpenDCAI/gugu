import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AppDb, DrizzleTx } from '@main/db/client';
import {parseNativeConnectionAttempt} from '@gugu/core/cloud/connectionAttempts';
import { connectionPublicationRequest } from './connection-publication-request';
import { kv, type ProviderAccountRow } from '@main/db/schema';

/** Private native protocol. This identity comes from the owned service/runtime
 * channel, never a renderer-provided success claim. No credential bytes enter it. */
export type {NativeConnectionAttempt as ManagedConnectionAttempt} from '@gugu/core/cloud/connectionAttempts';
import type {NativeConnectionAttempt as ManagedConnectionAttempt} from '@gugu/core/cloud/connectionAttempts';
type Evidence = {
  version: 1; attempt: ManagedConnectionAttempt; state: 'prepared' | 'started' | 'applied';
  fenced: boolean; fenceDigest?: string; publication?: string; accountId?: string; result?: ProviderAccountRow | null; digest?: string;
};
const attempts = new AsyncLocalStorage<ManagedConnectionAttempt>();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value,(_key,item)=>item && typeof item==='object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)) : item)).digest('hex');
const key = (attempt: ManagedConnectionAttempt) => `connection-effect:${hash([attempt.ownerId,attempt.deviceId,attempt.operationId])}`;
const revokedKey=(provider:string,account:string)=>`connection-revoked-account:${hash([provider,account])}`;
export const isManagedConnectionRevoked=(db:AppDb,provider:string,account:string):boolean=>read(db,revokedKey(provider,account))!==undefined;
const providerKey = (attempt: ManagedConnectionAttempt) => `connection-effect-provider:${hash([attempt.ownerId,attempt.deviceId,attempt.providerId])}`;
function read(tx: AppDb | DrizzleTx, name: string): string | undefined {
  return tx.select({ value: kv.value }).from(kv).where(eq(kv.key,name)).get()?.value;
}
function write(tx: DrizzleTx, name: string, value: unknown): void {
  const encoded = JSON.stringify(value);
  tx.insert(kv).values({ key:name,value:encoded,updatedAt:Date.now() })
    .onConflictDoUpdate({ target:kv.key,set:{ value:encoded,updatedAt:Date.now() } }).run();
}
// Compare original intent positions, not delivery/admission order. An explicit
// authorization begun after revision N supersedes the remove at N, even when
// that remove is admitted late and receives a larger attempt sequence number.
const bindingKey=(provider:string,account:string)=>`connection-account-generation:${hash([provider,account])}`;
function order(a: ManagedConnectionAttempt,b: ManagedConnectionAttempt): number {
  const epoch=BigInt(a.authorityEpoch)-BigInt(b.authorityEpoch);
  if(epoch!==0n)return epoch>0n?1:-1;
  const position=(v:ManagedConnectionAttempt)=>BigInt(v.effectKind==='authorize'?v.expectedHeadRevision??v.expectedItemRevision??'0':v.operationRevision??'0');
  const delta=position(a)-position(b);
  if(delta!==0n)return delta>0n?1:-1;
  if(a.effectKind==='authorize'&&b.effectKind!=='authorize')return 1;
  if(b.effectKind==='authorize'&&a.effectKind!=='authorize')return -1;
  const sequence=BigInt(a.attemptOrder)-BigInt(b.attemptOrder);
  return sequence>0n?1:sequence<0n?-1:0;
}
function currentBinding(tx:AppDb|DrizzleTx,attempt:ManagedConnectionAttempt,account:string):ManagedConnectionAttempt|undefined {
  const raw=read(tx,bindingKey(attempt.providerId,account));
  if(!raw)return;
  const binding=parseNativeConnectionAttempt(JSON.parse(raw));
  if(binding.ownerId!==attempt.ownerId||binding.deviceId!==attempt.deviceId)throw Error('CONNECTION_ATTEMPT_FENCED');
  return binding;
}
function revoke(tx:DrizzleTx,attempt:ManagedConnectionAttempt):void {
  if(attempt.effectKind!=='remove'||!attempt.accountId)return;
  const binding=currentBinding(tx,attempt,attempt.accountId);
  if(binding&&order(binding,attempt)>0)return;
  const old=read(tx,revokedKey(attempt.providerId,attempt.accountId));
  if(!old||order(attempt,JSON.parse(old))>0)write(tx,revokedKey(attempt.providerId,attempt.accountId),attempt);
}
function same(actual: ManagedConnectionAttempt, expected: ManagedConnectionAttempt): boolean {
  return hash(actual) === hash(expected);
}
function evidence(tx: AppDb | DrizzleTx, attempt: ManagedConnectionAttempt): Evidence {
  const raw=read(tx,key(attempt));
  if (!raw) throw new Error('CONNECTION_ATTEMPT_UNAVAILABLE');
  const value=JSON.parse(raw) as Evidence;
  if (value.version!==1 || !same(value.attempt,attempt)) throw new Error('CONNECTION_OPERATION_REUSED');
  if(!['prepared','started','applied'].includes(value.state)||typeof value.fenced!=='boolean'
    ||value.state==='applied'&&(typeof value.accountId!=='string'||value.result===undefined||value.digest!==hash([attempt,value.accountId,'applied',value.result,value.publication??null]))
    ||value.fenced&&value.fenceDigest!==hash([attempt,value.state,value.digest??null,'fenced'])) throw new Error('CONNECTION_EVIDENCE_INVALID');
  return value;
}
export const currentManagedConnectionAttempt = (): ManagedConnectionAttempt | undefined => attempts.getStore();

export function createNativeConnectionEvidence(db: AppDb) {
  return {
    begin(attempt: ManagedConnectionAttempt): void {
      parseNativeConnectionAttempt(attempt);
      const uuid=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
      if (!uuid.test(attempt.operationId) || !uuid.test(attempt.attemptId) || !uuid.test(attempt.credentialGeneration)
        || attempt.scopeKey!==`device:${attempt.deviceId}` || !/^[0-9]+$/.test(attempt.authorityEpoch)
        || !/^[0-9a-f]{64}$/.test(attempt.requestHash) || !Number.isFinite(attempt.deadlineAt)) throw new Error('CONNECTION_ATTEMPT_INVALID');
      db.transaction(tx=>{
        const prior=read(tx,key(attempt));
        if(prior){evidence(tx,attempt);return;}
        const latest=read(tx,providerKey(attempt));
        if(attempt.effectKind==='authorize'&&latest&&order(JSON.parse(latest),attempt)>=0)throw Error('CONNECTION_AUTHORITY_CHANGED');
        const binding=attempt.accountId?currentBinding(tx,attempt,attempt.accountId):undefined;
        if(binding&&order(binding,attempt)>0)throw Error('CONNECTION_ATTEMPT_FENCED');
        write(tx,key(attempt),{version:1,attempt,state:'prepared',fenced:false} satisfies Evidence);
        if(attempt.effectKind==='authorize')write(tx,providerKey(attempt),attempt);
        revoke(tx,attempt);
      });
    },
    async run<T>(attempt: ManagedConnectionAttempt, action:()=>Promise<T>): Promise<T> {
      db.transaction(tx=>{
        const prior=evidence(tx,attempt);
        if(prior.fenced || prior.state!=='prepared') throw new Error('CONNECTION_ATTEMPT_ALREADY_STARTED');
        const latest=read(tx,providerKey(attempt));
        if(Date.now()>=attempt.deadlineAt||attempt.effectKind==='authorize'&&(!latest||!same(JSON.parse(latest),attempt)))throw Error('CONNECTION_ATTEMPT_FENCED');
        write(tx,key(attempt),{...prior,state:'started'});
      });
      try{return await attempts.run(attempt,action);}
      catch(error){
        if((error as {knownNoEffect?:boolean})?.knownNoEffect){
          db.transaction(tx=>{
            const value=evidence(tx,attempt);
            if(!value.fenced){value.fenced=true;value.fenceDigest=hash([attempt,value.state,value.digest??null,'fenced']);write(tx,key(attempt),value);}
          });
        }
        throw error;
      }
    },
    read(attempt: ManagedConnectionAttempt): Readonly<Evidence> {
      return evidence(db,attempt);
    },
    fence(attempt: ManagedConnectionAttempt): Readonly<Evidence> {
      parseNativeConnectionAttempt(attempt);
      return db.transaction(tx=>{
        // Persist a missing-attempt tombstone without moving the provider head.
        // A late prepare cannot start it or supersede a newer authorization.
        if(!read(tx,key(attempt)))write(tx,key(attempt),{version:1,attempt,state:'prepared',fenced:false} satisfies Evidence);
        const value=evidence(tx,attempt);
        revoke(tx,attempt);
        if(!value.fenced){value.fenced=true;value.fenceDigest=hash([attempt,value.state,value.digest??null,'fenced']);write(tx,key(attempt),value);}
        return value;
      });
    },
  };
}

/** Called within the registry's actual SQLite transaction. The encrypted secret,
 * provider row and evidence commit or roll back together. No await is allowed. */
export function writeManagedProviderAccount<T extends ProviderAccountRow | null>(tx: DrizzleTx, attempt: ManagedConnectionAttempt | undefined,
  providerId: string, accountId: string, action:()=>T, effectKind: ManagedConnectionAttempt['effectKind']='authorize'): T {
  if(!attempt)return action();
  const value=evidence(tx,attempt);
  if(providerId!==attempt.providerId || effectKind!==attempt.effectKind || attempt.accountId!==null && attempt.accountId!==accountId)throw new Error('CONNECTION_OPERATION_REUSED');
  if(value.state==='applied') {
    if(value.accountId!==accountId || value.result===undefined)throw new Error('CONNECTION_OPERATION_REUSED');
    return value.result as T;
  }
  const latest=read(tx,providerKey(attempt));
  if(value.state!=='started' || value.fenced || Date.now()>=attempt.deadlineAt || attempt.effectKind==='authorize'&&(!latest||!same(JSON.parse(latest),attempt))
    || providerId!==attempt.providerId || attempt.accountId!==null && attempt.accountId!==accountId) throw new Error('CONNECTION_ATTEMPT_FENCED');
  const binding=currentBinding(tx,attempt,accountId);
  if(binding&&order(binding,attempt)>0)throw Error('CONNECTION_ATTEMPT_FENCED');
  const gate=read(tx,revokedKey(providerId,accountId));
  if(attempt.effectKind==='default'&&gate)throw Error('CONNECTION_ATTEMPT_FENCED');
  const result=action();
  if(attempt.effectKind==='authorize'){
    const revoked=read(tx,revokedKey(providerId,accountId));
    if(revoked){
      const prior=JSON.parse(revoked) as ManagedConnectionAttempt;
      if(order(prior,attempt)>=0)throw Error('CONNECTION_ATTEMPT_FENCED');
      // Only a later, explicitly bound authorization can release this account.
      // A failed disconnect may release the UI while the old credential stays unusable.
      tx.delete(kv).where(eq(kv.key,revokedKey(providerId,accountId))).run();
    }
  }
  if(attempt.effectKind==='authorize')write(tx,bindingKey(providerId,accountId),attempt);
  const publication=attempt.effectKind==='authorize'&&result?connectionPublicationRequest(attempt,result):undefined;
  const completed: Evidence={...value,state:'applied',accountId,result,...(publication?{publication}:{}),
    digest:hash([attempt,accountId,'applied',result,publication??null])};
  write(tx,key(attempt),completed);
  return result;
}
