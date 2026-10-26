import { useLayoutEffect, useRef, type RefObject } from 'react'

/** Keep each index position while a portal or an asynchronously loaded page opens. */
export function usePanelScroll(body: RefObject<HTMLDivElement | null>, key: string) {
  const positions = useRef(new Map<string, number>())
  useLayoutEffect(() => {
    const element = body.current
    if (!element) return
    const target = positions.current.get(key) ?? 0
    let restoring = true
    const restore = () => { element.scrollTop = target; restoring = element.scrollTop !== target }
    const remember = () => { if (!restoring) positions.current.set(key, element.scrollTop) }
    const interact = () => { restoring = false }
    const observer = new MutationObserver(() => { if (restoring) restore() })
    observer.observe(element, { childList: true, subtree: true })
    restore()
    element.addEventListener('scroll', remember)
    element.addEventListener('wheel', interact, { passive: true })
    element.addEventListener('touchstart', interact, { passive: true })
    return () => {
      observer.disconnect()
      element.removeEventListener('scroll', remember)
      element.removeEventListener('wheel', interact)
      element.removeEventListener('touchstart', interact)
    }
  }, [body, key])
}
