import { useLayoutEffect, useRef, useState } from 'react'
import { INITIAL_CONNECTED_APPS_VIEW, type ConnectedAppsView } from './connected-app-catalog'

type ViewMemory = { view: ConnectedAppsView; scroll: Map<string, number> }
const views = new Map<string, ViewMemory>()

function viewKey(view: ConnectedAppsView): string {
  return JSON.stringify([view.tab, view.category, view.query])
}

function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (/(auto|scroll)/u.test(getComputedStyle(parent).overflowY)) return parent
  }
  return document.scrollingElement instanceof HTMLElement ? document.scrollingElement : null
}

/** Account and host scope prevent another account from inheriting a directory view. */
export function useConnectedAppView(scope: string) {
  const [memory] = useState<ViewMemory>(() => {
    const saved = views.get(scope)
    if (saved) return saved
    const initial = { view: { ...INITIAL_CONNECTED_APPS_VIEW }, scroll: new Map<string, number>() }
    views.set(scope, initial)
    return initial
  })
  const [view, setView] = useState(memory.view)
  const root = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLElement | null>(null)
  const key = viewKey(view)
  useLayoutEffect(() => {
    const element = root.current && scrollParent(root.current)
    if (!element) return
    scroller.current = element
    element.scrollTop = memory.scroll.get(key) ?? 0
    const remember = () => memory.scroll.set(key, element.scrollTop)
    element.addEventListener('scroll', remember, { passive: true })
    return () => {
      element.removeEventListener('scroll', remember)
    }
  }, [key, memory])

  function rememberScroll() {
    if (scroller.current) memory.scroll.set(key, scroller.current.scrollTop)
  }
  function change(next: ConnectedAppsView) {
    rememberScroll()
    memory.view = next
    setView(next)
  }
  return { root, view, change, rememberScroll }
}
