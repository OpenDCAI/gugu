import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { AUTOMATION_TEST_IDS } from '@/lib/automationDom'
import { mobileListDiagnostics, type ElementGeometry, type ShellListGeometry, type ShellListState } from './mobileListDiagnostics'

/** Read fixed shell markers only: never text, input values, URLs, titles or arbitrary attributes. */
export function readMobileListGeometry(root: HTMLElement): ShellListGeometry {
  const win = root.ownerDocument.defaultView!
  const geometry = (element: Element | null): ElementGeometry | null => {
    if (!element) return null
    const rect = element.getBoundingClientRect(), style = win.getComputedStyle(element)
    return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height),
      display: style.display === 'none' ? 'none' : style.display === 'contents' ? 'contents' : 'box',
      visibility: style.visibility === 'hidden' ? 'hidden' : style.visibility === 'collapse' ? 'collapse' : 'visible',
      contentVisibility: style.contentVisibility === 'hidden' ? 'hidden' : style.contentVisibility === 'auto' ? 'auto' : 'visible',
      inert: !!element.closest('[inert]') }
  }
  const pager = root.querySelector<HTMLElement>('[data-mobile-tab-pager]')
  return {
    online: win.navigator.onLine, foreground: root.ownerDocument.visibilityState === 'visible',
    viewport: [win.innerWidth, win.innerHeight], shell: geometry(root), pager: geometry(pager),
    listPane: geometry(root.querySelector(`[data-testid="${AUTOMATION_TEST_IDS.chatListPane}"]`)),
    list: geometry(root.querySelector('[data-phone-root-list="chats"]')),
    me: geometry(root.querySelector(`[data-phone-root-list="chats"] [data-testid="${AUTOMATION_TEST_IDS.mobileProfileNav}"]`)),
    scrollLeft: pager ? Math.round(pager.scrollLeft) : null, scrollWidth: pager?.scrollWidth ?? null,
  }
}

export function useMobileShellDiagnostics(mobile: boolean, ownerId: string, root: RefObject<HTMLElement | null>, state: ShellListState) {
  const latest = useRef(state)
  latest.current = state
  // The owner ID is never logged. A different account cannot inherit the previous account's correlation keys.
  useLayoutEffect(() => {
    if (!mobile) return
    mobileListDiagnostics.reset()
    return () => mobileListDiagnostics.reset()
  }, [mobile, ownerId])
  const sample = (reason: 'commit' | 'viewport' | 'visibility') => {
    try { if (root.current) mobileListDiagnostics.shell(reason, latest.current, readMobileListGeometry(root.current)) }
    catch { /* A detached viewport or unsupported CSS API cannot block Back. */ }
  }
  useEffect(() => {
    if (!mobile) return
    // One trailing sample includes animation/layout settlement; no frame or DOM mutation polling.
    const timer = setTimeout(() => sample('commit'), 250)
    return () => clearTimeout(timer)
    // State fields, rather than the caller's object identity, define a navigation change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mobile, ownerId, state.activeTab, state.pagerTab, state.mobilePane, state.phoneLayerOpen, state.chatListHidden, state.tabBarVisible])
  useEffect(() => {
    const element = root.current
    if (!mobile || !element) return
    const doc = element.ownerDocument, win = doc.defaultView!
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => { clearTimeout(timer); timer = setTimeout(() => sample('viewport'), 250) }
    const visibility = () => sample('visibility')
    const click = (event: MouseEvent) => {
      const row = event.target instanceof win.Element ? event.target.closest('[data-chat-row]')?.getAttribute('data-chat-row') : null
      if (row) mobileListDiagnostics.openRow(row)
      schedule()
    }
    element.addEventListener('scroll', schedule, true)
    element.addEventListener('click', click, true)
    win.addEventListener('resize', schedule)
    win.addEventListener('pageshow', visibility)
    doc.addEventListener('visibilitychange', visibility)
    return () => {
      clearTimeout(timer)
      element.removeEventListener('scroll', schedule, true)
      element.removeEventListener('click', click, true)
      win.removeEventListener('resize', schedule)
      win.removeEventListener('pageshow', visibility)
      doc.removeEventListener('visibilitychange', visibility)
    }
    // The sampling callback reads current state through latest; listeners belong to this shell only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mobile, ownerId, root])
}
