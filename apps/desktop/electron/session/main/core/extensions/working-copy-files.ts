import { requireAgentFileTreeAccess } from '@gugu/core/local/state/agentFileBoundary';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { isExpandableFileNode, type FileNode } from '@gugu/session-core/files';
import { REMOTE_WORKSPACE_CHUNK_BYTES } from '@gugu/session-core/session-record/contract';
import { AppFileError } from '@shared/extensions/app-files-core';
import { placeKey, workspaceSession, type AppFileEntry, type WorkspacePlace } from '@shared/extensions/app-runtime-protocol';
import type { ExtensionFileChangeBatch } from '@shared/extensions/bridge-protocol';
import type { FileTreeProjector } from '@main/core/files/file-tree/projector';
import { workingCopyEntry } from './local-files';

/**
 * A working copy's files as an App reads them, on the machine it is on — the file panel's own chain: the file tree
 * (`FileTreeProjector`, one directory at a time), the chunked read (`readWorkspaceChunk`) and the files runtime's change
 * feed. Nothing here walks a folder or reads a file whole: it only turns those into `gugu.files` answers (entries named
 * by their path there).
 *
 * The folder comes from the session's or project's own record, and nothing here mounts it: mounting a workspace runs the
 * project's setup and run scripts (`createWorkspaceFactory`), which a page reading a folder must never set off.
 */

/** A subscription to the working copy's tree: a page keeps one while it is open, so the folders it listed stay loaded. */
interface View { place: WorkspacePlace; root: string; projector: FileTreeProjector; subscriptionId: string; close: () => Promise<void> }

async function openView(place: WorkspacePlace): Promise<View> {
  // Imported when used: a page let go of (`releaseWorkingCopies`) must not load the workspace stack to do it.
  const { localRootOf } = await import('./app-files');
  const { workspaceRoot: root } = await localRootOf(place);
  await requireAgentFileTreeAccess(root);
  const [{ acquireWorkspaceRuntime }, { runtimeManager }, { FileTreeProjector: Projector }] = await Promise.all([
    import('@main/core/workspaces/workspace-runtime'),
    import('@main/core/runtime/runtime-manager'),
    import('@main/core/files/file-tree/projector'),
  ]);
  const unreadable = () => new AppFileError('not-found', 'This folder cannot be read on its computer');
  const runtime = await acquireWorkspaceRuntime({ manager: runtimeManager }, root, true).catch(() => { throw unreadable(); });
  const projector = new Projector(runtime.fileTree, () => undefined);
  const close = async () => { projector.dispose(); await runtime.release(); };
  const opened = await projector.openProjection();
  if (!opened.success) { await close(); throw unreadable(); }
  return { place, root, projector, subscriptionId: opened.data.subscriptionId, close };
}

const views = new Map<string, Promise<View>>();

/** A folder as a call names it (`''` the top) → its absolute path there (null: the top), never outside. */
function folderPath(root: string, folder: string | undefined): string | null {
  const rel = (folder ?? '').replace(/^\/+|\/+$/g, '');
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new AppFileError('invalid', `${JSON.stringify(folder)} is not a folder of this working copy`);
  return rel ? abs : null;
}

const relOf = (root: string, abs: string) => path.relative(root, abs).split(path.sep).join('/');

/** One folder's tree nodes as entries: subfolders as `folder` entries, a file's size and dates read now. */
async function entriesOf(view: View, nodes: readonly FileNode[]): Promise<AppFileEntry[]> {
  const entries = await Promise.all(nodes.map(async (node): Promise<AppFileEntry | null> => {
    const rel = relOf(view.root, node.path);
    const parentId = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : null;
    if (isExpandableFileNode(node)) return { ...workingCopyEntry(view.place, rel, null, 'inode/directory'), type: 'folder', suffix: '', parentId };
    const stat = await fsp.stat(node.path).catch(() => null);
    return stat?.isFile() ? { ...workingCopyEntry(view.place, rel, stat), parentId } : null;
  }));
  return entries.filter((entry): entry is AppFileEntry => entry !== null);
}

/**
 * `files.list({ workspace, folder })`: what is directly in that folder (`''` the top), as the file panel has it. A page's
 * subscription is kept with it (`pageId`); a call for a page on another machine (`answerAppCall`) lets go as it answers.
 */
export async function listWorkingCopy(place: WorkspacePlace, folder: string | undefined, pageId: number | null): Promise<AppFileEntry[]> {
  const key = `${pageId}/${placeKey(place)}`;
  const kept = pageId === null ? null : views.get(key);
  const opening = kept ?? openView(place);
  if (pageId !== null && !kept) views.set(key, opening.catch((error: unknown) => { views.delete(key); throw error; }));
  const view = await opening;
  try {
    await requireAgentFileTreeAccess(view.root);
    const listed = await view.projector.listDir(view.subscriptionId, folderPath(view.root, folder));
    if (!listed.success) throw new AppFileError('not-found', `No folder ${JSON.stringify(folder ?? '')} in this working copy`);
    return await entriesOf(view, listed.data);
  } finally {
    if (pageId === null) await view.close();
  }
}

/** A page gone: its subscriptions to the tree go with it. */
export function releaseWorkingCopies(pageId: number): void {
  for (const [key, view] of views) {
    if (!key.startsWith(`${pageId}/`)) continue;
    views.delete(key);
    void view.then((open) => open.close(), () => undefined);
  }
}

/** `f.read(offset, length)`: up to 512 KB of a working copy's file, as the file panel reads it. */
export async function readWorkingCopy(place: WorkspacePlace, file: string, offset: number, length: number): Promise<{ size: number; etag: string; offset: number; data: string }> {
  const [{ localRootOf }, { readWorkspaceChunk, WorkspaceTransferError }] = await Promise.all([import('./app-files'), import('@main/core/files/workspace-transfer')]);
  const { workspaceRoot } = await localRootOf(place);
  await requireAgentFileTreeAccess(workspaceRoot);
  try {
    const chunk = await readWorkspaceChunk(workspaceRoot, { path: file, offset, length: Math.min(length, REMOTE_WORKSPACE_CHUNK_BYTES) });
    return { size: chunk.size, etag: chunk.etag, offset: chunk.offset, data: chunk.data };
  } catch (error) {
    if (error instanceof WorkspaceTransferError) throw new AppFileError(error.code === 'not_a_file' ? 'invalid' : 'not-found', error.message);
    throw error;
  }
}

/**
 * `files.onChanged({ workspace, folder? }, fn)`: what changed in the working copy — below `folder` when one is named —
 * by its path there, from the change feed the file panel and the search index hear. Where a whole tree is watched one
 * directory at a time (Linux, `@@@tree-by-directories`) the feed only carries directories someone watches, so the folder
 * named is watched here and what a page has listed is watched by its tree; deeper changes reach a page on Linux only
 * from there. A session's working copy on another machine sends nothing across machines: the watch is taken and stays
 * quiet (listing again shows its changes).
 */
export async function watchWorkingCopy(place: WorkspacePlace, folder: string | undefined, hear: (change: ExtensionFileChangeBatch) => void): Promise<() => void> {
  const session = workspaceSession(place);
  const { sessionMachine } = await import('./app-programs-elsewhere');
  if (session && await sessionMachine(session).catch(() => null)) return () => {};
  const [{ localRootOf }, { runtimeManager }] = await Promise.all([import('./app-files'), import('@main/core/runtime/runtime-manager')]);
  const { workspaceRoot: root } = await localRootOf(place);
  await requireAgentFileTreeAccess(root);
  const named = folderPath(root, folder) ?? root;
  const below = relOf(root, named);
  const cannotWatch = () => new AppFileError('not-found', 'This folder cannot be watched on its computer');
  const lease = await runtimeManager.acquire();
  const feed = lease.value.files.watchChanges(root, (update) => {
    if (update.kind === 'resync') return hear({ kind: 'resync' });
    const changes = update.changes.map((change) => ({ kind: change.kind, path: relOf(root, change.path) }))
      .filter(({ path: rel }) => rel && !rel.startsWith('..') && (!below || rel === below || rel.startsWith(`${below}/`)));
    if (changes.length > 0) hear({ kind: 'changes', changes });
  }, { ignore: ['**/{.git,node_modules}/**'] });
  if (!feed.success) {
    await lease.release();
    throw cannotWatch();
  }
  const directory = lease.value.files.watchDirectory(named);
  const stop = () => {
    if (directory.success) directory.data();
    feed.data.unsubscribe();
    void lease.release();
  };
  const ready = await feed.data.ready();
  if (!directory.success || !ready.success) {
    stop();
    throw cannotWatch();
  }
  return stop;
}
