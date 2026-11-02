import { realpathSync } from 'node:fs';
import { join } from 'node:path';

/** The host-derived reach of a tools program; consent and launch share the manifest qualification. */
export interface ProgramConfinement { fsRead: string[]; fsWrite: string[]; hosts: string[] }
export const CONFINE_HOSTS_ENV = 'GUGU_APP_NETWORK_HOSTS';

/** One translation to Node flags, with real paths on every platform. No native extensions or subprocesses. */
export function confinedNodeArgs(confine: ProgramConfinement, runtimeDir: string): string[] {
  return ['--permission', '--allow-worker', '--disable-warning=SecurityWarning',
    ...[...new Set([...confine.fsRead, runtimeDir].map((dir) => realpathSync(dir)))].map((dir) => `--allow-fs-read=${dir}`),
    ...confine.fsWrite.map((dir) => `--allow-fs-write=${realpathSync(dir)}`)];
}
export function confinedEnv(confine: ProgramConfinement): Record<string, string> {
  return { NODE_OPTIONS: '', [CONFINE_HOSTS_ENV]: JSON.stringify(confine.hosts), TMPDIR: join(realpathSync(confine.fsWrite[0]!), '.tmp') };
}
