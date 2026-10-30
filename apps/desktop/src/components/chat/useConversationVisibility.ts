import { useLayoutEffect, useRef, useState } from 'react'

/** A retained desktop slot stays mounted while another shell page covers it. */
export function useConversationVisibility(requested: boolean) {
  const ref = useRef<HTMLDivElement>(null)
  const [intersects, setIntersects] = useState(false)
  useLayoutEffect(() => {
    const element = ref.current
    if (!requested || !element) { setIntersects(false); return }
    let live = true
    let intersecting = false
    const publish = () => { if (live) setIntersects(intersecting && document.visibilityState !== 'hidden') }
    const observer = new IntersectionObserver(entries => {
      const entry = entries.find(entry => entry.target === element)
      if (!entry) return
      intersecting = entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0
      publish()
    })
    observer.observe(element)
    document.addEventListener('visibilitychange', publish)
    return () => { live = false; observer.disconnect(); document.removeEventListener('visibilitychange', publish) }
  }, [requested])
  return { ref, shown: requested && intersects }
}
