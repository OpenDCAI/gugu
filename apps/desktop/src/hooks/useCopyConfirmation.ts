import { useCallback, useEffect, useRef, useState } from 'react'
import { COPY_CONFIRMATION_MS } from '@/lib/copyFeedback'

/** Call only after the clipboard write succeeds. Changing the target clears the checkmark. */
export function useCopyConfirmation(target: unknown) {
  const [confirmation, setConfirmation] = useState<{ target: unknown } | null>(null)
  const current = useRef(target)
  current.current = target
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const live = useRef(false)
  useEffect(() => {
    live.current = true
    setConfirmation(null)
    return () => { live.current = false; clearTimeout(timer.current) }
  }, [target])
  const confirm = useCallback(() => {
    if (!live.current || current.current !== target) return
    clearTimeout(timer.current)
    setConfirmation({ target })
    timer.current = setTimeout(() => setConfirmation(null), COPY_CONFIRMATION_MS)
  }, [target])
  return { copied: confirmation !== null && confirmation.target === target, confirm }
}
