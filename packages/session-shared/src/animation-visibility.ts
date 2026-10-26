/** Desktop keeps backgroundThrottling disabled; the host reports minimize/tray visibility. */
export const ANIMATION_WINDOW_SEEN_EVENT = '__window_seen'

type WindowVisibility = {
  seen: boolean
  listeners: Set<() => void>
  viewports: Map<string, {
    observer: IntersectionObserver
    changed: Map<Element, (visible: boolean) => void>
  }>
}

// Retained surfaces and blocks moved to their own window use the document that owns them.
const windows = new WeakMap<Document, WindowVisibility>()

function listen(doc: Document): WindowVisibility {
  const existing = windows.get(doc)
  if (existing) return existing
  const state: WindowVisibility = { seen: true, listeners: new Set(), viewports: new Map() }
  windows.set(doc, state)
  const sync = () => {
    // 'initial' lets each retained surface/viewport supply its own pause state.
    doc.documentElement.style.setProperty('--gugu-animation-window-paused',
      isAnimationWindowVisible(doc) ? 'initial' : 'paused')
    for (const changed of state.listeners) changed()
  }
  doc.addEventListener('visibilitychange', sync)
  doc.defaultView?.addEventListener(ANIMATION_WINDOW_SEEN_EVENT, (event) => {
    state.seen = (event as CustomEvent<boolean>).detail
    sync()
  })
  sync()
  return state
}

export function isAnimationWindowVisible(doc: Document = document): boolean {
  return !doc.hidden && (windows.get(doc)?.seen ?? true)
}

export function subscribeAnimationWindowVisibility(changed: () => void, doc: Document = document): () => void {
  const state = listen(doc)
  state.listeners.add(changed)
  return () => { state.listeners.delete(changed) }
}

/** One viewport observer per document and margin; no ancestor observers or synchronous geometry reads. */
export function observeAnimationViewport(element: HTMLElement, changed: (visible: boolean) => void, rootMargin = '0px'): () => void {
  const doc = element.ownerDocument
  const state = listen(doc)
  const Observer = doc.defaultView?.IntersectionObserver
  // Preserve the existing old-WebView behavior: without IO, draw on screen.
  if (!Observer) {
    changed(true)
    return () => {}
  }
  let viewport = state.viewports.get(rootMargin)
  if (!viewport) {
    const callbacks = new Map<Element, (visible: boolean) => void>()
    viewport = {
      changed: callbacks,
      observer: new Observer((entries) => {
        for (const entry of entries) callbacks.get(entry.target)?.(entry.isIntersecting)
      }, { rootMargin }),
    }
    state.viewports.set(rootMargin, viewport)
  }
  viewport.changed.set(element, changed)
  viewport.observer.observe(element)
  return () => {
    viewport.changed.delete(element)
    viewport.observer.unobserve(element)
  }
}
