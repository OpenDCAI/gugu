import {createCipheriv,createDecipheriv,randomBytes,randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {openFixture,type FixtureDb} from '@tooling/utils/db';
import {appSecrets} from '@main/db/schema';
import {createConnectionEvidenceRequester} from '@gugu/core/cloud/connectionEvidenceRpc';
import {verifyConnectionEvidenceReply,type ConnectionEvidenceAction,type ConnectionEvidenceChallenge,type ConnectionEvidenceReply} from '@gugu/core/cloud/connectionEvidence';
import {createDeviceRpcRequestHandler} from '@gugu/core/cloud/deviceRpcResponder';
import {parseDeviceRpcRequest} from '@gugu/core/cloud/deviceRpcProtocol';
import type {DeviceTopicHandlers} from '@gugu/core/cloud/deviceRpcAttach';
import {REMOTE_PROTOCOL_VERSION} from '@gugu/core/cloud/serverMachineHealth';
import {createConnectionNativeEvidence} from '../../../../sessionpage/connection-native-evidence';
import {createNativeConnectionEvidence,type ManagedConnectionAttempt} from '../provider-accounts/connection-effect-evidence';
import {ProviderAccountRegistry} from '../provider-accounts/provider-account-registry';
import {EncryptedAppSecretsStore} from '../secrets/encrypted-app-secrets-store';
import {createNativeConnectionEvidenceSigner} from '../secrets/connection-evidence-signer';
import {connectionEvidenceRpcHandlers} from './connection-evidence-rpc';
import {setOwnerConnectionControl,type OwnerConnectionControl} from './owner-connection-control';

// Actual encrypted store, SQLite journal, native Ed25519, responder, attach and
// requester. Only the OS vault and network transport are injected test seams.
const vaultKey=randomBytes(32);
const vault={isEncryptionAvailable:()=>true,encryptString(value:string){
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',vaultKey,iv);
  const bytes=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),bytes]);
},decryptString(value:Buffer){
  const cipher=createDecipheriv('aes-256-gcm',vaultKey,value.subarray(0,12));cipher.setAuthTag(value.subarray(12,28));
  return Buffer.concat([cipher.update(value.subarray(28)),cipher.final()]).toString('utf8');
}};
const makeAttempt=():ManagedConnectionAttempt=>({operationId:randomUUID(),attemptId:randomUUID(),attemptOrder:'1',ownerId:randomUUID(),deviceId:'signed-device',
 scopeKey:'device:signed-device',resourceKey:null,providerId:'github',accountId:null,credentialGeneration:randomUUID(),authorityEpoch:'4',
 requestHash:'a'.repeat(64),operationRevision:null,admissionId:null,recreationId:randomUUID(),expectedItemRevision:null,expectedHeadRevision:'0',
 deadlineAt:Date.now()+600_000,effectKind:'authorize'});
function challenge(a:ManagedConnectionAttempt,keyId:string,action:ConnectionEvidenceAction):ConnectionEvidenceChallenge {
 return {version:1,challengeId:randomUUID(),nonce:randomBytes(32).toString('hex'),keyId,ownerId:a.ownerId,deviceId:a.deviceId,
  operationId:a.operationId,attemptId:a.attemptId,action,expiresAt:new Date(Date.now()+30_000).toISOString()};
}

describe('trusted connection evidence through actual device RPC',()=>{
 let fixture:FixtureDb;
 const closes:(()=>void)[]=[];
 beforeEach(async()=>{fixture=await openFixture('empty');});
 afterEach(()=>{for(const close of closes.splice(0))close();fixture?.close();});
 async function harness(){
  const a=makeAttempt(),secrets=new EncryptedAppSecretsStore(fixture.db,vault as never,'darwin');
  const signer=createNativeConnectionEvidenceSigner({ownerId:a.ownerId,deviceId:a.deviceId,secrets});
  const key=await signer.provision(randomUUID()),store=createNativeConnectionEvidence(fixture.db);
  let inspected=a,current=true;
  const native=createConnectionNativeEvidence({ownerId:a.ownerId,deviceId:a.deviceId,instance:()=> 'signed-fixture',
   assertCurrent:async()=>{if(!current)throw Error('CONNECTION_ACCOUNT_CHANGED')},signer:async()=>signer,store:async()=>store,
   cloud:{prepareAttempt:async()=>inspected,inspectAttempt:async()=>inspected}});
  const unused=async()=>{throw Error('fixture-unused')};
  setOwnerConnectionControl({readEvidence:native.read,fenceEvidence:native.fence,runAuthorization:unused,prepareAuthorization:unused,
   prepare:unused,hold:unused,release:unused,commitAuthorization:unused,commitAuthorizationBatch:unused} satisfies OwnerConnectionControl);
  const host=createDeviceRpcRequestHandler({handlers:{...connectionEvidenceRpcHandlers,
   'taskhost.attach':()=>({result:{attached:true,protocol:REMOTE_PROTOCOL_VERSION}})}});
  let transform:(v:unknown)=>unknown=v=>v,requestTransform:(v:unknown)=>unknown=v=>v;
  let forged:((payload:unknown)=>Promise<unknown>|unknown)|undefined;
  const topics=new Map<string,DeviceTopicHandlers>();
  const sent:unknown[]=[];
  const join=vi.fn(async(name:string,handlers:DeviceTopicHandlers)=>{
   topics.set(name,handlers);
   return {close(){topics.delete(name)},async send(message:unknown){
    const req=parseDeviceRpcRequest(message)!;sent.push(req);
    const deliver=(reply:unknown)=>{for(const handler of topics.values())handler.onMessage({type:'broadcast',event:'broadcast',payload:reply});};
    if(req.type==='taskhost.attach'){await host(message,deliver);return;}
    if(forged){deliver({type:`${req.type}:reply`,request_id:req.request_id,result:await forged(req.payload)});return;}
    await host(requestTransform(message),reply=>deliver(reply.error?reply:{...reply,result:transform(reply.result)}));
   }};
  });
  const trusted=vi.fn(async(_context:ManagedConnectionAttempt,action:ConnectionEvidenceAction)=>({challenge:challenge(a,key.keyId,action),publicKey:key.publicKey}));
  const requester=createConnectionEvidenceRequester({ownerId:a.ownerId,asker:randomUUID(),join,challenge:trusted});closes.push(requester.close);
  return {a,key,store,signer,secrets,native,requester,join,sent,trusted,
   changeReply(fn:typeof transform){transform=fn},changeRequest(fn:typeof requestTransform){requestTransform=fn},
   forge(fn:NonNullable<typeof forged>){forged=fn},setInspect(v:ManagedConnectionAttempt){inspected=v},signOut(){current=false},
   async applied(meta?:{displayName:string}){store.begin(a);await store.run(a,()=>new ProviderAccountRegistry(fixture.db,secrets)
    .upsertAccount({providerId:'github',accountId:'actual-account',secret:'fixture-credential',...(meta?{meta}:{})}));},
   query(action:ConnectionEvidenceAction){return {attempt:a,challenge:challenge(a,key.keyId,action)}}};
 }
 it('reads and fences the actual SQLite result with native signatures and a separate trusted root',async()=>{
  const h=await harness();await h.applied();const signed=await h.requester.read(h.a);
  expect(signed.proof).toMatchObject({state:'applied',fenced:false,accountId:'actual-account'});
  expect(h.trusted).toHaveBeenCalledWith(h.a,'read');expect(signed.signature).toMatch(/^[\w-]{86}$/);
  const fenced=await h.requester.fence(h.a);expect(fenced.proof).toMatchObject({state:'applied',fenced:true});
  expect(h.store.read(h.a).fenced).toBe(true);expect(JSON.stringify(fenced)).not.toContain('fixture-credential');
  const ciphertext=fixture.db.select().from(appSecrets).all().map(row=>row.secret).join('');
  expect(Buffer.from(ciphertext,'base64').toString()).not.toContain('privateKey');
 });
 it('preserves approved publications larger than 64KiB through real custody and requester',async()=>{
  const h=await harness();await h.applied({displayName:'x'.repeat(70_000)});
  const reply=await h.requester.read(h.a);
  expect(reply.proof.publication!.length).toBeGreaterThan(131_072);
  expect(reply.proof.accountId).toBe('actual-account');
 });
 it('keeps immutable per-device keys across signer instances and exports only the public key',async()=>{
  const h=await harness();
  const before=fixture.db.select().from(appSecrets).all().filter(row=>row.key.startsWith('connection-evidence-private:'));
  const reopened=createNativeConnectionEvidenceSigner({ownerId:h.a.ownerId,deviceId:h.a.deviceId,secrets:h.secrets});
  expect(await reopened.publicKey(h.key.keyId)).toBe(h.key.publicKey);
  expect(await reopened.provision(h.key.keyId)).toEqual(h.key);
  expect(fixture.db.select().from(appSecrets).all().filter(row=>row.key.startsWith('connection-evidence-private:'))).toEqual(before);
  const c=challenge(h.a,h.key.keyId,'read');
  const reply=await reopened.sign(c,{version:1,attempt:h.a,state:'prepared',fenced:false});
  expect(await verifyConnectionEvidenceReply(h.a,'read',c,h.key.publicKey,reply)).toEqual(reply);
 });
 it('checks the current runtime identity after loading the signing key',async()=>{
  const h=await harness(),assertCurrent=vi.fn(async()=>{throw Error('CONNECTION_ACCOUNT_CHANGED')});
  const guarded=createNativeConnectionEvidenceSigner({ownerId:h.a.ownerId,deviceId:h.a.deviceId,secrets:h.secrets,assertCurrent});
  await expect(guarded.sign(challenge(h.a,h.key.keyId,'read'),{version:1,attempt:h.a,state:'prepared',fenced:false}))
   .rejects.toThrow('CONNECTION_ACCOUNT_CHANGED');expect(assertCurrent).toHaveBeenCalledOnce();
 });
 it.each(['read','fence'] as const)('rejects a same-owner forged %s broadcast, even with a matching request ID',async action=>{
  const h=await harness(),spy=vi.spyOn(h.signer,'sign');
  h.forge(()=>({version:1,attempt:h.a,state:'applied',fenced:true,digest:'b'.repeat(64),fenceDigest:'c'.repeat(64),accountId:'forged'}));
  await expect(h.requester[action](h.a)).rejects.toThrow('CONNECTION_EVIDENCE_INVALID');expect(spy).not.toHaveBeenCalled();
  expect(()=>h.store.read(h.a)).toThrow('CONNECTION_ATTEMPT_UNAVAILABLE');
 });
 it('rejects another device signing under the same owner',async()=>{
  const h=await harness(),other={...h.a,deviceId:'other-device',scopeKey:'device:other-device'};
  const foreign=createNativeConnectionEvidenceSigner({ownerId:h.a.ownerId,deviceId:other.deviceId,secrets:h.secrets});
  const root=await foreign.provision(randomUUID());
  const reply=await foreign.sign(challenge(other,root.keyId,'read'),{version:1,attempt:other,state:'prepared',fenced:false});
  h.forge(()=>reply);await expect(h.requester.read(h.a)).rejects.toThrow('CONNECTION_EVIDENCE_INVALID');
 });
 it('rejects an attacker key signing forged evidence for the target device',async()=>{
  const h=await harness();
  // A separate encrypted store stands in for another machine claiming this ID.
  const otherFixture=await openFixture('empty');
  try{
   const attacker=createNativeConnectionEvidenceSigner({ownerId:h.a.ownerId,deviceId:h.a.deviceId,
    secrets:new EncryptedAppSecretsStore(otherFixture.db,vault as never,'darwin')});
   await attacker.provision(h.key.keyId);
   h.forge(async raw=>attacker.sign((raw as {challenge:ConnectionEvidenceChallenge}).challenge,
    {version:1,attempt:h.a,state:'prepared',fenced:false}));
   await expect(h.requester.read(h.a)).rejects.toThrow('CONNECTION_EVIDENCE_SIGNATURE_INVALID');
  }finally{otherFixture.close();}
 });
 it.each(['nonce','action','attempt','generation','expired','signature','extra','oversize'] as const)('rejects a signed reply with altered %s',async field=>{
  const h=await harness();await h.applied();h.changeReply(value=>{
   const v=structuredClone(value) as ConnectionEvidenceReply;
   if(field==='nonce')v.challenge.nonce='f'.repeat(64);
   if(field==='action')v.challenge.action='fence';
   if(field==='attempt')v.proof.attempt.attemptId=randomUUID();
   if(field==='generation')v.proof.attempt.credentialGeneration=randomUUID();
   if(field==='expired')v.challenge.expiresAt=new Date(Date.now()-1).toISOString();
   if(field==='signature')v.signature=(v.signature[0]==='a'?'b':'a')+v.signature.slice(1);
   if(field==='extra')Object.assign(v,{publicKey:h.key.publicKey});
   if(field==='oversize')v.proof.publication='x'.repeat(1_572_865);
   return v;
  });await expect(h.requester.read(h.a)).rejects.toThrow();
 });
 it('rejects a substituted trusted public key and malformed SPKI before device I/O',async()=>{
  const h=await harness();h.store.begin(h.a);
  const other=await h.signer.provision(randomUUID());await h.signer.provision(h.key.keyId);
  h.trusted.mockImplementation(async(_c,action)=>({challenge:challenge(h.a,h.key.keyId,action),publicKey:other.publicKey}));
  await expect(h.requester.read(h.a)).rejects.toThrow('CONNECTION_EVIDENCE_SIGNATURE_INVALID');
  h.trusted.mockImplementation(async(_c,action)=>({challenge:challenge(h.a,h.key.keyId,action),publicKey:'A'.repeat(59)}));
  const before=h.sent.length;await expect(h.requester.read(h.a)).rejects.toThrow('CONNECTION_EVIDENCE_INVALID');expect(h.sent).toHaveLength(before);
 });
 it('rejects a previously accepted reply while supporting layered pure verification',async()=>{
  const h=await harness();h.store.begin(h.a);
  const c=challenge(h.a,h.key.keyId,'read');h.trusted.mockResolvedValue({challenge:c,publicKey:h.key.publicKey});
  const signed=await h.requester.read(h.a);
  h.forge(()=>signed);await expect(h.requester.read(h.a)).rejects.toThrow('CONNECTION_EVIDENCE_REPLAY');
  h.trusted.mockImplementation(async(_c,action)=>({challenge:challenge(h.a,h.key.keyId,action),publicKey:h.key.publicKey}));
  await expect(h.requester.read(h.a)).rejects.toThrow('CONNECTION_EVIDENCE_INVALID');
  const fresh=challenge(h.a,h.key.keyId,'read');
  const reply=await h.native.read({attempt:h.a,challenge:fresh},h.a.ownerId);
  const results=await Promise.allSettled([verifyConnectionEvidenceReply(h.a,'read',fresh,h.key.publicKey,reply),verifyConnectionEvidenceReply(h.a,'read',fresh,h.key.publicKey,reply)]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(2);
  h.forge(()=>reply);h.trusted.mockResolvedValue({challenge:fresh,publicKey:h.key.publicKey});
  const concurrent=await Promise.allSettled([h.requester.read(h.a),h.requester.read(h.a)]);
  expect(concurrent.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 });
 it.each(['unknown','retired'] as const)('refuses %s key before SQLite or key creation',async mode=>{
  const h=await harness(),c=challenge(h.a,mode==='unknown'?randomUUID():h.key.keyId,'fence');
  if(mode==='retired')await h.signer.provision(randomUUID());
  const before=fixture.sqlite.prepare('SELECT total_changes() AS n').get();
  await expect(h.native.fence({attempt:h.a,challenge:c},h.a.ownerId)).rejects.toThrow('CONNECTION_EVIDENCE_KEY_UNAVAILABLE');
  expect(fixture.sqlite.prepare('SELECT total_changes() AS n').get()).toEqual(before);
  expect(()=>h.store.read(h.a)).toThrow('CONNECTION_ATTEMPT_UNAVAILABLE');
 });
 it.each(['owner','device','attempt','generation','action','nonce','expired','far-future','arbitrary-proof'] as const)('refuses incoming %s manipulation before journal writes',async field=>{
  const h=await harness(),q=h.query('fence');let owner=h.a.ownerId;
  if(field==='owner')owner=randomUUID();
  if(field==='device'){q.attempt={...q.attempt,deviceId:'foreign',scopeKey:'device:foreign'};q.challenge.deviceId='foreign';}
  if(field==='attempt'){q.attempt={...q.attempt,attemptId:randomUUID()};q.challenge.attemptId=q.attempt.attemptId;}
  if(field==='generation')q.attempt={...q.attempt,credentialGeneration:randomUUID()};
  if(field==='action')q.challenge.action='read';
  if(field==='nonce')q.challenge.nonce='A'.repeat(64);
  if(field==='expired')q.challenge.expiresAt=new Date(Date.now()-1).toISOString();
  if(field==='far-future')q.challenge.expiresAt=new Date(Date.now()+61_000).toISOString();
  if(field==='arbitrary-proof')Object.assign(q,{proof:{state:'applied',accountId:'forged'}});
  const before=fixture.sqlite.prepare('SELECT total_changes() AS n').get();
  await expect(h.native.fence(q,owner)).rejects.toThrow();
  expect(fixture.sqlite.prepare('SELECT total_changes() AS n').get()).toEqual(before);
 });
 it('refuses expired and excessively future authority challenges before opening a topic',async()=>{
  const h=await harness();
  for(const delta of [-1,61_000]){
   h.trusted.mockImplementation(async(_c,action)=>({challenge:{...challenge(h.a,h.key.keyId,action),expiresAt:new Date(Date.now()+delta).toISOString()},publicKey:h.key.publicKey}));
   await expect(h.requester.read(h.a)).rejects.toThrow();expect(h.join).not.toHaveBeenCalled();
  }
 });
 it('requires authority provisioning and refuses raw legacy device replies',async()=>{
  const h=await harness();
  expect(()=>createConnectionEvidenceRequester({ownerId:h.a.ownerId,join:h.join} as never)).toThrow('CONNECTION_EVIDENCE_TRUST_REQUIRED');
  await expect(h.native.read(h.a,h.a.ownerId)).rejects.toThrow();
  h.signOut();await expect(h.native.fence(h.query('fence'),h.a.ownerId)).rejects.toThrow('CONNECTION_ACCOUNT_CHANGED');
 });
});
