import { type Dirent } from 'node:fs';
import { readFile, readdir, realpath, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteText, resolveGuguHome } from '@gugu/core/local/state/paths';
import type { UserLibrary, UserLibraryKind, UserLibraryEntry, UserLibraryWrite, UserLibraryRead } from '@shared/user-library';
import { aggregateLibraryIndex, parseLibraryEntry } from './user-library-index';

let owner: (() => Promise<string | null>) | null = null;
export function setUserLibraryOwner(provider: (() => Promise<string | null>) | null): void { owner = provider; }
async function libraryHome(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const id = await owner?.();
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Gugu library account is not ready');
  return join(resolveGuguHome(), 'users', id);
}

const kinds: readonly UserLibraryKind[] = ['capabilities', 'devices'];
function checkedKind(kind: UserLibraryKind) {
  if (!kinds.includes(kind)) throw new Error('Unknown Gugu library kind');
  return kind;
}
export async function readUserLibrary(explicitHome?: string): Promise<UserLibrary> {
  const root = join(await libraryHome(explicitHome), 'library');
  return { root, volumes: kinds.map(kind => ({ kind, name: kind, path: join(root, kind), index: join(root, kind) })) };
}

/** A new Gugu profile starts empty; installed tools or third-party indexes are never prerequisites. */
export async function readUserLibraryVolume(kind: UserLibraryKind, explicitHome?: string): Promise<UserLibraryRead> {
  const guguHome = await libraryHome(explicitHome);
  const volume = (await readUserLibrary(guguHome)).volumes.find(item => item.kind === checkedKind(kind))!;
  let entries: Dirent[];
  try { entries = await readdir(volume.path, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; entries = []; }
  const records = await Promise.all(entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => readUserLibraryEntry(kind, entry.name, guguHome)));
  records.sort((a, b) => (a.group ?? '').localeCompare(b.group ?? '') || a.name.localeCompare(b.name));
  const items = records.map(({ content: _content, ...item }) => item);
  return { volume, items, content: aggregateLibraryIndex(volume, items) };
}

function validId(id: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) throw new Error('Invalid Gugu library entry ID');
  return id;
}
export async function readUserLibraryEntry(kind: UserLibraryKind, id: string, explicitHome?: string): Promise<UserLibraryEntry> {
  checkedKind(kind);
  const guguHome = await libraryHome(explicitHome);
  const root = join(guguHome, 'library', kind);
  const path = join(root, validId(id), 'index.json');
  const [actualRoot, actual] = await Promise.all([realpath(root), realpath(path)]);
  const rest = relative(actualRoot, actual);
  if (isAbsolute(rest) || rest === '..' || rest.startsWith('../') || rest.startsWith('..\\')) throw new Error('Library entry is outside Gugu storage');
  const entry = parseLibraryEntry(JSON.parse(await readFile(actual, 'utf8')), id);
  return { ...entry, path: dirname(path), index: path };
}

const writes = new Map<string, Promise<unknown>>();
/** Serialize edits and check the caller's version. Each entry is durable; the aggregate is always derived. */
export async function writeUserLibraryEntry(input: UserLibraryWrite, explicitHome?: string): Promise<UserLibraryEntry> {
  checkedKind(input.kind);
  const guguHome = await libraryHome(explicitHome);
  const id = validId(input.id ?? randomUUID());
  const root = join(guguHome, 'library', input.kind);
  const path = join(root, id, 'index.json');
  const previous = writes.get(path);
  const operation = (async () => {
    if (previous) await previous.catch(() => {});
    const existing = await readUserLibraryEntry(input.kind, id, guguHome).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (existing && (!input.expectedModifiedAt || input.expectedModifiedAt !== existing.modifiedAt)) throw new Error('Library entry changed; read it again before editing');
    if (!existing && input.expectedModifiedAt) throw new Error('Library entry no longer exists');
    const modifiedAt = new Date(Math.max(Date.now(), existing ? Date.parse(existing.modifiedAt) + 1 : 0)).toISOString();
    const record = parseLibraryEntry({ ...input, id, modifiedAt }, id);
    await mkdir(dirname(path), { recursive: true });
    // Resolve the created parent too: a symlink cannot redirect a write outside this profile.
    const rest = relative(await realpath(root), await realpath(dirname(path)));
    if (isAbsolute(rest) || rest === '..' || rest.startsWith('../') || rest.startsWith('..\\')) throw new Error('Library entry is outside Gugu storage');
    await atomicWriteText(path, `${JSON.stringify(record, null, 2)}\n`);
    return { ...record, path: dirname(path), index: path };
  })();
  writes.set(path, operation);
  try { return await operation; }
  finally { if (writes.get(path) === operation) writes.delete(path); }
}

export type LibraryAgentAction = { action: 'library_list' } | { action: 'library_read'; kind: UserLibraryKind; entry?: string }
  | ({ action: 'library_write' } & UserLibraryWrite);
export function isLibraryAgentAction(action: { action: string }): action is LibraryAgentAction {
  return ['library_list', 'library_read', 'library_write'].includes(action.action);
}
export async function runLibraryAgentAction(action: LibraryAgentAction) {
  if (action.action === 'library_list') return readUserLibrary();
  if (action.action === 'library_write') return writeUserLibraryEntry(action);
  return action.entry ? readUserLibraryEntry(action.kind, action.entry) : readUserLibraryVolume(action.kind);
}
