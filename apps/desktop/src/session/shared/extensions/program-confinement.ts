import { realpathSync } from 'node:fs';
import { join } from 'node:path';

/** The host-derived reach of a tools program; consent and launch share the manifest qualification. */
export interface ProgramConfinement { fsRead: string[]; fsWrite: string[]; hosts: string[] }
export const CONFINE_HOSTS_ENV = 'GUGU_APP_NETWORK_HOSTS';

/** Node checks both the supplied path and its real path, including macOS /var aliases. */
export function confinedNodeArgs(confine: ProgramConfinement, runtimeDir: string): string[] {
  const paths = (dirs: string[]) => [...new Set(dirs.flatMap((dir) => [dir, realpathSync(dir)]))];
  return ['--permission', '--allow-worker', '--disable-warning=SecurityWarning',
    ...paths([...confine.fsRead, runtimeDir]).map((dir) => `--allow-fs-read=${dir}`),
    ...paths(confine.fsWrite).map((dir) => `--allow-fs-write=${dir}`)];
}
export function confinedEnv(confine: ProgramConfinement): Record<string, string> {
  return { NODE_OPTIONS: '', [CONFINE_HOSTS_ENV]: JSON.stringify(confine.hosts), TMPDIR: join(realpathSync(confine.fsWrite[0]!), '.tmp') };
}
