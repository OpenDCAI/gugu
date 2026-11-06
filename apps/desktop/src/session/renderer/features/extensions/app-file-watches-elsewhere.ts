import type { FileChangesEvent } from '@shared/core/fs/fsEvents';
import type { ExtensionFileChangeBatch } from '@shared/extensions/bridge-protocol';

/**
 * A page's `files.onChanged` on one file of a session on another machine. That machine's file changes reach this window as
 * they reach the file panel (`workspaceEvents`, `fileChangesChannel`), and only this window: main asks here, and hears back.
 * Nothing else is watched: the file's folder is added to what that machine watches (`watchDirectory`), as an open file
 * tab's is. A file outside the working copy is in no feed there, and saving it is still checked against its version.
 */
export type AppFileWatchRequest = { key: string; sessionId: string; file: string; on: boolean };
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

const separators = /[\\/]/;
// @@@folder-watch-retry - A machine just back answers before its workspace is mounted again (`not_found`), and nothing says
// when it is. A folder's watch is a light ask, so it is asked a few more times, then said; saving is checked by version anyway.
const FOLDER_WATCH_RETRY_MS = [1000, 2000, 4000, 8000, 16000];
const isAbsolute = (file: string) => file.startsWith('/') || /^[A-Za-z]:[\\/]/.test(file);
const directoryOf = (file: string) => file.slice(0, Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')));

export function answerAppFileWatches(deps: AppFileWatchDeps): () => void {
  const watches = new Map<string, () => void>();
  const start = ({ key, sessionId, file }: AppFileWatchRequest) => {
    const workspace = deps.locate(sessionId);
    if (!workspace) {
      deps.warn('A file watch names a session this window does not hold', { sessionId });
      return;
    }
    const absolute = isAbsolute(file) ? file : `${workspace.root}/${file}`;
    const inside = absolute.startsWith(`${workspace.root}/`) || absolute.startsWith(`${workspace.root}\\`);
    const unsubscribe = deps.onFileChanges(({ workspaceId, update }) => {
      if (workspaceId !== workspace.workspaceId) return;
      if (update.kind === 'resync') return deps.reply({ key, change: { kind: 'resync' } });
      const changes = update.changes.filter((change) => change.path === absolute).map(({ kind }) => ({ kind, path: file }));
      if (changes.length > 0) deps.reply({ key, change: { kind: 'changes', changes } });
    });
    let stopped = false;
    let release: (() => void) | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let asking = 0;
    const watchFolder = (attempt = 0, asked = ++asking) => {
      if (!inside || !separators.test(absolute.slice(workspace.root.length + 1))) return;
      void deps.watchDirectory(workspace, directoryOf(absolute)).then(
        (letGo) => { if (stopped) letGo(); else { release?.(); release = letGo; } },
        (error: unknown) => {
          if (stopped || asked !== asking) return;
          const wait = FOLDER_WATCH_RETRY_MS[attempt];
          if (wait === undefined) return deps.warn('A file\'s folder could not be watched on its machine', { sessionId, error: String(error) });
          retry = setTimeout(() => watchFolder(attempt + 1, asked), wait);
        },
      );
    };
    watchFolder();
    const offBack = deps.onMachineBack(workspace, () => {
      clearTimeout(retry);
      watchFolder();
      deps.reply({ key, change: { kind: 'resync' } });
    });
    watches.set(key, () => { stopped = true; clearTimeout(retry); unsubscribe(); offBack(); release?.(); });
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
