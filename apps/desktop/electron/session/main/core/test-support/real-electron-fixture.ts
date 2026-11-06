import fs from 'node:fs';
import path from 'node:path';
import { spawnOwnedChild } from '@gugu/session-core/exec';

export interface RealElectronFixtureOptions {
  name: string;
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  reportDirectory?: string;
}

interface Failure { phase: string; message: string; stack?: string }
interface ProcessFailure { message: string; code?: string; stack?: string }
export interface FixtureDiagnostics {
  name: string;
  executable: string;
  args: string[];
  pid?: number;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  primaryFailure?: Failure;
  processError?: ProcessFailure;
  abortReason?: string;
  shutdownError?: string;
}

function primaryFailure(stderr: string): Failure | undefined {
  for (const line of stderr.split('\n')) {
    if (!line.startsWith('REAL_ELECTRON_FIXTURE_FAILURE=')) continue;
    try {
      const value = JSON.parse(line.slice('REAL_ELECTRON_FIXTURE_FAILURE='.length));
      if (typeof value.phase === 'string' && typeof value.message === 'string') return value;
    } catch { /* Incomplete child output remains verbatim in stderr. */ }
  }
}

/** A fixture owns its detached process group until both the tree and stdio close. */
export function startRealElectronFixture(options: RealElectronFixtureOptions) {
  let stdout = '', stderr = '', processError: ProcessFailure | undefined;
  let aborted = false, abortReason: string | undefined;
  let terminal!: () => void, closed!: () => void;
  const ending = new Promise<void>(resolve => { terminal = resolve; });
  const close = new Promise<void>(resolve => { closed = resolve; });
  // Do not pass the AbortSignal to spawn: its error event precedes tree shutdown.
  const owned = spawnOwnedChild(options.executable, options.args, {
    env: options.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    onError(error) {
      processError ??= { message: error.message, code: (error as NodeJS.ErrnoException).code, stack: error.stack };
      terminal();
    },
  });
  const child = owned.child;
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  // A surviving descendant may hold the pipes open after the root exits.
  child.once('exit', terminal);
  child.once('close', () => { closed(); terminal(); });
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= owned.stop();
  const abort = () => {
    aborted = true;
    const reason: unknown = options.signal?.reason;
    abortReason = reason instanceof Error ? reason.message : String(reason);
    terminal();
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();

  const result = (async (): Promise<FixtureDiagnostics> => {
    await ending;
    let shutdownError: string | undefined;
    try { await stop(); await close; }
    catch (error) { shutdownError = error instanceof Error ? error.message : String(error); }
    finally { options.signal?.removeEventListener('abort', abort); }
    const diagnostics: FixtureDiagnostics = {
      name: options.name, executable: options.executable, args: options.args, pid: child.pid,
      code: child.exitCode, signal: child.signalCode, stdout, stderr,
      primaryFailure: primaryFailure(stderr), processError, abortReason, shutdownError,
    };
    const failed = aborted || processError || shutdownError || diagnostics.code !== 0;
    // The CI log is an unconditional failure artifact, including when the caller's
    // beforeAll deadline fires before it gets to inspect this promise.
    if (failed) process.stderr.write('REAL_ELECTRON_FIXTURE_DIAGNOSTICS=' + JSON.stringify(diagnostics) + '\n');
    if (options.reportDirectory) {
      fs.mkdirSync(options.reportDirectory, { recursive: true });
      fs.writeFileSync(path.join(options.reportDirectory, options.name + '.json'), JSON.stringify(diagnostics, null, 2) + '\n');
      fs.writeFileSync(path.join(options.reportDirectory, options.name + '.log'), stdout + '\n' + stderr);
    }
    if (failed) {
      const reason = diagnostics.primaryFailure?.message ?? processError?.message ?? shutdownError ?? abortReason ?? `exit ${diagnostics.code} (${diagnostics.signal})`;
      throw Object.assign(new Error(`${options.name}: ${reason}\n${stdout}\n${stderr}`), { diagnostics });
    }
    return diagnostics;
  })();
  return {
    result,
    async dispose(): Promise<void> {
      terminal();
      await stop();
      await close;
      // Joining result also finishes diagnostic writes; its failure is already
      // delivered to beforeAll. A failed stop above must prevent profile removal.
      await result.catch(() => undefined);
    },
  };
}
