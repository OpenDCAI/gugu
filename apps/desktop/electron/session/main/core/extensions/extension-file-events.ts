import * as path from 'node:path';
import { extensionsService } from '@main/core/extensions/extensions-root';
import { log } from '@main/lib/logger';
import type { ExtensionFileChangeBatch } from '@shared/extensions/bridge-protocol';

/**
 * Tells one extension surface that the task's working copy changed.
 *
 * behavior tab-extensions gives exactly one way for an agent's work to reach a
 * tab —「tab 自己感知到文件变化并重画」—— and this is it. Nothing here knows an
 * agent exists: it watches the working copy, so a change made by an agent, by the
 * user's editor, or by a script all arrive identically. That is the point. A
 * channel that carried "the agent edited X" would make extensions a part of the
 * agent loop, and every author would then need to model turns.
 *
 * ⚠️ Consent is re-read on every batch, not captured at subscribe time. Capability
 * revocation has to stop the flow on the next event rather than on the next
 * restart — the same contract the bridge's per-call check gives. Which files exist
 * and when they change IS `files:read`; a surface that lost it must go quiet.
 */
export interface WorkspaceWatch {
  stop: () => void;
}

/** Absolute machine path → the workspace-relative POSIX path a surface speaks. */
function relativeToWorkspace(workspaceRoot: string, absolute: string): string | null {
  const relative = path.relative(workspaceRoot, absolute);
  // Outside the working copy: the watcher can surface a sibling when a directory
  // is moved. A surface consented to this working copy and nothing above it, so
  // the honest answer is to drop it rather than send a path it cannot place.
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

export function watchWorkspaceForSurface(input: {
  extensionId: string;
  workspaceRoot: string;
  deliver: (batch: ExtensionFileChangeBatch) => void;
}): WorkspaceWatch {
  let stopped = false;
  let release: (() => void) | null = null;
  let unsubscribe: (() => void) | null = null;

  const allowed = (): boolean =>
    extensionsService().grantedCapabilities(input.extensionId).includes('files:read');

  void (async () => {
    try {
      // Imported HERE, not at module load: the runtime manager pulls in the whole
      // machine-runtime and logging stack, and this module is imported by the
      // bridge, which is imported by nearly everything. A static import made three
      // unrelated test files fail on a half-built logger — a module that only
      // *might* need the runtime should not make everyone pay to load it.
      const { runtimeManager } = await import('@main/core/runtime/runtime-manager');
      // The lease is HELD for the life of the subscription rather than wrapped in
      // `withLease`: that helper releases when its callback returns, which for a
      // long-lived watch would drop the runtime the watch is running on.
      const acquired = await runtimeManager.acquire();
      if (stopped) {
        acquired.release();
        return;
      }
      release = () => acquired.release();

      const started = acquired.value.files.watchChanges(input.workspaceRoot, (update) => {
        if (stopped || !allowed()) return;
        if (update.kind === 'resync') {
          input.deliver({ kind: 'resync' });
          return;
        }
        const changes = update.changes
          .map((change) => {
            const relative = relativeToWorkspace(input.workspaceRoot, change.path);
            return relative === null ? null : { kind: change.kind, path: relative };
          })
          .filter((change): change is { kind: 'create' | 'update' | 'delete'; path: string } =>
            change !== null
          );
        // Every change fell outside the working copy: saying "something changed"
        // with an empty list would have a surface re-read for nothing.
        if (changes.length === 0) return;
        input.deliver({ kind: 'changes', changes });
        // 整棵树、粗一点可以:App 收得到 resync,一个目录一个 watch 的平台上没人盯着的目录由 nudge 补上。
      }, { coarse: true });

      if (!started.success) {
        // ❌ 不静默:订阅没建起来时,扩展会以「文件明明变了却不重画」的样子出现,
        // 而那是宿主的问题。喊出来,好过让作者去查自己的扩展。
        log.error('Extension workspace watch failed to start', {
          extensionId: input.extensionId,
          error: started.error,
        });
        release?.();
        release = null;
        return;
      }
      if (stopped) {
        started.data.unsubscribe();
        release?.();
        release = null;
        return;
      }
      unsubscribe = () => started.data.unsubscribe();
      // Stated, not assumed: "no events arrived" has two very different causes —
      // nothing changed, or nothing was ever watched — and without this line they
      // look identical from the outside (they did, on the first real-app run).
      log.info('Extension workspace watch started', {
        extensionId: input.extensionId,
        workspaceRoot: input.workspaceRoot,
      });
      void Promise.resolve(started.data.ready)
        .then(() => log.info('Extension workspace watch ready', { extensionId: input.extensionId }))
        .catch((error: unknown) =>
          log.error('Extension workspace watch never became ready', {
            extensionId: input.extensionId,
            error: String(error),
          })
        );
    } catch (error) {
      log.error('Extension workspace watch could not be established', {
        extensionId: input.extensionId,
        error: String(error),
      });
      release?.();
      release = null;
    }
  })();

  return {
    stop: () => {
      stopped = true;
      unsubscribe?.();
      unsubscribe = null;
      release?.();
      release = null;
    },
  };
}
