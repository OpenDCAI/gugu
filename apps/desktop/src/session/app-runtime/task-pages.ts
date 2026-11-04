import type { TaskPageEvent, TaskPageHost, TaskPagePresentation } from '@shared/extensions/task-page-protocol';
import type { TaskPageFileRef } from '@shared/extensions/task-page-files';

type Message = (method: string, params: Record<string, unknown>, sessionId?: string) => void;
type Lease = { id?: string; closed?: string; messages: Set<Message>; closures: Set<(reason: string) => void>;
  presentations: Set<(value: TaskPagePresentation | null) => void>; presentationVersion: number; presentation?: TaskPagePresentation | null };

function tellPresentation(page: Lease, value: TaskPagePresentation | null): void {
  page.presentation = value; page.presentationVersion++;
  for (const listener of page.presentations) {
    try { listener(value); } catch (error) { console.error('App page presentation listener failed', error); }
  }
}

/** One opaque host lease, with App-local protocol adaptation left to the caller. */
export function taskPagesApi(host: TaskPageHost) {
  const pages = new Map<string, Lease>();
  const finish = (watchId: string, reason: string) => {
    const page = pages.get(watchId);
    if (!page || page.closed) return;
    page.closed = reason;
    tellPresentation(page, null); page.presentations.clear();
    for (const listener of page.closures) listener(reason);
    page.closures.clear();
    page.messages.clear();
    pages.delete(watchId);
  };
  host.onTaskPage!((event: TaskPageEvent) => {
    const page = pages.get(event.watchId);
    if (!page || page.closed) return;
    if (event.type === 'closed') { finish(event.watchId, event.reason); return; }
    if (event.type === 'presentation') { tellPresentation(page, event.presentation); return; }
    for (const listener of page.messages) listener(event.method, event.params, event.sessionId);
  });
  return Object.freeze({
    async acquire(options: { url?: string } = {}) {
      const watchId = crypto.randomUUID();
      const page: Lease = { messages: new Set(), closures: new Set(), presentations: new Set(), presentationVersion: 0 };
      pages.set(watchId, page);
      try {
        const leased = await host.pages!.acquire({ watchId, ...options });
        page.id = leased.id;
        if (page.closed) throw new Error(page.closed);
        return Object.freeze({
          ...leased,
          send(method: string, params?: Record<string, unknown>, sessionId?: string) {
            if (page.closed) return Promise.reject(new Error(page.closed));
            return host.pages!.send({ id: leased.id, method, params, sessionId });
          },
          maintain(method: string, params?: Record<string, unknown>, sessionId?: string) {
            if (page.closed) return Promise.reject(new Error(page.closed));
            if (!host.pages!.maintain) return Promise.reject(new Error('This host cannot maintain a task page connection'));
            return host.pages!.maintain({ id: leased.id, method, params, sessionId });
          },
          async presentation() {
            if (page.closed) return Promise.reject(new Error(page.closed));
            if (!host.pages!.presentation) return Promise.reject(new Error('This host cannot measure a task page presentation'));
            const version = page.presentationVersion;
            const value = await host.pages!.presentation({ id: leased.id });
            if (page.closed) throw new Error(page.closed);
            // An event received while this snapshot was in flight is newer than its reply.
            return page.presentationVersion !== version ? page.presentation ?? null : value;
          },
          async filePayloads(refs: readonly TaskPageFileRef[]) {
            if (page.closed) throw new Error(page.closed);
            if (!host.pages!.filePayloads) throw new Error('This host cannot read task file payloads');
            const value = await host.pages!.filePayloads({ id: leased.id, refs });
            if (page.closed) throw new Error(page.closed);
            return value;
          },
          onPresentation(listener: (value: TaskPagePresentation | null) => void) {
            if (!page.closed) page.presentations.add(listener);
            return () => { page.presentations.delete(listener); };
          },
          onMessage(listener: Message) {
            if (!page.closed) page.messages.add(listener);
            return () => { page.messages.delete(listener); };
          },
          onClose(listener: (reason: string) => void) {
            if (page.closed) {
              let live = true; queueMicrotask(() => { if (live) listener(page.closed!); });
              return () => { live = false; };
            }
            page.closures.add(listener);
            return () => { page.closures.delete(listener); };
          },
          async close() {
            if (page.closed) return;
            try { await host.pages!.release({ id: leased.id }); }
            finally { finish(watchId, 'Released by its App'); }
          },
        });
      } catch (error) {
        finish(watchId, error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
  });
}

/** Native input stays with the real page; the App's element only supplies a clipped viewport. */
export async function mountTaskPage(host: TaskPageHost, element: HTMLElement, id: string, options: { error?(error: unknown): void } = {}) {
  let closed = false, closing: Promise<void> | undefined;
  let pending: { x: number; y: number; width: number; height: number } | undefined;
  let updating: Promise<void> | undefined;
  const lifetime = new AbortController();
  const failed = options.error ?? console.error;
  const report = () => {
    if (closed) return Promise.resolve();
    const box = element.getBoundingClientRect();
    pending = { x: box.x, y: box.y, width: box.width, height: box.height };
    updating ??= (async () => {
      while (pending && !closed) {
        const rect = pending; pending = undefined;
        await host.pages!.mount({ id, rect });
      }
    })().finally(() => { updating = undefined; });
    return updating;
  };
  const changed = () => { void report().catch(error => {
    failed(error);
    void close().catch(failed);
  }); };
  const observer = new ResizeObserver(changed);
  async function close() {
    if (closing) return closing;
    closed = true; pending = undefined; lifetime.abort(); observer.disconnect();
    // A failed layout must still be followed by the native unmount.
    closing = (async () => {
      try { await updating; } finally { await host.pages!.unmount({ id }); }
    })();
    return closing;
  }
  try { await report(); }
  catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Task page mount failed'); }
    throw error;
  }
  observer.observe(element);
  window.addEventListener('scroll', changed, { capture: true, signal: lifetime.signal });
  window.addEventListener('resize', changed, { signal: lifetime.signal });
  return Object.freeze({ close });
}
