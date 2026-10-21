import path from 'node:path';
import type { PluginFs } from '@gugu/session-core/agents/plugins';
import { log } from '@main/lib/logger';
import { createPluginFs } from './plugin-fs';

export type WorkspaceTrustHost = { kind: 'local'; homedir: string };

export type TrustTarget = {
  fs: PluginFs;
  lockKey: string;
  workspacePath: string;
};

export async function resolveTrustTarget(
  host: WorkspaceTrustHost,
  workspacePath: string,
  isolatedHome?: string
): Promise<TrustTarget | null> {
  const normalizedPath = normalizeLocalWorkspacePath(workspacePath);
  if (!normalizedPath) return null;
  return {
    fs: createPluginFs(isolatedHome ?? host.homedir),
    lockKey: `local:${path.resolve(isolatedHome ?? host.homedir)}`,
    workspacePath: normalizedPath,
  };
}

function normalizeLocalWorkspacePath(workspacePath: string): string | null {
  if (!path.isAbsolute(workspacePath)) {
    log.warn('WorkspaceTrust: refusing to auto-trust non-absolute workspace path', {
      path: workspacePath,
    });
    return null;
  }

  return path.normalize(workspacePath);
}
