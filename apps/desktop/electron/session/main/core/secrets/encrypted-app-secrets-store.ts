import { and, eq } from 'drizzle-orm';
import { safeStorage } from 'electron';
import { db as appDb, type AppDb, type DrizzleTx } from '@main/db/client';
import { appSecrets } from '@main/db/schema';

export class EncryptedAppSecretsStore {
  constructor(
    private readonly db = appDb,
    private readonly safeStorageApi = safeStorage,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  async getSecret(key: string): Promise<string | null> {
    const rows = await this.db
      .select({ secret: appSecrets.secret })
      .from(appSecrets)
      .where(eq(appSecrets.key, key))
      .limit(1);

    const secret = rows[0]?.secret;
    if (!secret) {
      return null;
    }

    this.assertSecureStorageAvailable();
    return this.safeStorageApi.decryptString(Buffer.from(secret, 'base64'));
  }

  /** Prepare encryption before entering SQLite; the returned write is sync
   * and can only be used with this store's actual database transaction. */
  atomicSecretWriter(db: AppDb, key: string, secret: string): (tx: DrizzleTx, currentKey?: string) => void {
    if(db!==this.db)throw new Error('CONNECTION_ATOMIC_STORE_UNAVAILABLE');
    this.assertSecureStorageAvailable();
    const encryptedSecret=this.safeStorageApi.encryptString(secret).toString('base64');
    return (tx,currentKey=key)=>{
      tx.insert(appSecrets).values({key:currentKey,secret:encryptedSecret})
        .onConflictDoUpdate({target:appSecrets.key,set:{secret:encryptedSecret}}).run();
    };
  }

  /** Immutable key material must never be replaced by a concurrent creator. */
  async createSecret(key: string, secret: string): Promise<boolean> {
    this.assertSecureStorageAvailable();
    const encryptedSecret = this.safeStorageApi.encryptString(secret).toString('base64');
    return this.db.insert(appSecrets).values({key,secret:encryptedSecret})
      .onConflictDoNothing({target:appSecrets.key}).run().changes === 1;
  }

  async setSecret(key: string, secret: string): Promise<void> {
    this.assertSecureStorageAvailable();
    const encryptedSecret = this.safeStorageApi.encryptString(secret).toString('base64');

    await this.setEncryptedSecret(key, encryptedSecret);
  }

  async setEncryptedSecret(key: string, encryptedSecret: string): Promise<void> {
    await this.db
      .insert(appSecrets)
      .values({
        key: key,
        secret: encryptedSecret,
      })
      .onConflictDoUpdate({ target: appSecrets.key, set: { secret: encryptedSecret } })
      .execute();
  }

  async atomicSecretCompareAndSwap(db: AppDb, key: string, expected: string, replacement: string): Promise<((tx: DrizzleTx) => boolean) | null> {
    if(db!==this.db)throw new Error('CONNECTION_ATOMIC_STORE_UNAVAILABLE');
    const original=this.db.select({secret:appSecrets.secret}).from(appSecrets).where(eq(appSecrets.key,key)).get()?.secret;
    if(!original)return null;
    this.assertSecureStorageAvailable();
    if(this.safeStorageApi.decryptString(Buffer.from(original,'base64'))!==expected)return null;
    const sealed=this.safeStorageApi.encryptString(replacement).toString('base64');
    return tx=>tx.update(appSecrets).set({secret:sealed})
      .where(and(eq(appSecrets.key,key),eq(appSecrets.secret,original))).run().changes===1;
  }

  atomicSecretRemover(db: AppDb): (tx: DrizzleTx, key: string) => void {
    if(db!==this.db)throw new Error('CONNECTION_ATOMIC_STORE_UNAVAILABLE');
    return (tx,key)=>{tx.delete(appSecrets).where(eq(appSecrets.key,key)).run();};
  }

  async deleteSecret(key: string): Promise<void> {
    await this.db.delete(appSecrets).where(eq(appSecrets.key, key));
  }

  private assertSecureStorageAvailable(): void {
    if (!this.safeStorageApi.isEncryptionAvailable()) {
      throw new Error('Secure secret storage is unavailable on this system.');
    }

    if (this.platform !== 'linux') {
      return;
    }

    const backend = this.safeStorageApi.getSelectedStorageBackend?.();
    if (backend === 'basic_text') {
      throw new Error(
        'Secure secret storage is unavailable: Linux safeStorage backend is basic_text.'
      );
    }
  }
}

export const encryptedAppSecretsStore = new EncryptedAppSecretsStore();
