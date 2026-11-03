import { TERMINAL_CHUNK_CAPABILITY } from '@gugu/session-core/acp/client';
import { connect, WireError, type Connection, type WireTransport } from '@gugu/session-wire';

/** Only live-state reads are replayable. Engine commands retain their original result. */
export function connectAcpLiveState(transport: WireTransport): Connection {
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
    // Commands belong to the current runtime. In particular a debounced draft must never
    // enter the transport's offline queue and run before its session is reattached.
    call: (path, input, options) => connected
      ? connection.call(path, input, options)
      : Promise.reject(new WireError('DISCONNECTED', 'Wire transport disconnected')),
    snapshot: topic => read(() => connection.snapshot(topic)),
    attach: (topic, push, options) => read(() => connection.attach(topic, push, options)),
  };
}
