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
        if(latest && (BigInt((JSON.parse(latest) as ManagedConnectionAttempt).authorityEpoch)>BigInt(attempt.authorityEpoch)
          ||BigInt((JSON.parse(latest) as ManagedConnectionAttempt).attemptOrder)>=BigInt(attempt.attemptOrder))) throw new Error('CONNECTION_AUTHORITY_CHANGED');
        write(tx,key(attempt),{version:1,attempt,state:'prepared',fenced:false} satisfies Evidence);
        write(tx,providerKey(attempt),attempt);
        if(attempt.effectKind==='remove'&&attempt.accountId)write(tx,revokedKey(attempt.providerId,attempt.accountId),attempt);
      });
    },
    async run<T>(attempt: ManagedConnectionAttempt, action:()=>Promise<T>): Promise<T> {
      db.transaction(tx=>{
        const prior=evidence(tx,attempt);
        if(prior.fenced || prior.state!=='prepared') throw new Error('CONNECTION_ATTEMPT_ALREADY_STARTED');
        const latest=read(tx,providerKey(attempt));
        if(Date.now()>=attempt.deadlineAt||!latest||!same(JSON.parse(latest),attempt))throw Error('CONNECTION_ATTEMPT_FENCED');
        write(tx,key(attempt),{...prior,state:'started'});
      });
      return attempts.run(attempt,action);
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
  if(value.state!=='started' || value.fenced || Date.now()>=attempt.deadlineAt || !latest || !same(JSON.parse(latest),attempt)
    || providerId!==attempt.providerId || attempt.accountId!==null && attempt.accountId!==accountId) throw new Error('CONNECTION_ATTEMPT_FENCED');
  const result=action();
  if(attempt.effectKind==='authorize'){
    const revoked=read(tx,revokedKey(providerId,accountId));
    if(revoked){
      const prior=JSON.parse(revoked) as ManagedConnectionAttempt;
      if(BigInt(prior.attemptOrder)>=BigInt(attempt.attemptOrder))throw Error('CONNECTION_ATTEMPT_FENCED');
      // Only a later, explicitly bound authorization can release this account.
      // A failed disconnect may release the UI while the old credential stays unusable.
      tx.delete(kv).where(eq(kv.key,revokedKey(providerId,accountId))).run();
    }
  }
  const publication=attempt.effectKind==='authorize'&&result?connectionPublicationRequest(attempt,result):undefined;
  const completed: Evidence={...value,state:'applied',accountId,result,...(publication?{publication}:{}),
    digest:hash([attempt,accountId,'applied',result,publication??null])};
  write(tx,key(attempt),completed);
  return result;
}
