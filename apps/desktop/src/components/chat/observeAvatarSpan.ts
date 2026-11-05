/** Read-only geometry is delivered by the browser after layout, never queried mid-commit. */
export function observeAvatarSpan(slot: HTMLElement, layer: HTMLElement, continuesGroup: boolean): () => void {
  const row = slot.closest('[role="listitem"]')
  const list = row?.parentElement
  if (!row || !list) return () => {}
  let active = true
  let pending: IntersectionObserver | null = null
  let watched: Element[] = []
  const requestSample = () => {
    if (!active) return
    pending?.disconnect()
    let top: Element | null = null
    for (let previous = continuesGroup ? row.previousElementSibling : null; previous && !top; previous = previous.previousElementSibling) {
      top = previous.querySelector('[data-avatar-group-top]')
    }
    const own = row.querySelector('[data-message-bubble-row]')
    const first = (top?.closest('[role="listitem"]') ?? row).querySelector('[data-message-bubble-row]')
    if (!own || !first) return
    const targets = [...new Set([first, own, slot])]
    for (const target of watched) if (!targets.includes(target)) resize.unobserve(target)
    for (const target of targets) if (!watched.includes(target)) resize.observe(target)
    watched = targets
    const rects = new Map<Element, DOMRectReadOnly>()
    const observer = new IntersectionObserver(entries => {
      if (!active || pending !== observer) return
      for (const entry of entries) rects.set(entry.target, entry.boundingClientRect)
      if (!targets.every(target => rects.has(target))) return
      // A one-shot sample avoids mixing later scroll notifications with older coordinates.
      observer.disconnect()
      pending = null
      const bottom = `${rects.get(slot)!.bottom - rects.get(own)!.bottom}px`
      const height = `${rects.get(own)!.bottom - rects.get(first)!.top}px`
      if (layer.style.bottom !== bottom) layer.style.bottom = bottom
      if (layer.style.height !== height) layer.style.height = height
    })
    pending = observer
    for (const target of targets) observer.observe(target)
  }
  const resize = new ResizeObserver(requestSample)
  resize.observe(list)
  requestSample()
  return () => { active = false; resize.disconnect(); pending?.disconnect(); pending = null }
}
