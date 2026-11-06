import { useLayoutEffect, useState } from 'react'

const COMPOSER = '[data-slot="composer"]'
// Product spacing: the notice stack ends 8px above every visible composer.
const COMPOSER_GAP = 8

export function readNoticeComposerBottom(): number | undefined {
  let top = window.innerHeight
  let visible = false
  for (const composer of document.querySelectorAll<HTMLElement>(COMPOSER)) {
    // Retained task/chat surfaces keep their layout while content-visibility hides them.
    if (!composer.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue
    const rect = composer.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0 || rect.right <= 0 || rect.left >= window.innerWidth || rect.bottom <= 0 || rect.top >= window.innerHeight) continue
    visible = true
    top = Math.min(top, rect.top)
  }
  return visible ? window.innerHeight - top + COMPOSER_GAP : undefined
}

/** The single outlet follows actual composer geometry, including retained/split surfaces. */
export function useNoticeComposerBottom(active: boolean): number | undefined {
  const [bottom, setBottom] = useState<number>()
  useLayoutEffect(() => {
    if (!active) return
    let frame = 0
    const observed = new Set<Element>()
    const resize = new ResizeObserver(() => measure())
    const measure = () => {
      const next = new Set<Element>()
      for (const composer of document.querySelectorAll(COMPOSER)) {
        // A parent can move the composer without changing its own size (pane/layout changes).
        for (let element: Element | null = composer; element; element = element.parentElement) next.add(element)
      }
      for (const element of observed) if (!next.has(element)) { resize.unobserve(element); observed.delete(element) }
      for (const element of next) if (!observed.has(element)) { resize.observe(element); observed.add(element) }
      const value = readNoticeComposerBottom()
      setBottom((previous) => previous === value ? previous : value)
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure() }) }
    const containsComposer = (node: Node) => node instanceof Element && (node.matches(COMPOSER) || node.querySelector(COMPOSER) !== null)
    const mutations = new MutationObserver((records) => {
      // Streaming transcript rows and Sonner's own style updates do not change the anchor.
      if (records.some((record) => record.type === 'attributes'
        ? containsComposer(record.target)
        : [...record.addedNodes, ...record.removedNodes].some(containsComposer))) schedule()
    })
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'data-state'] })
    window.addEventListener('resize', schedule)
    document.addEventListener('scroll', schedule, true)
    measure()
    return () => {
      if (frame) cancelAnimationFrame(frame)
      resize.disconnect()
      mutations.disconnect()
      window.removeEventListener('resize', schedule)
      document.removeEventListener('scroll', schedule, true)
    }
  }, [active])
  return bottom
}
