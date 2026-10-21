import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ paths: {} as Record<string, string> }));

vi.mock('electron', () => ({
  app: { getPath: (name: string) => mocks.paths[name] },
}));

import { migrateLegacySessionHome, resolveSessionHomeDir } from './session-home-dir';

/**
 * #6948:回退到 ASCII 目录时按 tier 分开。Windows 那半只能在这里用 `path.win32` 验 ——
 * 协调机上不重启咕咕,mac1 没有 `%APPDATA%`。
 */
describe('resolveSessionHomeDir', () => {
  const win = {
    appData: 'C:\\Users\\u\\AppData\\Roaming',
    production: 'C:\\Users\\u\\AppData\\Roaming\\咕咕',
    beta: 'C:\\Users\\u\\AppData\\Roaming\\咕咕 Beta',
  };
  const mac = {
    appData: '/Users/u/Library/Application Support',
    production: '/Users/u/Library/Application Support/咕咕',
    beta: '/Users/u/Library/Application Support/咕咕 Beta',
  };

  it('Windows: production and Beta fall back to different ASCII dirs', () => {
    const production = resolveSessionHomeDir(win.production, win.appData, 'production', path.win32);
    const beta = resolveSessionHomeDir(win.beta, win.appData, 'beta', path.win32);
    expect(production).toBe('C:\\Users\\u\\AppData\\Roaming\\gugu\\task-home');
    expect(beta).toBe('C:\\Users\\u\\AppData\\Roaming\\gugu-beta\\task-home');
  });

  it('macOS: the same split (the fallback is about non-ASCII, not about Windows)', () => {
    expect(resolveSessionHomeDir(mac.production, mac.appData, 'production', path.posix)).toBe(
      '/Users/u/Library/Application Support/gugu/task-home'
    );
    expect(resolveSessionHomeDir(mac.beta, mac.appData, 'beta', path.posix)).toBe(
      '/Users/u/Library/Application Support/gugu-beta/task-home'
    );
    expect(resolveSessionHomeDir(mac.beta, mac.appData, 'acceptance-6948', path.posix)).toBe(
      '/Users/u/Library/Application Support/gugu-acceptance-6948/task-home'
    );
  });

  it('an ASCII userData keeps task-home where it is, whatever the tier', () => {
    for (const tier of ['production', 'beta']) {
      expect(resolveSessionHomeDir('C:\\gugu-data', win.appData, tier, path.win32)).toBe(
        'C:\\gugu-data\\task-home'
      );
      expect(resolveSessionHomeDir('/srv/gugu', mac.appData, tier, path.posix)).toBe(
        '/srv/gugu/task-home'
      );
    }
  });
});

describe('sessionHomeDir reads the build-time tier', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('defaults to production when the define is absent', async () => {
    mocks.paths = { userData: path.join('/x', '咕咕'), appData: '/x' };
    const { sessionHomeDir } = await import('./session-home-dir');
    expect(sessionHomeDir()).toBe(path.join('/x', 'gugu', 'task-home'));
  });

  it('uses __GUGU_TIER__ when the bundle defines it', async () => {
    vi.stubGlobal('__GUGU_TIER__', 'beta');
    vi.resetModules();
    mocks.paths = { userData: path.join('/x', '咕咕 Beta'), appData: '/x' };
    const { sessionHomeDir } = await import('./session-home-dir');
    expect(sessionHomeDir()).toBe(path.join('/x', 'gugu-beta', 'task-home'));
  });
});

describe('migrateLegacySessionHome into the tier dir', () => {
  let root = '';
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('moves Beta’s legacy task-home into gugu-beta and leaves production’s gugu/task-home alone', () => {
    root = mkdtempSync(path.join(tmpdir(), 'session-home-6948-'));
    const legacy = path.join(root, '咕咕 Beta', 'task-home');
    const production = path.join(root, 'gugu', 'task-home');
    mkdirSync(legacy, { recursive: true });
    mkdirSync(production, { recursive: true });
    writeFileSync(path.join(legacy, 'beta-file'), 'b');
    writeFileSync(path.join(production, 'production-file'), 'p');

    const target = resolveSessionHomeDir(path.join(root, '咕咕 Beta'), root, 'beta');
    // gugu-beta 还不存在:搬家要先把上一级建出来。
    expect(existsSync(path.dirname(target))).toBe(false);
    expect(migrateLegacySessionHome(legacy, target)).toBe('moved');

    expect(readdirSync(target)).toEqual(['beta-file']);
    expect(existsSync(legacy)).toBe(false);
    expect(readdirSync(production)).toEqual(['production-file']);
    expect(migrateLegacySessionHome(legacy, target)).toBe('skipped');
  });

  it('never merges into a tier dir that already exists', () => {
    root = mkdtempSync(path.join(tmpdir(), 'session-home-6948-'));
    const legacy = path.join(root, '咕咕 Beta', 'task-home');
    const target = path.join(root, 'gugu-beta', 'task-home');
    mkdirSync(legacy, { recursive: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(legacy, 'old'), 'o');

    expect(migrateLegacySessionHome(legacy, target)).toBe('skipped');
    expect(readdirSync(legacy)).toEqual(['old']);
    expect(readdirSync(target)).toEqual([]);
  });
});
