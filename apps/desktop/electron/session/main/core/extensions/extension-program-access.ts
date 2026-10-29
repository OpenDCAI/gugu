/** App-wide revocation and per-call cancellation are separate authorization scopes. */
const active = new Map<string, Set<AbortController>>();

function registerAccess(extensionId: string, parent?: AbortSignal) {
  const controller = new AbortController();
  const own = active.get(extensionId) ?? new Set<AbortController>();
  own.add(controller);
  active.set(extensionId, own);
  return {
    signal: parent ? AbortSignal.any([parent, controller.signal]) : controller.signal,
    revoked: controller.signal,
    release() {
      own.delete(controller);
      if (own.size === 0 && active.get(extensionId) === own) active.delete(extensionId);
    },
  };
}

/** Open after checking current grants. Also usable by page/input resources; release when the resource closes. */
export function openExtensionProgramAccess(extensionId: string, parent?: AbortSignal): {
  signal: AbortSignal;
  release(): void;
} {
  const { signal, release } = registerAccess(extensionId, parent);
  return { signal, release };
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
  work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const access = registerAccess(extensionId, parent);
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
