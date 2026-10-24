import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { resize } from 'framer-motion'

/** Keep a readable chat title and the existing actions; only App shortcuts move into More. */
export function useHeaderAppCapacity(count: number, compact: boolean, moreInTabMenu: boolean, moreButton: RefObject<HTMLButtonElement | null>) {
  const ref = useRef<HTMLSpanElement>(null)
  const [capacity, setCapacity] = useState(0)
  useLayoutEffect(() => {
    const strip = ref.current
    const actions = strip?.parentElement
    const header = strip?.closest<HTMLElement>('[data-chat-area-header], .session-tab-bar')
    if (compact || !strip || !actions || !header) return
    const measure = () => {
      const button = actions.querySelector<HTMLElement>('[data-slot="icon-button"]')
      const unit = (button?.getBoundingClientRect().width ?? 0) + 2
      if (unit <= 2) return
      const width = header.getBoundingClientRect().width
      const base = actions.getBoundingClientRect().width - strip.getBoundingClientRect().width
      // A tab-hosted header normally has no More; reserve it before overflowing so its appearance cannot oscillate.
      const more = moreInTabMenu && !moreButton.current ? unit : 0
      setCapacity(Math.max(0, Math.min(count, Math.floor((width - Math.min(160, width / 3) - base - more - 32) / unit))))
    }
    measure()
    return resize([header, actions], measure)
  }, [count, compact, moreInTabMenu, moreButton])
  return { ref, capacity: compact ? 0 : capacity }
}
