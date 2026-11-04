import { randomUUID } from 'node:crypto';
import { anySignal } from '@gugu/core/shared/anySignal';
import type { TaskPageEvent, TaskPagePresentation } from '@shared/extensions/task-page-protocol';
import type { PageProtocol } from '../browser/page-protocol';
import { isSupportedBrowserNavigationUrl } from '../browser/browser-navigation';
import { openExtensionProgramAccess } from './extension-program-access';
import type { BridgeCaller } from './extension-bridge';
import { ownProgramResource } from './program-resource-lifetime';
import { workspaceSession } from '@shared/extensions/app-runtime-protocol';
import { ownAppPageResource } from './app-page-resources';
import { pageProtocolMaintenance } from '../browser/page-protocol-maintenance';
import type { TaskPageFilePayload } from '@shared/extensions/task-page-files';

export type TaskPageRect = { x: number; y: number; width: number; height: number };

export interface TaskPageNative {
  projectId: string;
  title: string;
  url: string;
  protocol: PageProtocol;
  setActive(active: boolean): void;
  release(): void;
  cleanup?(): Promise<void>;
  presentation?(): TaskPagePresentation | null;
  onPresentation?(listener: (value: TaskPagePresentation | null) => void): () => void;
  mount?(caller: BridgeCaller, rect: TaskPageRect): { layout(rect: TaskPageRect): void; close(): void };
}
type RecordOfPage = {
  id: string; owner: number; extensionId: string; sessionId: string; watchId: string;
  native: TaskPageNative; closed: boolean; active: number;
  access: ReturnType<typeof openExtensionProgramAccess>;
  hear(event: TaskPageEvent): void;
  listen(): void;
  off(): void;
  unmount?(): void;
  closing?: Promise<void>;
};

/** App-owned, task-scoped raw page leases. No browser tools or driver policy here. */
export class ExtensionTaskPages {
  private readonly pages = new Map<string, RecordOfPage>();
  private readonly owners = new Map<number, { live: boolean; controller: AbortController; pending: Set<Promise<void>>; release(): void }>();
  private readonly taskEpochs = new Map<string, number>();
  private readonly deletedProjects = new Set<string>();
  private readonly mounted = new Map<number, { id: string; layout(rect: TaskPageRect): void; close(): void }>();
  private readonly closing = new Map<number, Set<Promise<void>>>();

  constructor(private readonly authorize: (extensionId: string) => void,
    private readonly select: (input: { sessionId: string; url?: string; signal: AbortSignal; lifetime: AbortSignal }) => Promise<TaskPageNative>,
    private readonly report: (error: unknown) => void = console.error,
    private readonly files?: (caller: BridgeCaller, refs: unknown, signal: AbortSignal) => Promise<TaskPageFilePayload[]>) {}

  private caller(caller: BridgeCaller): { sessionId: string; signal: AbortSignal } {
    if (caller.kind !== 'program' || !caller.callingSession || !caller.signal) {
      throw new Error('A task page needs a current task program call');
    }
    caller.signal.throwIfAborted();
    this.authorize(caller.extensionId);
    return { sessionId: caller.callingSession, signal: caller.signal };
  }

  private own(caller: BridgeCaller, id: unknown): RecordOfPage {
    this.caller(caller);
    return this.resource(caller, id);
  }

  private resource(caller: BridgeCaller, id: unknown): RecordOfPage {
    if (caller.kind !== 'program') throw new Error('Only the owning App program may maintain a page');
    caller.signal?.throwIfAborted();
    this.authorize(caller.extensionId);
    const page = typeof id === 'string' ? this.pages.get(id) : undefined;
    if (!page || page.closed || page.owner !== caller.pageId || page.extensionId !== caller.extensionId
      || caller.callingSession && page.sessionId !== caller.callingSession) throw new Error('This task page is not owned by this call');
    page.access.signal.throwIfAborted();
    return page;
  }

  private releaseIdleOwner(pageId: number): void {
    const owner = this.owners.get(pageId);
    if (owner && !owner.pending.size && !this.closing.get(pageId)?.size && ![...this.pages.values()].some(page => page.owner === pageId)) {
      owner.release(); this.owners.delete(pageId);
    }
  }

  async acquire(caller: BridgeCaller, args: Record<string, unknown>) {
    const from = this.caller(caller);
    if (typeof args.watchId !== 'string' || !args.watchId || args.watchId.length > 128
      || args.url !== undefined && (typeof args.url !== 'string' || !isSupportedBrowserNavigationUrl(args.url))) {
      throw new Error('Invalid task page request');
    }
    let owner = this.owners.get(caller.pageId);
    if (!owner) {
      owner = { live: true, controller: new AbortController(), pending: new Set(), release: () => {} };
      owner.release = ownProgramResource(caller.pageId, () => this.closeProgram(caller.pageId));
      this.owners.set(caller.pageId, owner);
    }
    if (owner.pending.size + [...this.pages.values()].filter(page => page.owner === caller.pageId).length >= 16) {
      throw new Error('Too many task page leases in this program');
    }
    const pending = Promise.withResolvers<void>();
    owner.pending.add(pending.promise);
    void pending.promise.catch(this.report);
    let cleanupFailure: unknown;
    const epoch = this.taskEpochs.get(from.sessionId) ?? 0;
    // A returned connection is the App/task's resource, not the acquiring call's.
    // Individual acquisition/commands still take that call's signal; stopping the
    // task revokes this independent resource scope without cancelling concurrent B when only A ends.
    const access = openExtensionProgramAccess(caller.extensionId, undefined, from.sessionId);
    const signal = anySignal([from.signal, access.signal, owner.controller.signal]);
    let native: TaskPageNative | undefined;
    let admitted: RecordOfPage | undefined;
    try {
      signal.throwIfAborted();
      native = await this.select({ sessionId: from.sessionId, ...(args.url === undefined ? {} : { url: args.url as string }), signal, lifetime: access.signal });
      signal.throwIfAborted();
      if (!owner.live || epoch !== (this.taskEpochs.get(from.sessionId) ?? 0) || this.deletedProjects.has(native.projectId)) {
        throw new Error('The task page owner changed while acquiring the page');
      }
      const page: RecordOfPage = {
        id: randomUUID(), owner: caller.pageId, extensionId: caller.extensionId, sessionId: from.sessionId,
        watchId: args.watchId, native, access, closed: false, active: 0,
        hear: event => caller.hear({ type: 'taskPage', event }), off: () => {}, listen: () => {},
      };
      admitted = page;
      const stop = () => this.endFromNative(page, 'App page access was revoked');
      let offMessage = () => {};
      let offClose = () => {}, offPresentation = () => {};
      page.off = () => { offMessage(); offClose(); offPresentation(); access.signal.removeEventListener('abort', stop); };
      let listening = false;
      page.listen = () => {
        if (listening) return;
        listening = true;
        offMessage = page.native.protocol.onMessage((method, params, sessionId) => {
          if (!page.closed) page.hear({ watchId: page.watchId, type: 'message', method, params,
            ...(sessionId === undefined ? {} : { sessionId }) });
        });
      };
      offClose = native.protocol.onClose(reason => this.endFromNative(page, reason));
      if (page.closed) { page.off(); throw new Error('Task page closed during acquisition'); }
      const showPresentation = (presentation: TaskPagePresentation | null) => {
        if (page.closed || page.access.signal.aborted) return;
        try { page.hear({ watchId: page.watchId, type: 'presentation', presentation }); }
        catch (error) { this.report(error); }
      };
      try { offPresentation = native.onPresentation?.(showPresentation) ?? (() => {}); }
      catch (error) { this.report(error); showPresentation(null); }
      access.signal.addEventListener('abort', stop, { once: true });
      if (page.closed) { page.off(); throw new Error('Task page closed during acquisition'); }
      this.pages.set(page.id, page);
      signal.throwIfAborted();
      return { id: page.id, title: native.title, url: native.url };
    } catch (error) {
      // The call may have ended while the page was being restored. Release that
      // late result, without closing the person's page or retaining its debugger.
      if (admitted) {
        try { await this.close(admitted, 'Task page acquisition cancelled'); }
        catch (cleanup) { cleanupFailure = cleanup; throw new AggregateError([error, cleanup], 'Task page acquisition and cleanup failed'); }
      }
      else {
        const failures: unknown[] = [];
        for (const finish of [() => native?.protocol.close('Task page acquisition cancelled'), () => native?.release(), () => access.release()]) {
          try { finish(); } catch (cleanup) { failures.push(cleanup); }
        }
        if (failures.length) {
          cleanupFailure = new AggregateError(failures, 'Late task page cleanup failed');
          throw new AggregateError([error, cleanupFailure], 'Task page acquisition and cleanup failed');
        }
      }
      throw error;
    } finally {
      owner.pending.delete(pending.promise);
      if (cleanupFailure === undefined) pending.resolve(); else pending.reject(cleanupFailure);
      this.releaseIdleOwner(caller.pageId);
    }
  }

  async send(caller: BridgeCaller, args: Record<string, unknown>): Promise<unknown> {
    const page = this.own(caller, args.id);
    if (typeof args.method !== 'string' || !args.method || args.method.length > 128
      || args.params !== undefined && (!args.params || typeof args.params !== 'object' || Array.isArray(args.params))
      || args.sessionId !== undefined && typeof args.sessionId !== 'string') throw new Error('Invalid task page command');
    // The raw internal protocol also serves trusted host code. Lending a page to
    // a tools App does not lend native local-file authority with it.
    if (args.method === 'DOM.setFileInputFiles') throw new Error('Task page tools cannot attach local files');
    page.active++;
    try {
      page.listen();
      page.native.setActive(true);
      return await page.native.protocol.send(args.method, args.params as Record<string, unknown> | undefined,
        args.sessionId as string | undefined, caller.signal);
    } finally {
      page.active--;
      if (!page.closed && page.active === 0) page.native.setActive(false);
    }
  }

  async maintain(caller: BridgeCaller, args: Record<string, unknown>): Promise<unknown> {
    const page = this.resource(caller, args.id);
    if (typeof args.method !== 'string' || !args.method || args.method.length > 128
      || args.params !== undefined && (!args.params || typeof args.params !== 'object' || Array.isArray(args.params))
      || args.sessionId !== undefined && typeof args.sessionId !== 'string') throw new Error('Invalid task page maintenance');
    if (!pageProtocolMaintenance(args.method, args.params as Record<string, unknown> | undefined ?? {})) {
      throw new Error('This command is not connection maintenance');
    }
    if (!page.native.protocol.maintain) throw new Error('This host cannot maintain a task page connection');
    page.listen();
    return page.native.protocol.maintain(args.method, args.params as Record<string, unknown> | undefined,
      args.sessionId as string | undefined, page.access.signal);
  }

  presentation(caller: BridgeCaller, args: Record<string, unknown>): TaskPagePresentation | null {
    if (Object.keys(args).length !== 1 || !Object.hasOwn(args, 'id')) throw new Error('A presentation query takes only its page lease');
    const page = this.resource(caller, args.id);
    if (!page.native.presentation) throw new Error('This host cannot measure a task page presentation');
    return page.native.presentation();
  }

  async filePayloads(caller: BridgeCaller, args: Record<string, unknown>): Promise<TaskPageFilePayload[]> {
    const page = this.own(caller, args.id);
    if (Object.keys(args).length !== 2 || !Object.hasOwn(args, 'id') || !Object.hasOwn(args, 'refs')) throw new Error('File payloads take only a page lease and file cards');
    if (!this.files) throw new Error('This host cannot read task file payloads');
    const signal = anySignal([caller.signal, page.access.signal]);
    signal.throwIfAborted();
    const payloads = await this.files(caller, args.refs, signal);
    signal.throwIfAborted(); this.own(caller, args.id);
    return payloads;
  }

  release(caller: BridgeCaller, id: unknown): Promise<void> {
    const page = typeof id === 'string' ? this.pages.get(id) : undefined;
    // Cleanup grants no new input. It must remain available after this call was cancelled or completed.
    if (caller.kind !== 'program' || !page || page.owner !== caller.pageId || page.extensionId !== caller.extensionId
      || caller.callingSession && caller.callingSession !== page.sessionId) throw new Error('This task page is not owned by this program');
    return this.close(page, 'Released by its App');
  }

  mount(caller: BridgeCaller, args: Record<string, unknown>): void {
    if (caller.kind !== 'page' || !workspaceSession(caller.binding)) throw new Error('A task page mount needs a bound App page');
    this.authorize(caller.extensionId);
    const page = typeof args.id === 'string' ? this.pages.get(args.id) : undefined;
    if (!page || page.closed || page.extensionId !== caller.extensionId || page.sessionId !== workspaceSession(caller.binding)) throw new Error('This page is not in the App task');
    page.access.signal.throwIfAborted();
    const rect = args.rect as TaskPageRect | undefined;
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width < 0 || rect.height < 0) throw new Error('Invalid task page rectangle');
    const current = this.mounted.get(caller.pageId);
    if (current?.id === page.id) { current.layout(rect); return; }
    current?.close(); page.unmount?.();
    if (!page.native.mount) throw new Error('This host cannot mount a native task page');
    const native = page.native.mount(caller, rect);
    let box = rect, closed = false, off = () => {};
    const handle = { id: page.id, layout: (next: TaskPageRect) => { box = next; native.layout(next); }, close: () => {
      if (closed) return; closed = true; off();
      if (this.mounted.get(caller.pageId) === handle) this.mounted.delete(caller.pageId);
      if (page.unmount === handle.close) delete page.unmount;
      native.close();
    } };
    this.mounted.set(caller.pageId, handle); page.unmount = handle.close;
    off = ownAppPageResource(caller.pageId, { close: handle.close, layout: () => {
      try { native.layout(box); } catch (error) { handle.close(); this.report(error); }
    } });
  }

  unmount(caller: BridgeCaller, id: unknown): void {
    if (caller.kind !== 'page') throw new Error('Only the mounted App page may unmount');
    const mounted = this.mounted.get(caller.pageId);
    if (mounted?.id === id) mounted.close();
  }

  private close(page: RecordOfPage, reason: string): Promise<void> {
    if (page.closed) return page.closing ?? Promise.resolve();
    page.closed = true;
    this.pages.delete(page.id);
    const failures: unknown[] = [];
    for (const work of [() => page.unmount?.(), () => page.off()]) {
      try { work(); } catch (error) { failures.push(error); }
    }
    const work = (async () => {
      try { if (page.native.cleanup) await page.native.cleanup(); } catch (error) { failures.push(error); }
      for (const finish of [() => page.native.protocol.close(reason), () => page.native.release(), () => page.access.release(),
        () => page.hear({ watchId: page.watchId, type: 'closed', reason })]) {
        try { finish(); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, 'Task page cleanup failed');
    })();
    page.closing = work;
    const batch = this.closing.get(page.owner) ?? new Set<Promise<void>>(); batch.add(work); this.closing.set(page.owner, batch);
    const done = () => { batch.delete(work); if (!batch.size && this.closing.get(page.owner) === batch) this.closing.delete(page.owner); this.releaseIdleOwner(page.owner); };
    void work.then(done, done);
    return work;
  }

  private endFromNative(page: RecordOfPage, reason: string): void {
    void this.close(page, reason).catch(this.report);
  }

  async closeProgram(pageId: number): Promise<void> {
    const owner = this.owners.get(pageId);
    if (owner) { owner.live = false; owner.controller.abort(new Error('App program closed')); }
    owner?.release();
    this.owners.delete(pageId);
    const cleanup = new Set(this.closing.get(pageId));
    for (const page of [...this.pages.values()]) if (page.owner === pageId) {
      cleanup.add(this.close(page, 'App program closed'));
    }
    // A native restoration that ignores cancellation must still release its late result before shutdown completes.
    const acquisitions = await Promise.allSettled(owner?.pending ?? []);
    for (const pending of this.closing.get(pageId) ?? []) cleanup.add(pending);
    const results = await Promise.allSettled(cleanup);
    const failures = [...acquisitions, ...results].flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'Task pages did not close cleanly');
  }

  closeScope(scope: { sessionId: string } | { projectId: string }): void {
    if ('sessionId' in scope) this.taskEpochs.set(scope.sessionId, (this.taskEpochs.get(scope.sessionId) ?? 0) + 1);
    else this.deletedProjects.add(scope.projectId);
    for (const page of [...this.pages.values()]) {
      if ('sessionId' in scope ? page.sessionId === scope.sessionId : page.native.projectId === scope.projectId) this.endFromNative(page, 'Task page ended');
    }
  }
}
