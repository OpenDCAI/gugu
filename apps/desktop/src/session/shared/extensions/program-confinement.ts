import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The host-derived reach of a tools program; consent and launch share the manifest qualification. */
export interface ProgramConfinement { fsRead: string[]; fsWrite: string[]; hosts: string[] }
export const CONFINE_HOSTS_ENV = 'GUGU_APP_NETWORK_HOSTS';

/** Use the same real paths as the actual launch; ancestor symlinks cannot be granted by granting their children. */
export function confinedNodeArgs(confine: ProgramConfinement, runtimeDir: string): string[] {
  const paths = (dirs: string[]) => [...new Set(dirs.map((dir) => realpathSync(dir)))];
  return ['--permission', '--allow-worker', '--disable-warning=SecurityWarning',
    ...paths([...confine.fsRead, runtimeDir]).map((dir) => `--allow-fs-read=${dir}`),
    ...paths(confine.fsWrite).map((dir) => `--allow-fs-write=${dir}`)];
}
export function confinedEnv(confine: ProgramConfinement): Record<string, string> {
  return { NODE_OPTIONS: '', [CONFINE_HOSTS_ENV]: JSON.stringify(confine.hosts), TMPDIR: join(realpathSync(confine.fsWrite[0]!), '.tmp') };
}

/** Confined tools descriptors contain file arguments only: their MCP runtime and tools module. */
export function confinedLaunch(confine: ProgramConfinement, preload: string, args: string[], cwd: string): { args: string[]; cwd: string; env: Record<string, string> } {
  const at = realpathSync(preload);
  const dataDir = realpathSync(confine.fsWrite[0]!);
  return {
    args: [...confinedNodeArgs(confine, dirname(at)), '--import', pathToFileURL(at).href, ...args.map((arg) => realpathSync(arg))],
    cwd: realpathSync(cwd),
    env: { ...confinedEnv(confine), GUGU_EXTENSION_DATA_DIR: dataDir },
  };
}
