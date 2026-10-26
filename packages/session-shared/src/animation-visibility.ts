/** Desktop keeps backgroundThrottling disabled; the host reports minimize/tray visibility. */
export const ANIMATION_WINDOW_SEEN_EVENT = '__window_seen'

const listening = new WeakSet<Document>()
const viewports = new WeakMap<Document, Map<string, {
  observer: IntersectionObserver
  changed: Map<Element, (visible: boolean) => void>
}>>()

function listen(doc: Document) {
  if (listening.has(doc)) return
  listening.add(doc)
  let windowSeen = true
  const sync = () => {
    // Inherited through shadow roots too. 'initial' unsets the custom property,
    // letting each surface/viewport supply its own pause state in CSS.
    doc.documentElement.style.setProperty('--gugu-animation-window-paused',
      !doc.hidden && windowSeen ? 'initial' : 'paused')
  }
  doc.addEventListener('visibilitychange', sync)
  doc.defaultView?.addEventListener(ANIMATION_WINDOW_SEEN_EVENT, (event) => {
    windowSeen = (event as CustomEvent<boolean>).detail
    sync()
  })
  sync()
}

export function isAnimationWindowVisible(doc = document): boolean {
  listen(doc)
  return !doc.hidden && doc.documentElement.style.getPropertyValue('--gugu-animation-window-paused') !== 'paused'
}

export function subscribeAnimationWindowVisibility(changed: () => void, doc = document): () => void {
  listen(doc)
  // A portal is painted in its own document, even when its component runs in
  // the opener. Subscribe to that document's existing signals, not the opener.
  const notify = () => changed()
  doc.addEventListener('visibilitychange', notify)
  doc.defaultView?.addEventListener(ANIMATION_WINDOW_SEEN_EVENT, notify)
  return () => {
    doc.removeEventListener('visibilitychange', notify)
    doc.defaultView?.removeEventListener(ANIMATION_WINDOW_SEEN_EVENT, notify)
  }
}

/** One viewport observer per margin; no ancestor observers or synchronous style/geometry reads. */
export function observeAnimationViewport(element: HTMLElement, changed: (visible: boolean) => void, rootMargin = '0px'): () => void {
  const doc = element.ownerDocument
  listen(doc)
  // Preserve the existing old-WebView behavior: without IO, draw on screen.
  const Observer = doc.defaultView?.IntersectionObserver
  if (!Observer) {
    changed(true)
    return () => {}
  }
  let margins = viewports.get(doc)
  if (!margins) {
    margins = new Map()
    viewports.set(doc, margins)
  }
  let viewport = margins.get(rootMargin)
  if (!viewport) {
    const callbacks = new Map<Element, (visible: boolean) => void>()
    viewport = {
      changed: callbacks,
      observer: new Observer((entries) => {
        for (const entry of entries) callbacks.get(entry.target)?.(entry.isIntersecting)
      }, { rootMargin }),
    }
    margins.set(rootMargin, viewport)
  }
  viewport.changed.set(element, changed)
  viewport.observer.observe(element)
  return () => {
    viewport.changed.delete(element)
    viewport.observer.unobserve(element)
  }
}
