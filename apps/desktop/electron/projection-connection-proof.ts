import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DeviceRpcAskerContext } from '@gugu/core/cloud/deviceRpcResponder';
import type { ProjectionIdentityLease } from './projection-host-identity';

type Connection = {
  id: string;
  proof: string;
  controller: AbortController;
  identity?: ProjectionIdentityLease;
  ready: Promise<void>;
  off(): void;
  offIdentity(): void;
  closed: boolean;
};
const refused = () => new Error('Projection connection authentication is required');
const sameProof = (expected: string, supplied: unknown): boolean => typeof supplied === 'string'
  && /^[A-Za-z0-9_-]{43}$/.test(supplied)
  && timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));

/** A reply on the actual private asker topic proves read access. Payload user/device ids are ignored. */
export function createProjectionConnectionProofs(identity: { capture(signal: AbortSignal): Promise<ProjectionIdentityLease> }) {
  const connections = new Map<DeviceRpcAskerContext, Connection>();
  let disposed = false;
  const close = (asker: DeviceRpcAskerContext, connection: Connection, reason: unknown) => {
    if (connection.closed) return;
    connection.closed = true;
    if (connections.get(asker) === connection) connections.delete(asker);
    connection.off(); connection.offIdentity(); connection.controller.abort(reason); connection.identity?.release();
  };
  const current = (asker: DeviceRpcAskerContext | undefined, proof: unknown) => {
    const connection = asker && connections.get(asker);
    if (disposed || !asker || !connection || connection.closed || !connection.identity || !sameProof(connection.proof, proof)) throw refused();
    connection.controller.signal.throwIfAborted();
    try { connection.identity.assertCurrent(); }
    catch (error) { close(asker, connection, error); throw error; }
    return connection;
  };
  return {
    async hello(asker: DeviceRpcAskerContext | undefined) {
      if (disposed || !asker) throw refused();
      let connection = connections.get(asker);
      if (!connection) {
        if (connections.size >= 64) throw new Error('Too many projection connections');
        const entry: Connection = { id: randomUUID(), proof: randomBytes(32).toString('base64url'), controller: new AbortController(),
          ready: Promise.resolve(), off() {}, offIdentity() {}, closed: false };
        connection = entry; connections.set(asker, entry);
        entry.off = asker.onDetached(() => close(asker, entry, new Error('Projection asker detached')));
        if (entry.closed) entry.off();
        entry.ready = (async () => {
          const lease = await identity.capture(entry.controller.signal);
          entry.identity = lease;
          const revoked = () => close(asker, entry, lease.signal.reason);
          entry.offIdentity = () => lease.signal.removeEventListener('abort', revoked);
          lease.signal.addEventListener('abort', revoked, { once: true });
          if (lease.signal.aborted || entry.closed) { close(asker, entry, lease.signal.reason ?? new Error('Projection asker detached')); lease.release(); }
          entry.controller.signal.throwIfAborted(); lease.assertCurrent();
        })();
      }
      try {
        await connection.ready;
        const checked = current(asker, connection.proof);
        return Object.freeze({ connectionId: checked.id, proof: checked.proof, deviceId: checked.identity!.deviceId });
      } catch (error) { close(asker, connection, error); throw error; }
    },
    authorize(asker: DeviceRpcAskerContext | undefined, proof: unknown) {
      const connection = current(asker, proof), lease = connection.identity!;
      return Object.freeze({ ownerId: lease.ownerId, deviceId: lease.deviceId, runtimeInstanceId: lease.runtimeInstanceId,
        connectionId: connection.id, signal: connection.controller.signal,
        assertCurrent() { current(asker, proof); } });
    },
    revoke(asker: DeviceRpcAskerContext | undefined, proof: unknown) {
      const connection = current(asker, proof);
      close(asker!, connection, new Error('Projection connection released'));
    },
    dispose() {
      disposed = true;
      for (const [asker, connection] of [...connections]) close(asker, connection, new Error('Projection device handler closed'));
    },
  };
}
