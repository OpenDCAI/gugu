/**
 * A ResizeObserver that, like a browser, delivers each observed target's first notification after the commit (here: a
 * microtask, which `act` flushes). The setup's no-op observer never calls back, so code that measures only in the
 * observer callback (the running strip) never fits under it.
 */
export class InitialResizeObserver {
  private live = true
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(): void { queueMicrotask(() => { if (this.live) this.callback([], this as unknown as ResizeObserver) }) }
  unobserve(): void {}
  disconnect(): void { this.live = false }
}
