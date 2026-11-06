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
  /** The session's workspace mounted on its machine: at once when it already is. */
  mount: (sessionId: string, workspace: WatchedWorkspace) => Promise<void>;
  /** Resolves to letting go of the watch. */
  watchDirectory: (workspace: WatchedWorkspace, directory: string) => Promise<() => void>;
  /** That machine reachable again: what changed meanwhile was told to no one, and what it was watching went with it. */
  onMachineBack: (workspace: WatchedWorkspace, handler: () => void) => () => void;
  warn: (message: string, data: Record<string, unknown>) => void;
};

const separators = /[\\/]/;
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
    const attach = () => {
      // A machine just back has not mounted the workspace again, and its feed and folder watches need that: mount it, then ask once.
      void deps.mount(sessionId, workspace).then(async () => {
        if (stopped || !inside || !separators.test(absolute.slice(workspace.root.length + 1))) return;
        const letGo = await deps.watchDirectory(workspace, directoryOf(absolute));
        if (stopped) letGo(); else { release?.(); release = letGo; }
      }).catch((error: unknown) => deps.warn('A file could not be watched on its machine', { sessionId, error: String(error) }));
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
