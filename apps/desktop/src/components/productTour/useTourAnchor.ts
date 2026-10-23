import { useEffect, useState } from 'react'

/** Follow current navigation, including the project/chat pages inside the unified Messages entry. */
export function useTourAnchor(rail: string | null, enabled: boolean) {
  const [target, setTarget] = useState<{ rail: string; anchor: HTMLElement; container?: HTMLElement } | null>(null)
  useEffect(() => {
    if (!enabled || !rail) return
    let clicked: HTMLElement | null = null
    let messagesOpened = false
    const locate = () => {
      const messages = rail === 'tasks' || rail === 'chats'
      const entry = document.querySelector<HTMLElement>(`.gg-sidebar-rail [data-rail="${messages ? 'chats' : rail}"]`)
      if (!entry || entry.getBoundingClientRect().width === 0) return
      if (messages && !messagesOpened) {
        messagesOpened = true
        entry.click()
      }
      const page = messages ? document.querySelector<HTMLElement>(`[data-testid="sidebar-list-page-${rail === 'tasks' ? 'projects' : 'chats'}"]`) : null
      // A merged sidebar has no page switch. Highlight its existing Messages entry without changing that layout.
      const button = page && page.getBoundingClientRect().width > 0 ? page : entry
      const container = rail === 'settings' ? document.querySelector('[data-settings-modal-card]')?.closest<HTMLElement>('[data-slot="dialog-popup"]') ?? undefined : undefined
      setTarget((current) => current?.anchor === button && current.container === container && current.rail === rail ? current : { rail, anchor: button, container })
      if (clicked !== button) {
        clicked?.removeAttribute('data-product-tour-target')
        clicked = button
        button.setAttribute('data-product-tour-target', '')
        button.scrollIntoView({ block: 'nearest' })
        if (!messages || button !== entry) button.click()
      }
    }
    const observer = new MutationObserver(locate)
    observer.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('resize', locate)
    locate()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', locate)
      clicked?.removeAttribute('data-product-tour-target')
    }
  }, [enabled, rail])
  return enabled && target?.rail === rail ? target : null
}
