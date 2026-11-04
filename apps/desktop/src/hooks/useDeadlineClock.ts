import { useEffect, useState } from 'react'

/** Recompute once at a deadline; no deadline means no timer. */
export function useDeadlineClock(deadline: number | null, graceMs = 0): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (deadline === null) return
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, deadline - Date.now()) + graceMs)
    return () => window.clearTimeout(timer)
  }, [deadline, graceMs])
  return now
}
