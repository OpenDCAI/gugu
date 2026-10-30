/** Local host identity only. Neither a request envelope nor SDP supplies these fields. */
export type ProjectionRuntimeIdentity = Readonly<{ ownerId: string; deviceId: string; runtimeInstanceId: string }>;
export type ProjectionIdentityLease = ProjectionRuntimeIdentity & Readonly<{
  signal: AbortSignal;
  assertCurrent(): void;
  release(): void;
}>;

type Pending = { abort(reason: unknown): void; check?: () => void };
const abortable = <T>(work: Promise<T>, signal: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
  const aborted = () => { signal.removeEventListener('abort', aborted); reject(signal.reason); };
  signal.addEventListener('abort', aborted, { once: true });
  work.then(value => { signal.removeEventListener('abort', aborted); resolve(value); },
    error => { signal.removeEventListener('abort', aborted); reject(error); });
  if (signal.aborted) aborted();
});

export function createProjectionHostIdentity(input: {
  auth(): Promise<{ userId: string; accessToken: string } | null>;
  runtime(): ProjectionRuntimeIdentity | null;
}) {
  let revision = 0, disposed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const active = new Set<Pending>();
  const invalidate = (reason = new Error('Projection host authentication changed')) => {
    revision++;
    for (const lease of [...active]) lease.abort(reason);
  };
  return {
    invalidate,
    dispose() { disposed = true; invalidate(new Error('Projection host stopped')); },
    async capture(parent: AbortSignal): Promise<ProjectionIdentityLease> {
      parent.throwIfAborted();
      if (disposed || active.size >= 128) throw new Error('Projection host identity is unavailable');
      const controller = new AbortController(), epoch = revision;
      const release = (reason: unknown = new Error('Projection identity released')) => {
        controller.abort(reason); parent.removeEventListener('abort', cancelled); active.delete(pending);
        if (!active.size) { clearInterval(timer); timer = undefined; }
      };
      const cancelled = () => release(parent.reason);
      const pending: Pending = { abort: release };
      active.add(pending);
      parent.addEventListener('abort', cancelled, { once: true });
      if (parent.aborted) cancelled();
      timer ??= setInterval(() => {
        for (const lease of [...active]) { try { lease.check?.(); } catch { /* check revokes the lease before throwing. */ } }
      }, 1000);
      timer.unref?.();
      try {
        const auth = await abortable(Promise.resolve().then(() => { controller.signal.throwIfAborted(); return input.auth(); }), controller.signal);
        controller.signal.throwIfAborted();
        const runtime = input.runtime();
        if (!auth?.accessToken || !runtime || auth.userId !== runtime.ownerId) throw new Error('Projection host has no matching authenticated runtime');
        const stamp = Object.freeze({ ...runtime });
        const assertCurrent = () => {
          try {
            controller.signal.throwIfAborted();
            const current = input.runtime();
            if (disposed || revision !== epoch || !current || current.ownerId !== stamp.ownerId
              || current.deviceId !== stamp.deviceId || current.runtimeInstanceId !== stamp.runtimeInstanceId) {
              throw new Error('Projection host runtime changed');
            }
          } catch (error) { release(error); throw error; }
        };
        pending.check = assertCurrent; assertCurrent();
        return Object.freeze({ ...stamp, signal: controller.signal, assertCurrent, release: () => release() });
      } catch (error) { release(error); throw error; }
    },
  };
}
