/** Desktop keeps backgroundThrottling disabled; the host reports minimize/tray visibility. */
export const ANIMATION_WINDOW_SEEN_EVENT = '__window_seen'

let windowSeen = true
let listening = false
const windowListeners = new Set<() => void>()
const viewports = new Map<string, {
  observer: IntersectionObserver
  changed: Map<Element, (visible: boolean) => void>
}>()

function listen() {
  if (listening) return
  listening = true
  const sync = () => {
    // Inherited through shadow roots too. 'initial' unsets the custom property,
    // letting each surface/viewport supply its own pause state in CSS.
    document.documentElement.style.setProperty('--gugu-animation-window-paused',
      isAnimationWindowVisible() ? 'initial' : 'paused')
    for (const changed of windowListeners) changed()
  }
  document.addEventListener('visibilitychange', sync)
  window.addEventListener(ANIMATION_WINDOW_SEEN_EVENT, (event) => {
    windowSeen = (event as CustomEvent<boolean>).detail
    sync()
  })
  sync()
}

export function isAnimationWindowVisible(): boolean {
  return !document.hidden && windowSeen
}

export function subscribeAnimationWindowVisibility(changed: () => void): () => void {
  listen()
  windowListeners.add(changed)
  return () => { windowListeners.delete(changed) }
}

/** One viewport observer per margin; no ancestor observers or synchronous style/geometry reads. */
export function observeAnimationViewport(element: HTMLElement, changed: (visible: boolean) => void, rootMargin = '0px'): () => void {
  listen()
  // Preserve the existing old-WebView behavior: without IO, draw on screen.
  if (typeof IntersectionObserver === 'undefined') {
    changed(true)
    return () => {}
  }
  let viewport = viewports.get(rootMargin)
  if (!viewport) {
    const callbacks = new Map<Element, (visible: boolean) => void>()
    viewport = {
      changed: callbacks,
      observer: new IntersectionObserver((entries) => {
        for (const entry of entries) callbacks.get(entry.target)?.(entry.isIntersecting)
      }, { rootMargin }),
    }
    viewports.set(rootMargin, viewport)
  }
  viewport.changed.set(element, changed)
  viewport.observer.observe(element)
  return () => {
    viewport.changed.delete(element)
    viewport.observer.unobserve(element)
  }
}
