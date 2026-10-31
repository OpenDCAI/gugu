import { useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'

/** Keep a readable chat title and the existing actions; only App shortcuts move into More. */
export function useHeaderAppCapacity(count: number, compact: boolean) {
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
      setCapacity(Math.max(0, Math.min(count, Math.floor((width - Math.min(160, width / 3) - base - 32) / unit))))
    }
    // No synchronous first measure (it forced a layout mid-commit): the observer's first delivery runs after layout,
    // before paint; flushSync lands the capacity in that same frame.
    const observer = new ResizeObserver(() => flushSync(measure))
    observer.observe(header)
    observer.observe(actions)
    return () => observer.disconnect()
  }, [count, compact])
  return { ref, capacity: compact ? 0 : capacity }
}
