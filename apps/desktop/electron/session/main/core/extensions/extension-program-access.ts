import { anySignal } from '@gugu/core/shared/anySignal';

/** App revocation and a task's current calls are independent authorization scopes. */
const active = new Map<string, Set<AbortController>>();
const taskCalls = new Map<string, Set<AbortController>>();

function registerAccess(extensionId: string, parent?: AbortSignal, sessionId?: string) {
  const controller = new AbortController();
  const own = active.get(extensionId) ?? new Set<AbortController>();
  own.add(controller);
  active.set(extensionId, own);
  // The session comes from the host's caller binding, never a tool argument. Register
  // synchronously, before tool discovery, caller lookup or program startup can await.
  const task = sessionId ? taskCalls.get(sessionId) ?? new Set<AbortController>() : undefined;
  const taskController = task ? new AbortController() : undefined;
  if (task && taskController && sessionId) {
    task.add(taskController);
    taskCalls.set(sessionId, task);
  }
  return {
    signal: anySignal([parent, controller.signal, taskController?.signal]),
    revoked: controller.signal,
    release() {
      own.delete(controller);
      if (own.size === 0 && active.get(extensionId) === own) active.delete(extensionId);
      if (taskController) task?.delete(taskController);
      if (task && sessionId && task.size === 0 && taskCalls.get(sessionId) === task) taskCalls.delete(sessionId);
    },
  };
}

/** Open after checking current grants. Also usable by page/input resources; release when the resource closes. */
export function openExtensionProgramAccess(extensionId: string, parent?: AbortSignal, sessionId?: string): {
  signal: AbortSignal;
  release(): void;
} {
  const { signal, release } = registerAccess(extensionId, parent, sessionId);
  return { signal, release };
}

/**
 * Stop the calls admitted for this task before this synchronous boundary. Remove the
 * batch before aborting: callbacks and a newer turn may admit new calls immediately.
 * Late cleanup belongs to the captured set and cannot detach or cancel that new turn.
 * This does not revoke the App, terminate its shared process, or cancel a person's UI.
 */
export function cancelExtensionSessionCalls(sessionId: string): void {
  const calls = taskCalls.get(sessionId);
  taskCalls.delete(sessionId);
  for (const controller of calls ?? []) {
    controller.abort(new DOMException('The calling task was stopped', 'AbortError'));
  }
}

/** Invalidates only resources already admitted; a re-enabled App receives a fresh scope. Synchronous. */
export function revokeExtensionProgramAccess(extensionId: string): void {
  const own = active.get(extensionId);
  active.delete(extensionId);
  for (const controller of own ?? []) {
    controller.abort(Object.assign(new Error('App program access was revoked'), { code: 'denied' }));
  }
}

/** Register before any preparation or startup, so revocation cannot be lost while waiting for either. */
export async function withExtensionProgramAccess<T>(extensionId: string, parent: AbortSignal | undefined,
  work: (signal: AbortSignal) => Promise<T>, sessionId?: string): Promise<T> {
  const access = registerAccess(extensionId, parent, sessionId);
  const { signal, revoked } = access;
  let abort!: () => void;
  try {
    signal.throwIfAborted();
    const cancelled = new Promise<never>((_resolve, reject) => {
      // A single call still waits for use() to release its handed authority (F106).
      // App revocation also closes the complete program surface synchronously, so only it may return early.
      abort = () => reject(revoked.reason);
      revoked.addEventListener('abort', abort, { once: true });
    });
    const result = await Promise.race([work(signal), cancelled]);
    signal.throwIfAborted();
    return result;
  } finally {
    if (abort) revoked.removeEventListener('abort', abort);
    access.release();
  }
}
