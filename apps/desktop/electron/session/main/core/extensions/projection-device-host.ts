import { randomUUID } from 'node:crypto';
import type { DeviceRpcHandler, DeviceRpcHandlerContext, DeviceRpcHandlers } from '@gugu/core/cloud/deviceRpcResponder';
import { createProjectionConnectionProofs } from '../../../../projection-connection-proof';
import type { createProjectionHostIdentity } from '../../../../projection-host-identity';
import { projectionControlKey, verifyProjectionControl } from '../../../../projection-control-auth';
import { ProjectionSignals, type ProjectionSignalContext, type ProjectionSignalCommand, type ProjectionSignalLease } from '../../../../../native/projection-media/node/signaling.mjs';
import type { ProjectionRemoteMediaBinding } from './projection-media-access';
import type { projectionVideoFeed } from './projection-video-feed';

export type ProjectionDeviceHostOptions = {
  identity: Pick<ReturnType<typeof createProjectionHostIdentity>, 'capture'>;
  /** Installed/enabled App, exact version, and the real source registry check their own grants. */
  assertApp(appId: string, version: string): void;
  createFeed(binding: ProjectionRemoteMediaBinding, source: string, context: ProjectionSignalContext): ReturnType<typeof projectionVideoFeed>;
  report(error: unknown): void;
};
type Connection = ReturnType<ReturnType<typeof createProjectionConnectionProofs>['authorize']>;
type Page = {
  id: string; epoch: number; appId: string; version: string; sessionId: string;
  bindingId: string; controlKey: string; connection: Connection; abort: AbortController;
  context: ProjectionSignalContext; off(): void; closing?: Promise<void>;
};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid projection request');
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => {
  if (typeof value !== 'string' || !value.length || value.length > 256) throw new Error('Invalid projection binding');
  return value;
};
const exact = (value: Record<string, unknown>, keys: string[]) => {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error('Unexpected projection request field');
};

/** Registered only on the authenticated cloud responder. No App chooses executables or identity. */
export function createProjectionDeviceHost(options: ProjectionDeviceHostOptions) {
  const proofs = createProjectionConnectionProofs(options.identity);
  const pages = new Map<string, Page>(); // Tombstones prevent a delayed old bind from reviving an epoch.
  const bindings = new Map<string, Page>();
  const cancelled = new Map<string, { epoch: number; off(): void }>();
  const closing = new Set<Promise<void>>();
  const reported = new Set<unknown>();
  const feeds = new WeakMap<ProjectionSignalLease, ReturnType<typeof projectionVideoFeed>>();
  let disposed = false;
  const report = (error: unknown) => {
    if (reported.has(error)) return;
    reported.add(error); if (reported.size > 256) reported.delete(reported.values().next().value);
    try { options.report(error); }
    catch (reporter) { process.stderr.write(`Projection cleanup/report failed: ${String(error).slice(0, 1000)}; ${String(reporter).slice(0, 1000)}\n`); }
  };
  const check = (page: Page) => {
    page.abort.signal.throwIfAborted(); page.connection.assertCurrent();
    if (disposed || bindings.get(page.bindingId) !== page) throw new Error('Projection page binding is closed');
    options.assertApp(page.appId, page.version);
  };
  const signals = new ProjectionSignals({
    onError: event => report(event.error),
    authorize: async (context, source, signal) => {
      const page = bindings.get(context.epoch);
      if (!page || page.context !== context && JSON.stringify(page.context) !== JSON.stringify(context)) throw new Error('Projection page is not bound');
      check(page); signal.throwIfAborted();
      const feed = options.createFeed({ extensionId: page.appId, sessionId: page.sessionId,
        pageId: context.pageId, epoch: context.epoch, signal: page.abort.signal, assertCurrent: () => check(page) }, source, context);
      const lease: ProjectionSignalLease = { ...feed.lease, receive: (wire, cancelled) => {
        check(page);
        return feed.lease.receive(verifyProjectionControl(page.controlKey, page.bindingId, source, wire), cancelled);
      } };
      feeds.set(lease, feed); return lease;
    },
    openMedia: (lease, signal, onControl) => feeds.get(lease)!.openMedia(signal, onControl),
  });
  const close = (page: Page): Promise<void> => {
    if (page.closing) return page.closing;
    page.abort.abort(new Error('Projection remote page changed')); // Before draining or awaiting anything.
    const work = signals.closeBinding(page.context).finally(() => { bindings.delete(page.bindingId); closing.delete(work); });
    page.closing = work; closing.add(work); void work.catch(report);
    return work;
  };
  const authorize = (payload: Record<string, unknown>, ctx: DeviceRpcHandlerContext) => proofs.authorize(ctx.asker, payload.proof);
  const bound = (payload: Record<string, unknown>, ctx: DeviceRpcHandlerContext) => {
    const connection = authorize(payload, ctx), page = bindings.get(text(payload.bindingId));
    if (!page || page.connection.connectionId !== connection.connectionId) throw new Error('Projection binding belongs to another connection');
    check(page); return page;
  };
  const handle = (run: (payload: Record<string, unknown>, ctx: DeviceRpcHandlerContext) => Promise<unknown>): DeviceRpcHandler =>
    async (payload, ctx) => ({ result: await run(object(payload), ctx) });
  const handlers: DeviceRpcHandlers = {
    'projection.hello': handle(async (payload, ctx) => { exact(payload, []); return proofs.hello(ctx.asker); }),
    'projection.bind': handle(async (payload, ctx) => {
      exact(payload, ['proof', 'page']); const connection = authorize(payload, ctx), input = object(payload.page);
      exact(input, ['id', 'epoch', 'appId', 'version', 'sessionId']);
      const id = text(input.id), appId = text(input.appId), version = text(input.version), sessionId = text(input.sessionId);
      if (id.length > 128) throw new Error('Invalid projection page id');
      const epoch = input.epoch;
      if (!Number.isSafeInteger(epoch) || (epoch as number) < 1) throw new Error('Invalid projection page epoch');
      options.assertApp(appId, version); connection.assertCurrent();
      const key = JSON.stringify([connection.connectionId, id]), old = pages.get(key);
      if ((cancelled.get(key)?.epoch ?? 0) >= (epoch as number)) throw new Error('Projection page was already cancelled');
      if (old && (epoch as number) <= old.epoch) {
        check(old);
        if (epoch !== old.epoch || appId !== old.appId || sessionId !== old.sessionId || version !== old.version) throw new Error('Stale projection page epoch');
        return { bindingId: old.bindingId, controlKey: old.controlKey };
      }
      if (!old && pages.size >= 128) throw new Error('Too many projection pages');
      const bindingId = randomUUID(), abort = new AbortController();
      const page: Page = { id, epoch: epoch as number, appId, version, sessionId, bindingId,
        controlKey: projectionControlKey(), connection, abort, off() {},
        context: Object.freeze({ ownerId: connection.ownerId, deviceId: connection.deviceId, appId, sessionId,
          pageId: `remote:${connection.connectionId}:${id}`, epoch: bindingId }) };
      // Replace the epoch before cleanup; a simultaneous stale answer cannot reach the old lease.
      pages.set(key, page); bindings.set(bindingId, page);
      const detached = () => { page.off(); void close(page); if (pages.get(key) === page) pages.delete(key); };
      connection.signal.addEventListener('abort', detached, { once: true });
      page.off = () => connection.signal.removeEventListener('abort', detached);
      if (connection.signal.aborted) detached();
      try { if (old) { old.off(); await close(old); } check(page); }
      catch (error) { await close(page).catch(report); throw error; }
      return { bindingId, controlKey: page.controlKey };
    }),
    'projection.signal': handle(async (payload, ctx) => {
      exact(payload, ['proof', 'bindingId', 'command']); const page = bound(payload, ctx);
      const result = await signals.receive(page.context, payload.command as ProjectionSignalCommand);
      check(page); return result;
    }),
    'projection.unbind': handle(async (payload, ctx) => {
      exact(payload, ['proof', 'page']); const connection = authorize(payload, ctx), input = object(payload.page);
      exact(input, ['id', 'epoch']); const id = text(input.id), epoch = input.epoch;
      if (!Number.isSafeInteger(epoch) || (epoch as number) < 1) throw new Error('Invalid projection page epoch');
      const key = JSON.stringify([connection.connectionId, id]), previous = cancelled.get(key);
      if (!previous && cancelled.size >= 128) throw new Error('Too many cancelled projection pages');
      if (!previous) {
        const detached = () => { cancelled.get(key)?.off(); cancelled.delete(key); };
        const entry = { epoch: epoch as number, off: () => connection.signal.removeEventListener('abort', detached) };
        cancelled.set(key, entry); connection.signal.addEventListener('abort', detached, { once: true });
        if (connection.signal.aborted) detached();
      } else previous.epoch = Math.max(previous.epoch, epoch as number);
      const page = pages.get(key);
      if (page && page.epoch <= (epoch as number)) await close(page);
    }),
    'projection.goodbye': handle(async (payload, ctx) => {
      exact(payload, ['proof']); proofs.revoke(ctx.asker, payload.proof);
    }),
  };
  return { handlers, async dispose() {
    disposed = true; proofs.dispose();
    const results = await Promise.allSettled([...pages.values()].map(close));
    await Promise.allSettled([...closing]); pages.clear();
    for (const entry of cancelled.values()) entry.off(); cancelled.clear();
    const all = [...results, ...(await Promise.allSettled([signals.dispose()]))];
    const failure = all.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  } };
}
