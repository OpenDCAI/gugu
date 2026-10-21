import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * What a running agent session holds on to from an extension, kept apart from the installed
 * copy so that upgrading or uninstalling never pulls files out from under it. Refs #6387.
 *
 * One copy per bundle as installed, named by its content (bundleContentDigest): a reinstall of the same version with
 * changed code is another copy, never the old one again (10-06: same manifest, new tools.js, the old code ran).
 * Programs run from the copy of the bundle installed now, never
 * from the installed folder: install, upgrade and uninstall move that folder by rename, which
 * Windows refuses (EBUSY) while a process has its cwd inside. An upgrade retires the old
 * version's programs (extension-programs.ts); the skills a running session listed at its start
 * keep reading from the copy they came from. Uninstalling retires its programs and, once they have
 * exited, takes the data folder and the copies at once (removeUninstalledLeftovers): a program left
 * running after an uninstall held a chat file open and its next file frame took gugu down (10-06).
 * Whatever belongs to no installed App at gugu's start goes then (a quit before that finished).
 */

export const SESSION_SNAPSHOTS_DIR_NAME = 'extension-sessions';

export function sessionSnapshotsRoot(userDataDir: string): string {
  return path.join(userDataDir, SESSION_SNAPSHOTS_DIR_NAME);
}

/** Folder of one installed bundle of one extension; the digest (bundleContentDigest) names it exactly. */
export function sessionSnapshotDir(userDataDir: string, extensionId: string, bundleDigest: string): string {
  return path.join(sessionSnapshotsRoot(userDataDir), extensionId, bundleDigest.slice(0, 16));
}

const bundleDigests = new Map<string, { stamp: string; digest: string }>();

/**
 * What an installed bundle is, by content: every file's path and bytes (links by target). Read once per install — an
 * install lands as a new folder, so its inode and times say when to read again.
 */
export function bundleContentDigest(dir: string): string {
  const stat = fs.statSync(dir);
  const stamp = `${stat.ino}:${stat.birthtimeMs}:${stat.mtimeMs}`;
  const known = bundleDigests.get(dir);
  if (known?.stamp === stamp) return known.digest;
  const hash = createHash('sha256');
  const walk = (rel: string): void => {
    const entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child);
      else if (entry.isSymbolicLink()) hash.update(`${child}\0link\0${fs.readlinkSync(path.join(dir, child))}\0`);
      else if (entry.isFile()) hash.update(`${child}\0`).update(fs.readFileSync(path.join(dir, child))).update('\0');
    }
  };
  walk('');
  const digest = hash.digest('hex');
  bundleDigests.set(dir, { stamp, digest });
  return digest;
}

/**
 * The frozen copy for this version, made the first time a session needs it. Copied to a
 * staging folder and renamed into place, so a session never starts from half a copy.
 */
export function ensureSessionSnapshot(installedDir: string, snapshotDir: string): string {
  if (fs.existsSync(snapshotDir)) return snapshotDir;
  fs.mkdirSync(path.dirname(snapshotDir), { recursive: true });
  const staging = `${snapshotDir}.staging-${process.pid}-${Date.now()}`;
  fs.cpSync(installedDir, staging, { recursive: true, verbatimSymlinks: true });
  try {
    fs.renameSync(staging, snapshotDir);
  } catch (error) {
    // Two sessions starting at once: the other one's copy is just as good.
    fs.rmSync(staging, { recursive: true, force: true });
    if (!fs.existsSync(snapshotDir)) throw error;
  }
  return snapshotDir;
}

/**
 * At gugu's start, before any session: keep only the copy of each installed extension's
 * current version. Everything else belonged to sessions that ended with the last run.
 */
export function pruneSessionSnapshots(
  userDataDir: string,
  installed: ReadonlyMap<string, string>
): void {
  const root = sessionSnapshotsRoot(userDataDir);
  if (!fs.existsSync(root)) return;
  for (const extension of fs.readdirSync(root, { withFileTypes: true })) {
    const extensionDir = path.join(root, extension.name);
    const digest = installed.get(extension.name);
    if (!extension.isDirectory() || !digest) {
      fs.rmSync(extensionDir, { recursive: true, force: true });
      continue;
    }
    const keep = digest.slice(0, 16);
    for (const version of fs.readdirSync(extensionDir)) {
      if (version !== keep) fs.rmSync(path.join(extensionDir, version), { recursive: true, force: true });
    }
  }
}

/** An uninstalled App, once its programs have exited: its data folder and every frozen copy of it go. */
export function removeUninstalledLeftovers(userDataDir: string, dataDir: string, extensionId: string): void {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(path.join(sessionSnapshotsRoot(userDataDir), extensionId), { recursive: true, force: true });
}

/**
 * At gugu's start: data folders of Apps not installed go (an uninstall gugu quit before finishing). An installed bundle
 * gugu cannot read still counts as installed — its data stays for when it can.
 */
export function pruneExtensionData(dataRoot: string, installed: ReadonlySet<string>): void {
  if (!fs.existsSync(dataRoot)) return;
  for (const entry of fs.readdirSync(dataRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && !installed.has(entry.name)) fs.rmSync(path.join(dataRoot, entry.name), { recursive: true, force: true });
  }
}
