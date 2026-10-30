import { log } from '@main/lib/logger';
import { sessionEvents } from '../sessions/session-events';
import { projectEvents } from '../projects/project-events';
import { randomUUID } from 'node:crypto';
import { PROJECTION_NOT_SENT, PROJECTION_UNCONFIRMED, projectionInputOutcome, type ProjectionInputOutcome, type ProjectionHostPacket, type ProjectionSourceEvent } from '@shared/extensions/projection-protocol';
import { ExtensionProjections, ProjectionInputFailure } from './extension-projections';
import { ProjectionMediaAccess } from './projection-media-access';
import { projectionVideoFeed } from './projection-video-feed';
import { extensionsService } from './extensions-root';
import type { BridgeCaller } from './extension-bridge';

type Source = {
  pageId: number;
  extensionId: string;
  handle: ReturnType<ExtensionProjections['open']>;
  alive: boolean;
  hear(event: ProjectionSourceEvent): void;
  closed?: { resolve(): void; reject(reason: Error): void };
};
type PendingInput = { source: Source; resolve(outcome?: ProjectionInputOutcome): void; reject(error: Error): void };
type Viewer = { pageId: number; sessionId: string; epoch: number; receive(packet: unknown): Promise<void>; close(): void };
type SourceCommand = Omit<Extract<ProjectionSourceEvent, { type: 'input' }>, 'id' | 'requestId'>
  | Omit<Extract<ProjectionSourceEvent, { type: 'disconnect' }>, 'id' | 'requestId'>;

/** Dedicated, exact-recipient events. Pictures never use the App-wide program notification broadcaster. */
export class ExtensionProjectionBridge {
  private lifecycle = 0;
  private readonly resources: ExtensionProjections;
  private readonly mediaAccess: ProjectionMediaAccess;
  private readonly sources = new Map<string, Source>();
  private readonly inputs = new Map<string, PendingInput>();
  private readonly viewers = new Map<string, Viewer>();
  private readonly epochs = new Map<number, number>();
  private readonly watches = new Map<string, string>();

  constructor(authorize: (extensionId: string) => void, private readonly projectOf: (session: string) => Promise<string>) {
    this.resources = new ExtensionProjections(({ extensionId }) => authorize(extensionId));
    this.mediaAccess = new ProjectionMediaAccess(this.resources, pageId => this.epochs.get(pageId) ?? 0);
  }

  /** Internal host adapter; deliberately absent from the App verb dispatcher. */
  mediaResource(caller: BridgeCaller, sourceId: string) { return this.mediaAccess.open(caller, sourceId); }

  /** Trusted host encoding adapter, not an App verb or a bitmap-over-RPC route. */
  mediaFeed(caller: BridgeCaller, sourceId: string, context: Parameters<typeof projectionVideoFeed>[2],
    decode: Parameters<typeof projectionVideoFeed>[3], createMedia: Parameters<typeof projectionVideoFeed>[4]) {
    return projectionVideoFeed(this.resources, this.mediaResource(caller, sourceId), context, decode, createMedia);
  }

  count(pageId: number): number {
    return [...this.sources.values()].filter(source => source.pageId === pageId && source.alive).length;
  }

  private source(caller: BridgeCaller, id: unknown): Source {
    const source = typeof id === 'string' ? this.sources.get(id) : undefined;
    if (caller.kind !== 'program' || !source || source.pageId !== caller.pageId || source.extensionId !== caller.extensionId) {
      throw new Error('Projection is not owned by this program');
    }
    return source;
  }

  private watchKey(caller: BridgeCaller, watch: unknown): string {
    if (caller.kind !== 'page' || !caller.binding?.sessionId || typeof watch !== 'string' || !watch || watch.length > 128) {
      throw new Error('Projection viewer needs a bound task page');
    }
    return `${caller.pageId}:${watch}`;
  }

  private command(source: Source, event: SourceCommand, signal?: AbortSignal): Promise<ProjectionInputOutcome | void> {
    return new Promise<ProjectionInputOutcome | void>((resolve, reject) => {
      const requestId = randomUUID();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let finished = false;
      const finish = (error?: Error, outcome?: ProjectionInputOutcome) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.inputs.delete(requestId);
        if (error) reject(error); else resolve(outcome);
      };
      const boundCleanup = () => {
        timer ??= setTimeout(() => {
          finish(new Error('Projection input cleanup timed out'));
          void source.handle.close().catch(() => undefined);
        }, 10_000);
      };
      const abort = () => {
        boundCleanup();
        try { source.hear({ type: 'cancel', id: source.handle.id, requestId }); }
        catch { finish(new Error('Projection producer disconnected')); void source.handle.close().catch(() => undefined); }
      };
      // Only cleanup has a deadline. A healthy, long-running driver operation does not revoke its source.
      if (event.type === 'disconnect') boundCleanup();
      this.inputs.set(requestId, { source, resolve: outcome => finish(undefined, outcome), reject: finish });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { finish(new Error('Projection input cancelled')); return; }
      try { source.hear({ ...event, id: source.handle.id, requestId }); }
      catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  async call(caller: BridgeCaller, method: string, args: Record<string, unknown>): Promise<unknown> {
    if (method === 'projectionCreate') {
      if (caller.kind !== 'program' || !caller.callingSession) throw new Error('Create a projection inside a task tool call');
      if (this.count(caller.pageId) >= 16) throw new Error('Too many projections in this program');
      const epoch = this.lifecycle;
      const projectId = await this.projectOf(caller.callingSession);
      if (epoch !== this.lifecycle) throw new Error('Projection task lifecycle changed');
      if (this.count(caller.pageId) >= 16) throw new Error('Too many projections in this program');
      const hear = (event: ProjectionSourceEvent) => caller.hear({ type: 'projectionSource', event });
      const handle = this.resources.open({ extensionId: caller.extensionId, sessionId: caller.callingSession, projectId }, {
        refresh: () => hear({ type: 'refresh', id: handle.id }),
        close: () => {
          for (const [requestId, pending] of this.inputs) {
            if (pending.source === source) {
              this.inputs.delete(requestId);
              pending.reject(new Error('Projection closed'));
            }
          }
          if (!source.alive) { this.sources.delete(handle.id); return; }
          return new Promise<void>((resolve, reject) => {
            const finish = (error?: Error) => {
              clearTimeout(timer);
              this.sources.delete(handle.id);
              if (error) reject(error); else resolve();
            };
            const timer = setTimeout(() => finish(new Error('Projection cleanup timed out')), 10_000);
            source.closed = { resolve: () => finish(), reject: finish };
            try { hear({ type: 'close', id: handle.id }); }
            catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
          });
        },
        input: (input, { frame, signal, viewer }) => this.command(source,
          { type: 'input', viewer, input, frame: { sequence: frame.sequence, width: frame.width, height: frame.height } }, signal),
        disconnect: async viewer => {
          if (source.alive) await this.command(source, { type: 'disconnect', viewer });
        },
      });
      const source: Source = { pageId: caller.pageId, extensionId: caller.extensionId, handle, alive: true, hear };
      this.sources.set(handle.id, source);
      return { id: handle.id };
    }
    if (method === 'projectionPublish') return this.source(caller, args.id).handle.publish(args.frame);
    if (method === 'projectionClose') return await this.source(caller, args.id).handle.close();
    if (method === 'projectionClosed') {
      const source = this.source(caller, args.id);
      if (!source.closed) throw new Error('Projection is not closing');
      if (typeof args.error === 'string') source.closed.reject(new Error(args.error.slice(0, 1000)));
      else source.closed.resolve();
      return;
    }
    if (method === 'projectionInputResult') {
      const source = this.source(caller, args.id);
      const pending = typeof args.requestId === 'string' ? this.inputs.get(args.requestId) : undefined;
      if (!pending || pending.source !== source) throw new Error('Unknown projection input');
      if (typeof args.error === 'string') pending.reject(new Error(args.error.slice(0, 1000)));
      else pending.resolve(projectionInputOutcome(args.outcome));
      return;
    }
    const key = this.watchKey(caller, args.watchId);
    if (method === 'projectionWatch') {
      if (typeof args.id !== 'string') throw new Error('Projection id is required');
      this.viewers.get(key)?.close();
      this.viewers.delete(key);
      const prefix = `${caller.pageId}:`;
      if (!this.watches.has(key) && [...this.watches.keys()].filter(watch => watch.startsWith(prefix)).length >= 16) {
        throw new Error('Too many projection viewers');
      }
      const token = randomUUID();
      this.watches.set(key, token);
      // This binding is local. A remote viewer must enter through an authenticated direct connection, never a cloud RPC.
      const epoch = this.epochs.get(caller.pageId) ?? 0;
      const sessionId = caller.binding!.sessionId!;
      try {
        const { knownSessionMachine } = await import('./app-programs-elsewhere');
        if (epoch !== (this.epochs.get(caller.pageId) ?? 0) || caller.binding!.sessionId !== sessionId
          || this.watches.get(key) !== token) throw new Error('Projection page changed');
        if (knownSessionMachine(sessionId)?.deviceId) throw new Error('Projection needs a direct connection to that computer');
        const viewer = this.resources.connect({ extensionId: caller.extensionId, sessionId }, args.id, {
          transport: 'local',
          send: (packet: ProjectionHostPacket) => {
            if (packet.type === 'state' && packet.state === 'closed' && this.watches.get(key) === token) {
              this.viewers.delete(key); this.watches.delete(key);
            }
            caller.hear({ type: 'projection', watchId: args.watchId as string, packet });
          },
          onClose: () => () => {},
        });
        if (epoch !== (this.epochs.get(caller.pageId) ?? 0) || this.watches.get(key) !== token) { viewer.close(); throw new Error('Projection page changed'); }
        this.viewers.set(key, { pageId: caller.pageId, sessionId, epoch, ...viewer });
        return;
      } catch (error) {
        if (this.watches.get(key) === token) this.watches.delete(key);
        throw error;
      }
    }
    const viewer = this.viewers.get(key);
    if (method === 'projectionUnwatch') { viewer?.close(); this.viewers.delete(key); this.watches.delete(key); return; }
    if (method === 'projectionSend') {
      if (!viewer) throw new Error('Projection viewer is closed');
      if (viewer.sessionId !== caller.binding?.sessionId || viewer.epoch !== (this.epochs.get(caller.pageId) ?? 0)) {
        viewer.close(); this.viewers.delete(key); this.watches.delete(key);
        throw new Error('Projection page changed');
      }
      try {
        await viewer.receive(args.packet);
        return { status: 'applied' };
      } catch (error) {
        if ((args.packet as { type?: unknown })?.type !== 'input') throw error;
        if (error instanceof ProjectionInputFailure && error.outcome) return error.outcome;
        log.warn('Projection input failed', { error });
        return error instanceof ProjectionInputFailure && error.uncertain
          ? { status: 'unknown', reason: PROJECTION_UNCONFIRMED } : { status: 'rejected', reason: PROJECTION_NOT_SENT };
      }
    }
    throw new Error('Unknown projection call');
  }

  closeScope(scope: { sessionId: string } | { projectId: string }): void {
    this.lifecycle++;
    this.resources.closeScope(scope);
  }

  /** Only completion of already-closing, owned work bypasses withdrawn grants. No new work is admitted. */
  isCleanup(caller: BridgeCaller, method: string, args: Record<string, unknown>): boolean {
    let source: Source;
    try { source = this.source(caller, args.id); } catch { return false; }
    if (!source.handle.isClosing()) return false;
    return method === 'projectionClosed' ? !!source.closed : method === 'projectionInputResult'
      && typeof args.requestId === 'string' && this.inputs.get(args.requestId)?.source === source;
  }

  async closeProgram(pageId: number): Promise<void> {
    const results = await Promise.allSettled([...this.sources.values()].filter(source => source.pageId === pageId).map(source => source.handle.close()));
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  /** The actual document/child went away. Other pages of the same App keep their own resources. */
  closePage(pageId: number): void {
    this.epochs.set(pageId, (this.epochs.get(pageId) ?? 0) + 1);
    this.mediaAccess.closePage(pageId);
    for (const key of this.watches.keys()) if (key.startsWith(`${pageId}:`)) this.watches.delete(key);
    for (const [key, viewer] of this.viewers) {
      if (viewer.pageId === pageId) { viewer.close(); this.viewers.delete(key); }
    }
    for (const source of this.sources.values()) {
      if (source.pageId === pageId) {
        source.alive = false;
        for (const pending of this.inputs.values()) if (pending.source === source) pending.reject(new Error('Projection producer closed'));
        source.closed?.resolve();
        void source.handle.close().catch(() => undefined);
      }
    }
  }
}

export const extensionProjections = new ExtensionProjectionBridge((id) => {
  const service = extensionsService();
  service.get(id);
  if (!service.isEnabled(id) || !service.hasCapability(id, 'agents:tools')) throw new Error('App program access was revoked');
}, async sessionId => {
  const { projectionTaskProject } = await import('./projection-task');
  return projectionTaskProject(sessionId);
});

// These hooks run synchronously, before another input can be admitted; a round finishing is not a task ending.
sessionEvents.on('session:deleted', sessionId => extensionProjections.closeScope({ sessionId }));
sessionEvents.on('session:archived', sessionId => extensionProjections.closeScope({ sessionId }));
projectEvents.on('project:deleted', projectId => extensionProjections.closeScope({ projectId }));
