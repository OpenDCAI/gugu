import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { APP_RUNTIME_VERSION } from '@shared/extensions/app-runtime-protocol';

/**
 * Where this build's App runtime sits on disk: the directory that `/_gugu/` maps to, holding
 * `<ver>/gugu.js`, `<ver>/files.js`, `<ver>/codemirror.js`, `<ver>/markdown.js`, `<ver>/glue.js` and their shared chunks.
 *
 * The main build writes it to `dist-electron/app-runtime/` (vite.config.mts,
 * `gugu-bundle-app-runtime`), beside the flat main bundle — the same place the bridge
 * preload is looked for, and for the same reason both candidates are tried
 * (`bridge-preload-path.ts`: the sibling is today's layout, the parent the legacy one).
 * Missing is a build fault; the protocol handler answers it with a 500 rather than serve
 * an App page whose `window.gugu` silently never appears.
 */
export function appRuntimeDirCandidates(moduleDir: string): string[] {
  return [join(moduleDir, 'app-runtime'), join(moduleDir, '..', 'app-runtime')];
}

let cached: string | null | undefined;

export function appRuntimeDir(exists: (path: string) => boolean = existsSync): string | null {
  if (cached !== undefined && exists === existsSync) return cached;
  const found = appRuntimeDirCandidates(__dirname).find((dir) => exists(join(dir, APP_RUNTIME_VERSION, 'gugu.js'))) ?? null;
  if (exists === existsSync && found) cached = found;
  return found;
}

/**
 * The program runtime (F16): `gugu` for an App's MCP program, started as `node --import <this>` before the
 * App's own code. `null` when this build has no App runtime (as `appRuntimeDir`).
 */
export function programRuntimePath(): string | null {
  const dir = appRuntimeDir();
  return dir ? join(dir, APP_RUNTIME_VERSION, 'gugu-program.mjs') : null;
}

/** F77 The MCP program gugu runs for an App's tools module (`mcpServers: [{ name, tools }]`); `null` as above. */
export function toolsRuntimePath(): string | null {
  const dir = appRuntimeDir();
  return dir ? join(dir, APP_RUNTIME_VERSION, 'gugu-tools.mjs') : null;
}
