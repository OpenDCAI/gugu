import { randomUUID } from 'node:crypto';
import { anySignal } from '@gugu/core/shared/anySignal';
import { appSurfaceOptionsSchema, appSurfaceUpdateSchema, type AppSurfaceOptions, type AppSurfaceUpdate, type AppSurfaceEvent } from '@shared/extensions/app-surface';
import { workspaceSession } from '@shared/extensions/app-runtime-protocol';
import type { BridgeCaller } from './extension-bridge';
import { openExtensionProgramAccess } from './extension-program-access';
import { ownProgramResource } from './program-resource-lifetime';

export interface AppSurfaceNative {
  pageId: number;
  shown(): boolean;
  reason?(): string | undefined;
  update(update: AppSurfaceUpdate): void;
  close(): void;
}
type Surface = { id: string; caller: BridgeCaller; sessionId: string; projectId?: string; options: AppSurfaceOptions;
  access: ReturnType<typeof openExtensionProgramAccess>; controller: AbortController; native?: AppSurfaceNative;
  release(): void; off(): void; closed: boolean; preparing: boolean; opening?: Promise<void> };

/** Presentation only. Creation replies before native loading; no action can depend on a shown window. */
export class ExtensionAppSurfaces {
  private readonly surfaces = new Map<string, Surface>();
  private readonly tasks = new Map<string, number>();
  private readonly deletedProjects = new Set<string>();
  constructor(private readonly authorize: (extensionId: string) => void,
    private readonly projectOf: (sessionId: string) => Promise<string>,
    private readonly create: (input: { id: string; extensionId: string; sessionId: string; options: AppSurfaceOptions;
      signal: AbortSignal; closed(reason: string): void }) => Promise<AppSurfaceNative>,
    private readonly report: (error: unknown) => void) {}

  private from(caller: BridgeCaller): string {
    if (caller.kind !== 'program' || !caller.callingSession || !caller.signal) throw new Error('A surface needs a current task program call');
    caller.signal.throwIfAborted(); this.authorize(caller.extensionId);
    return caller.callingSession;
  }
  private own(caller: BridgeCaller, id: unknown, cleanup = false): Surface {
    // Presentation leases also update from App-owned window tracking or a person's button event,
    // outside an MCP call. No new action/task authority is granted by this opaque resource.
    if (caller.kind !== 'program') throw new Error('Only the owning App program may update a surface');
    if (!cleanup) { this.authorize(caller.extensionId); caller.signal?.throwIfAborted(); }
    const surface = typeof id === 'string' ? this.surfaces.get(id) : undefined;
    if (!surface || surface.closed || surface.caller.pageId !== caller.pageId || surface.caller.extensionId !== caller.extensionId
      || caller.callingSession && surface.sessionId !== caller.callingSession) throw new Error('This surface is not owned by this task call');
    if (!cleanup) surface.access.signal.throwIfAborted(); return surface;
  }
  private emit(surface: Surface, event: AppSurfaceEvent): void {
    try { surface.caller.hear({ type: 'appSurface', event }); } catch (error) { this.report(error); }
  }
  open(caller: BridgeCaller, args: unknown): { id: string; shown: false } {
    const sessionId = this.from(caller), options = appSurfaceOptionsSchema.parse(args);
    if ([...this.surfaces.values()].filter(surface => surface.caller.pageId === caller.pageId).length >= 16) throw new Error('Too many App surfaces');
    const access = openExtensionProgramAccess(caller.extensionId), controller = new AbortController();
    const surface: Surface = { id: randomUUID(), caller, sessionId, options, access, controller, closed: false, preparing: true, release: () => {}, off: () => {} };
    const epoch = this.tasks.get(sessionId) ?? 0;
    this.surfaces.set(surface.id, surface);
    surface.release = ownProgramResource(caller.pageId, () => {
      this.close(surface, 'App program closed'); return surface.opening;
    });
    const revoked = () => this.end(surface, 'App surface access was revoked');
    access.signal.addEventListener('abort', revoked, { once: true });
    surface.off = () => access.signal.removeEventListener('abort', revoked);
    // The call authorizes creation. Normal completion must not prevent a slow display;
    // actual interruption, App withdrawal, or explicit release still cancels preparation.
    const signal = anySignal([caller.interruption, access.signal, controller.signal]);
    surface.opening = Promise.resolve().then(() => this.projectOf(sessionId)).then(async projectId => {
      signal.throwIfAborted();
      if (surface.closed || (this.tasks.get(sessionId) ?? 0) !== epoch || this.deletedProjects.has(projectId)) throw new Error('App surface task ended');
      surface.projectId = projectId;
      const native = await this.create({ id: surface.id, extensionId: caller.extensionId, sessionId, options: surface.options,
        signal, closed: reason => this.end(surface, reason) });
      if (surface.closed || signal.aborted) { native.close(); return; }
      surface.native = native;
      // Updates can arrive while the page is loading. Apply the current data, never the initial snapshot.
      this.refresh(surface, surface.options);
    }).catch(error => {
      if (!surface.closed) {
        this.emit(surface, { id: surface.id, type: 'display', shown: false, reason: 'display-unavailable' });
        this.end(surface, 'App surface could not be displayed');
      }
      this.report(error);
    }).finally(() => { surface.preparing = false; if (surface.closed) surface.release(); });
    return { id: surface.id, shown: false };
  }
  update(caller: BridgeCaller, id: unknown, args: unknown): void {
    const surface = this.own(caller, id), update = appSurfaceUpdateSchema.parse(args);
    surface.options = { ...surface.options, ...update };
    if (surface.native) this.refresh(surface, update);
  }
  private refresh(surface: Surface, update: AppSurfaceUpdate): void {
    try {
      surface.native!.update(update);
      const reason = surface.native!.reason?.();
      this.emit(surface, { id: surface.id, type: 'display', shown: surface.native!.shown(), ...(reason ? { reason } : {}) });
    } catch (error) {
      this.emit(surface, { id: surface.id, type: 'display', shown: false, reason: 'display-unavailable' }); this.report(error);
    }
  }
  release(caller: BridgeCaller, id: unknown): void { this.close(this.own(caller, id, true), 'Released by its App'); }
  post(caller: BridgeCaller, message: unknown): void {
    if (caller.kind !== 'page' || !workspaceSession(caller.binding)) throw new Error('Only an App surface page can post to its owner');
    const surface = [...this.surfaces.values()].find(one => one.native?.pageId === caller.pageId);
    if (!surface || surface.closed || surface.sessionId !== workspaceSession(caller.binding) || surface.caller.extensionId !== caller.extensionId) throw new Error('This App surface is closed');
    if (surface.options.decorative) throw new Error('A decorative surface cannot post input to its App');
    this.authorize(caller.extensionId); surface.access.signal.throwIfAborted();
    this.emit(surface, { id: surface.id, type: 'message', message });
  }
  private close(surface: Surface, reason: string): void {
    if (surface.closed) return;
    surface.closed = true; this.surfaces.delete(surface.id);
    surface.controller.abort(new Error(reason)); surface.off(); if (!surface.preparing) surface.release();
    try { surface.native?.close(); }
    finally { surface.access.release(); this.emit(surface, { id: surface.id, type: 'closed', reason }); }
  }
  private end(surface: Surface, reason: string): void { try { this.close(surface, reason); } catch (error) { this.report(error); } }
  closeScope(scope: { sessionId: string } | { projectId: string }): void {
    if ('sessionId' in scope) this.tasks.set(scope.sessionId, (this.tasks.get(scope.sessionId) ?? 0) + 1);
    else this.deletedProjects.add(scope.projectId);
    for (const surface of this.surfaces.values()) if ('sessionId' in scope ? surface.sessionId === scope.sessionId : surface.projectId === scope.projectId) this.end(surface, 'App surface task ended');
  }
}
