import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getGitExecutable,
  GIT_EXECUTABLE,
  parseRegExportString,
  resolveGitBin,
  setGitExecutableOverride,
} from './exec';

const originalPlatform = process.platform;
let tempDir: string;

beforeEach(() => {
  setGitExecutableOverride(null);
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emdash-git-bin-'));
});

afterEach(() => {
  setGitExecutableOverride(null);
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform });
}

function executableGit(directory: string, filename = 'git'): string {
  fs.mkdirSync(directory, { recursive: true });
  const gitPath = path.join(directory, filename);
  fs.writeFileSync(gitPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return gitPath;
}

describe('parseRegExportString', () => {
  // What `reg export HKCU\SOFTWARE\GitForWindows` writes, decoded from its UTF-16LE file.
  const exported =
    '\uFEFFWindows Registry Editor Version 5.00\r\n\r\n' +
    '[HKEY_CURRENT_USER\\SOFTWARE\\GitForWindows]\r\n' +
    '"CurrentVersion"="2.47.1"\r\n' +
    '"InstallPath"="C:\\\\Users\\\\张三\\\\AppData\\\\Local\\\\Programs\\\\Git"\r\n' +
    '"LibexecPath"="C:\\\\Users\\\\张三\\\\AppData\\\\Local\\\\Programs\\\\Git\\\\mingw64\\\\libexec\\\\git-core"\r\n';

  it('reads a non-ASCII path back exactly, undoing the export escaping', () => {
    expect(parseRegExportString(exported, 'InstallPath')).toBe(
      'C:\\Users\\张三\\AppData\\Local\\Programs\\Git'
    );
  });

  it('matches the whole value name, not a prefix of another one', () => {
    expect(parseRegExportString(exported, 'Install')).toBeNull();
    expect(parseRegExportString(exported, 'MissingValue')).toBeNull();
  });
});

describe('resolveGitBin', () => {
  it('prefers explicit GIT_PATH over PATH git', () => {
    const pathGit = executableGit(path.join(tempDir, 'path-bin'));
    const explicitGit = executableGit(path.join(tempDir, 'explicit-bin'));

    expect(resolveGitBin({ GIT_PATH: explicitGit, PATH: path.dirname(pathGit) })).toBe(explicitGit);
  });

  it('prefers PATH git before hardcoded fallbacks', () => {
    const pathGit = executableGit(path.join(tempDir, 'path-bin'));

    expect(resolveGitBin({ PATH: path.dirname(pathGit) })).toBe(pathGit);
  });

  it('skips invalid explicit GIT_PATH and falls back to PATH git', () => {
    const pathGit = executableGit(path.join(tempDir, 'path-bin'));

    expect(resolveGitBin({ GIT_PATH: '/does/not/exist', PATH: path.dirname(pathGit) })).toBe(
      pathGit
    );
  });

  it('finds PATHEXT executables on Windows PATH', () => {
    setPlatform('win32');
    const pathGit = executableGit(path.join(tempDir, 'path-bin'), 'git.exe');

    expect(resolveGitBin({ PATH: path.dirname(pathGit), PATHEXT: '.exe' })).toBe(pathGit);
  });

  it('finds a standard Git for Windows install when Electron PATH omits it', () => {
    setPlatform('win32');
    const programFiles = path.join(tempDir, 'Program Files');
    const installedGit = executableGit(path.join(programFiles, 'Git', 'cmd'), 'git.exe');

    expect(resolveGitBin({ PATH: '', ProgramFiles: programFiles })).toBe(installedGit);
  });

  it('finds a registered custom Git for Windows install when Electron PATH omits it', () => {
    setPlatform('win32');
    const installRoot = path.join(tempDir, 'D-drive', 'Git');
    const installedGit = executableGit(path.join(installRoot, 'cmd'), 'git.exe');

    expect(resolveGitBin({ PATH: '' }, () => installRoot)).toBe(installedGit);
  });

  it('uses the local host dependency override when present', () => {
    setGitExecutableOverride('/opt/homebrew/bin/git');

    expect(getGitExecutable()).toBe('/opt/homebrew/bin/git');

    setGitExecutableOverride(null);
    expect(getGitExecutable()).toBe(GIT_EXECUTABLE);
  });

  it('keeps remote host dependency overrides scoped by connection', () => {
    setGitExecutableOverride('/remote-a/bin/git', 'ssh-a');
    setGitExecutableOverride('/remote-b/bin/git', 'ssh-b');

    expect(getGitExecutable('ssh-a')).toBe('/remote-a/bin/git');
    expect(getGitExecutable('ssh-b')).toBe('/remote-b/bin/git');
    expect(getGitExecutable('ssh-c')).toBe('git');

    setGitExecutableOverride(null, 'ssh-a');
    setGitExecutableOverride(null, 'ssh-b');
    expect(getGitExecutable('ssh-a')).toBe('git');
  });
});
