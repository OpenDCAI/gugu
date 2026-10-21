/** Transitional named import, remove when workspace server runs  */
import type { IFilesRuntime as CoreFilesRuntime } from '@gugu/session-core/files';
import type { IGitRuntime } from '@gugu/session-core/git';
import type { IDisposable, Lease, Unsubscribe } from '@gugu/session-shared';

export type RuntimeHealth =
  | { status: 'ok' }
  | { status: 'degraded'; reason: string }
  | { status: 'disconnected' };

export interface HealthSource {
  current(): RuntimeHealth;
  subscribe(cb: (health: RuntimeHealth) => void): Unsubscribe;
}

/**
 * Transitional: per-runtime path algebra bound to the machine that owns the files.
 * Removed when the workspace server moves remote path math into core.
 */
export type RuntimePath = {
  join(...parts: string[]): string;
  dirname(path: string): string;
  basename(path: string): string;
  isAbsolute(path: string): boolean;
  relative(from: string, to: string): string;
  contains(parent: string, child: string): boolean;
};

/** Transitional named import, remove when workspace server runs  */
export type IFilesRuntime = CoreFilesRuntime & { readonly path: RuntimePath };

export interface MachineRuntime extends IDisposable {
  readonly files: IFilesRuntime;
  readonly git: IGitRuntime;
  readonly health: HealthSource;
}

export interface RuntimeManager {
  /** The one machine there is: this one. */
  acquire(): Promise<Lease<MachineRuntime>>;
}
