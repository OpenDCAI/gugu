/** Desktop keeps backgroundThrottling disabled; the host reports minimize/tray visibility. */
export const ANIMATION_WINDOW_SEEN_EVENT = '__window_seen'

type Viewport = {
  observer: IntersectionObserver | null
  changed: Map<Element, (visible?: boolean) => void>
}
const viewports = new WeakMap<Document, Map<string, Viewport>>()

function listen(doc: Document) {
  const existing = viewports.get(doc)
  if (existing) return existing
  const margins = new Map<string, Viewport>()
  viewports.set(doc, margins)
  let windowSeen = true
  const sync = () => {
    // 'initial' lets each surface/viewport supply its own inherited pause state.
    doc.documentElement.style.setProperty('--gugu-animation-window-paused',
      !doc.hidden && windowSeen ? 'initial' : 'paused')
    for (const viewport of margins.values())
      for (const changed of viewport.changed.values()) changed()
  }
  doc.addEventListener('visibilitychange', sync)
  doc.defaultView?.addEventListener(ANIMATION_WINDOW_SEEN_EVENT, (event) => {
    windowSeen = (event as CustomEvent<boolean>).detail
    sync()
  })
  sync()
  return margins
}

export function isAnimationWindowVisible(doc = document): boolean {
  listen(doc)
  return !doc.hidden && doc.documentElement.style.getPropertyValue('--gugu-animation-window-paused') !== 'paused'
}

/** One observer per owning document/margin; one callback combines window and viewport visibility. */
export function observeAnimationViewport(element: HTMLElement, changed: (visible: boolean) => void, rootMargin = '0px'): () => void {
  const doc = element.ownerDocument
  const margins = listen(doc)
  const Observer = doc.defaultView?.IntersectionObserver
  let viewport = margins.get(rootMargin)
  if (!viewport) {
    const callbacks = new Map<Element, (visible?: boolean) => void>()
    viewport = {
      changed: callbacks,
      observer: Observer ? new Observer((entries) => {
        for (const entry of entries) callbacks.get(entry.target)?.(entry.isIntersecting)
      }, { rootMargin }) : null,
    }
    margins.set(rootMargin, viewport)
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
