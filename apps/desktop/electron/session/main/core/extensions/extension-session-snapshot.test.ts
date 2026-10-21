import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bundleContentDigest,
  ensureSessionSnapshot,
  pruneExtensionData,
  pruneSessionSnapshots,
  removeUninstalledLeftovers,
  sessionSnapshotDir,
} from './extension-session-snapshot';

/**
 * #6387 owner「时机和状态，你有理清吗」: an extension upgraded or uninstalled while a session
 * runs must not pull files from under that session's program or skills.
 */

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-6387-snap-'));
}

function bundle(root: string, version: string): string {
  const dir = path.join(root, 'installed', 'agent-notes');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'mcp'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'mcp', 'server.mjs'), `// ${version}`);
  return dir;
}

describe('session snapshots of an extension (#6387)', () => {
  it('a running session keeps the version it started with through an upgrade and an uninstall', () => {
    const userData = tmp();
    const v1 = ensureSessionSnapshot(bundle(userData, 'v1'), sessionSnapshotDir(userData, 'agent-notes', 'a'.repeat(64)));
    // 升级:装着的那份换成 v2,新会话拿到 v2 的副本,老会话那份原样还在。
    const v2 = ensureSessionSnapshot(bundle(userData, 'v2'), sessionSnapshotDir(userData, 'agent-notes', 'b'.repeat(64)));
    expect(fs.readFileSync(path.join(v1, 'mcp', 'server.mjs'), 'utf8')).toBe('// v1');
    expect(fs.readFileSync(path.join(v2, 'mcp', 'server.mjs'), 'utf8')).toBe('// v2');
    // 卸载:装着的那份没了,正在跑的会话读的副本还在。
    fs.rmSync(path.join(userData, 'installed'), { recursive: true });
    expect(fs.existsSync(path.join(v2, 'mcp', 'server.mjs'))).toBe(true);
  });

  it('a reinstall of the same version with changed code is another copy; the same bytes are the same digest (10-06)', () => {
    const userData = tmp();
    const installed = bundle(userData, 'v1');
    const first = bundleContentDigest(installed);
    ensureSessionSnapshot(installed, sessionSnapshotDir(userData, 'agent-notes', first));
    // Installed again at the same place (an install lands as a new folder: its times are new).
    bundle(userData, 'v1, changed');
    fs.utimesSync(installed, new Date(1_000_000), new Date(1_000_000));
    const second = bundleContentDigest(installed);
    expect(second).not.toBe(first);
    const copy = ensureSessionSnapshot(installed, sessionSnapshotDir(userData, 'agent-notes', second));
    expect(fs.readFileSync(path.join(copy, 'mcp', 'server.mjs'), 'utf8')).toBe('// v1, changed');
    bundle(userData, 'v1');
    fs.utimesSync(installed, new Date(2_000_000), new Date(2_000_000));
    expect(bundleContentDigest(installed)).toBe(first);
  });

  it('the same version is copied once', () => {
    const userData = tmp();
    const target = sessionSnapshotDir(userData, 'agent-notes', 'a'.repeat(64));
    ensureSessionSnapshot(bundle(userData, 'v1'), target);
    bundle(userData, 'changed-in-place');
    ensureSessionSnapshot(path.join(userData, 'installed', 'agent-notes'), target);
    expect(fs.readFileSync(path.join(target, 'mcp', 'server.mjs'), 'utf8')).toBe('// v1');
  });

  it('at the next start only the current version of installed extensions is kept', () => {
    const userData = tmp();
    const old = ensureSessionSnapshot(bundle(userData, 'v1'), sessionSnapshotDir(userData, 'agent-notes', 'a'.repeat(64)));
    const current = ensureSessionSnapshot(bundle(userData, 'v2'), sessionSnapshotDir(userData, 'agent-notes', 'b'.repeat(64)));
    const gone = ensureSessionSnapshot(bundle(userData, 'x'), sessionSnapshotDir(userData, 'uninstalled', 'c'.repeat(64)));
    pruneSessionSnapshots(userData, new Map([['agent-notes', 'b'.repeat(64)]]));
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(current)).toBe(true);
    expect(fs.existsSync(path.dirname(gone))).toBe(false);
  });
});

describe('an uninstalled App’s files: gone once its programs have exited (10-06)', () => {
  function dataRoot(userData: string): string {
    const root = path.join(userData, 'extension-data');
    for (const id of ['agent-notes', 'other']) {
      fs.mkdirSync(path.join(root, id), { recursive: true });
      fs.writeFileSync(path.join(root, id, 'notes.json'), '[1]');
    }
    return root;
  }

  it('takes its data folder and every frozen copy of it, and nothing of another App', () => {
    const userData = tmp();
    const root = dataRoot(userData);
    const v1 = ensureSessionSnapshot(bundle(userData, 'v1'), sessionSnapshotDir(userData, 'agent-notes', 'a'.repeat(64)));
    const v2 = ensureSessionSnapshot(bundle(userData, 'v2'), sessionSnapshotDir(userData, 'agent-notes', 'b'.repeat(64)));
    const other = ensureSessionSnapshot(bundle(userData, 'o'), sessionSnapshotDir(userData, 'other', 'c'.repeat(64)));
    removeUninstalledLeftovers(userData, path.join(root, 'agent-notes'), 'agent-notes');
    expect([v1, v2, path.join(root, 'agent-notes')].filter((dir) => fs.existsSync(dir))).toEqual([]);
    expect([other, path.join(root, 'other', 'notes.json')].every((dir) => fs.existsSync(dir))).toBe(true);
  });

  it('at gugu’s start, a data folder of an App not installed goes (a quit mid-uninstall); an installed one stays', () => {
    const root = dataRoot(tmp());
    pruneExtensionData(root, new Set(['other']));
    expect(fs.existsSync(path.join(root, 'agent-notes'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'other', 'notes.json'), 'utf8')).toBe('[1]');
  });
});
