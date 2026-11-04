import type { AppSurfaceEvent, AppSurfaceHost, AppSurfaceUpdate } from '@shared/extensions/app-surface';

/** App content and buttons are opaque to the host. Display status is never permission to act. */
export function appSurfacesApi(host: AppSurfaceHost, program: boolean) {
  if (!program) return Object.freeze({ post: (message: unknown) => host.surfaces!.post({ message }) });
  const listeners = new Map<string, { callbacks: Set<(event: AppSurfaceEvent) => void>; closed?: AppSurfaceEvent }>();
  const early = new Map<string, AppSurfaceEvent[]>();
  let opening = 0;
  host.onSurface!(event => {
    const entry = listeners.get(event.id);
    if (entry) {
      if (event.type === 'closed') { entry.closed = event; listeners.delete(event.id); }
      for (const callback of entry.callbacks) callback(event);
    }
    else if (opening) {
      const events = early.get(event.id) ?? []; events.push(event);
      if (events.length > 16) events.shift(); early.set(event.id, events);
    }
  });
  return Object.freeze({
    screen: (options: Parameters<NonNullable<AppSurfaceHost['surfaces']>['screen']>[0]) => host.surfaces!.screen(options),
    async open(options: Parameters<NonNullable<AppSurfaceHost['surfaces']>['open']>[0]) {
      opening++;
      try {
        const result = await host.surfaces!.open(options);
        const callbacks = new Set<(event: AppSurfaceEvent) => void>();
        const held = early.get(result.id) ?? []; early.delete(result.id);
        const entry = { callbacks, closed: held.find(event => event.type === 'closed') };
        listeners.set(result.id, entry);
        return Object.freeze({ ...result,
          update(update: AppSurfaceUpdate) {
            if (entry.closed) return Promise.reject(new Error('App surface closed'));
            return host.surfaces!.update({ id: result.id, update });
          },
          onEvent(callback: (event: AppSurfaceEvent) => void) {
            callbacks.add(callback);
            // Subscribe before displaying anything; preserve early failure and actual shown status.
            const events = held.splice(0);
            if (!events.length && entry.closed) events.push(entry.closed);
            queueMicrotask(() => { if (callbacks.has(callback)) for (const event of events) callback(event); });
            return () => { callbacks.delete(callback); if (!callbacks.size && entry.closed) listeners.delete(result.id); };
          },
          async close() {
            if (!entry.closed) await host.surfaces!.close({ id: result.id });
            listeners.delete(result.id); callbacks.clear();
          },
        });
      } finally { if (--opening === 0) early.clear(); }
    },
  });
}
