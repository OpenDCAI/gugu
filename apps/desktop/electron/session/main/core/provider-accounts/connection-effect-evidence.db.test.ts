import { randomUUID } from 'node:crypto';
import { afterEach,beforeEach,describe,expect,it } from 'vitest';
import { openFixture,type FixtureDb } from '@tooling/utils/db';
import { eq } from 'drizzle-orm';
import { appSecrets,kv } from '@main/db/schema';
import {createNativeConnectionEvidenceSigner} from '../secrets/connection-evidence-signer';
import type {ConnectionEvidenceAction} from '@gugu/core/cloud/connectionEvidence';
import { EncryptedAppSecretsStore } from '../secrets/encrypted-app-secrets-store';
import { ProviderAccountRegistry } from './provider-account-registry';
import {createConnectionNativeEvidence} from '../../../../sessionpage/connection-native-evidence';
import { createNativeConnectionEvidence,type ManagedConnectionAttempt } from './connection-effect-evidence';

const secureStorage={isEncryptionAvailable:()=>true,encryptString:(value:string)=>Buffer.from(`sealed:${value}`),
  decryptString:(value:Buffer)=>value.toString().slice(7)};
describe('managed native effect custody transaction',()=>{
 let fixture:FixtureDb,sequence=0;
 beforeEach(async()=>{sequence=0;fixture=await openFixture('empty');});
 afterEach(()=>fixture?.close());
 const attempt=():ManagedConnectionAttempt=>({operationId:randomUUID(),attemptId:randomUUID(),attemptOrder:String(++sequence),ownerId:randomUUID(),deviceId:'fixture-device',
  scopeKey:'device:fixture-device',resourceKey:null,providerId:'github',accountId:null,credentialGeneration:randomUUID(),
  recreationId:randomUUID(),expectedItemRevision:null,expectedHeadRevision:'0',effectKind:'authorize',authorityEpoch:'4',requestHash:'a'.repeat(64),operationRevision:null,admissionId:null,deadlineAt:Date.now()+600_000});
 const registry=()=>new ProviderAccountRegistry(fixture.db,new EncryptedAppSecretsStore(fixture.db,secureStorage as never,'darwin'));
 const saved=()=>fixture.db.select().from(appSecrets).all();
 async function signedNative(a:ManagedConnectionAttempt,store:ReturnType<typeof createNativeConnectionEvidence>){
  const signer=createNativeConnectionEvidenceSigner({ownerId:a.ownerId,deviceId:a.deviceId,
   secrets:new EncryptedAppSecretsStore(fixture.db,secureStorage as never,'darwin')});
  const {keyId}=await signer.provision(randomUUID());
  const query=(action:ConnectionEvidenceAction,attempt=a)=>({attempt,challenge:{version:1 as const,challengeId:randomUUID(),nonce:'a'.repeat(64),keyId,
   ownerId:a.ownerId,deviceId:a.deviceId,operationId:a.operationId,attemptId:a.attemptId,action,expiresAt:new Date(Date.now()+30_000).toISOString()}});
  const native=createConnectionNativeEvidence({ownerId:a.ownerId,deviceId:a.deviceId,instance:()=> 'fixture-runtime',assertCurrent:async()=>{},
   signer:async()=>signer,store:async()=>store,cloud:{prepareAttempt:async()=>a,inspectAttempt:async()=>a}});
  return {native,query};
 }
 it('commits real encrypted storage, account and original UUID/generation evidence together',async()=>{
  const service=createNativeConnectionEvidence(fixture.db),a=attempt(),accounts=registry();service.begin(a);
  await service.run(a,()=>accounts.upsertAccount({providerId:'github',accountId:'real-account',secret:'fixture-secret'}));
  expect(saved()).toHaveLength(1);expect(saved()[0]!.secret).not.toBe('fixture-secret');
  const proof=service.read(a);expect(proof).toMatchObject({state:'applied',accountId:'real-account',attempt:{operationId:a.operationId,credentialGeneration:a.credentialGeneration}});
  expect(await accounts.listAccounts('github')).toHaveLength(1);
  expect(fixture.db.select().from(kv).all().map(row=>row.value).join('')).not.toContain('fixture-secret');
 });
 it('rolls back ciphertext and evidence when the actual account insert fails',async()=>{
  const service=createNativeConnectionEvidence(fixture.db),a=attempt(),accounts=registry();service.begin(a);
  fixture.sqlite.exec("CREATE TEMP TRIGGER refuse_account BEFORE INSERT ON provider_accounts BEGIN SELECT RAISE(ABORT,'fixture-refusal'); END;");
  await expect(service.run(a,()=>accounts.upsertAccount({providerId:'github',accountId:'real-account',secret:'fixture-secret'}))).rejects.toThrow('fixture-refusal');
  expect(saved()).toHaveLength(0);expect(await accounts.listAccounts('github')).toHaveLength(0);
  expect(service.read(a).state).toBe('started');expect(service.fence(a).fenced).toBe(true);
 });
 it('fences the same SQLite boundary before a late credential commit, without an effect',async()=>{
  const service=createNativeConnectionEvidence(fixture.db),a=attempt(),accounts=registry();service.begin(a);
  await expect(service.run(a,async()=>{service.fence(a);return accounts.upsertAccount({providerId:'github',accountId:'late',secret:'fixture-secret'});})).rejects.toThrow('CONNECTION_ATTEMPT_FENCED');
  expect(saved()).toHaveLength(0);expect(await accounts.listAccounts('github')).toHaveLength(0);
  expect(service.fence(a)).toEqual(service.fence(a));
 });
 it('refuses to restart an authorization after the durable started marker',async()=>{
  const service=createNativeConnectionEvidence(fixture.db),a=attempt();service.begin(a);let calls=0;
  await expect(service.run(a,async()=>{calls++;throw Error('simulated-response-loss');})).rejects.toThrow('simulated-response-loss');
  await expect(service.run(a,async()=>{calls++;})).rejects.toThrow('CONNECTION_ATTEMPT_ALREADY_STARTED');
  expect(calls).toBe(1);
 });
 it('repeated account writes keep the original effect and reject other account/provider UUID reuse',async()=>{
  const service=createNativeConnectionEvidence(fixture.db),a=attempt(),accounts=registry();service.begin(a);
  await service.run(a,async()=>{
   const first=await accounts.upsertAccount({providerId:'github',accountId:'first',secret:'fixture-original'});
   const ciphertext=saved()[0]!.secret;
   expect((await accounts.upsertAccount({providerId:'github',accountId:'first',secret:'fixture-changed'})).account).toEqual(first.account);
   expect(saved()[0]!.secret).toBe(ciphertext);
   await expect(accounts.upsertAccount({providerId:'github',accountId:'other',secret:'fixture-other'})).rejects.toThrow('CONNECTION_OPERATION_REUSED');
   await expect(accounts.upsertAccount({providerId:'mail',accountId:'first',secret:'fixture-other'})).rejects.toThrow('CONNECTION_OPERATION_REUSED');
  });
  expect(saved()).toHaveLength(1);
 });
 it('records default selection and ciphertext deletion in their real SQLite transactions',async()=>{
  const service=createNativeConnectionEvidence(fixture.db),accounts=registry();
  await accounts.upsertAccount({providerId:'github',accountId:'first',secret:'fixture-first'});
  await accounts.upsertAccount({providerId:'github',accountId:'second',secret:'fixture-second'});
  const select={...attempt(),accountId:'second',effectKind:'default' as const};service.begin(select);
  await service.run(select,()=>accounts.setDefaultAccount('github','second'));
  expect(service.read(select).result?.isDefault).toBe(true);
  const remove={...attempt(),accountId:'second',effectKind:'remove' as const};service.begin(remove);
  await service.run(remove,async()=>{
   await accounts.removeAccount('github','second');
   const before=fixture.sqlite.prepare('SELECT total_changes() AS n').get();
   await accounts.removeAccount('github','second');
   expect(fixture.sqlite.prepare('SELECT total_changes() AS n').get()).toEqual(before);
  });
  expect(service.read(remove)).toMatchObject({state:'applied',accountId:'second'});
  expect(saved()).toHaveLength(1);
  expect((await accounts.listAccounts('github')).map(row=>[row.accountId,row.isDefault])).toEqual([['first',true]]);
 });
 it('rolls back registry removal when ciphertext deletion fails',async()=>{
  const service=createNativeConnectionEvidence(fixture.db),accounts=registry();
  await accounts.upsertAccount({providerId:'github',accountId:'first',secret:'fixture-first'});
  const a={...attempt(),accountId:'first',effectKind:'remove' as const};service.begin(a);
  fixture.sqlite.exec("CREATE TEMP TRIGGER refuse_secret_delete BEFORE DELETE ON app_secrets BEGIN SELECT RAISE(ABORT,'fixture-delete-refusal'); END;");
  await expect(service.run(a,()=>accounts.removeAccount('github','first'))).rejects.toThrow('fixture-delete-refusal');
  expect(saved()).toHaveLength(1);expect(await accounts.listAccounts('github')).toHaveLength(1);
  expect(service.read(a).state).toBe('started');
 });
 it('allows a conditional refresh and rejects a stale refresh after reauthorization or deletion',async()=>{
  const accounts=registry();await accounts.upsertAccount({providerId:'github',accountId:'first',secret:'fixture-old'});
  expect(await accounts.compareAndSwapSecret('github','first','fixture-old','fixture-refreshed')).toBe(true);
  expect(await accounts.resolveSecret('github','first')).toBe('fixture-refreshed');
  await accounts.upsertAccount({providerId:'github',accountId:'first',secret:'fixture-new-authorization'});
  expect(await accounts.compareAndSwapSecret('github','first','fixture-refreshed','fixture-stale-refresh')).toBe(false);
  expect(await accounts.resolveSecret('github','first')).toBe('fixture-new-authorization');
  await accounts.removeAccount('github','first');
  expect(await accounts.compareAndSwapSecret('github','first','fixture-new-authorization','fixture-late-refresh')).toBe(false);
  expect(saved()).toHaveLength(0);expect(await accounts.listAccounts('github')).toHaveLength(0);
 });
 it.each(['reauthorize','disconnect'] as const)('rejects a refresh paused between encryption and commit during %s',async(mode)=>{
  let entered!:()=>void,release!:()=>void;
  const paused=new Promise<void>(resolve=>{entered=resolve;});
  const resume=new Promise<void>(resolve=>{release=resolve;});
  class PausedSecrets extends EncryptedAppSecretsStore {
   override async atomicSecretCompareAndSwap(...args:Parameters<EncryptedAppSecretsStore['atomicSecretCompareAndSwap']>){
    const write=await super.atomicSecretCompareAndSwap(...args);entered();await resume;return write;
   }
  }
  const accounts=new ProviderAccountRegistry(fixture.db,new PausedSecrets(fixture.db,secureStorage as never,'darwin'));
  await accounts.upsertAccount({providerId:'github',accountId:'first',secret:'fixture-original'});
  const refresh=accounts.compareAndSwapSecret('github','first','fixture-original','fixture-stale');
  await paused;
  if(mode==='reauthorize')await accounts.upsertAccount({providerId:'github',accountId:'first',secret:'fixture-new'});
  else await accounts.removeAccount('github','first');
  release();expect(await refresh).toBe(false);
  expect(await accounts.resolveSecret('github','first')).toBe(mode==='reauthorize'?'fixture-new':null);
 });
 it('persists a fence for a missing attempt without replacing a newer provider attempt',async()=>{
  const service=createNativeConnectionEvidence(fixture.db),old=attempt(),newer={...old,operationId:randomUUID(),attemptId:randomUUID(),attemptOrder:'2'};
  service.begin(newer);expect(service.fence(old).fenced).toBe(true);service.begin(old);
  await expect(service.run(old,async()=>{})).rejects.toThrow('CONNECTION_ATTEMPT_ALREADY_STARTED');
  const accounts=registry();await service.run(newer,()=>accounts.upsertAccount({providerId:'github',accountId:'newer',secret:'fixture-secret'}));
  expect(service.read(newer).state).toBe('applied');
 });
 it('rejects a reordered older prepare before any upstream action',async()=>{
  const service=createNativeConnectionEvidence(fixture.db),old=attempt(),newer={...old,operationId:randomUUID(),attemptId:randomUUID(),attemptOrder:'2'};
  service.begin(newer);expect(()=>service.begin(old)).toThrow('CONNECTION_AUTHORITY_CHANGED');
 });
 it('keeps a failed disconnect credential unusable until a later explicit authorization commits',async()=>{
  const service=createNativeConnectionEvidence(fixture.db),accounts=registry();
  await accounts.upsertAccount({providerId:'github',accountId:'first',secret:'fixture-original'});
  const removal={...attempt(),accountId:'first',effectKind:'remove' as const};service.begin(removal);service.fence(removal);
  expect(saved()).toHaveLength(1);expect(await accounts.resolveSecret('github','first')).toBeNull();
  await accounts.upsertAccount({providerId:'github',accountId:'first',secret:'fixture-late-observation'});
  expect(await accounts.resolveSecret('github','first')).toBeNull();
  const fresh={...attempt(),ownerId:removal.ownerId,deviceId:removal.deviceId,accountId:'first'};service.begin(fresh);
  await service.run(fresh,()=>accounts.upsertAccount({providerId:'github',accountId:'first',secret:'fixture-explicit'}));
  expect(await accounts.resolveSecret('github','first')).toBe('fixture-explicit');
 });
 it('preserves a newer explicit credential when an older remove is admitted after its commit',async()=>{
  const service=createNativeConnectionEvidence(fixture.db),accounts=registry(),fresh={...attempt(),expectedHeadRevision:'12'};
  service.begin(fresh);await service.run(fresh,()=>accounts.upsertAccount({providerId:'github',accountId:'first',secret:'fixture-new-consent'}));
  const older={...fresh,operationId:randomUUID(),attemptId:randomUUID(),attemptOrder:'99',credentialGeneration:randomUUID(),
   recreationId:null,expectedItemRevision:null,expectedHeadRevision:null,operationRevision:'12',admissionId:randomUUID(),accountId:'first',effectKind:'remove' as const};
  expect(()=>service.begin(older)).toThrow('CONNECTION_ATTEMPT_FENCED');
  service.fence(older);
  expect(await accounts.resolveSecret('github','first')).toBe('fixture-new-consent');expect(saved()).toHaveLength(1);
 })
 it('fences credential use even when an admitted remove never reached native preparation',async()=>{
  const service=createNativeConnectionEvidence(fixture.db),accounts=registry();
  await accounts.upsertAccount({providerId:'github',accountId:'first',secret:'fixture-old'});
  const a={...attempt(),accountId:'first',effectKind:'remove' as const,operationRevision:'1',recreationId:null,expectedHeadRevision:null};
  service.fence(a);
  expect(await accounts.resolveSecret('github','first')).toBeNull();expect(saved()).toHaveLength(1);
 })
 it('keeps the prior credential usable after a failed reauthorization and never clears a newer revoke',async()=>{
  const service=createNativeConnectionEvidence(fixture.db),accounts=registry();
  await accounts.upsertAccount({providerId:'github',accountId:'first',secret:'fixture-old'});
  const a=attempt();service.begin(a);
  await expect(service.run(a,async()=>{throw Object.assign(Error('fixture-cancel'),{knownNoEffect:true});})).rejects.toThrow('fixture-cancel');
  expect(await accounts.resolveSecret('github','first')).toBe('fixture-old');
 })
 it('serves only original device proof and refuses foreign or altered identities before touching the journal',async()=>{
  const store=createNativeConnectionEvidence(fixture.db),a=attempt(),accounts=registry();store.begin(a);
  await store.run(a,()=>accounts.upsertAccount({providerId:'github',accountId:'first',secret:'fixture-secret'}));
  const {native,query}=await signedNative(a,store);
  const changes=()=>fixture.sqlite.prepare('SELECT total_changes() AS n').get(),before=changes();
  const proof=await native.read(query('read'),a.ownerId);expect(proof).toMatchObject({version:1,proof:{state:'applied',accountId:'first'}});
  expect(changes()).toEqual(before);expect(JSON.stringify(proof)).not.toContain('fixture-secret');
  await expect(native.fence(query('fence'),randomUUID())).rejects.toMatchObject({code:'42501'});
  await expect(native.fence(query('fence',{...a,credentialGeneration:randomUUID()}),a.ownerId)).rejects.toMatchObject({code:'42501'});
  expect(changes()).toEqual(before);
 });
 it('automatically fences a forever missing native attempt without replaying authorization',async()=>{
  const store=createNativeConnectionEvidence(fixture.db),a=attempt();let effects=0;
  const {native,query}=await signedNative(a,store);
  expect(await native.fence(query('fence'),a.ownerId)).toMatchObject({proof:{state:'prepared',fenced:true}});
  store.begin(a);await expect(store.run(a,async()=>{effects++;})).rejects.toThrow('CONNECTION_ATTEMPT_ALREADY_STARTED');
  expect(effects).toBe(0);const again=await native.fence(query('fence'),a.ownerId);expect(again.proof.fenced).toBe(true);
 });
 it('durably fences a known refusal without issuing a credential effect',async()=>{
  const store=createNativeConnectionEvidence(fixture.db),a=attempt();store.begin(a);
  await expect(store.run(a,async()=>{throw Object.assign(new Error('fixture-refusal'),{knownNoEffect:true});})).rejects.toThrow('fixture-refusal');
  expect(store.read(a)).toMatchObject({state:'started',fenced:true});expect(saved()).toHaveLength(0);
 });
 it('retains authoritative applied evidence even if a later error is labelled as a refusal',async()=>{
  const store=createNativeConnectionEvidence(fixture.db),a=attempt(),accounts=registry();store.begin(a);
  await expect(store.run(a,async()=>{
   await accounts.upsertAccount({providerId:'github',accountId:'actual',secret:'fixture-secret'});
   throw Object.assign(new Error('fixture-after-commit'),{knownNoEffect:true});
  })).rejects.toThrow('fixture-after-commit');
  expect(store.read(a)).toMatchObject({state:'applied',fenced:true,accountId:'actual'});expect(saved()).toHaveLength(1);
 });
 it('cancels a prepared original authorization while its upstream action is paused, before credential custody',async()=>{
  const store=createNativeConnectionEvidence(fixture.db),a=attempt(),accounts=registry();let prepared=0;
  const native=createConnectionNativeEvidence({ownerId:a.ownerId,deviceId:a.deviceId,instance:()=> 'fixture-runtime',assertCurrent:async()=>{},
   signer:async()=>{throw Error('fixture-unused')},store:async()=>store,cloud:{prepareAttempt:async()=>{prepared++;return a},inspectAttempt:async()=>a}});
  await native.begin('github',a.operationId,a.authorityEpoch);expect(prepared).toBe(1);
  let enter!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>{enter=resolve}),resume=new Promise<void>(resolve=>{release=resolve});
  const effect=native.run('github',a.operationId,a.authorityEpoch,async()=>{enter();await resume;return accounts.upsertAccount({providerId:'github',accountId:'late',secret:'fixture-late'});});
  await started;await native.cancel('github',a.operationId);release();
  await expect(effect).rejects.toThrow('CONNECTION_ATTEMPT_FENCED');
  expect(store.read(a)).toMatchObject({state:'started',fenced:true});expect(saved()).toHaveLength(0);
 })
 it('reads evidence without a database mutation',async()=>{
  const service=createNativeConnectionEvidence(fixture.db),a=attempt();service.begin(a);
  const changes=()=>fixture.sqlite.prepare('SELECT total_changes() AS n').get();
  const before=changes();service.read(a);service.read(a);expect(changes()).toEqual(before);
  expect(fixture.db.select().from(kv).where(eq(kv.key,'unrelated')).all()).toEqual([]);
 });
});
