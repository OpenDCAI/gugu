import { vi } from 'vitest'

/**
 * jsdom has no rendering step, so no IntersectionObserver. This stand-in reports what a browser would for the cases
 * the tests set up: a target intersects when it is connected, not under [hidden] / display:none / content-visibility:hidden,
 * and has a non-empty box. Like the browser it reports on observe and again whenever that answer changes.
 */
export function stubLayoutIntersection(): void {
  vi.stubGlobal('IntersectionObserver', class {
    private readonly last = new Map<Element, boolean>()
    private readonly watch = new MutationObserver(() => this.report())
    constructor(private readonly callback: IntersectionObserverCallback) {
      this.watch.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'style', 'class'] })
    }
    observe(target: Element) {
      this.last.set(target, !intersects(target))
      queueMicrotask(() => this.report())
    }
    unobserve(target: Element) { this.last.delete(target) }
    disconnect() { this.last.clear(); this.watch.disconnect() }
    private report() {
      const changed: IntersectionObserverEntry[] = []
      for (const [target, was] of this.last) {
        const now = intersects(target)
        if (now === was) continue
        this.last.set(target, now)
        changed.push({ target, isIntersecting: now, boundingClientRect: target.getBoundingClientRect() } as IntersectionObserverEntry)
      }
      if (changed.length) this.callback(changed, this as unknown as IntersectionObserver)
    }
  })
}

function intersects(target: Element): boolean {
  if (!target.isConnected || target.closest('[hidden]')) return false
  for (let node: Element | null = target; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (style.display === 'none' || style.contentVisibility === 'hidden') return false
  }
  const box = target.getBoundingClientRect()
  return box.width > 0 && box.height > 0
}
