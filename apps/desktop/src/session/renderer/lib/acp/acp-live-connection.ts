import { TERMINAL_CHUNK_CAPABILITY } from '@gugu/session-core/acp/client';
import { connect, WireError, type Connection, type WireTransport } from '@gugu/session-wire';

export type AcpLiveConnection = Connection & {
  readonly generation: number;
  readonly connected: boolean;
  whenConnected(signal: AbortSignal): Promise<number>;
};

/** Machine-wide state can reconnect; a session attachment belongs to one host connection. */
export function connectAcpLiveState(transport: WireTransport): AcpLiveConnection {
  const connection = connect(transport, { capabilities: [TERMINAL_CHUNK_CAPABILITY] });
  let connected = true;
  transport.onDisconnect(() => { connected = false; });
  let generation = 0;
  const reconnected = new Set<() => void>();
  transport.onReconnect?.(() => {
    connected = true;
    generation++;
    for (const done of [...reconnected]) done();
    reconnected.clear();
  });
  const waitForReconnect = (since: number) => generation !== since ? Promise.resolve()
    : new Promise<void>(resolve => reconnected.add(resolve));
  const read = async <T>(operation: () => Promise<T>): Promise<T> => {
    for (;;) {
      const since = generation;
      try { return await operation(); }
      catch (error) {
        if (!(error instanceof WireError) || error.code !== 'DISCONNECTED' || !transport.onReconnect) throw error;
        // Wait for a real new connection, including one that arrived before this catch.
        // Retrying a rejected attach against the same connection would spin forever.
        await waitForReconnect(since);
      }
    }
  };
  return {
    ...connection,
    get generation() { return generation; },
    get connected() { return connected; },
    whenConnected: signal => {
      if (signal.aborted) return Promise.reject(signal.reason);
      if (connected) return Promise.resolve(generation);
      return new Promise((resolve, reject) => {
        const cleanup = () => { reconnected.delete(done); signal.removeEventListener('abort', abort); };
        const done = () => { cleanup(); resolve(generation); };
        const abort = () => { cleanup(); reject(signal.reason); };
        reconnected.add(done);
        signal.addEventListener('abort', abort, { once: true });
      });
    },
    // Commands belong to the current runtime. In particular a debounced draft must never
    // enter the transport's offline queue and run before its session is reattached.
    call: (path, input, options) => connected
      ? connection.call(path, input, options)
      : Promise.reject(new WireError('DISCONNECTED', 'Wire transport disconnected')),
    // An interrupted initial session snapshot cannot be replayed against a new host
    // before that host has created the session. Its owner waits for a fresh ready first.
    snapshot: topic => topic.startsWith('session.')
      ? connected ? connection.snapshot(topic) : Promise.reject(new WireError('DISCONNECTED', 'Wire transport disconnected'))
      : read(() => connection.snapshot(topic)),
    attach: (topic, push, options) => topic.startsWith('session.')
      ? connected ? connection.attach(topic, push, options) : Promise.reject(new WireError('DISCONNECTED', 'Wire transport disconnected'))
      : read(() => connection.attach(topic, push, options)),
  };
}
