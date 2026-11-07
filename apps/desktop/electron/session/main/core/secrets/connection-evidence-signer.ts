import {createHash,createPrivateKey,createPublicKey,generateKeyPairSync,sign} from 'node:crypto';
import {connectionEvidenceSigningBytes,connectionEvidencePublicKeyBytes,parseConnectionEvidenceChallenge,parseConnectionEvidenceProof,
  type ConnectionEvidenceChallenge,type ConnectionEvidenceSigner} from '@gugu/core/cloud/connectionEvidence';
import type {EncryptedAppSecretsStore} from './encrypted-app-secrets-store';

const uuid=(v:string)=>/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
/** This local maintenance API never registers a trusted root. Pairing must
 * separately approve its public key in the authority's closed registry. */
export function createNativeConnectionEvidenceSigner(input:{ownerId:string;deviceId:string;
  secrets:Pick<EncryptedAppSecretsStore,'getSecret'|'setSecret'|'createSecret'>;assertCurrent?():Promise<void>}) {
  if(!uuid(input.ownerId)||!input.deviceId||input.deviceId.length>256)throw Error('CONNECTION_EVIDENCE_KEY_INVALID');
  const scope=createHash('sha256').update(JSON.stringify([input.ownerId,input.deviceId])).digest('hex');
  const currentKey=`connection-evidence-current:${scope}`;
  const secretKey=(keyId:string)=>{
    if(!uuid(keyId))throw Error('CONNECTION_EVIDENCE_KEY_INVALID');
    return `connection-evidence-private:${scope}:${keyId}`;
  };
  async function load(keyId:string){
    const raw=await input.secrets.getSecret(secretKey(keyId));
    if(!raw)throw Error('CONNECTION_EVIDENCE_KEY_UNAVAILABLE');
    const stored=JSON.parse(raw);
    if(stored.version!==1||stored.ownerId!==input.ownerId||stored.deviceId!==input.deviceId||stored.keyId!==keyId
      ||typeof stored.privateKey!=='string'||stored.privateKey.length>256)throw Error('CONNECTION_EVIDENCE_KEY_INVALID');
    const privateKey=createPrivateKey({key:Buffer.from(stored.privateKey,'base64url'),format:'der',type:'pkcs8'});
    if(privateKey.asymmetricKeyType!=='ed25519')throw Error('CONNECTION_EVIDENCE_KEY_INVALID');
    return privateKey;
  }
  async function current(challenge:ConnectionEvidenceChallenge){
    if(challenge.ownerId!==input.ownerId||challenge.deviceId!==input.deviceId
      ||await input.secrets.getSecret(currentKey)!==challenge.keyId)throw Error('CONNECTION_EVIDENCE_KEY_UNAVAILABLE');
    const key=await load(challenge.keyId);
    if(await input.secrets.getSecret(currentKey)!==challenge.keyId)throw Error('CONNECTION_EVIDENCE_KEY_UNAVAILABLE');
    return key;
  }
  const signer:ConnectionEvidenceSigner={
    async assertCurrentKey(challenge){await current(challenge);},
    async sign(challenge,proof){
      const normalized=parseConnectionEvidenceProof(proof.attempt,proof);
      if(normalized.attempt.ownerId!==input.ownerId||normalized.attempt.deviceId!==input.deviceId)throw Error('CONNECTION_EVIDENCE_KEY_UNAVAILABLE');
      const checked=parseConnectionEvidenceChallenge(normalized.attempt,challenge.action,challenge);
      const key=await current(checked);
      await input.assertCurrent?.();
      // No async boundary between the final expiry check and native signing.
      parseConnectionEvidenceChallenge(normalized.attempt,checked.action,checked);
      return {version:1,challenge:checked,proof:normalized,
        signature:sign(null,connectionEvidenceSigningBytes(checked,normalized),key).toString('base64url')};
    },
  };
  return {...signer,
    /** Explicit maintenance only; RPC read/fence never creates/rotates a key. */
    async provision(keyId:string):Promise<{keyId:string;publicKey:string}>{
      const name=secretKey(keyId);
      if(!await input.secrets.getSecret(name)){
        const {privateKey}=generateKeyPairSync('ed25519');
        await input.secrets.createSecret(name,JSON.stringify({version:1,ownerId:input.ownerId,deviceId:input.deviceId,keyId,
          privateKey:privateKey.export({format:'der',type:'pkcs8'}).toString('base64url')}));
      }
      const key=await load(keyId);
      const publicKey=createPublicKey(key).export({format:'der',type:'spki'}).toString('base64url');
      connectionEvidencePublicKeyBytes(publicKey);
      await input.secrets.setSecret(currentKey,keyId);
      return {keyId,publicKey};
    },
    async publicKey(keyId:string):Promise<string>{
      return createPublicKey(await load(keyId)).export({format:'der',type:'spki'}).toString('base64url');
    },
  };
}
