import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTENSION_API_VERSION } from '@shared/extensions/manifest';
import { onActivitySignal } from '../activity/signals';

/**
 * A failed upgrade must leave the extension the user already had.
 *
 * The failure it guards against is a filesystem one — the rename that lands the
 * new bundle throwing after the old one was moved aside — so the only way to
 * reach it is to make that call fail. The module mock lives in its own file
 * because it replaces node:fs for everything importing it.
 */

/**
 * Which rename to fail, counted from the start of the install.
 *
 * It has to be the second: the first moves the working bundle aside, and
 * failing that one never reaches the rollback at all — a test that fails the
 * first rename passes whether or not the rollback exists.
 */
let failRenameAtCall: number | null = null;
let renameCalls = 0;

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    renameSync: (from: string, to: string) => {
      renameCalls += 1;
      if (failRenameAtCall !== null && renameCalls === failRenameAtCall) {
        throw new Error('EPERM: simulated rename failure');
      }
      return actual.renameSync(from, to);
    },
  };
});

const { ExtensionsService } = await import('./extensions-service');

let workDir: string;

function manifest(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'demo-ext',
    name: 'Demo',
    version: '1.0.0',
    apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en',
    platforms: ['desktop'],
    entry: 'index.html',
    contributes: { tabs: [{ name: 'main', title: 'Demo' }] },
    ...patch,
  };
}

function writeBundle(dirName: string, content: string, patch: Record<string, unknown> = {}): string {
  const bundleDir = path.join(workDir, 'sources', dirName);
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(path.join(bundleDir, 'manifest.json'), JSON.stringify(manifest(patch)));
  writeFileSync(path.join(bundleDir, 'index.html'), content);
  return bundleDir;
}

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'gugu-extensions-rollback-'));
  failRenameAtCall = null;
  renameCalls = 0;
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** 产品的装法:对 inspect 读到的那份点头,然后装的必须正是那一份。 */
function installConsented(target: InstanceType<typeof ExtensionsService>, sourceDir: string) {
  return target.installFromDirectory(sourceDir, target.inspectDirectory(sourceDir).manifestDigest, 'folder');
}

describe('ExtensionsService install rollback', () => {
  it('restores the previous version when landing the new bundle fails', () => {
    const service = new ExtensionsService(path.join(workDir, 'task-extensions'));
    installConsented(service, writeBundle('v1', 'v1'));

    const upgrade = writeBundle('v2', 'v2', { version: '2.0.0' });
    // Rename 1 moves the working bundle aside; rename 2 lands the new one.
    renameCalls = 0;
    failRenameAtCall = 2;

    const activity: string[] = [];
    const off = onActivitySignal(event => activity.push(event.kind));
    try {
      expect(() => installConsented(service, upgrade)).toThrowError(/simulated rename failure/);
      expect(activity).toEqual([]);
    } finally { off(); }

    // The upgrade did not happen; losing the working extension would be worse
    // than the upgrade not happening, so the old bundle is put back.
    const installed = service.get('demo-ext');
    expect(installed.manifest.version).toBe('1.0.0');
    expect(readFileSync(path.join(installed.rootDir, 'index.html'), 'utf8')).toBe('v1');
  });
});
