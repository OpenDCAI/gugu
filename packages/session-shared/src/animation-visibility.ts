/** Desktop keeps backgroundThrottling disabled; the host reports minimize/tray visibility. */
export const ANIMATION_WINDOW_SEEN_EVENT = '__window_seen'

type Viewport = {
  observer: IntersectionObserver | null
  changed: Map<Element, (visible?: boolean) => void>
}

type WindowVisibility = {
  seen: boolean
  listeners: Set<() => void>
  viewports: Map<string, Viewport>
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
    for (const viewport of state.viewports.values())
      for (const changed of viewport.changed.values()) changed()
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
  const state = listen(doc)
  return !doc.hidden && state.seen
}

export function subscribeAnimationWindowVisibility(changed: () => void, doc: Document = document): () => void {
  const state = listen(doc)
  state.listeners.add(changed)
  return () => { state.listeners.delete(changed) }
}

/** One observer per owning document/margin; one callback combines window and viewport visibility. */
export function observeAnimationViewport(element: HTMLElement, changed: (visible: boolean) => void, rootMargin = '0px'): () => void {
  const doc = element.ownerDocument
  const state = listen(doc)
  const Observer = doc.defaultView?.IntersectionObserver
  let viewport = state.viewports.get(rootMargin)
  if (!viewport) {
    const callbacks = new Map<Element, (visible?: boolean) => void>()
    viewport = {
      changed: callbacks,
      observer: Observer ? new Observer((entries) => {
        for (const entry of entries) callbacks.get(entry.target)?.(entry.isIntersecting)
      }, { rootMargin }) : null,
    }
    state.viewports.set(rootMargin, viewport)
  }
  // Without IO, preserve the existing on-screen assumption, while still honoring window hide.
  let inViewport = !Observer
  const update = (visible = inViewport) => {
    inViewport = visible
    changed(visible && isAnimationWindowVisible(doc))
  }
  viewport.changed.set(element, update)
  viewport.observer?.observe(element)
  if (!viewport.observer) update()
  return () => {
    viewport.changed.delete(element)
    viewport.observer?.unobserve(element)
  }
}
