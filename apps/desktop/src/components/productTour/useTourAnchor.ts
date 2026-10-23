import { useEffect, useState } from 'react'

/** Follow the actual rail through async shell mounting and window resizing. Navigation uses its own click handler. */
export function useTourAnchor(rail: string | null, enabled: boolean) {
  const [target, setTarget] = useState<{ anchor: HTMLElement; container?: HTMLElement } | null>(null)
  useEffect(() => {
    if (!enabled || !rail) return
    let clicked: HTMLElement | null = null
    const locate = () => {
      const button = document.querySelector<HTMLElement>(`.gg-sidebar-rail [data-rail="${rail}"]`)
      if (!button || button.getBoundingClientRect().width === 0) return
      const container = rail === 'settings' ? document.querySelector('[data-settings-modal-card]')?.closest<HTMLElement>('[data-slot="dialog-popup"]') ?? undefined : undefined
      setTarget((current) => current?.anchor === button && current.container === container ? current : { anchor: button, container })
      if (clicked !== button) {
        clicked?.removeAttribute('data-product-tour-target')
        clicked = button
        button.setAttribute('data-product-tour-target', '')
        button.scrollIntoView({ block: 'nearest' })
        button.click()
      }
    }
    const observer = new MutationObserver(locate)
    observer.observe(document.body, { childList: true, subtree: true })
    locate()
    return () => { observer.disconnect(); clicked?.removeAttribute('data-product-tour-target') }
  }, [enabled, rail])
  return enabled && target?.anchor.dataset.rail === rail ? target : null
}
