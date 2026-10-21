import * as fs from 'node:fs';
import * as path from 'node:path';
import { appDataTooLarge } from '@shared/extensions/app-data';
import { resolvesInside } from './path-containment';

/**
 * One folder per extension that both halves of it share: its tab / background pages
 * (through `readData` / `writeData` / `listData`) and the MCP programs it runs for agents
 * (through `GUGU_EXTENSION_DATA_DIR`). Refs #6387. The device's, whoever is signed in (主人 10-01).
 *
 * Without it an extension that gives agents tools has two stores that never meet — the
 * program writes a note to disk, the page keeps its own copy in browser storage, and the
 * person never sees what the agent did. Removed with the extension: a reinstall must not
 * inherit what the person believed they had deleted.
 */

export const EXTENSION_DATA_DIR_NAME = 'extension-data';

export function extensionDataDir(userDataDir: string, extensionId: string): string {
  return path.join(userDataDir, EXTENSION_DATA_DIR_NAME, extensionId);
}

/** The codes a page branches on (`bridgeFailure`), the same here and for a page on another machine. */
const coded = (code: 'invalid' | 'too-large', message: string) => Object.assign(new Error(message), { code });

function resolveData(root: string, relative: string): string {
  fs.mkdirSync(root, { recursive: true });
  const cleaned = relative.trim() === '' ? '.' : relative;
  const target = resolvesInside(root, cleaned);
  if (!target) throw coded('invalid', `path must stay inside the App's data folder: ${relative}`);
  return target;
}

export function readExtensionData(root: string, relative: string): string | null {
  const target = resolveData(root, relative);
  if (target === root) throw coded('invalid', 'path must name a file');
  // Absent is an answer, not an error: a notebook nobody has written to yet is empty.
  if (!fs.existsSync(target)) return null;
  return fs.readFileSync(target, 'utf8');
}

export function writeExtensionData(root: string, relative: string, content: string): void {
  // The same limit as the phone's App data (app-data.ts).
  const tooLarge = appDataTooLarge(Buffer.byteLength(content));
  if (tooLarge) throw coded('too-large', tooLarge);
  const target = resolveData(root, relative);
  if (target === root) throw coded('invalid', 'path must name a file');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Write-then-rename: the MCP program may read this file at the same moment, and a
  // half-written JSON document is worse than the previous whole one.
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, content, 'utf8');
  fs.renameSync(temp, target);
}

export function listExtensionData(root: string, relative: string): { path: string; kind: 'file' | 'directory' }[] {
  const target = resolveData(root, relative);
  if (!fs.existsSync(target)) return [];
  return fs.readdirSync(target, { withFileTypes: true }).map((entry) => ({
    path: path.relative(root, path.join(target, entry.name)).split(path.sep).join('/'),
    kind: entry.isDirectory() ? 'directory' : 'file',
  }));
}

export function removeExtensionData(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}
