import { randomUUID } from 'node:crypto';
import {
  projectionFrame, projectionViewerPacket,
  type ProjectionFrame, type ProjectionInput,
} from '@shared/extensions/projection-protocol';
import { openExtensionProgramAccess } from './extension-program-access';
import { ProjectionViewer, type ProjectionConnection } from './projection-viewer';

/** Supplied by the invoking tool/page's host binding, never by an App's parameters. */
export interface ProjectionPrincipal { extensionId: string; sessionId: string }
export interface ProjectionSource {
  /** Local Browser pages already receive native input; forwarding it would type twice. */
  localInput: 'native' | 'forwarded';
  input(input: ProjectionInput, context: { frame: ProjectionFrame; signal: AbortSignal; viewer: string }): Promise<void>;
  /** Release this viewer's held keys/buttons before another viewer's next input. */
  disconnect(viewer: string): Promise<void>;
  /** Capture again for a newly connected viewer. Never resend a retained old picture. */
  refresh(): void;
  /** Tear down capture/input immediately; called once, including App-wide revocation. */
  close(): void | Promise<void>;
}

type Resource = {
  principal: ProjectionPrincipal;
  source: ProjectionSource;
  controller: AbortController;
  release(): void;
  off(): void;
  sequence: number;
  geometry: { width: number; height: number } | null;
  viewers: Set<ProjectionViewer>;
  queue: Promise<void>;
  queued: number;
  disconnected: Set<string>;
  closing?: Promise<void>;
};
const same = (a: ProjectionPrincipal, b: ProjectionPrincipal) => a.extensionId === b.extensionId && a.sessionId === b.sessionId;

/** Generic picture/input resources. This registry neither finds native windows nor implements a driver. */
export class ExtensionProjections {
  private readonly resources = new Map<string, Resource>();

  constructor(private readonly authorize: (principal: ProjectionPrincipal) => void) {}

  open(principal: ProjectionPrincipal, source: ProjectionSource, parent?: AbortSignal): {
    id: string; publish(frame: unknown): void; close(): Promise<void>;
  } {
    if (!principal.extensionId || !principal.sessionId) throw new Error('Projection needs an App and a session');
    this.authorize(principal);
    // Register before capture starts: revoking while startup is pending cannot leave an unowned resource.
    const access = openExtensionProgramAccess(principal.extensionId, parent);
    const controller = new AbortController();
    const id = randomUUID();
    const resource: Resource = {
      principal: { ...principal }, source, controller, release: access.release, off: () => {},
      sequence: 0, geometry: null, viewers: new Set(), queue: Promise.resolve(), queued: 0, disconnected: new Set(),
    };
    const abort = () => { void this.close(id, resource).catch(() => undefined); };
    access.signal.addEventListener('abort', abort, { once: true });
    resource.off = () => access.signal.removeEventListener('abort', abort);
    this.resources.set(id, resource);
    if (access.signal.aborted) {
      abort();
      access.signal.throwIfAborted();
    }
    return {
      id,
      publish: (raw) => {
        this.authorize(resource.principal);
        resource.controller.signal.throwIfAborted();
        const frame = projectionFrame(raw);
        if (frame.sequence <= resource.sequence) throw new Error('Projection frame sequence must increase');
        resource.sequence = frame.sequence;
        resource.geometry = { width: frame.width, height: frame.height };
        for (const viewer of resource.viewers) viewer.publish(frame);
      },
      close: () => this.close(id, resource),
    };
  }

  connect(principal: ProjectionPrincipal, id: string, connection: ProjectionConnection): {
    receive(packet: unknown): Promise<void>; close(): void;
  } {
    this.authorize(principal);
    principal = { ...principal };
    if (connection.transport !== 'local') throw new Error('Bitmap preview is local only; remote projection needs the media transport');
    const resource = this.resources.get(id);
    if (!resource || !same(principal, resource.principal)) throw new Error('Projection is not in this App session');
    resource.controller.signal.throwIfAborted();
    const drain = async () => {
      while (resource.disconnected.size && !resource.controller.signal.aborted) {
        const [generation] = resource.disconnected;
        resource.disconnected.delete(generation!);
        try { await resource.source.disconnect(generation!); }
        catch (error) { void this.close(id, resource).catch(() => undefined); throw error; }
      }
    };
    const viewer = new ProjectionViewer(randomUUID(), resource.sequence, connection, (gone) => {
      resource.viewers.delete(gone);
      if (resource.controller.signal.aborted) return;
      resource.disconnected.add(gone.generation);
      resource.queue = resource.queue.then(drain).catch(() => { void this.close(id, resource).catch(() => undefined); });
    });
    if (!viewer.abort.signal.aborted) resource.viewers.add(viewer);
    try { resource.source.refresh(); }
    catch { viewer.close('Capture failed'); throw new Error('Projection capture failed'); }
    return {
      receive: async (raw) => {
        this.authorize(principal);
        resource.controller.signal.throwIfAborted();
        const packet = projectionViewerPacket(raw);
        if (packet.type === 'ack') return viewer.ack(packet);
        if (connection.transport === 'local' && resource.source.localInput === 'native') throw new Error('This page receives native input');
        if (resource.queued >= 64) throw new Error('Projection input queue is full');
        const frame = viewer.admit(packet);
        const signal = AbortSignal.any([viewer.abort.signal, resource.controller.signal]);
        resource.queued += 1;
        const task = resource.queue.then(async () => {
          signal.throwIfAborted();
          await drain();
          signal.throwIfAborted();
          this.authorize(principal);
          if ((packet.input.kind === 'pointer' || packet.input.kind === 'wheel')
            && (frame.width !== resource.geometry?.width || frame.height !== resource.geometry.height)) {
            throw new Error('Projection geometry changed');
          }
          await resource.source.input(packet.input, { frame, signal, viewer: viewer.generation });
          signal.throwIfAborted();
        }).finally(() => { resource.queued -= 1; });
        // One source's native input is ordered; a different source is never held behind it.
        resource.queue = task.catch(() => undefined);
        let abort!: () => void;
        try {
          return await Promise.race([task, new Promise<never>((_resolve, reject) => {
            abort = () => reject(signal.reason);
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
          })]);
        } finally { signal.removeEventListener('abort', abort); }
      },
      close: () => viewer.close('Viewer closed'),
    };
  }

  private close(id: string, resource: Resource | undefined = this.resources.get(id)): Promise<void> {
    if (!resource) return Promise.resolve();
    if (resource.closing) return resource.closing;
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    resource.closing = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    this.resources.delete(id);
    resource.off();
    resource.controller.abort(new Error('Projection closed'));
    for (const viewer of resource.viewers) viewer.close('Projection closed');
    // close() runs synchronously up to its first await; drivers can stop in-flight OS work now.
    let stopped: Promise<void>;
    try { stopped = Promise.resolve(resource.source.close()); }
    catch (error) { stopped = Promise.reject(error); }
    void Promise.allSettled([stopped, resource.queue]).then((results) => {
      resource.release();
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') reject(failure.reason);
      else resolve();
    });
    return resource.closing;
  }
}
