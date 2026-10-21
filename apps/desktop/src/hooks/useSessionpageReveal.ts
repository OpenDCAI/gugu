import { useEffect } from 'react'
import { UI_EVENTS } from '../lib/uiEvents'

/**
 * The session page asks to come forward: someone must decide something there (#6646, an install's consent), or a person's
 * click opened something there (a banner, a link, a composer an App named) — on the chats page it happened unseen.
 */
export function revealSessionpage(): void {
  window.dispatchEvent(new CustomEvent(UI_EVENTS.sessionpageReveal))
}

export function useSessionpageReveal(setActiveTab: (tab: 'tasks') => void): void {
  useEffect(() => {
    const reveal = () => setActiveTab('tasks')
    window.addEventListener(UI_EVENTS.sessionpageReveal, reveal)
    return () => window.removeEventListener(UI_EVENTS.sessionpageReveal, reveal)
  }, [setActiveTab])
}
