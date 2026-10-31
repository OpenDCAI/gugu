import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { isExpandableFileNode, type FileNode } from '@gugu/session-core/files';
import { REMOTE_WORKSPACE_CHUNK_BYTES } from '@gugu/session-core/session-record/contract';
import { AppFileError } from '@shared/extensions/app-files-core';
import { placeKey, workspaceSession, type AppFileEntry, type WorkspacePlace } from '@shared/extensions/app-runtime-protocol';
import type { ExtensionFileChangeBatch } from '@shared/extensions/bridge-protocol';
import { fileTreeProjectionChannel, type FileTreeProjectionEvent } from '@shared/core/fs/fsEvents';
import { tapMainEvents } from '@main/lib/events';
import { resolveWorkspace } from '@main/core/projects/utils';
import { readWorkspaceChunk, WorkspaceTransferError } from '@main/core/files/workspace-transfer';
import type { FileTreeProjector } from '@main/core/files/file-tree/projector';
import { workingCopyEntry } from './local-files';

/**
 * A working copy's files as an App reads them — the folder a session (or a project) works in, on the machine it is on:
 * the same file tree the task page's file panel reads (`FileTreeProjector`: one directory at a time, loaded when asked,
 * pushed when it changes) and the same chunked read (`readWorkspaceChunk`). Nothing here walks a folder or reads a
 * file whole: a folder of ten thousand files lists its top as fast as the panel does, and a 100 MB log reads in pieces.
 */

type Root = { workspaceRoot: string; projectId: string; workspaceId: string | null };

/** Where a call's folder is on this machine (`localRootOf`): a session's working copy, a project's root folder. */
async function rootOf(place: WorkspacePlace): Promise<Root & { projector: FileTreeProjector }> {
  const { localRootOf } = await import('./app-files');
  const root = await localRootOf(place);
  const workspace = root.workspaceId ? resolveWorkspace(root.projectId, root.workspaceId) : null;
  if (!workspace) throw new AppFileError('not-found', 'This folder is not open on its computer');
  return { ...root, projector: workspace.fileTreeProjector };
}

/** A folder as a call names it (`''` the top) → its absolute path there, never outside. */
function folderPath(root: string, folder: string | undefined): string | null {
  const rel = (folder ?? '').replace(/^\/+|\/+$/g, '');
  if (!rel) return null;
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new AppFileError('invalid', `${JSON.stringify(folder)} is not a folder of this working copy`);
  return abs;
}

const relOf = (root: string, abs: string) => path.relative(root, abs).split(path.sep).join('/');

/** The tree's nodes of one folder as entries: folders first-class (`type: 'folder'`), a file's size and dates read now. */
async function entriesOf(place: WorkspacePlace, root: string, nodes: readonly FileNode[]): Promise<AppFileEntry[]> {
  const entries = await Promise.all(nodes.map(async (node): Promise<AppFileEntry | null> => {
    const rel = relOf(root, node.path);
    const parent = path.posix.dirname(rel);
    const parentId = parent === '.' ? null : parent;
    if (isExpandableFileNode(node)) {
      return { ...workingCopyEntry(place, rel, null, 'inode/directory'), type: 'folder', suffix: '', parentId };
    }
    const stat = await fsp.stat(node.path).catch(() => null);
    return stat?.isFile() ? { ...workingCopyEntry(place, rel, stat), parentId } : null;
  }));
  return entries.filter((entry): entry is AppFileEntry => entry !== null);
}

/** A page's view of one working copy: its subscription to the tree, the folders it listed, and whom a change is told. */
interface View {
  place: WorkspacePlace;
  root: string;
  projector: FileTreeProjector;
  subscriptionId: string;
  /** Folder (absolute path, `null` the top) → the ids it last listed: what a push's `gone` is read against. */
  listed: Map<string | null, Set<string>>;
  hear: ((change: ExtensionFileChangeBatch) => void) | null;
}

const views = new Map<string, View>();
const viewKey = (pageId: number, place: WorkspacePlace) => `${pageId}/${placeKey(place)}`;

async function viewOf(pageId: number, place: WorkspacePlace): Promise<View> {
  const key = viewKey(pageId, place);
  const known = views.get(key);
  if (known) return known;
  const { workspaceRoot, projector } = await rootOf(place);
  const opened = await projector.openProjection();
  if (!opened.success) throw new AppFileError('not-found', 'This folder is not open on its computer');
  const view: View = { place, root: workspaceRoot, projector, subscriptionId: opened.data.subscriptionId, listed: new Map(), hear: null };
  // Two calls racing to open the same view: the first one kept, the other's subscription let go.
  const raced = views.get(key);
  if (raced) {
    void projector.closeProjection(view.subscriptionId);
    return raced;
  }
  views.set(key, view);
  return view;
}

async function listIn(view: View, folder: string | undefined): Promise<AppFileEntry[]> {
  const dir = folderPath(view.root, folder);
  const listed = await view.projector.listDir(view.subscriptionId, dir);
  if (!listed.success) throw new AppFileError('not-found', `No folder ${JSON.stringify(folder ?? '')} in this working copy`);
  const entries = await entriesOf(view.place, view.root, listed.data);
  view.listed.set(dir, new Set(entries.map((entry) => entry.id)));
  return entries;
}

/**
 * `files.list({ session }, { folder })`: what is directly in that folder (`''` or none: the top), as the file panel has it.
 * A page's listing is kept with the page (`pageId`), so its watch hears the folders it listed; a call for a page on another
 * machine (`answerAppCall`) has none, and lets go of the tree as it answers.
 */
export async function listWorkingCopy(place: WorkspacePlace, folder: string | undefined, pageId: number | null): Promise<AppFileEntry[]> {
  if (pageId !== null) return listIn(await viewOf(pageId, place), folder);
  const { workspaceRoot, projector } = await rootOf(place);
  const opened = await projector.openProjection();
  if (!opened.success) throw new AppFileError('not-found', 'This folder is not open on its computer');
  const view: View = { place, root: workspaceRoot, projector, subscriptionId: opened.data.subscriptionId, listed: new Map(), hear: null };
  try {
    return await listIn(view, folder);
  } finally {
    await projector.closeProjection(view.subscriptionId);
  }
}

/** `files.read(file, { offset, length })`: up to 512 KB of a working copy's file, as the file panel reads it. */
export async function readWorkingCopy(place: WorkspacePlace, file: string, offset: number, length: number): Promise<{ size: number; offset: number; data: string }> {
  const { workspaceRoot } = await rootOf(place);
  try {
    const chunk = await readWorkspaceChunk(workspaceRoot, { path: file, offset, length: Math.min(length, REMOTE_WORKSPACE_CHUNK_BYTES) });
    return { size: chunk.size, offset: chunk.offset, data: chunk.data };
  } catch (error) {
    if (error instanceof WorkspaceTransferError) throw new AppFileError(error.code === 'not_a_file' ? 'invalid' : 'not-found', error.message);
    throw error;
  }
}

/** Tell a page that files changed in the folders it listed of this working copy: each one as it is now, and what went. */
export async function watchWorkingCopy(pageId: number, place: WorkspacePlace, hear: (change: ExtensionFileChangeBatch) => void): Promise<() => void> {
  // A session's working copy on another machine sends no pushes across machines: the watch is taken and stays quiet —
  // listing again shows what changed there.
  const session = workspaceSession(place);
  if (session) {
    const { sessionMachine } = await import('./app-programs-elsewhere');
    if (await sessionMachine(session).catch(() => null)) return () => {};
  }
  const view = await viewOf(pageId, place);
  view.hear = hear;
  return () => {
    if (view.hear === hear) view.hear = null;
  };
}

/** A page gone: its subscriptions to the tree go with it. */
export function releaseWorkingCopies(pageId: number): void {
  for (const [key, view] of views) {
    if (!key.startsWith(`${pageId}/`)) continue;
    views.delete(key);
    void view.projector.closeProjection(view.subscriptionId);
  }
}

// The tree's pushes (the same ones the file panel gets): a folder a page listed and watches, told as it is now.
tapMainEvents((channel, data) => {
  if (channel !== fileTreeProjectionChannel.name) return;
  const push = data as FileTreeProjectionEvent;
  for (const view of views.values()) {
    if (view.subscriptionId !== push.subscriptionId || !view.hear) continue;
    void (async () => {
      for (const scope of push.scopes) {
        const dir = view.projector.scopePath(scope.scopeId);
        if (dir === undefined || !view.listed.has(dir)) continue;
        const entries = await entriesOf(view.place, view.root, scope.entries);
        const before = view.listed.get(dir) ?? new Set<string>();
        const now = new Set(entries.map((entry) => entry.id));
        view.listed.set(dir, now);
        view.hear?.({ kind: 'entries', entries, gone: [...before].filter((id) => !now.has(id)) });
      }
    })();
  }
});
