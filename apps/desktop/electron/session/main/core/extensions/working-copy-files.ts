import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { isExpandableFileNode, type FileNode } from '@gugu/session-core/files';
import { REMOTE_WORKSPACE_CHUNK_BYTES, WORKSPACE_CONFLICT_CODE } from '@gugu/session-core/session-record/contract';
import { AppFileError } from '@shared/extensions/app-files-core';
import { placeKey, workspaceSession, type AppFileEntry, type WorkspacePlace } from '@shared/extensions/app-runtime-protocol';
import type { ExtensionFileChangeBatch } from '@shared/extensions/bridge-protocol';
import type { IGitWorktree } from '@gugu/session-core/git';
import type { RuntimeManager } from '@main/core/runtime/types';
import { log } from '@main/lib/logger';
import type { FileTreeProjector } from '@main/core/files/file-tree/projector';
import { createWorkspaceUploads, inWorkspace, WorkspaceTransferError, type WorkspaceWriteChunk } from '@main/core/files/workspace-transfer';
import { workingCopyEntry, workingCopyFolder } from './local-files';

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
interface View { place: WorkspacePlace; root: string; projector: FileTreeProjector; subscriptionId: string; workspaceId: string | null; git: IGitWorktree | undefined; close: () => Promise<void> }

async function openGit(manager: Pick<RuntimeManager, 'acquire'>, root: string): Promise<{ value: IGitWorktree; release: () => Promise<void> } | null> {
  const lease = await manager.acquire();
  try {
    const worktree = await lease.value.git.openWorktree(root);
    return { value: worktree.value, release: async () => { await worktree.release(); await lease.release(); } };
  } catch (error) {
    // A folder that is no repository has no git to say anything: the list is the same without it.
    log.info('[working-copy] no git for this folder', { root, error: String(error) });
    await lease.release();
    return null;
  }
}

async function openView(place: WorkspacePlace): Promise<View> {
  // Imported when used: a page let go of (`releaseWorkingCopies`) must not load the workspace stack to do it.
  const [{ localRootOf }, { acquireWorkspaceRuntime }, { runtimeManager }, { FileTreeProjector: Projector }] = await Promise.all([
    import('./app-files'),
    import('@main/core/workspaces/workspace-runtime'),
    import('@main/core/runtime/runtime-manager'),
    import('@main/core/files/file-tree/projector'),
  ]);
  const { workspaceRoot: root, workspaceId } = await localRootOf(place);
  const unreadable = () => new AppFileError('not-found', 'This folder cannot be read on its computer');
  const runtime = await acquireWorkspaceRuntime({ manager: runtimeManager }, root, true).catch(() => { throw unreadable(); });
  const projector = new Projector(runtime.fileTree, () => undefined);
  // The tree opens without git (a folder need not be a repository); what git says of its files, where it is one, is read beside it.
  const git = await openGit(runtimeManager, root);
  const close = async () => { projector.dispose(); await git?.release(); await runtime.release(); };
  const opened = await projector.openProjection();
  if (!opened.success) { await close(); throw unreadable(); }
  return { place, root, projector, subscriptionId: opened.data.subscriptionId, workspaceId, git: git?.value, close };
}

const views = new Map<string, Promise<View>>();

/** A folder as a call names it (`''` the top) → its absolute path there (null: the top), never outside. */
function folderPath(root: string, folder: string | undefined): string | null {
  const rel = (folder ?? '').replace(/^\/+|\/+$/g, '');
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new AppFileError('invalid', `${JSON.stringify(folder)} is not a folder of this working copy`);
  return rel ? abs : null;
}

/** What a chunked write is still gathering beside its file: not a file of the working copy yet. */
const UPLOADING_SUFFIX = '.gugu-tmp';

const relOf = (root: string, abs: string) => path.relative(root, abs).split(path.sep).join('/');

/** One folder's tree nodes as entries: subfolders as `folder` entries, a file's size and dates read now. */
async function entriesOf(view: View, nodes: readonly FileNode[]): Promise<AppFileEntry[]> {
  const status = await view.git?.getStatus().catch((error: unknown) => {
    log.warn('[working-copy] git status failed', { root: view.root, error: String(error) });
    return null;
  });
  if (status && status.kind !== 'ok') log.warn('[working-copy] git status said no', { root: view.root, kind: status.kind });
  const gitStatus = new Map(status?.kind === 'ok' ? [...status.staged, ...status.unstaged].map((change) => [path.resolve(view.root, change.path), change.status]) : []);
  const entries = await Promise.all(nodes.map(async (node): Promise<AppFileEntry | null> => {
    const rel = relOf(view.root, node.path);
    if (rel.endsWith(UPLOADING_SUFFIX)) return null;
    const parentId = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : null;
    const facts = { parentId, absolutePath: node.path, ...(view.workspaceId ? { workspaceId: view.workspaceId } : {}), ...(gitStatus.has(node.path) ? { gitStatus: gitStatus.get(node.path) } : {}) };
    if (isExpandableFileNode(node)) return { ...workingCopyFolder(view.place, rel), ...facts };
    const stat = await fsp.stat(node.path).catch(() => null);
    // A link that points nowhere still stands in the folder: to be seen, and deleted.
    if (!stat) return await fsp.lstat(node.path).then((link) => ({ ...workingCopyEntry(view.place, rel, link), ...facts }), () => null);
    return stat.isFile() ? { ...workingCopyEntry(view.place, rel, stat), ...facts } : null;
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
  try {
    const chunk = await readWorkspaceChunk(workspaceRoot, { path: file, offset, length: Math.min(length, REMOTE_WORKSPACE_CHUNK_BYTES) });
    return { size: chunk.size, etag: chunk.etag, offset: chunk.offset, data: chunk.data };
  } catch (error) {
    if (error instanceof WorkspaceTransferError) throw new AppFileError(error.code === 'not_a_file' ? 'invalid' : 'not-found', error.message);
    throw error;
  }
}

/** A file's size is the disk's to limit: the parts go to disk as they come, whatever the file's length. */
const uploads = createWorkspaceUploads({ maxBytes: Number.MAX_SAFE_INTEGER });

/**
 * `files.upload` into a working copy, one part: at most 512 KB, so a call stays under what one call may carry across
 * machines. `expectedEtag: null` is a new file: one already at that path is said at the first part, before any bytes go.
 */
export async function writeWorkingCopyChunk(place: WorkspacePlace, chunk: WorkspaceWriteChunk & { abort?: boolean }): Promise<{ received: number; entry?: AppFileEntry }> {
  if (chunk.abort === true) {
    await uploads.abort(chunk.uploadId);
    return { received: 0 };
  }
  const { localRootOf } = await import('./app-files');
  const { workspaceRoot } = await localRootOf(place);
  const taken = () => new AppFileError('name-taken', `${chunk.path} already exists`);
  try {
    if (chunk.offset === 0) {
      // Its folders are made once the path is known to be inside; one already there is said before any bytes go.
      const file = await inWorkspace(workspaceRoot, chunk.path);
      if (chunk.expectedEtag === null && await fsp.lstat(file).then(() => true, () => false)) throw taken();
      await fsp.mkdir(path.dirname(file), { recursive: true });
    }
    const { received, committed } = await uploads.write(workspaceRoot, chunk);
    if (!committed) return { received };
    return { received, entry: workingCopyEntry(place, relOf(workspaceRoot, path.resolve(workspaceRoot, chunk.path)), await fsp.stat(path.resolve(workspaceRoot, chunk.path))) };
  } catch (error) {
    if (!(error instanceof WorkspaceTransferError)) throw error;
    if (error.code === WORKSPACE_CONFLICT_CODE) throw taken();
    throw new AppFileError(error.code === 'outside_workspace' || error.code === 'invalid_payload' ? 'invalid' : 'failed', error.message);
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
