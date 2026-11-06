import type { FileChangesEvent } from '@shared/core/fs/fsEvents';
import type { ExtensionFileChangeBatch } from '@shared/extensions/bridge-protocol';

/**
 * A page's `files.onChanged` on one file or one folder of a session on another machine. That machine's file changes reach
 * this window as they reach the file panel (`workspaceEvents`, `fileChangesChannel`), and only this window: main asks here,
 * and hears back. Nothing else is watched: the folder is added to what that machine watches (`watchDirectory`), as an open
 * file tab's is. A file outside the working copy is in no feed there, and saving it is still checked against its version.
 */
export type AppFileWatchRequest = { key: string; sessionId: string; on: boolean } & ({ file: string } | { folder: string });
export type AppFileHeard = { key: string; change: ExtensionFileChangeBatch };
export type WatchedWorkspace = { projectId: string; workspaceId: string; root: string };

export type AppFileWatchDeps = {
  onRequest: (handler: (request: AppFileWatchRequest) => void) => () => void;
  reply: (heard: AppFileHeard) => void;
  /** The session's working copy as this window has it; null: this window does not hold it. */
  locate: (sessionId: string) => WatchedWorkspace | null;
  onFileChanges: (handler: (event: FileChangesEvent) => void) => () => void;
  /** Resolves to letting go of the watch. */
  watchDirectory: (workspace: WatchedWorkspace, directory: string) => Promise<() => void>;
  /** That machine reachable again: what changed meanwhile was told to no one, and what it was watching went with it. */
  onMachineBack: (workspace: WatchedWorkspace, handler: () => void) => () => void;
  warn: (message: string, data: Record<string, unknown>) => void;
};

const isAbsolute = (file: string) => file.startsWith('/') || /^[A-Za-z]:[\\/]/.test(file);
const directoryOf = (file: string) => file.slice(0, Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')));

/** What a watch of one file hears, by the name it asked with, and the folder to watch for it (none: outside the working copy). */
function ofFile(root: string, file: string) {
  const absolute = isAbsolute(file) ? file : `${root}/${file}`;
  const inside = absolute.startsWith(`${root}/`) || absolute.startsWith(`${root}\\`);
  return {
    nameOf: (path: string) => (path === absolute ? file : null),
    directory: inside ? directoryOf(absolute) : null,
  };
}

/** What a watch of one folder hears: what changes below it, by its path in the working copy, as one on this machine does. */
function ofFolder(root: string, folder: string) {
  const base = folder ? `${root}/${folder}` : root;
  return {
    nameOf: (path: string) => {
      if (!path.startsWith(`${base}/`) && !path.startsWith(`${base}\\`)) return null;
      const name = path.slice(root.length + 1).replaceAll('\\', '/');
      return /(^|\/)(\.git|node_modules)\//.test(name) ? null : name;
    },
    directory: base,
  };
}

export function answerAppFileWatches(deps: AppFileWatchDeps): () => void {
  const watches = new Map<string, () => void>();
  const start = (request: AppFileWatchRequest) => {
    const { key, sessionId } = request;
    const workspace = deps.locate(sessionId);
    if (!workspace) {
      deps.warn('A file watch names a session this window does not hold', { sessionId });
      return;
    }
    const { nameOf, directory } = 'file' in request ? ofFile(workspace.root, request.file) : ofFolder(workspace.root, request.folder);
    const unsubscribe = deps.onFileChanges(({ workspaceId, update }) => {
      if (workspaceId !== workspace.workspaceId) return;
      if (update.kind === 'resync') return deps.reply({ key, change: { kind: 'resync' } });
      const changes = update.changes.flatMap(({ kind, path }) => {
        const name = nameOf(path);
        return name === null ? [] : [{ kind, path: name }];
      });
      if (changes.length > 0) deps.reply({ key, change: { kind: 'changes', changes } });
    });
    let stopped = false;
    let release: (() => void) | null = null;
    const attach = () => {
      if (!directory) return;
      deps.watchDirectory(workspace, directory).then((letGo) => {
        if (stopped) letGo(); else { release?.(); release = letGo; }
      }).catch((error: unknown) => deps.warn('A file or folder could not be watched on its machine', { sessionId, error: String(error) }));
    };
    attach();
    const offBack = deps.onMachineBack(workspace, () => {
      attach();
      deps.reply({ key, change: { kind: 'resync' } });
    });
    watches.set(key, () => { stopped = true; unsubscribe(); offBack(); release?.(); });
  };
  const stopRequests = deps.onRequest((request) => {
    if (request.on) return start(request);
    watches.get(request.key)?.();
    watches.delete(request.key);
  });
  return () => {
    stopRequests();
    for (const stop of watches.values()) stop();
    watches.clear();
  };
}
