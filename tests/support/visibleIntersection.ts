import { vi } from 'vitest'

/** Composer tests declare a visible host; geometry and occlusion have separate browser contracts. */
export function stubVisibleIntersection(): void {
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private readonly callback: IntersectionObserverCallback) {}
    observe(target: Element) {
      this.callback([{ target, isIntersecting: true, intersectionRect: { width: 1, height: 1 } } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
    }
    disconnect() {}
    unobserve() {}
  })
}
