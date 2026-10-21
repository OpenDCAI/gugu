import path from 'node:path';

export function getWindowsEnvKey(env: NodeJS.ProcessEnv, key: string): string | undefined {
  if (env[key] !== undefined) return key;

  const lowerKey = key.toLowerCase();
  return Object.keys(env).find((candidate) => candidate.toLowerCase() === lowerKey);
}

export function getWindowsEnvValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const envKey = getWindowsEnvKey(env, key);
  return envKey ? env[envKey] : undefined;
}

export function getWindowsPathEnvKey(env: NodeJS.ProcessEnv): string {
  return getWindowsEnvKey(env, 'PATH') ?? 'PATH';
}

/**
 * Windows PATH entries compare case-insensitively, and a trailing separator is meaningless
 * (`C:\x\npm` and `c:\X\npm\` are the same directory). Normalising both sides keeps the
 * presence check from prepending a duplicate that Windows would treat as the same entry.
 */
function normalizeWindowsPathEntry(entry: string): string {
  return entry.trim().replace(/[\\/]+$/, '').toLowerCase();
}

export function prependWindowsPathEntry(env: NodeJS.ProcessEnv, entry: string): boolean {
  const pathKey = getWindowsPathEnvKey(env);
  const entries = (env[pathKey] ?? '').split(path.win32.delimiter).filter(Boolean);
  const existing = new Set(entries.map(normalizeWindowsPathEntry));

  if (existing.has(normalizeWindowsPathEntry(entry))) {
    return false;
  }

  env[pathKey] = [entry, ...entries].join(path.win32.delimiter);
  return true;
}
