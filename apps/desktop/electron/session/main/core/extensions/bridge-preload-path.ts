import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Where the extension bridge preload sits relative to the module that looks for it.
 *
 * ⚠️ NOT simply `join(moduleDir, …)`. Historically the attach policy was bundled, with the
 * rest of the embedded task main, into `dist-electron/taskpage/emdash-main-bridge.cjs`,
 * while the preload is a vite entry that lands beside gugu's own preload in
 * `dist-electron/` — so the policy's `__dirname` was the *sessionpage* directory and the
 * file sat one level up. Since #4865 the task main is a chunk of the same electron-main
 * build, flat in `dist-electron/`, so the sibling candidate is the one that hits today;
 * the parent candidate stays for the legacy layout.
 *
 * Reading "task main and gugu main are one bundle since the fusion" as "same
 * directory" is what broke it: the bridge was declared missing on every launch, the
 * attach was refused, and each extension rendered as a blank pane while the reason
 * went only to the main log (#2374 — the ten example extensions all looked broken;
 * the bug was this join).
 *
 * The parent is tried first because that is where the build puts it today; the
 * sibling stays a candidate so moving the preload beside this bundle keeps working.
 * Neither found is a hard failure at the call site — a missing bridge must fail
 * visibly, never hand an extension a surface with no way to talk to the host.
 */
export function extensionBridgePreloadCandidates(moduleDir: string): string[] {
  return [
    join(moduleDir, '..', 'extension-bridge-preload.js'),
    join(moduleDir, 'extension-bridge-preload.js'),
  ];
}

/** `exists` is injectable so the layout rule can be judged against a real directory tree. */
export function resolveExtensionBridgePreload(
  moduleDir: string,
  exists: (path: string) => boolean = existsSync
): string | null {
  return extensionBridgePreloadCandidates(moduleDir).find(exists) ?? null;
}
