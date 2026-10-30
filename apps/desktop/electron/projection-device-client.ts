import { randomUUID } from 'node:crypto';
import { createDeviceRpcRequester, type DeviceRpcPipe, type DeviceRpcPipeHandlers } from '@gugu/core/cloud/deviceRpcRequester';
import { projectionViewerPacket } from '../src/session/shared/extensions/projection-protocol';
import { projectionControlSigner } from './projection-control-auth';
import type { ProjectionIdentityLease } from './projection-host-identity';

export type ProjectionViewerPage = Readonly<{
  id: string; epoch: number; appId: string; version: string; sessionId: string; deviceId: string;
  signal: AbortSignal; assertCurrent(): void; release(): void;
}>;
type Offer = { id: string; offer: { type: 'offer'; sdp: string } };
/** Internal main-only client. The App never receives proof, controlKey, or a generic signer. */
export async function createProjectionDeviceClient(options: {
  page: ProjectionViewerPage;
  identity: { capture(signal: AbortSignal): Promise<ProjectionIdentityLease> };
  openPipe(deviceId: string, asker: string, handlers: DeviceRpcPipeHandlers, signal: AbortSignal): Promise<DeviceRpcPipe>;
  report(error: unknown): void;
}) {
  const page = options.page, lifetime = new AbortController();
  let hostIdentity: ProjectionIdentityLease | undefined, proof: string | undefined, bindingId: string | undefined, controlKey: string | undefined;
  let disposing: Promise<void> | undefined;
  let pendingOpens = 0;
  const streams = new Map<string, string>();
  const check = () => {
    try { lifetime.signal.throwIfAborted(); page.assertCurrent(); hostIdentity?.assertCurrent(); }
    catch (error) { lifetime.abort(error); throw error; }
  };
  const abort = () => lifetime.abort(page.signal.reason ?? new Error('Projection viewer page closed'));
  const revoked = () => lifetime.abort(hostIdentity!.signal.reason);
  page.signal.addEventListener('abort', abort, { once: true }); if (page.signal.aborted) abort();
  const requester = createDeviceRpcRequester({
    // Envelope attribution for cleanup remains the captured owner. New work still calls check().
    userId: async () => { if (!hostIdentity) throw new Error('Projection viewer is not authenticated'); return hostIdentity.ownerId; },
    openPipe: async (device, handlers) => {
      lifetime.signal.throwIfAborted();
      const pipe = await options.openPipe(device, randomUUID().replaceAll('-', ''), { ...handlers, onClosed(error) {
        lifetime.abort(error); handlers.onClosed(error);
      } }, lifetime.signal);
      if (lifetime.signal.aborted) { pipe.close(); lifetime.signal.throwIfAborted(); }
      return pipe;
    },
  });
  const rpc = async (type: string, payload: unknown, signal: AbortSignal = lifetime.signal) => {
    const response = await requester.call(page.deviceId, `projection.${type}`, payload, { timeoutMs: 20_000, signal });
    if (response.error) throw new Error(`Projection signaling refused: ${response.error.message}`);
    return response.result;
  };
  const close = (): Promise<void> => {
    if (disposing) return disposing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    disposing = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void disposing.catch(error => { try { options.report(error); } catch { process.stderr.write(`Projection viewer cleanup failed: ${String(error).slice(0, 1000)}\n`); } });
    lifetime.abort(new Error('Projection viewer closed'));
    void (async () => {
      try {
        // Cleanup has its own deadline; the revoked page may no longer sign or negotiate.
        if (proof) {
          const errors: unknown[] = [];
          try { await rpc('unbind', { proof, page: { id: page.id, epoch: page.epoch } }, AbortSignal.timeout(5_000)); }
          catch (error) { errors.push(error); }
          try { await rpc('goodbye', { proof }, AbortSignal.timeout(5_000)); }
          catch (error) { errors.push(error); }
          if (errors.length === 1) throw errors[0];
          if (errors.length > 1) throw new AggregateError(errors, 'Projection viewer cleanup failed', { cause: errors[0] });
        }
      } finally {
        streams.clear(); proof = undefined; bindingId = undefined; controlKey = undefined;
        requester.closeAll(); page.signal.removeEventListener('abort', abort);
        hostIdentity?.signal.removeEventListener('abort', revoked); hostIdentity?.release(); page.release();
      }
    })().then(resolve, reject);
    return disposing;
  };
  lifetime.signal.addEventListener('abort', () => { void close(); }, { once: true });
  try {
    check(); hostIdentity = await options.identity.capture(lifetime.signal);
    hostIdentity.signal.addEventListener('abort', revoked, { once: true });
    if (hostIdentity.signal.aborted) revoked(); check();
    const hello = await rpc('hello', {}) as { proof: string; deviceId: string };
    check(); if (hello.deviceId !== page.deviceId || typeof hello.proof !== 'string') throw new Error('Projection replied from another host');
    proof = hello.proof;
    const bound = await rpc('bind', { proof, page: { id: page.id, epoch: page.epoch,
      appId: page.appId, version: page.version, sessionId: page.sessionId } }) as { bindingId: string; controlKey: string };
    check(); bindingId = bound.bindingId; controlKey = bound.controlKey;
    // Validate secret shape before returning a usable client; never forward it to the guest.
    projectionControlSigner(controlKey, bindingId, '', check);
    return Object.freeze({ signal: lifetime.signal, close,
      async open(sourceId: string): Promise<Offer> {
        check();
        if (streams.size + pendingOpens >= 16 || typeof sourceId !== 'string' || !sourceId.length || sourceId.length > 256) throw new Error('Invalid projection viewer source');
        pendingOpens++;
        try {
          const result = await rpc('signal', { proof, bindingId, command: { type: 'open', sourceId, requestId: randomUUID() } }) as Offer;
          check(); streams.set(result.id, sourceId); return { id: result.id, offer: result.offer };
        } finally { pendingOpens--; }
      },
      async answer(id: string, sdp: { type: 'answer'; sdp: string }): Promise<void> {
        check(); if (!streams.has(id)) throw new Error('Projection is not in this page');
        await rpc('signal', { proof, bindingId, command: { type: 'answer', id, sdp } }); check();
      },
      sign(id: string, data: string): string {
        check(); const source = streams.get(id); if (!source) throw new Error('Projection is not in this page');
        projectionViewerPacket(JSON.parse(data));
        return projectionControlSigner(controlKey!, bindingId!, source, check)(data);
      },
    });
  } catch (error) { await close().catch(() => { /* The shared cleanup sink already observed this failure. */ }); throw error; }
}
