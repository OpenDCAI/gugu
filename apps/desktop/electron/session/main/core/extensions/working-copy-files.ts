import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { isExpandableFileNode, type FileNode } from '@gugu/session-core/files';
import { REMOTE_WORKSPACE_CHUNK_BYTES } from '@gugu/session-core/session-record/contract';
import { AppFileError } from '@shared/extensions/app-files-core';
import { placeKey, workspaceSession, type AppFileEntry, type WorkspacePlace } from '@shared/extensions/app-runtime-protocol';
import type { ExtensionFileChangeBatch } from '@shared/extensions/bridge-protocol';
import { fileChangesChannel, type FileChangesEvent } from '@shared/core/fs/fsEvents';
import { tapMainEvents } from '@main/lib/events';
import type { FileTreeProjector } from '@main/core/files/file-tree/projector';
import { workingCopyEntry } from './local-files';

/**
 * A working copy's files as an App reads them, on the machine it is on — the file panel's own chain: the file tree
 * (`FileTreeProjector`, one directory at a time), the chunked read (`readWorkspaceChunk`) and the working copy's change
 * stream (`fileChangesChannel`). Nothing here walks a folder, reads a file whole or watches the disk: it only turns those
 * into `gugu.files` answers (entries named by their path there).
 */

/** A subscription to the working copy's tree: a page keeps one while it is open, so the folders it listed stay loaded. */
interface View { place: WorkspacePlace; root: string; workspaceId: string; projector: FileTreeProjector; subscriptionId: string }

async function openView(place: WorkspacePlace): Promise<View> {
  // Imported when used: a page let go of (`releaseWorkingCopies`) must not load the workspace stack to do it.
  const [{ localRootOf }, { resolveWorkspace }] = await Promise.all([import('./app-files'), import('@main/core/projects/utils')]);
  const { workspaceRoot: root, projectId, workspaceId } = await localRootOf(place);
  const projector = workspaceId ? resolveWorkspace(projectId, workspaceId)?.fileTreeProjector : undefined;
  const opened = projector ? await projector.openProjection() : null;
  if (!projector || !workspaceId || !opened?.success) throw new AppFileError('not-found', 'This folder is not open on its computer');
  return { place, root, workspaceId, projector, subscriptionId: opened.data.subscriptionId };
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
    const listed = await view.projector.listDir(view.subscriptionId, folderPath(view.root, folder));
    if (!listed.success) throw new AppFileError('not-found', `No folder ${JSON.stringify(folder ?? '')} in this working copy`);
    return await entriesOf(view, listed.data);
  } finally {
    if (pageId === null) await view.projector.closeProjection(view.subscriptionId);
  }
}

/** A page gone: its subscriptions to the tree go with it. */
export function releaseWorkingCopies(pageId: number): void {
  for (const [key, view] of views) {
    if (!key.startsWith(`${pageId}/`)) continue;
    views.delete(key);
    void view.then((open) => open.projector.closeProjection(open.subscriptionId), () => undefined);
  }
}

/** `f.read(offset, length)`: up to 512 KB of a working copy's file, as the file panel reads it. */
export async function readWorkingCopy(place: WorkspacePlace, file: string, offset: number, length: number): Promise<{ size: number; etag: string; offset: number; data: string }> {
  const [{ localRootOf }, { readWorkspaceChunk, WorkspaceTransferError }] = await Promise.all([import('./app-files'), import('@main/core/files/workspace-transfer')]);
  const { workspaceRoot } = await localRootOf(place);
  try {
    const chunk = await readWorkspaceChunk(workspaceRoot, { path: file, offset, length: Math.min(length, REMOTE_WORKSPACE_CHUNK_BYTES) });
    return { size: chunk.size, etag: chunk.etag, offset: chunk.offset, data: chunk.data };
  } catch (error) {
    if (error instanceof WorkspaceTransferError) throw new AppFileError(error.code === 'not_a_file' ? 'invalid' : 'not-found', error.message);
    throw error;
  }
}

const watchers = new Set<{ workspaceId: string; root: string; folder: string; hear: (change: ExtensionFileChangeBatch) => void }>();

/**
 * `files.onChanged({ workspace, folder? }, fn)`: what changed in the working copy — below `folder` when one is named —
 * by its path there, from the change stream the file panel and the search index hear. A session's working copy on
 * another machine sends nothing across machines: the watch is taken and stays quiet (listing again shows its changes).
 */
export async function watchWorkingCopy(place: WorkspacePlace, folder: string | undefined, hear: (change: ExtensionFileChangeBatch) => void): Promise<() => void> {
  const session = workspaceSession(place);
  const { sessionMachine } = await import('./app-programs-elsewhere');
  if (session && await sessionMachine(session).catch(() => null)) return () => {};
  const { localRootOf } = await import('./app-files');
  const { workspaceRoot: root, workspaceId } = await localRootOf(place);
  if (!workspaceId) throw new AppFileError('not-found', 'This folder is not open on its computer');
  const watcher = { workspaceId, root, folder: relOf(root, folderPath(root, folder) ?? root), hear };
  watchers.add(watcher);
  return () => void watchers.delete(watcher);
}

tapMainEvents((channel, data) => {
  if (channel !== fileChangesChannel.name || watchers.size === 0) return;
  const { workspaceId, update } = data as FileChangesEvent;
  for (const watcher of watchers) {
    if (watcher.workspaceId !== workspaceId) continue;
    if (update.kind === 'resync') {
      watcher.hear({ kind: 'resync' });
      continue;
    }
    const changes = update.changes.map((change) => ({ kind: change.kind, path: relOf(watcher.root, change.path) }))
      .filter(({ path: rel }) => rel && !rel.startsWith('..') && (!watcher.folder || rel === watcher.folder || rel.startsWith(`${watcher.folder}/`)));
    if (changes.length > 0) watcher.hear({ kind: 'changes', changes });
  }
});
