import type { LifeView } from '@shared/core/sessions/session-life';
import type { AcpLiveConnection } from './acp-live-connection';

type Disposable = { dispose(): void };
export type AttachmentPorts<T extends Disposable> = {
  connection: Pick<AcpLiveConnection, 'connected' | 'generation' | 'whenConnected' | 'onDisconnect'>;
  readLife(): Promise<LifeView>;
  onLife(listener: (view: LifeView) => void): () => void;
  attach(): Promise<T>;
};

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Versions order events only within this attempt, never against a previous host's mirror. */
function hostReady<T extends Disposable>(ports: AttachmentPorts<T>, signal: AbortSignal): Promise<void> {
  let off = () => {};
  let abort = () => {};
  return new Promise<void>((resolve, reject) => {
    let version = -1;
    const accept = (view: LifeView) => {
      if (signal.aborted || view.version < version) return;
      version = view.version;
      if (view.kind === 'ready') resolve();
      else if (view.kind === 'failed' || view.kind === 'archived') {
        reject(new Error(view.failure?.message ?? view.kind, { cause: view.failure?.cause }));
      }
    };
    off = ports.onLife(accept);
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    // Subscribe before reading, so ready between the two cannot be missed.
    void ports.readLife().then(accept, reject);
  }).finally(() => { off(); signal.removeEventListener('abort', abort); });
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
      await hostReady(ports, attempt.signal);
      signal.throwIfAborted();
      if (!current()) continue;
      let abandoned = false;
      const pending = ports.attach().then(session => {
        if (abandoned || attempt.signal.aborted) { session.dispose(); throw attempt.signal.reason; }
        return session;
      });
      try {
        const session = await abortable(pending, attempt.signal);
        if (current()) return session;
        session.dispose();
      } finally { abandoned = attempt.signal.aborted; }
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
