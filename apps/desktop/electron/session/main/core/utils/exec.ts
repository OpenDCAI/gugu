import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from '@gugu/core/local/childProcess';

function windowsExecutableExtensions(env: NodeJS.ProcessEnv): string[] {
  const pathExt = env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
  return pathExt
    .split(';')
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean)
    .map((extension) => (extension.startsWith('.') ? extension : `.${extension}`));
}

function findExecutableOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const pathValue = env.PATH;
  if (!pathValue) return null;

  const extensions =
    process.platform === 'win32' && !path.extname(name)
      ? ['', ...windowsExecutableExtensions(env)]
      : [''];

  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;

    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {}
    }
  }

  return null;
}

/**
 * One string value out of a `reg export` file. The file is UTF-16LE whatever the system code page,
 * and escapes `\` and `"` inside the quoted value.
 */
export function parseRegExportString(exported: string, name: string): string | null {
  const prefix = `"${name}"="`;
  for (const rawLine of exported.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.startsWith(prefix) && line.endsWith('"')) {
      return line.slice(prefix.length, -1).replace(/\\(.)/g, '$1');
    }
  }
  return null;
}

function readGitForWindowsInstallPath(env: NodeJS.ProcessEnv): string | null {
  const reg = env.SystemRoot ? path.join(env.SystemRoot, 'System32', 'reg.exe') : 'reg.exe';
  for (const root of ['HKLM', 'HKCU']) {
    // `reg query` prints in the console code page: decoded as UTF-8, a non-ASCII install path (GBK
    // on zh-CN) came back garbled, and its localized "key not found" error leaked onto our stderr.
    // `reg export` writes UTF-16LE regardless, and piped stdio keeps a missing key quiet (#5670).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-reg-'));
    try {
      const file = path.join(dir, 'git-for-windows.reg');
      execFileSync(reg, ['export', `${root}\\SOFTWARE\\GitForWindows`, file, '/y'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const installPath = parseRegExportString(fs.readFileSync(file, 'utf16le'), 'InstallPath');
      if (installPath) return installPath;
    } catch {
      // The key is absent when Git for Windows is not installed for this scope.
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return null;
}

export function resolveGitBin(
  env: NodeJS.ProcessEnv = process.env,
  gitForWindowsInstallPath = readGitForWindowsInstallPath
): string {
  const pathGit = findExecutableOnPath('git', env);
  const registeredGit =
    process.platform === 'win32' ? gitForWindowsInstallPath(env) : null;
  const windowsGit =
    process.platform === 'win32'
      ? [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)']]
          .filter(Boolean)
          .map((directory) => path.join(directory as string, 'Git', 'cmd', 'git.exe'))
      : [];
  const candidates = [
    (env.GIT_PATH || '').trim(),
    pathGit,
    registeredGit && path.join(registeredGit, 'cmd', 'git.exe'),
    ...windowsGit,
    '/opt/homebrew/bin/git',
    '/usr/local/bin/git',
    '/usr/bin/git',
  ].filter(Boolean) as string[];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return 'git';
}

/** Initial fallback path for Git before the host dependency probe completes. */
export const GIT_EXECUTABLE = resolveGitBin();

let localGitExecutableOverride: string | null = null;
const remoteGitExecutableOverrides = new Map<string, string>();

export function setGitExecutableOverride(executable: string | null, connectionId?: string): void {
  if (connectionId) {
    if (executable) remoteGitExecutableOverrides.set(connectionId, executable);
    else remoteGitExecutableOverrides.delete(connectionId);
    return;
  }

  localGitExecutableOverride = executable;
}

/** Current Git executable selected by the host dependency system, with startup fallback. */
export function getGitExecutable(connectionId?: string): string {
  if (connectionId) return remoteGitExecutableOverrides.get(connectionId) ?? 'git';
  return localGitExecutableOverride ?? GIT_EXECUTABLE;
}

export function isMissingGitExecutableError(error: unknown): boolean {
  const err = error as NodeJS.ErrnoException | undefined;
  return (
    err?.code === 'ENOENT' &&
    (err.path === 'git' || err.path === GIT_EXECUTABLE || err.path === localGitExecutableOverride)
  );
}

export function missingGitExecutableError(): Error {
  return new Error(
    'Git is not installed or 咕咕 cannot find it. Install Git, then restart 咕咕.'
  );
}
