import { lstat, mkdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import lockfile from '../../lib/proper-lockfile';
import { managedMiseBinDir } from './managed-agent-home';

/** Preparation and ordinary installs share the final launchers, even when their
 * download trees differ. Hold this lock through verification and rollback. */
export async function withManagedLauncherPublication<T>(work: (assertOwned: () => void) => Promise<T>): Promise<T> {
  const directory = managedMiseBinDir();
  await mkdir(directory, { recursive: true });
  let compromised: Error | undefined;
  const release = await lockfile.lock(path.join(directory, '.publication'), {
    realpath: false, stale: 30_000, update: 10_000,
    retries: { retries: 80, factor: 1, minTimeout: 500, maxTimeout: 500 },
    onCompromised: error => { compromised = error; },
  });
  const assertOwned = () => { if (compromised) throw compromised; };
  let result: T;
  try { result = await work(assertOwned); }
  catch (error) {
    try { await release(); }
    catch (releaseError) {
      throw new Error('Launcher publication and lock release failed', { cause: new AggregateError([error, releaseError]) });
    }
    throw error;
  }
  await release();
  return result;
}

/** Windows may briefly hold a newly scanned launcher open. Never unlink the
 * destination to make rename succeed: replacement must remain atomic. */
export async function replaceManagedLauncher(temporary: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rename(temporary, destination); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt === 5) throw error;
      await setTimeout(50 * 2 ** attempt);
    }
  }
}

/** Call under the publication lock. BigInt preserves Windows' 64-bit file IDs. */
export async function rollbackManagedLauncher(source: string, destination: string): Promise<void> {
  const [prepared, current] = await Promise.all([
    lstat(source, { bigint: true }),
    lstat(destination, { bigint: true }).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }),
  ]);
  if (current?.isFile() && prepared.dev === current.dev && prepared.ino === current.ino) await unlink(destination);
}
