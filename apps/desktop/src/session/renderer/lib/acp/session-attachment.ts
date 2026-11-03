import type { LifeView } from '@shared/core/sessions/session-life';
import type { AcpLiveConnection } from './acp-live-connection';

type Disposable = { dispose(): void };
export type AttachmentPorts<T extends Disposable> = {
  connection: Pick<AcpLiveConnection, 'connected' | 'generation' | 'whenConnected' | 'onDisconnect'>;
  readLife(): Promise<LifeView>;
  onLife(listener: (view: LifeView) => void): () => void;
  attach(): Promise<T>;
};

/** Keep the ready permission live until attachment completes, including within one connection. */
function attachWhileReady<T extends Disposable>(ports: AttachmentPorts<T>, signal: AbortSignal): Promise<T> {
  let off = () => {};
  let abort = () => {};
  let finished = false;
  return new Promise<T>((resolve, reject) => {
    let version = -1;
    let ready = false;
    let era = 0;
    const fail = (error: unknown) => { if (!finished) { finished = true; reject(error); } };
    const accept = (view: LifeView) => {
      if (signal.aborted || finished || view.version < version) return;
      version = view.version;
      if (view.kind !== 'ready') {
        ready = false;
        era++;
        if (view.kind === 'failed' || view.kind === 'archived') {
          fail(new Error(view.failure?.message ?? view.kind, { cause: view.failure?.cause }));
        }
        return;
      }
      if (ready) return;
      ready = true;
      const permission = era;
      const valid = () => !finished && !signal.aborted && ready && era === permission;
      // A newer non-ready event in the same batch can revoke ready before work begins.
      void Promise.resolve().then(() => valid() ? ports.attach() : undefined).then(session => {
        if (!session) return;
        if (!valid()) { session.dispose(); return; }
        finished = true;
        resolve(session);
      }, error => { if (valid()) fail(error); });
    };
    off = ports.onLife(accept);
    abort = () => fail(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    // Subscribe before reading, so ready between the two cannot be missed.
    void ports.readLife().then(accept, fail);
  }).finally(() => { finished = true; off(); signal.removeEventListener('abort', abort); });
}

/** A connection change abandons the attempt; only the current host's ready permits a new handle. */
export async function attachInCurrentConnection<T extends Disposable>(
  ports: AttachmentPorts<T>, signal: AbortSignal,
): Promise<T> {
  for (;;) {
    signal.throwIfAborted();
    const generation = await ports.connection.whenConnected(signal);
    const attempt = new AbortController();
    const cancel = () => attempt.abort(signal.reason);
    const off = ports.connection.onDisconnect(() => attempt.abort());
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    const current = () => ports.connection.connected && ports.connection.generation === generation;
    try {
      if (!current()) { attempt.abort(); continue; }
      const session = await attachWhileReady(ports, attempt.signal);
      if (!signal.aborted && current()) return session;
      session.dispose();
      signal.throwIfAborted();
    } catch (error) {
      signal.throwIfAborted();
      if (current()) throw error;
      // The connection itself invalidated the attempt. No error type or timer retries an attachment.
    } finally {
      off();
      signal.removeEventListener('abort', cancel);
    }
  }
}
