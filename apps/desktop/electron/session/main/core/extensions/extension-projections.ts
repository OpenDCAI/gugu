import { randomUUID } from 'node:crypto';
import {
  projectionFrame, projectionViewerPacket, isProjectionRelease,
  type ProjectionFrame, type ProjectionInput, type ProjectionInputOutcome,
} from '@shared/extensions/projection-protocol';
import { openExtensionProgramAccess } from './extension-program-access';
import { ProjectionViewer, type ProjectionConnection } from './projection-viewer';

/** Supplied by the invoking tool/page's host binding, never by an App's parameters. */
export interface ProjectionPrincipal { extensionId: string; sessionId: string; projectId?: string }
export interface ProjectionSource {
  input(input: ProjectionInput, context: { frame: ProjectionFrame; signal: AbortSignal; viewer: string }): Promise<ProjectionInputOutcome | void>;
  /** Release this viewer's held keys/buttons before another viewer's next input. */
  disconnect(viewer: string): Promise<void>;
  /** Capture again for a newly connected viewer. Never resend a retained old picture. */
  refresh(): void;
  /** Tear down capture/input immediately; called once, including App-wide revocation. */
  close(): void | Promise<void>;
}

export class ProjectionInputFailure extends Error {
  constructor(message: string, readonly uncertain: boolean, readonly outcome?: ProjectionInputOutcome) { super(message); }
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
  driver: string | null;
  closing?: Promise<void>;
};
const same = (a: ProjectionPrincipal, b: ProjectionPrincipal) => a.extensionId === b.extensionId && a.sessionId === b.sessionId;

/** Generic picture/input resources. This registry neither finds native windows nor implements a driver. */
export class ExtensionProjections {
  private readonly resources = new Map<string, Resource>();

  constructor(private readonly authorize: (principal: ProjectionPrincipal) => void) {}

  open(principal: ProjectionPrincipal, source: ProjectionSource, parent?: AbortSignal): {
    id: string; publish(frame: unknown): void; close(): Promise<void>; isClosing(): boolean;
  } {
    if (!principal.extensionId || !principal.sessionId) throw new Error('Projection needs an App and a session');
    this.authorize(principal);
    // Register before capture starts: revoking while startup is pending cannot leave an unowned resource.
    const access = openExtensionProgramAccess(principal.extensionId, parent);
    const controller = new AbortController();
    const id = randomUUID();
    const resource: Resource = {
      principal: { ...principal }, source, controller, release: access.release, off: () => {},
      driver: null, sequence: 0, geometry: null, viewers: new Set(), queue: Promise.resolve(), queued: 0, disconnected: new Set(),
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
      isClosing: () => controller.signal.aborted,
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
      while (resource.disconnected.size) {
        const [generation] = resource.disconnected;
        resource.disconnected.delete(generation!);
        if (resource.driver === generation) resource.driver = null;
        try { await resource.source.disconnect(generation!); }
        catch (error) { void this.close(id, resource).catch(() => undefined); throw error; }
      }
    };
    const viewer = new ProjectionViewer(randomUUID(), resource.sequence, connection, (gone) => {
      resource.viewers.delete(gone);
      resource.disconnected.add(gone.generation);
      resource.queue = resource.queue.then(drain).catch(() => { void this.close(id, resource).catch(() => undefined); });
    });
    if (!viewer.abort.signal.aborted) {
      resource.viewers.add(viewer);
    }
    try { resource.source.refresh(); }
    catch { viewer.close('Capture failed'); throw new Error('Projection capture failed'); }
    return {
      receive: async (raw) => {
        this.authorize(principal);
        resource.controller.signal.throwIfAborted();
        const packet = projectionViewerPacket(raw);
        if (packet.type === 'ack') return viewer.ack(packet);
        if (resource.queued >= 64) {
          if (isProjectionRelease(packet.input) && packet.generation === viewer.generation) {
            // No extra queue capacity: cancel the old generation and await its
            // disconnect barrier, which releases all native keys and buttons.
            viewer.close('Projection input queue release barrier');
            await resource.queue;
            throw new ProjectionInputFailure('Projection input generation reset after release barrier', true);
          }
          throw new Error('Projection input queue is full');
        }
        const frame = viewer.admit(packet);
        const signal = AbortSignal.any([viewer.abort.signal, resource.controller.signal]);
        let started = false;
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
          if (resource.driver && resource.driver !== viewer.generation) throw new Error('Projection is controlled by another viewer');
          resource.driver = viewer.generation;
          started = true;
          const outcome = await resource.source.input(packet.input, { frame, signal, viewer: viewer.generation });
          if (outcome && outcome.status !== 'applied') throw new ProjectionInputFailure(outcome.reason, outcome.status === 'unknown', outcome);
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
        } catch (error) {
          if (error instanceof ProjectionInputFailure) throw error;
          throw new ProjectionInputFailure(error instanceof Error ? error.message : String(error), started);
        } finally { signal.removeEventListener('abort', abort); }
      },
      close: () => viewer.close('Viewer closed'),
    };
  }

  closeScope(scope: { sessionId: string } | { projectId: string }): void {
    for (const [id, resource] of this.resources) {
      if ('sessionId' in scope ? resource.principal.sessionId === scope.sessionId : resource.principal.projectId === scope.projectId) {
        void this.close(id, resource).catch(() => undefined);
      }
    }
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
    // Cancellation is immediate. Cleanup is ordered behind the in-flight callback, before the producer can exit.
    void resource.queue.then(async () => {
      for (const generation of resource.disconnected) {
        await resource.source.disconnect(generation);
        resource.disconnected.delete(generation);
      }
    }).finally(() => resource.source.close()).finally(resource.release).then(resolve, reject);
    return resource.closing;
  }
}
