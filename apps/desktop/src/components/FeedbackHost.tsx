import { useEffect, useState } from 'react'
import { UI_EVENTS } from '../lib/uiEvents'
import { FeedbackModal } from './FeedbackModal'

/** Settings and session menus use the same feedback form, on desktop and mobile alike. */
export function FeedbackHost() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const show = () => setOpen(true)
    window.addEventListener(UI_EVENTS.sessionpageOpenFeedback, show)
    return () => window.removeEventListener(UI_EVENTS.sessionpageOpenFeedback, show)
  }, [])
  return open ? <FeedbackModal onClose={() => setOpen(false)} /> : null
}
