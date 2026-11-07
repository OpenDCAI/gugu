import {and,eq} from 'drizzle-orm';
import type {AppDb} from '@main/db/client';
import {providerAccounts} from '@main/db/schema';
import type {ProviderAccountSecretStore} from './provider-account-registry';

/** A delayed refresh can only replace the ciphertext it actually read; it
 * cannot recreate an account or replace a newer explicit authorization. */
export async function compareAndSwapProviderSecret(db:AppDb,store:ProviderAccountSecretStore,
  providerId:string,accountId:string,expected:string,replacement:string):Promise<boolean> {
  const prior=db.select().from(providerAccounts).where(and(eq(providerAccounts.providerId,providerId),eq(providerAccounts.accountId,accountId))).get();
  if(!prior||['platform','platform-rejected-key'].includes(prior.meta?.credentialSource??''))return false;
  if(!store.atomicSecretCompareAndSwap)throw Error('CONNECTION_ATOMIC_STORE_UNAVAILABLE');
  const write=await store.atomicSecretCompareAndSwap(db,prior.credentialRef,expected,replacement);
  if(!write)return false;
  return db.transaction(tx=>{
    const current=tx.select().from(providerAccounts).where(eq(providerAccounts.id,prior.id)).get();
    if(!current||current.credentialRef!==prior.credentialRef||current.meta?.credentialSource!==prior.meta?.credentialSource)return false;
    if(!write(tx))return false;
    tx.update(providerAccounts).set({updatedAt:Date.now()}).where(eq(providerAccounts.id,current.id)).run();
    return true;
  });
}
